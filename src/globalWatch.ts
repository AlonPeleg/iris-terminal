// Global Watch: pure logic (no vscode import) so it can be tested on its own.
//
//  - parsePattern / describePattern     the subscript pattern syntax (^g, ^g(), ^g(,), ^g("x"), ^g("x", ...)
//  - buildQueryLines / buildListLines   the ObjectScript that is typed into the hidden IRIS terminal
//  - extractFrame / parseQueryOutput    reading the framed, hex-escaped answer back
//
// How the answer is read: every request is wrapped in markers that are printed by the IRIS side as
// "@@WS" _ id _ "B" ... "@@WS" _ id _ "Z". The markers are built by concatenation in the typed code, so the
// terminal's echo of what we typed can never be mistaken for them. All text that comes back (subscripts,
// values, error messages) is escaped so that only plain printable characters travel: anything outside
// 32..126, plus '\', '|' and '@', becomes "\HEX;" (HEX = the character's code). Line breaks that a terminal
// might insert into a long line are simply removed before parsing, which is safe because real line breaks
// in values travel as \D; and \A; (hex 13 and 10).

export type PatternSlot = null | { type: 'n' | 's'; value: string };   // null = any value

export interface Pattern {
    name: string;            // global name without the ^
    slots: PatternSlot[];    // empty = the whole global
    closed: boolean;         // true: exactly slots.length levels; false: that level and everything below
}

export type PatternResult = { ok: true; pattern: Pattern } | { ok: false; error: string };

