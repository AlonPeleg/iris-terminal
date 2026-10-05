// Global Watch: pure logic (no vscode import) so it can be tested on its own.
//
//  - parsePattern / describePattern     the subscript pattern syntax (see patternSyntax.ts: ^g, ^g(,), ^g("x",, 2:5, ["out", ...)
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

import { Item, Pattern, PatternSlot, NS_RE } from './patternSyntax';
export * from './patternSyntax';

// ---- ObjectScript generation ---------------------------------------------------------------------

function osString(s: string): string { return '"' + s.replace(/"/g, '""') + '"'; }
function osLiteral(s: { type: 'n' | 's'; value: string }): string { return s.type === 'n' ? numLit(s.value) : osString(s.value); }
/** A number as ObjectScript code; negative numbers are parenthesised so no operator can swallow the minus. */
function numLit(v: string): string { return v[0] === '-' ? '(' + v + ')' : v; }
const CANON_NUM = /^(-?(0|[1-9]\d*)(\.\d*[1-9])?|-?\.\d*[1-9])$/;
/** Subscript collation: numbers (by value) first, then text (by character code). */
function collate(values: string[]): string[] {
    const uniq = Array.from(new Set(values));
    const nums = uniq.filter(v => CANON_NUM.test(v)).sort((a, b) => Number(a) - Number(b));
    const strs = uniq.filter(v => !CANON_NUM.test(v)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return nums.concat(strs);
}

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
    scanLimit?: number;     // most subscripts looked at (filters can scan a lot); default 200000
}

export const DEFAULT_SCAN_LIMIT = 200000;

// ---- the test applied to one subscript (variable v) by a filtered slot ----
function itemTest(v: string, it: Item): string {
    switch (it.type) {
        case 'n': return `(${v}=${numLit(it.value)})`;
        case 's': return `(${v}=${osString(it.value)})`;
        case 'starts': return `($e(${v},1,$l(${osString(it.value)}))=${osString(it.value)})`;
        case 'range': {
            const parts = [`(${v}=(+${v}))`];        // a number, not text
            if (it.lo !== null) parts.push(it.loInc ? `(${v}'<${numLit(it.lo)})` : `(${v}>${numLit(it.lo)})`);
            if (it.hi !== null) parts.push(it.hiInc ? `(${v}'>${numLit(it.hi)})` : `(${v}<${numLit(it.hi)})`);
            return '(' + parts.join('&&') + ')';
        }
    }
}
function slotTest(v: string, slot: Exclude<PatternSlot, null>): string {
    switch (slot.type) {
        case 'n': case 's': case 'starts': case 'range': return itemTest(v, slot);
        case 'neq': return `(${v}'=${slot.num ? numLit(slot.value) : osString(slot.value)})`;
        case 'contains': return `(${v}${slot.not ? "'" : ''}[${osString(slot.value)})`;
        case 'follows': return `(${v}${slot.not ? "'" : ''}]${osString(slot.value)})`;
        case 'match': return `(${v}${slot.not ? "'" : ''}?${slot.value})`;
        case 'list': return '(' + slot.items.map(it => itemTest(v, it)).join('||') + ')';
    }
}

/** The ObjectScript program (one string, not yet split into lines) for one watch. */
export function buildQueryProgram(p: Pattern, o: QueryOptions): string {
    const g = '^' + p.name;
    const K = p.slots.length;
    const scanLimit = Math.max(1, Math.floor(o.scanLimit ?? DEFAULT_SCAN_LIMIT));
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

    // Looking at a subscript counts towards the scan limit, so a filter that matches nothing cannot run for ever.
    const guard = `s zwy=zwy+1 i zwy>${scanLimit} { s zwt=2 q } `;
    const levels = (i: number): string => {
        if (i > K) {
            const node = `s zwn=$na(${ref(K)}) ${emit}`;
            return p.closed ? node : node + descend;
        }
        const slot = p.slots[i - 1];
        const v = 'zs' + i;
        if (slot && (slot.type === 'n' || slot.type === 's')) return `s ${v}=${osLiteral(slot)} i $d(${ref(i)}) { ${levels(i + 1)}} `;
        if (slot && slot.type === 'list' && slot.items.every(it => it.type === 'n' || it.type === 's')) {
            // only exact values: visit just those, in collation order
            const vals = collate(slot.items.map(it => (it as { value: string }).value)).map(x => (CANON_NUM.test(x) ? numLit(x) : osString(x)));
            return `s zwL${i}=$lb(${vals.join(',')}) f zwI${i}=1:1:$ll(zwL${i}) { q:zwt  s ${v}=$lg(zwL${i},zwI${i}) i $d(${ref(i)}) { ${levels(i + 1)}} } `;
        }
        if (!slot) return `s ${v}="" f { s ${v}=$o(${ref(i)}) q:${v}=""  q:zwt  ${guard}${levels(i + 1)}} `;

        // A filter: look at the subscripts of this level one by one. Numeric ranges and plain prefixes do not need
        // to look at all of them: start just before the range and stop as soon as it is over.
        let start = `s ${v}="" `;
        let stop = '';
        if (slot.type === 'range') {
            if (slot.lo !== null) start = `s ${v}=${numLit(slot.lo)} s ${v}=$o(${ref(i)},-1) `;
            stop = `q:'(${v}=(+${v}))  ` + (slot.hi !== null ? (slot.hiInc ? `q:(${v}>${numLit(slot.hi)})  ` : `q:(${v}'<${numLit(slot.hi)})  `) : '');
        } else if (slot.type === 'starts' && !/^[-+.0-9]/.test(slot.value)) {
            const t = osString(slot.value);
            start = `s ${v}=${t} s ${v}=$o(${ref(i)},-1) `;
            stop = `q:($e(${v},1,$l(${t}))'=${t})  `;
        }
        return `${start}f { s ${v}=$o(${ref(i)}) q:${v}=""  q:zwt  ${stop}${guard}i ${slotTest(v, slot)} { ${levels(i + 1)}} } `;
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
    return `s zwq=0,zwt=0,zwy=0 w ${marker(o.id, 'B')} try { ${zn}${body}w ${marker(o.id, 'E|')}_$s($d(${g}):1,1:0)_"|"_zwt } ` +
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
    scanLimit?: boolean;      // stopped after looking at the most subscripts allowed; the rows are partial
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
    return trunc === '2'
        ? { exists: exists === '1', truncated: false, scanLimit: true, rows }
        : { exists: exists === '1', truncated: trunc === '1', rows };
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
