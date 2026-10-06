// "Run in Terminal" for the label / function / method signature lines of ObjectScript files.
// Pure text work (no VS Code API). It finds the signature lines (for the CodeLens) and, for one of them, writes the
// ObjectScript that calls it. The result then goes through the normal "send to terminal" pipeline, which asks for the
// parameters (the Fill-in view), turns `..Method(` into `##class(Pkg.Class).Method(` and asks for an object when the
// method is an instance method.
//
//   routine  TestFunction(test)  returns a value   ->  set status=$$TestFunction^WBLRSHOWFF(test)
//   routine  TestLabel(test)     only a bare quit  ->  do TestLabel^WBLRSHOWFF(test)
//   class    ClassMethod getAllTables(ByRef out) As %Status  ->  set status=..getAllTables(.out)
//   class    ClassMethod Reset()                            ->  do ..Reset()
//
// A routine label is a function when its body has a `quit` / `return` that carries a value, otherwise a subroutine.

export interface Signature { line: number; kind: 'label' | 'classmethod' | 'method'; name: string }

export type Built = { ok: true; code: string } | { ok: false; error: string };

const LABEL_RE = /^([%A-Za-z][%A-Za-z0-9]*)(?=[\s(;/]|$)/;
const METHOD_RE = /^[ \t]*(ClassMethod|Method)[ \t]+([%A-Za-z][A-Za-z0-9%]*)/i;
const MAX_SIGNATURE_LINES = 40;

function splitLines(text: string): string[] { return text.split(/\r?\n/); }

function labelAt(line: string): string | undefined {
    const m = LABEL_RE.exec(line);
    if (!m) return undefined;
    if (m[1].toUpperCase() === 'ROUTINE') return undefined;
    return m[1];
}

/** Every label (routines) or Method / ClassMethod (classes) line - what gets a "Run in Terminal" lens. */
export function findSignatures(text: string, isClass: boolean): Signature[] {
    const out: Signature[] = [];
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isClass) {
            const m = METHOD_RE.exec(line);
            if (m) out.push({ line: i, kind: m[1].toLowerCase() === 'classmethod' ? 'classmethod' : 'method', name: m[2] });
        } else {
            const name = labelAt(line);
            if (name) out.push({ line: i, kind: 'label', name });
        }
    }
    return out;
}

/** Reads the (...) that starts at s[open]; returns its inside and what follows it. */
function balanced(s: string, open: number): { inside: string; rest: string } | undefined {
    let depth = 0;
    let inStr = false;
    for (let i = open; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (c === '"') { if (s[i + 1] === '"') i++; else inStr = false; }
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return { inside: s.slice(open + 1, i), rest: s.slice(i + 1) }; }
    }
    return undefined;
}

/** Splits at commas that are outside quotes and brackets. */
function splitTop(s: string): string[] {
    const out: string[] = [];
    let cur = '';
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            cur += c;
            if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else inStr = false; }
            continue;
        }
        if (c === '"') { inStr = true; cur += c; continue; }
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim() !== '' || out.length > 0) out.push(cur);
    return out.map(x => x.trim()).filter(x => x !== '');
}

/** The code of a line without string contents and comments (so a quit inside text or a comment is not seen). */
function codeOnly(line: string, state: { block: boolean }): string {
    let out = '';
    let inStr = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (state.block) {
            if (c === '*' && line[i + 1] === '/') { state.block = false; i++; }
            continue;
        }
        if (inStr) {
            if (c === '"') { if (line[i + 1] === '"') i++; else { inStr = false; out += '"'; } }
            continue;
        }
        if (c === '"') { inStr = true; out += '"'; continue; }
        if (c === ';' || (c === '/' && line[i + 1] === '/') || (c === '#' && line[i + 1] === ';')) break;
        if (c === '/' && line[i + 1] === '*') { state.block = true; i++; continue; }
        out += c;
    }
    return out;
}

// QUIT / RETURN followed by exactly one blank and then a value. (A bare quit followed by a command has two blanks.)
const VALUE_QUIT = /(?:^|[\s{};.)])(?:quit|q|return|ret)(?::\S*)?[ \t](?![ \t])(?=[^\s}])/i;

