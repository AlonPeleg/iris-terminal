// Finds the global reference under the cursor (or in the selection) of one line of ObjectScript, for
// "Send to Global Watch". Pure text work - no VS Code API - so it can be tested on its own.
//
// What counts as a global:        ^mtemp   ^mtemp(1,"a")   ^["ACC"]mtemp(1)   ^|"ACC"|mtemp   ^%mtemp
// What does NOT (routine calls):  label^routine   label+3^routine   $$^routine   $$label^routine
//                                 do ^routine   d:cond ^routine   goto ^routine   job ^routine   $text(^routine)
// Process-private globals (^||x) are recognised but can't be watched from another connection.
//
// Subscripts are copied only when they are plain literals ("text", 12, -3.5). Anything else - variables,
// expressions, function calls - becomes an empty slot, i.e. "any value", so the pattern still makes sense.

import { NS_RE } from './patternSyntax';

export type GlobalRefResult =
    | { kind: 'global'; name: string; namespace?: string; text: string; notes: string[] }   // text: ^name(slots...) without the namespace
    | { kind: 'routine' }
    | { kind: 'private'; name: string }
    | { kind: 'none'; reason: 'nothing' | 'comment' };

interface Ref {
    start: number;        // index of the ^ (for routine references: the start of the label before it)
    caret: number;        // index of the ^
    end: number;          // one past the last character of the reference
    inComment: boolean;
    result: GlobalRefResult;
    nameStart?: number;   // globals only: index of the first letter of the name
    open?: number;        // globals only: index of the ( that starts the subscripts, or -1
}

const NAME_RE = /^%?[A-Za-z][A-Za-z0-9]*/;
const IDENT = /[A-Za-z0-9%.]/;
// before the ^ : "d ", "do ", "d:cond ", "goto ", "job ", also after a comma in "d ^a,^b"
const ROUTINE_CMD = /(?:^|[\s{};])(?:d|do|g|goto|j|job)(?::\S+)?[ \t]+(?:[^\s,]*,)*$/i;
const TEXT_FN = /\$t(?:ext)?\($/i;

/** Marks every character of the line as code, string or comment. */
function classify(line: string): ('c' | 's' | 'm')[] {
    const out: ('c' | 's' | 'm')[] = [];
    let inStr = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inStr) {
            out.push('s');
            if (ch === '"') {
                if (line[i + 1] === '"') { out.push('s'); i++; } else inStr = false;
            }
            continue;
        }
        if (ch === '"') { inStr = true; out.push('s'); continue; }
        if (ch === ';' || (ch === '/' && line[i + 1] === '/') || (ch === '#' && line[i + 1] === ';')) {
            while (out.length < line.length) out.push('m');
            break;
        }
        if (ch === '/' && line[i + 1] === '*') {
            const close = line.indexOf('*/', i + 2);
            const stop = close < 0 ? line.length : close + 2;
            while (out.length < stop) out.push('m');
            i = stop - 1;
            continue;
        }
        out.push('c');
    }
    return out;
}

/** Reads the (…) argument list that starts at line[open] === '('. Returns the top-level pieces and whether it was closed. */
function readArgs(line: string, open: number): { slots: string[]; closed: boolean; end: number } {
    const slots: string[] = [];
    let cur = '';
    let inStr = false;
    let depth = 0;
    for (let i = open + 1; i < line.length; i++) {
        const ch = line[i];
        if (inStr) {
            cur += ch;
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; } else inStr = false;
            }
            continue;
        }
        if (ch === '"') { inStr = true; cur += ch; continue; }
        if (ch === '(') { depth++; cur += ch; continue; }
        if (ch === ')') {
            if (depth === 0) { slots.push(cur); return { slots, closed: true, end: i + 1 }; }
            depth--; cur += ch; continue;
        }
        if (ch === ',' && depth === 0) { slots.push(cur); cur = ''; continue; }
        cur += ch;
    }
    slots.push(cur);
    return { slots, closed: false, end: line.length };
}

/** A literal subscript is kept, everything else becomes "any value". */
function literalSlot(raw: string): string | null {
    const s = raw.trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    if (/^"(?:[^"]|"")*"$/.test(s)) return s;
    return null;
}

/** Literal subscripts stay, everything else becomes an empty slot (any value). */
function keepSlots(slots: string[], notes: string[]): string[] {
    return slots.map(raw => {
        const lit = literalSlot(raw);
        if (lit === null && raw.trim() !== '') notes.push('"' + raw.trim() + '" became an empty slot (any value)');
        return lit === null ? '' : lit;
    });
}

function namespaceOf(inner: string, notes: string[]): string | undefined {
    const m = /^\s*"([^"]*)"\s*$/.exec(inner);
    if (m && NS_RE.test(m[1])) return m[1];
    notes.push('the namespace in the reference is not a plain "NAME" (' + inner.trim() + ') - using the editor\'s namespace');
    return undefined;
}

