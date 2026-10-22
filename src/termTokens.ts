// Finds the local variables and globals in a command line shown at the IRIS prompt ("USER>k x  set y=..."), so
// each one can be Ctrl+Clicked to see its current value (the extension types zw name / w ^global at the prompt).
//
// It reads ObjectScript the way a person skims it, not as a full parser: strings and comments are skipped; $functions,
// ##class(...), .Members after an object, labels after do / goto / job and routine references (label^rtn, $$^rtn,
// do ^rtn) are not variables; a name right after a command (set x, k x, w x) or after ( , = : operators, or a
// by-reference .name inside an argument list, is.

export interface CmdToken {
    start: number;      // index in the line as given (prompt included)
    length: number;
    kind: 'local' | 'global';
    ref: string;        // what to look at: outSearch, ^mtempTest("Customer","in")
}

const PROMPT = /^([A-Z0-9%_-]+(?:\s+\S+)?>)/i;

/** The prompt at the start of a line ("USER>", "USER 2d0>"), or undefined. */
export function promptOf(line: string): string | undefined {
    const m = PROMPT.exec(line);
    return m ? m[1] : undefined;
}

// Commands (full names and abbreviations). A word from this list at a command position is the command itself.
const COMMANDS = new Set([
    'b', 'break', 'c', 'close', 'catch', 'continue', 'd', 'do', 'e', 'else', 'elseif', 'f', 'for', 'g', 'goto', 'h', 'halt',
    'hang', 'i', 'if', 'j', 'job', 'k', 'kill', 'l', 'lock', 'm', 'merge', 'n', 'new', 'o', 'open', 'q', 'quit', 'r', 'read',
    'ret', 'return', 's', 'set', 'tc', 'tcommit', 'tro', 'trollback', 'ts', 'tstart', 'throw', 'try', 'u', 'use', 'v', 'view',
    'w', 'write', 'while', 'x', 'xecute', 'zw', 'zwrite', 'zk', 'zkill', 'zn', 'znspace', 'zzdump', 'zb', 'zbreak',
    'zl', 'zload', 'zp', 'zprint', 'zr', 'zremove', 'zs', 'zsave', 'zi', 'zinsert', 'zt', 'ztrap'
]);
// Their arguments are labels / routines, not variables.
const LABEL_COMMANDS = new Set(['d', 'do', 'g', 'goto', 'j', 'job']);
// Words in a dynamic object / array literal that are values, not variables.
const LITERAL_WORDS = new Set(['true', 'false', 'null']);
// Methods that may be part of a clickable chain (zw evaluates the chain, so only ones that change nothing).
const SAFE_CALLS = new Set(['%get', '%size', '%isdefined', '%gettypeof', '%tojson', '%classname', '%id']);

const isIdStart = (c: string) => /[A-Za-z%]/.test(c);
const isIdChar = (c: string) => /[A-Za-z0-9]/.test(c);