/** Does the body of the label that starts at lines[at] hand a value back? */
function returnsValue(lines: string[], at: number): boolean {
    const state = { block: false };
    for (let i = at + 1; i < lines.length; i++) {
        const raw = lines[i];
        if (!state.block && (labelAt(raw) !== undefined || /^\}/.test(raw))) break;      // next label / end of the procedure block
        if (VALUE_QUIT.test(codeOnly(raw, state))) return true;
    }
    return false;
}

function routineName(lines: string[], fileName: string): string | undefined {
    for (let i = 0; i < Math.min(lines.length, 25); i++) {
        const m = /^ROUTINE[ \t]+([%A-Za-z][A-Za-z0-9.%]*)/i.exec(lines[i]);
        if (m) return m[1];
    }
    const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(mac|int|inc|rtn)$/i, '');
    return /^[%A-Za-z][A-Za-z0-9.%]*$/.test(base) ? base : undefined;
}

/** The call arguments for a routine label's formal parameters: `Label(a,&out,*msg,b="x")` -> a, .out, .msg, b
 *  (& = by reference, * = output; both are passed with a leading dot). */
function routineParams(afterLabel: string): string[] | undefined {
    if (afterLabel[0] !== '(') return undefined;
    const b = balanced(afterLabel, 0);
    if (!b) return undefined;
    const args: string[] = [];
    for (const part of splitTop(b.inside)) {
        const m = /^([.&*])?[ \t]*([%A-Za-z][%A-Za-z0-9]*)(\.\.\.)?/.exec(part);
        if (m) args.push((m[1] ? '.' : '') + m[2] + (m[3] ?? ''));
    }
    return args;
}

/** The call arguments of a class method: ByRef / Output / InOut parameters are passed by reference (`.name`). */
function classArgs(inside: string): string[] {
    const args: string[] = [];
    for (const part of splitTop(inside)) {
        const m = /^(?:(ByRef|Output|InOut)[ \t]+)?([%A-Za-z][A-Za-z0-9%]*)(\.\.\.)?/i.exec(part);
        if (!m) continue;
        args.push((m[1] ? '.' : '') + m[2] + (m[3] ?? ''));
    }
    return args;
}

/** The ObjectScript that calls the label / method whose signature is on `line` (0-based). */
export function buildInvocation(text: string, line: number, isClass: boolean, fileName: string): Built {
    const lines = splitLines(text);
    const here = lines[line];
    if (here === undefined) return { ok: false, error: 'That line does not exist any more.' };

    if (isClass) {
        const m = METHOD_RE.exec(here);
        if (!m) return { ok: false, error: 'This line is not a Method / ClassMethod signature.' };
        // the signature may continue over several lines, up to the { that opens the body
        let sig = '';
        for (let i = line; i < Math.min(lines.length, line + MAX_SIGNATURE_LINES); i++) {
            sig += (i === line ? '' : ' ') + lines[i].trim();
            if (/\{\s*$/.test(lines[i]) || (i > line && /^\s*\{/.test(lines[i]))) break;
        }
        const open = sig.indexOf('(', m[0].trim().length);
        const b = open >= 0 ? balanced(sig, open) : undefined;
        if (!b) return { ok: false, error: 'Could not read the parameter list of this method.' };
        const args = classArgs(b.inside).join(',');
        const returns = /^\s*As\b/i.test(b.rest);
        return { ok: true, code: `${returns ? 'set status=' : 'do '}..${m[2]}(${args})` };
    }

    const label = labelAt(here);
    if (label === undefined) return { ok: false, error: 'This line is not a label.' };
    const routine = routineName(lines, fileName);
    if (routine === undefined) return { ok: false, error: 'Could not tell which routine this file is (no ROUTINE line and an unusable file name).' };
    const params = routineParams(here.slice(label.length));
    const args = params ? params.join(',') : '';
    if (returnsValue(lines, line)) return { ok: true, code: `set status=$$${label}^${routine}(${args})` };
    return { ok: true, code: params ? `do ${label}^${routine}(${args})` : `do ${label}^${routine}` };
}