function scan(line: string): Ref[] {
    const mask = classify(line);
    const refs: Ref[] = [];
    for (let i = 0; i < line.length; i++) {
        if (line[i] !== '^') continue;
        const caret = i;
        const before = line.slice(0, caret);
        const prev = caret > 0 ? line[caret - 1] : '';
        const inComment = mask[caret] === 'm';

        // process-private ^||name
        if (line[caret + 1] === '|' && line[caret + 2] === '|') {
            const nm = NAME_RE.exec(line.slice(caret + 3));
            if (nm) {
                const end = caret + 3 + nm[0].length;
                refs.push({ start: caret, caret, end, inComment, result: { kind: 'private', name: nm[0] } });
                i = end - 1;
            }
            continue;
        }

        // routine references: label^routine, $$^routine, do ^routine, $text(^routine)
        const isRoutineCtx = (prev !== '' && (IDENT.test(prev) || prev === '$')) || ROUTINE_CMD.test(before) || TEXT_FN.test(before);

        // optional extended reference: ^["NS"]name  or  ^|"NS"|name
        let pos = caret + 1;
        let nsInner: string | undefined;
        if (line[pos] === '[') {
            const close = line.indexOf(']', pos);
            if (close > 0) { nsInner = line.slice(pos + 1, close); pos = close + 1; }
        } else if (line[pos] === '|') {
            const close = line.indexOf('|', pos + 1);
            if (close > 0) { nsInner = line.slice(pos + 1, close); pos = close + 1; }
        }
        const nm = NAME_RE.exec(line.slice(pos));
        if (!nm) continue;
        let end = pos + nm[0].length;

        // a name followed by .something is a routine / class name, never a global
        const dotted = line[end] === '.' && /[A-Za-z0-9]/.test(line[end + 1] || '');
        if (isRoutineCtx || dotted) {
            let start = caret;
            while (start > 0 && IDENT.test(line[start - 1])) start--;      // include the label so a selection of it still hits
            while (end < line.length && /[A-Za-z0-9%.]/.test(line[end])) end++;      // My.Routine.Name
            if (line[end] === '(') end = readArgs(line, end).end;
            refs.push({ start, caret, end, inComment, result: { kind: 'routine' } });
            i = end - 1;
            continue;
        }

        const notes: string[] = [];
        const namespace = nsInner !== undefined ? namespaceOf(nsInner, notes) : undefined;
        let text = '^' + nm[0];
        const open = line[end] === '(' ? end : -1;
        if (open >= 0) {
            const a = readArgs(line, open);
            text += '(' + keepSlots(a.slots, notes).join(',') + (a.closed ? ')' : '');
            end = a.end;
        }
        const result: GlobalRefResult = namespace !== undefined
            ? { kind: 'global', name: nm[0], namespace, text, notes }
            : { kind: 'global', name: nm[0], text, notes };
        refs.push({ start: caret, caret, end, inComment, result, nameStart: pos, open });
        // keep scanning inside the arguments: ^a($order(^b(1))) holds two references
    }
    return refs;
}

/**
 * line: the text of the line; from/to: the selection on that line (equal = just a cursor).
 *
 *  - cursor inside a reference (or right at its end): that reference (the innermost one if they are nested)
 *  - a selection touching a reference: that reference
 *  - a selected bare name (double-click gives "mtemp" without the ^): treated as ^mtemp, never ^^mtemp
 */
export function findGlobalReference(line: string, from: number, to: number): GlobalRefResult {
    const a = Math.max(0, Math.min(from, to));
    const b = Math.min(line.length, Math.max(from, to));
    const refs = scan(line);
    const hasSelection = b > a;

    const hits = refs.filter(r => hasSelection ? (a < r.end && b > r.start) : (a >= r.start && a <= r.end));
    if (hits.length > 0) {
        hits.sort((x, y) => (x.end - x.start) - (y.end - y.start));      // innermost first
        const h = hits[0];
        if (!hasSelection && h.inComment) return { kind: 'none', reason: 'comment' };
        // What you select is what you get, as long as the selection starts at the reference (^ or the name):
        //   ^g          ->  ^g                 (just the global)
        //   ^g(         ->  ^g(                (the same, spelled with the paren)
        //   ^g("a","b", ->  ^g("a","b",        (the node's children, not the node itself)
        // With only the cursor in it, the whole reference is used. A selection that is just a piece of the name or sits
        // inside the subscripts cannot be a global on its own, so it also falls back to the whole reference.
        if (hasSelection && h.result.kind === 'global' && h.nameStart !== undefined && h.open !== undefined) {
            const nameEnd = h.nameStart + h.result.name.length;
            if (a <= h.nameStart && b >= nameEnd && b < h.end) {
                const notes: string[] = [];
                let text = '^' + h.result.name;
                if (h.open >= 0 && b > h.open) {
                    const part = readArgs(line.slice(0, b), h.open);
                    text += '(' + keepSlots(part.slots, notes).join(',');
                }
                return h.result.namespace !== undefined
                    ? { kind: 'global', name: h.result.name, namespace: h.result.namespace, text, notes }
                    : { kind: 'global', name: h.result.name, text, notes };
            }
        }
        return h.result;
    }

    if (hasSelection) {
        const sel = line.slice(a, b).trim();
        const nm = /^\^?(%?[A-Za-z][A-Za-z0-9]*)$/.exec(sel);
        if (nm) return { kind: 'global', name: nm[1], text: '^' + nm[1], notes: [] };
        // a selected bare reference with subscripts: mtemp(1,"a")  (nothing else on the line points at it)
        const withSubs = /^\^?%?[A-Za-z][A-Za-z0-9]*\(/.exec(sel);
        if (withSubs) {
            const sub = scan(sel.startsWith('^') ? sel : '^' + sel);
            if (sub.length > 0 && sub[0].result.kind === 'global') return sub[0].result;
        }
    }
    return { kind: 'none', reason: 'nothing' };
}