export function parsePattern(text: string): PatternResult {
    const t = text.trim();
    const m = /^\^(%?[A-Za-z][A-Za-z0-9.]*)([\s\S]*)$/.exec(t);
    if (!m) return { ok: false, error: 'A pattern must start with ^ and a global name, e.g. ^mtemp' };
    const name = m[1];
    let rest = m[2];
    if (rest === '') return { ok: true, pattern: { name, slots: [], closed: false } };
    if (rest[0] !== '(') return { ok: false, error: 'Expected ( after the global name' };
    rest = rest.slice(1);
    let closed = false;

    // Walk the text once: split on commas outside quotes, and notice a closing ) outside quotes.
    const rawSlots: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        if (c === '"') {
            if (inQ && rest[i + 1] === '"') { cur += '""'; i++; continue; }   // doubled quote inside a string
            inQ = !inQ; cur += c; continue;
        }
        if (!inQ && c === ')') {
            if (rest.slice(i + 1).trim() !== '') return { ok: false, error: 'Nothing is allowed after the closing )' };
            closed = true;
            break;
        }
        if (!inQ && c === ',') { rawSlots.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (inQ) return { ok: false, error: 'Close the quote: text subscripts need both quotes (numbers do not)' };
    rawSlots.push(cur);

    const slots: PatternSlot[] = [];
    for (const raw of rawSlots) {
        const s = raw.trim();
        if (s === '') { slots.push(null); continue; }
        if (s[0] === '"') {
            if (s.length < 2 || s[s.length - 1] !== '"') return { ok: false, error: 'Close the quote: text subscripts need both quotes (numbers do not)' };
            const inner = s.slice(1, -1);
            if (inner.replace(/""/g, '').includes('"')) return { ok: false, error: 'A quote inside text must be doubled ("")' };
            const value = inner.replace(/""/g, '"');
            if (/[\u0000-\u001f]/.test(value)) return { ok: false, error: 'Control characters are not allowed in a subscript' };
            slots.push({ type: 's', value });
            continue;
        }
        if (/^-?\d+(\.\d+)?$/.test(s)) { slots.push({ type: 'n', value: s }); continue; }
        return { ok: false, error: 'Subscript ' + s + ' must be "text" or a number' };
    }
    return { ok: true, pattern: { name, slots, closed } };
}

const ORD = ['', '1st', '2nd', '3rd'];
const ordinal = (i: number) => ORD[i] ?? `${i}th`;

export function describePattern(p: Pattern): string {
    if (p.slots.length === 0) return 'Everything in the global';
    const L = p.slots.length;
    const lit = p.slots.map((s, i) => s ? `${ordinal(i + 1)} = "${s.value}"` : '').filter(Boolean);
    const cond = lit.length ? ' where ' + lit.join(' and ') : '';
    if (p.closed) return `Level ${L} only${cond}`;
    if (p.slots[L - 1] === null && L > 1) return `Everything below level ${L - 1}, not that node itself${cond}`;
    return `That node and everything below it${cond}`;
}

// ---- ObjectScript generation ---------------------------------------------------------------------

export const NS_RE = /^[%A-Za-z0-9_-]+$/;

function osString(s: string): string { return '"' + s.replace(/"/g, '""') + '"'; }
function osLiteral(s: PatternSlot & object): string { return s.type === 'n' ? s.value : osString(s.value); }

// "@@WS" _ "7" _ "B"   (built by concatenation so an echo of this text never looks like a marker)
const marker = (id: number, suffix: string) => `"@@WS"_"${id}"_"${suffix}"`;

// Escapes the text in variable `src` into variable zwe (see the header comment).
const enc = (src: string) =>
    `s zwe="" f zwk=1:1:$l(${src}) { s zwa=$a(${src},zwk) s zwe=zwe_$s(zwa>31&&(zwa<127)&&(zwa'=92)&&(zwa'=124)&&(zwa'=64):$c(zwa),1:"\\"_$zhex(zwa)_";") } `;

const ERR_PART = (id: number) =>
    `catch zwx { s zwu=$s($ze'="":$ze,1:zwx.Name) ${enc('zwu')}w ${marker(id, 'X|')}_zwe } `;

export interface QueryOptions {
    id: number;
    limit: number;          // most nodes to return; one more is probed to know whether there were more
    valueLimit: number;     // most characters of a value to return
    namespace: string;      // namespace of the watch
    currentNamespace: string; // namespace the hidden session is in
}

/** The ObjectScript program (one string, not yet split into lines) for one watch. */
export function buildQueryProgram(p: Pattern, o: QueryOptions): string {
    const g = '^' + p.name;
    const K = p.slots.length;
    const ref = (i: number) => g + '(' + Array.from({ length: i }, (_, k) => 'zs' + (k + 1)).join(',') + ')';

    // Writes one record. `src` = variable holding the node name, `depth` = how many subscripts to print,
    // `withValue` = a real node (prints its value) or an intermediate level that holds no data of its own.
    const record = (src: string, depth: string, withValue: boolean) =>
        `s zwq=zwq+1 i zwq>${o.limit} { s zwt=1 } else { s zwo="@R" f zwj=1:1:${depth} { s zwu=$qs(${src},zwj) ${enc('zwu')}s zwo=zwo_"|"_$s(zwu=+zwu:"n",1:"s")_zwe } ` +
        (withValue
            ? `s zwd=$d(@${src}) i zwd#2 { s zwv=$g(@${src}) s zwl=$s($l(zwv)>${o.valueLimit}:1,1:0) s zwu=$e(zwv,1,${o.valueLimit}) ${enc('zwu')}s zwo=zwo_"|V"_zwe_$s(zwl:"\\T;",1:"") } else { s zwo=zwo_"|G" } `
            : `s zwo=zwo_"|G" `) +
        `w zwo } `;
    const emit = record('zwn', '$ql(zwn)', true);

    // Everything below the node in zwn. $QUERY only returns nodes that hold data, so the levels in between
    // (which hold only children) are printed as they are first passed: zwc = first subscript that differs
    // from the previous node, so every level from there down to the node itself is new.
    const below = (base: number) =>
        `f { s zwr=$q(@zwr) q:zwr=""  q:$e(zwr,1,$l(zwp))'=zwp  q:zwt  ` +
        `s zwc=1 f { q:zwc>$ql(zwr)  q:$qs(zwr,zwc)'=$s(zwc>$ql(zwb):"",1:$qs(zwb,zwc))  s zwc=zwc+1 } ` +
        `f zwi=$s(zwc>${base}:zwc,1:${base + 1}):1:$ql(zwr)-1 { ${record('zwr', 'zwi', false)}} ` +
        `q:zwt  s zwn=zwr ${emit}s zwb=zwr } `;
    const descend = `s zwr=zwn,zwb=zwn,zwp=$e(zwn,1,$l(zwn)-1)_"," ${below(K)}`;

    const levels = (i: number): string => {
        if (i > K) {
            const node = `s zwn=$na(${ref(K)}) ${emit}`;
            return p.closed ? node : node + descend;
        }
        const slot = p.slots[i - 1];
        const v = 'zs' + i;
        if (slot) return `s ${v}=${osLiteral(slot)} i $d(${ref(i)}) { ${levels(i + 1)}} `;
        return `s ${v}="" f { s ${v}=$o(${ref(i)}) q:${v}=""  q:zwt  ${levels(i + 1)}} `;
    };

    let body: string;
    if (K === 0) {
        body = `i $d(${g}) { s zwn=${osString(g)} i $d(${g})#2 { ${emit}} ` +
            `s zwr=zwn,zwb=zwn,zwp="" ${below(0)}} `;
    } else {
        body = `i $d(${g}) { ${levels(1)}} `;
    }

    const switched = o.namespace.toUpperCase() !== o.currentNamespace.toUpperCase();
    const zn = switched ? `zn ${osString(o.namespace)} ` : '';
    const back = switched ? `zn ${osString(o.currentNamespace)} ` : '';
    return `s zwq=0,zwt=0 w ${marker(o.id, 'B')} try { ${zn}${body}w ${marker(o.id, 'E|')}_$s($d(${g}):1,1:0)_"|"_zwt } ` +
        ERR_PART(o.id) + back + `w ${marker(o.id, 'Z')}`;
}

/** The ObjectScript program that lists the namespaces (same call the "Switch Namespace" command uses). */
export function buildListProgram(id: number): string {
    return `s zwc=0 w ${marker(id, 'B')} try { d ##class(%SYS.Namespace).ListAll(.zwa) s zwn="" f { s zwn=$o(zwa(zwn)) q:zwn=""  w "@N|"_zwn } w ${marker(id, 'E|')} } ` +
        ERR_PART(id) + `w ${marker(id, 'Z')}`;
}

/**
 * Splits a program into short typed lines: `s zwp(n)="..."` for each piece and one final `x zwp(1)_zwp(2)...`.
 * Short lines keep clear of any input-line length limit, whatever the pattern looks like.
 */
export function programToLines(program: string, pieceSize = 200): string[] {
    const pieces: string[] = [];
    for (let i = 0; i < program.length; i += pieceSize) pieces.push(program.slice(i, i + pieceSize));
    const lines = pieces.map((piece, i) => `s zwp(${i + 1})=${osString(piece)}`);
    lines.push('x ' + pieces.map((_, i) => `zwp(${i + 1})`).join('_'));
    return lines;
}

// ---- reading the answer --------------------------------------------------------------------------

export interface Frame { payload: string; rest: string }

/** Finds "@@WS<id>B ... @@WS<id>Z" in the text received so far. */
export function extractFrame(buffer: string, id: number): Frame | undefined {
    const b = buffer.indexOf(`@@WS${id}B`);
    if (b < 0) return undefined;
    const z = buffer.indexOf(`@@WS${id}Z`, b);
    if (z < 0) return undefined;
    return { payload: buffer.slice(b + `@@WS${id}B`.length, z), rest: buffer.slice(z + `@@WS${id}Z`.length) };
}

export function unescapeText(s: string, encoding: string): string {
    return s.replace(/\\([0-9A-Fa-f]+);/g, (_m, hex: string) => {
        const code = parseInt(hex, 16);
        // Windows-1255 servers hand out byte values: map the Hebrew letters back to Unicode.
        if (encoding === 'windows1255') {
            if (code >= 0xE0 && code <= 0xFA) return String.fromCharCode(0x05D0 + code - 0xE0);
            return code < 256 ? String.fromCharCode(code) : '?';
        }
        try { return String.fromCodePoint(code); } catch { return '?'; }
    });
}

export interface WatchSub { t: 'n' | 's'; v: string }
export interface WatchRow { subs: WatchSub[]; value: string | null; valueCut?: boolean }
export interface QueryResult {
    exists: boolean;
    truncated: boolean;
    rows: WatchRow[];
    error?: string;
}

function stripBreaks(s: string): string { return s.replace(/[\r\n]/g, ''); }

export function parseQueryOutput(payload: string, id: number, encoding: string): QueryResult {
    const text = stripBreaks(payload);
    const xi = text.indexOf(`@@WS${id}X|`);
    if (xi >= 0) {
        const msg = text.slice(xi + `@@WS${id}X|`.length);
        return { exists: false, truncated: false, rows: [], error: unescapeText(msg, encoding).trim() || 'Unknown error' };
    }
    const ei = text.indexOf(`@@WS${id}E|`);
    if (ei < 0) return { exists: false, truncated: false, rows: [], error: 'The server gave no result (the command may have been rejected)' };
    const [exists, trunc] = text.slice(ei + `@@WS${id}E|`.length).split('|');
    const recs = text.slice(0, ei).split('@R|').slice(1);
    const rows: WatchRow[] = recs.map(rec => {
        const fields = rec.split('|');
        const last = fields.pop() ?? 'G';
        const subs: WatchSub[] = fields.map(f => ({ t: f[0] === 'n' ? 'n' as const : 's' as const, v: unescapeText(f.slice(1), encoding) }));
        if (last[0] === 'V') {
            const raw = last.slice(1);
            const cut = raw.endsWith('\\T;');
            return { subs, value: unescapeText(cut ? raw.slice(0, -3) : raw, encoding), valueCut: cut || undefined };
        }
        return { subs, value: null };
    });
    return { exists: exists === '1', truncated: trunc === '1', rows };
}

export function parseNamespaces(payload: string, id: number, encoding: string): { names: string[]; error?: string } {
    const text = stripBreaks(payload);
    const xi = text.indexOf(`@@WS${id}X|`);
    if (xi >= 0) return { names: [], error: unescapeText(text.slice(xi + `@@WS${id}X|`.length), encoding).trim() || 'Unknown error' };
    const ei = text.indexOf(`@@WS${id}E|`);
    if (ei < 0) return { names: [], error: 'The server gave no namespace list' };
    const names = text.slice(0, ei).split('@N|').slice(1).map(s => s.trim()).filter(s => NS_RE.test(s));
    return { names: [...new Set(names)].sort((a, b) => a.localeCompare(b)) };
}

/** Text -> bytes the way the terminal sends it (Windows-1255 maps Hebrew letters; other text is UTF-8). */
export function encodeText(data: string, encoding: string): Buffer {
    if (encoding !== 'windows1255') return Buffer.from(data, 'utf8');
    const bytes: number[] = [];
    for (let i = 0; i < data.length; i++) {
        const c = data.charCodeAt(i);
        if (c >= 0x05D0 && c <= 0x05EA) bytes.push(c - 0x05D0 + 0xE0);
        else if (c < 256) bytes.push(c);
        else bytes.push(0x3F);
    }
    return Buffer.from(bytes);
}