/** Index just after the ")" matching the "(" at `open` (strings inside skipped), or -1. */
function closeParen(s: string, open: number): number {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        const c = s[i];
        if (c === '"') { i++; while (i < s.length && !(s[i] === '"' && s[i + 1] !== '"')) { if (s[i] === '"') i++; i++; } continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
}

export function findCommandTokens(line: string): CmdToken[] {
    const prompt = promptOf(line);
    if (!prompt) return [];
    const out: CmdToken[] = [];
    // cmd: a command comes next. after: just read the command word. post: in its postcondition (s:x=1).
    // args: in its arguments; a space outside brackets ends them.
    let state: 'cmd' | 'after' | 'post' | 'args' = 'cmd';
    let lastCommand = '';
    let depth = 0;                  // ( { [ nesting: spaces inside a dynamic literal do not end the arguments
    let i = prompt.length;
    while (i < line.length && line[i] === ' ') i++;

    while (i < line.length) {
        const c = line[i];

        if (c === '"') {            // strings are skipped ("" inside is a quote)
            i++;
            while (i < line.length) { if (line[i] === '"') { if (line[i + 1] === '"') { i += 2; continue; } break; } i++; }
            i++;
            if (state === 'after') state = 'args';
            continue;
        }
        if (depth === 0 && (c === ';' || (c === '/' && line[i + 1] === '/'))) break;   // comment: rest of the line
        if (c === ' ') {
            let j = i; while (j < line.length && line[j] === ' ') j++;
            if (depth === 0) {
                if (state === 'after') state = (j - i === 1) ? 'args' : 'cmd';     // one space: arguments follow
                else if (state === 'post') state = (j - i === 1) ? 'args' : 'cmd';
                else if (state === 'args') state = 'cmd';
            }
            i = j; continue;
        }
        if (state === 'after' && c === ':') { state = 'post'; i++; continue; }
        if (c === '(' || c === '{' || c === '[') depth++;
        if ((c === ')' || c === '}' || c === ']') && depth > 0) depth--;

        // globals: ^name, ^["NS"]name, ^|"NS"|name, ^||name, with or without subscripts
        if (c === '^') {
            const before = line[i - 1] || '';
            let j = i + 1;
            if (line[j] === '[') { const k = line.indexOf(']', j); if (k < 0) { i++; continue; } j = k + 1; }
            else if (line[j] === '|') { const k = line.indexOf('|', j + 1); if (k < 0) { i++; continue; } j = k + 1; }
            if (!isIdStart(line[j] || '')) { i = j; continue; }
            j++;
            while (j < line.length && (isIdChar(line[j]) || line[j] === '.')) j++;
            const head = line.slice(0, i);
            const routine = isIdChar(before) || before === '%' || /\$\$$/.test(head) || /\$t(?:ext)?\($/i.test(head) || LABEL_COMMANDS.has(lastCommand);
            // A global's subscripts belong to it; a routine call's arguments are scanned on (they hold variables).
            if (!routine && line[j] === '(') { const k = closeParen(line, j); if (k > 0) j = k; }
            if (!routine) out.push({ start: i, length: j - i, kind: 'global', ref: line.slice(i, j) });
            if (state === 'after' || state === 'cmd') state = 'args';
            i = j; continue;
        }

        if (isIdStart(c)) {
            let j = i + 1;
            while (j < line.length && isIdChar(line[j])) j++;
            const word = line.slice(i, j);
            const before = line[i - 1] || '';
            const after = line[j] || '';
            if (state === 'cmd' && COMMANDS.has(word.toLowerCase())) {
                lastCommand = word.toLowerCase();
                state = 'after';
                i = j; continue;
            }
            if (state === 'cmd' || state === 'after') state = 'args';
            // ##class(Pkg.Cls): the class name is not a variable
            if (word.toLowerCase() === 'class' && before === '#' && after === '(') {
                const k = closeParen(line, j);
                i = k > 0 ? k : j; continue;
            }

            let isVar = true;
            if (before === '$' || before === '#') isVar = false;                       // $func, $zaccessor, ##class
            else if (before === '.') {
                const b2 = line[i - 2] || '';                                           // (.x  ,.x = by reference
                if (b2 !== '(' && b2 !== ',') isVar = false;                            // obj.Member
            }
            else if (isIdChar(before) || before === '^') isVar = false;
            if (after === '^' || after === '(') isVar = false;                          // label^rtn, f(), obj.M()
            if (LITERAL_WORDS.has(word)) isVar = false;
            if (LABEL_COMMANDS.has(lastCommand) && state !== 'post' && depth === 0) isVar = false;   // do Label
            if (isVar) {
                out.push({ start: i, length: j - i, kind: 'local', ref: word });
                // A property chain after it (out.data.list): each ".member" is a link of its own to the chain up to
                // there. Method calls end the chain - zw would run them - except read-only ones of dynamic entities
                // with literal arguments (%Get(0), %Size()).
                let k = j;
                while (line[k] === '.' && isIdStart(line[k + 1] || '')) {
                    let e = k + 2;
                    while (e < line.length && isIdChar(line[e])) e++;
                    const member = line.slice(k + 1, e);
                    if (line[e] === '(') {
                        const close = closeParen(line, e);
                        if (close < 0 || !SAFE_CALLS.has(member.toLowerCase())) break;
                        const args = line.slice(e + 1, close - 1).replace(/"(?:[^"]|"")*"/g, '');
                        if (!/^[\s\d.,+-]*$/.test(args)) break;
                        e = close;
                    }
                    out.push({ start: k, length: e - k, kind: 'local', ref: line.slice(i, e) });
                    k = e;
                }
                j = k;
            }
            i = j; continue;
        }

        if (/[0-9]/.test(c)) {
            let j = i + 1; while (j < line.length && /[0-9.E]/i.test(line[j])) j++;
            if (state === 'after') state = 'args';
            i = j; continue;
        }
        if (state === 'after') state = 'args';
        i++;
    }
    return out;
}
