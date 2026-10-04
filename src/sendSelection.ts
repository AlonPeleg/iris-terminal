// Pure logic (no `vscode` import) for "Send Selection to IRIS Terminal".
//
// Pipeline:  tokenize -> split into statements -> find the "slots" the user may want to fill in
// (variables, by-reference args, unknown macros, instance-relative refs) -> apply answers ->
// flatten to a single terminal line.
//
// It is a heuristic ObjectScript reader, not a compiler: it knows command abbreviations, string
// literals, comments, brace blocks vs. object literals, and what a command assigns, which is what
// is needed to decide "does this name need a value before the code can run at a terminal prompt?".

export type SlotKind = 'variable' | 'byref' | 'macro' | 'relative';

export interface Edit { start: number; end: number; replacement: string; }

export interface Occurrence {
    start: number;
    end: number;
    text: string;
    kind: SlotKind;
    /** true when the name is the root of `obj.Method(` (only the part before the method is replaced) */
    callRoot: boolean;
    /** true when it sits alone between '(' / ',' and ',' / ')' (a call argument position) */
    argSlot: boolean;
}

export interface Slot {
    key: string;
    kind: SlotKind;
    text: string;
    occurrences: Occurrence[];
    argSlot: boolean;
}

/** A later read of a name that a by-reference argument defines (`.out` ... `out.data`): not asked, renamed along with the argument. */
export interface Dependent { slotKey: string; start: number; end: number; name: string; }

/** A use of the current object (`..Method(`, `..Property`, `$this`) that needs an instance to run at the terminal. */
export interface ObjectRef { start: number; end: number; text: string; /** what follows the object: `Method`, `Prop.Sub`, or '' for a bare $this */ rest: string; }

/** What the editor's class file says: its name and which methods are ClassMethods / instance Methods. */
export interface ClassContext { className: string; classMethods: Set<string>; instanceMethods: Set<string>; }

export interface Analysis {
    slots: Slot[];
    /** `..Name` / `$this` uses that need an object (only when the class is known) */
    objectRefs: ObjectRef[];
    className?: string;
    /** reads of a variable that a by-reference argument fills in; they follow the argument if it is renamed */
    dependents: Dependent[];
    /** universal macros ($$$OK, $$$ISOK, $$$ISERR) translated without asking */
    autoEdits: Edit[];
}

/** Macros that are the same everywhere (defined in the system include files); translated silently. */
export const AUTO_MACROS: Record<string, string> = {
    ok: '1',
    isok: '$system.Status.IsOK',
    iserr: '$system.Status.IsError'
};

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

export type TokType = 'ws' | 'str' | 'comment' | 'num' | 'word' | 'rel' | 'byref' | 'macro' | 'automacro' | 'skip' | 'p';

export interface Tok {
    type: TokType;
    start: number;
    end: number;
    text: string;
    nl?: boolean;
    parts?: string[];
}

const ID_START = /[A-Za-z%]/;
const ID_PART = /[A-Za-z0-9%]/;
const DIGIT = /[0-9]/;

export function tokenize(src: string): Tok[] {
    const toks: Tok[] = [];
    const n = src.length;
    let i = 0;

    const push = (type: TokType, start: number, end: number, extra?: Partial<Tok>) => {
        toks.push({ type, start, end, text: src.slice(start, end), ...extra });
    };
    const eol = (from: number): number => {
        let k = from;
        while (k < n && src[k] !== '\n' && src[k] !== '\r') k++;
        return k;
    };
    const atLineStart = (pos: number): boolean => {
        let k = pos - 1;
        while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k--;
        return k < 0 || src[k] === '\n' || src[k] === '\r';
    };
    const readIdent = (pos: number): number => {
        let k = pos;
        if (k < n && ID_START.test(src[k])) {
            k++;
            while (k < n && ID_PART.test(src[k])) k++;
        }
        return k;
    };
    const readDotted = (pos: number): number => {
        let k = readIdent(pos);
        while (k < n && src[k] === '.' && k + 1 < n && ID_START.test(src[k + 1])) k = readIdent(k + 1);
        return k;
    };
    // index just after the ')' matching the '(' at `open`, or -1
    const matchParen = (open: number): number => {
        let depth = 0;
        let k = open;
        while (k < n) {
            const c = src[k];
            if (c === '"') {
                k++;
                while (k < n) {
                    if (src[k] === '"') {
                        if (src[k + 1] === '"') { k += 2; continue; }
                        break;
                    }
                    k++;
                }
                k++;
                continue;
            }
            if (c === '(') depth++;
            else if (c === ')') { depth--; if (depth === 0) return k + 1; }
            k++;
        }
        return -1;
    };
    const prevNonSpace = (pos: number): string => {
        let k = pos - 1;
        while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k--;
        return k >= 0 ? src[k] : '';
    };

    while (i < n) {
        const c = src[i];

        // whitespace
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
            let j = i;
            let nl = false;
            while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r' || src[j] === '\n')) {
                if (src[j] === '\n' || src[j] === '\r') nl = true;
                j++;
            }
            push('ws', i, j, { nl });
            i = j;
            continue;
        }

        // comments: ; ... // ... /* ... */ and preprocessor lines (#dim, #define, #include, #; ...)
        if (c === ';' || (c === '/' && src[i + 1] === '/')) {
            const j = eol(i);
            push('comment', i, j);
            i = j;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const e = src.indexOf('*/', i + 2);
            const j = e < 0 ? n : e + 2;
            push('comment', i, j);
            i = j;
            continue;
        }
        if (c === '#' && src[i + 1] !== '#' && /[A-Za-z;]/.test(src[i + 1] || '') && atLineStart(i)) {
            const j = eol(i);
            push('comment', i, j);
            i = j;
            continue;
        }

        // string literal ("" is an escaped quote)
        if (c === '"') {
            let j = i + 1;
            while (j < n) {
                if (src[j] === '"') {
                    if (src[j + 1] === '"') { j += 2; continue; }
                    break;
                }
                j++;
            }
            const end = Math.min(j + 1, n);
            push('str', i, end);
            i = end;
            continue;
        }

        // $$$Macro, $$extrinsic, $function / $specialvar / $this
        if (c === '$') {
            if (src.startsWith('$$$', i)) {
                let j = i + 3;
                while (j < n && /[A-Za-z0-9_%]/.test(src[j])) j++;
                if (j > i + 3) {
                    const name = src.slice(i + 3, j).toLowerCase();
                    if (Object.prototype.hasOwnProperty.call(AUTO_MACROS, name)) {
                        push('automacro', i, j);
                        i = j;
                        continue;
                    }
                    let end = j;
                    if (src[j] === '(') {
                        const m = matchParen(j);
                        if (m > 0) end = m;
                    }
                    push('macro', i, end);
                    i = end;
                    continue;
                }
                push('p', i, i + 1);
                i++;
                continue;
            }
            if (src[i + 1] === '$') {
                let j = i + 2;
                if (src[j] === '^') {
                    j = readDotted(j + 1);
                } else {
                    j = readIdent(j);
                    if (src[j] === '^') j = readDotted(j + 1);
                }
                push('skip', i, Math.max(j, i + 2));
                i = Math.max(j, i + 2);
                continue;
            }
            let j = i + 1;
            while (j < n && /[A-Za-z]/.test(src[j])) j++;
            if (j > i + 1) {
                const name = src.slice(i + 1, j).toLowerCase();
                let k = j;
                while (k < n && src[k] === '.' && k + 1 < n && ID_START.test(src[k + 1])) k = readIdent(k + 1);
                push(name === 'this' ? 'rel' : 'skip', i, k);
                i = k;
                continue;
            }
            push('p', i, i + 1);
            i++;
            continue;
        }

        // ##class(Pkg.Name) and other ## keywords
        if (c === '#' && src[i + 1] === '#') {
            let j = i + 2;
            while (j < n && /[A-Za-z]/.test(src[j])) j++;
            if (j > i + 2) {
                let end = j;
                if (src.slice(i + 2, j).toLowerCase() === 'class' && src[j] === '(') {
                    const m = matchParen(j);
                    if (m > 0) end = m;
                }
                push('skip', i, end);
                i = end;
                continue;
            }
            push('p', i, i + 1);
            i++;
            continue;
        }

        // global reference: ^Name, ^["ns"]Name, ^|"ns"|Name, ^$ROUTINE
        if (c === '^') {
            let j = i + 1;
            if (src[j] === '$') {
                j++;
                while (j < n && /[A-Za-z]/.test(src[j])) j++;
                push('skip', i, j);
                i = j;
                continue;
            }
            if (src[j] === '[') {
                const e = src.indexOf(']', j);
                if (e > 0) j = e + 1;
            } else if (src[j] === '|') {
                const e = src.indexOf('|', j + 1);
                if (e > 0) j = e + 1;
            }
            let k = j;
            if (k < n && ID_START.test(src[k])) {
                k++;
                while (k < n && (ID_PART.test(src[k]) || (src[k] === '.' && k + 1 < n && ID_START.test(src[k + 1])))) k++;
            }
            if (k > i + 1) {
                push('skip', i, k);
                i = k;
                continue;
            }
            push('p', i, i + 1);
            i++;
            continue;
        }

        // pattern match / write tab: ?1.N, ?3A1"-"3N, ?10
        if (c === '?') {
            let j = i + 1;
            while (j < n) {
                if (/[0-9A-Za-z.]/.test(src[j])) { j++; continue; }
                if (src[j] === '"') {
                    j++;
                    while (j < n) {
                        if (src[j] === '"') {
                            if (src[j + 1] === '"') { j += 2; continue; }
                            break;
                        }
                        j++;
                    }
                    j++;
                    continue;
                }
                if (src[j] === '(') {
                    const m = matchParen(j);
                    if (m > 0) { j = m; continue; }
                }
                break;
            }
            push('skip', i, Math.min(j, n));
            i = Math.min(j, n);
            continue;
        }

        // number (also .5)
        if (DIGIT.test(c) || (c === '.' && DIGIT.test(src[i + 1] || '') && !/[A-Za-z0-9%)\]}"]/.test(src[i - 1] || ''))) {
            let j = i;
            while (j < n && DIGIT.test(src[j])) j++;
            if (src[j] === '.' && DIGIT.test(src[j + 1] || '')) {
                j++;
                while (j < n && DIGIT.test(src[j])) j++;
            }
            if ((src[j] === 'E' || src[j] === 'e') && (DIGIT.test(src[j + 1] || '') || ((src[j + 1] === '+' || src[j + 1] === '-') && DIGIT.test(src[j + 2] || '')))) {
                j += 2;
                while (j < n && DIGIT.test(src[j])) j++;
            }
            push('num', i, j);
            i = j;
            continue;
        }

        // names: variable, property chain a.b.c, label^routine
        if (ID_START.test(c)) {
            const end = readDotted(i);
            if (src[end] === '^' && ID_START.test(src[end + 1] || '')) {
                const e2 = readDotted(end + 1);
                push('skip', i, e2);
                i = e2;
                continue;
            }
            push('word', i, end, { parts: src.slice(i, end).split('.') });
            i = end;
            continue;
        }

        // dots: ..Relative, .byRef, .member after ) ] } "
        if (c === '.') {
            if (src[i + 1] === '.' && ID_START.test(src[i + 2] || '')) {
                const e = readDotted(i + 2);
                push('rel', i, e);
                i = e;
                continue;
            }
            if (ID_START.test(src[i + 1] || '')) {
                const prev = src[i - 1] || '';
                if (prev === ')' || prev === ']' || prev === '}' || prev === '"') {
                    const e = readDotted(i + 1);
                    push('skip', i, e);
                    i = e;
                    continue;
                }
                const ps = prevNonSpace(i);
                if (ps === '(' || ps === ',') {
                    const e = readIdent(i + 1);
                    push('byref', i, e);
                    i = e;
                    continue;
                }
            }
            push('p', i, i + 1);
            i++;
            continue;
        }

        // anything else: single punctuation character
        push('p', i, i + 1);
        i++;
    }
    return toks;
}

// ---------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------

// ObjectScript commands incl. abbreviations (case-insensitive) -> normalized name.
const COMMANDS: Record<string, string> = {
    b: 'break', break: 'break',
    c: 'close', close: 'close',
    catch: 'catch', continue: 'continue',
    d: 'do', do: 'do',
    e: 'else', else: 'else', elseif: 'elseif',
    f: 'for', for: 'for', finally: 'finally',
    g: 'goto', goto: 'goto',
    h: 'hang', halt: 'halt', hang: 'hang',
    i: 'if', if: 'if',
    j: 'job', job: 'job',
    k: 'kill', kill: 'kill',
    l: 'lock', lock: 'lock',
    m: 'merge', merge: 'merge',
    n: 'new', new: 'new',
    o: 'open', open: 'open',
    p: 'print', print: 'print',
    q: 'quit', quit: 'quit',
    r: 'read', read: 'read',
    return: 'return',
    s: 'set', set: 'set',
    throw: 'throw', try: 'try',
    tc: 'tcommit', tcommit: 'tcommit',
    tro: 'trollback', trollback: 'trollback',
    ts: 'tstart', tstart: 'tstart',
    u: 'use', use: 'use',
    v: 'view', view: 'view',
    w: 'write', write: 'write',
    while: 'while',
    x: 'xecute', xecute: 'xecute',
    zb: 'zbreak', zbreak: 'zbreak',
    zk: 'zkill', zkill: 'zkill',
    zn: 'znspace', znspace: 'znspace',
    zp: 'zprint', zprint: 'zprint',
    zt: 'ztrap', ztrap: 'ztrap',
    zw: 'zwrite', zwrite: 'zwrite'
};

// commands that never take arguments (the next word is always a new statement)
const NO_ARG_CMDS = new Set(['else', 'try', 'continue', 'finally']);
// commands that can open a block directly: `else {`, `try {`, `do {`, `for {`, `catch {`
const BLOCK_CMDS = new Set(['else', 'try', 'do', 'for', 'catch', 'finally']);

interface Stmt { cmd: string | null; post: Tok[]; args: Tok[]; }

const isSig = (t: Tok) => t.type !== 'ws' && t.type !== 'comment';
const isP = (t: Tok | undefined, ch: string) => t !== undefined && t.type === 'p' && t.text === ch;

function commandOf(t: Tok): string | undefined {
    if (t.type !== 'word' || !t.parts || t.parts.length !== 1) return undefined;
    return COMMANDS[t.text.toLowerCase()];
}

function splitStatements(toks: Tok[]): Stmt[] {
    const stmts: Stmt[] = [];
    let cur: Stmt | null = null;
    const stack: string[] = [];             // '(' '[' '{obj' '{block'
    const openCount = () => stack.filter(s => s !== '{block').length;
    let atStart = true;
    let afterOperand = false;
    let inPost = false;
    let justCmd = false;
    let lastWsLen = 0;

    const startStmt = (cmd: string | null) => {
        cur = { cmd, post: [], args: [] };
        stmts.push(cur);
    };
    const argsEmpty = (s: Stmt) => s.args.every(a => a.type === 'ws');

    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.type === 'comment') continue;
        const depth = openCount();

        if (t.type === 'ws') {
            justCmd = false;
            if (depth === 0 && t.nl) {
                atStart = true; afterOperand = false; cur = null; inPost = false; lastWsLen = 0;
                continue;
            }
            if (depth === 0) inPost = false;
            lastWsLen = t.nl ? 2 : t.text.length;
            if (cur) (cur as Stmt).args.push(t);
            continue;
        }

        const wasJustCmd = justCmd;
        justCmd = false;
        const cmdName = commandOf(t);

        if (atStart) {
            if (isP(t, '.')) continue;                                   // dot-block prefix
            if (isP(t, '}')) { if (stack[stack.length - 1] === '{block') stack.pop(); continue; }
            if (isP(t, '{')) { stack.push('{block'); continue; }
            if (cmdName) {
                startStmt(cmdName);
                atStart = false; afterOperand = false; justCmd = true; lastWsLen = 0;
                continue;
            }
            startStmt(null);
            atStart = false; afterOperand = false;
            // fall through: this token is the first part of an expression statement
        } else if (cur && cmdName && depth === 0) {
            const c = cur as Stmt;
            const noArgs = c.cmd !== null && argsEmpty(c) && !inPost && (NO_ARG_CMDS.has(c.cmd) || lastWsLen >= 2);
            if (afterOperand || noArgs) {
                startStmt(cmdName);
                afterOperand = false; justCmd = true; lastWsLen = 0;
                continue;
            }
        }

        const c = cur as Stmt | null;
        if (!c) continue;

        // postcondition: `cmd:expr`
        if (wasJustCmd && isP(t, ':') && c.cmd !== null) { inPost = true; continue; }

        const target = inPost ? c.post : c.args;
        let consumed = false;

        if (t.type === 'p') {
            switch (t.text) {
                case '(': stack.push('('); afterOperand = false; break;
                case ')': if (stack[stack.length - 1] === '(') stack.pop(); afterOperand = true; break;
                case '[':
                    if (afterOperand) afterOperand = false;                // contains operator
                    else stack.push('[');                                  // array literal
                    break;
                case ']':
                    if (stack[stack.length - 1] === '[') { stack.pop(); afterOperand = true; }
                    else afterOperand = false;                             // follows operator
                    break;
                case '{': {
                    const blockStart = depth === 0 &&
                        (afterOperand || (c.cmd !== null && BLOCK_CMDS.has(c.cmd) && argsEmpty(c)));
                    if (blockStart) {
                        stack.push('{block');
                        cur = null; atStart = true; afterOperand = false; inPost = false;
                        consumed = true;
                    } else {
                        stack.push('{obj');
                        afterOperand = false;
                    }
                    break;
                }
                case '}':
                    if (stack[stack.length - 1] === '{obj') {
                        stack.pop(); afterOperand = true;
                    } else {
                        if (stack[stack.length - 1] === '{block') stack.pop();
                        cur = null; atStart = true; afterOperand = false; inPost = false;
                        consumed = true;
                    }
                    break;
                case '!': case '#':
                    afterOperand = depth === 0 && (c.cmd === 'write' || c.cmd === 'read');
                    break;
                default: afterOperand = false;
            }
        } else {
            afterOperand = true;
        }
        if (!consumed) target.push(t);
    }
    return stmts;
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

interface RawOcc { start: number; end: number; text: string; kind: SlotKind; callRoot: boolean; }
interface Ctx { assigned: Set<string>; occs: RawOcc[]; autos: Edit[]; byref: Map<string, string>; deps: Dependent[]; cls?: ClassContext; objRefs: ObjectRef[]; }

// Depth-aware walk over argument tokens. `[` after an operand is the "contains" operator, not a bracket.
function scanDepth(a: Tok[], visit: (t: Tok, i: number, depth: number) => void) {
    const stack: string[] = [];
    let afterOperand = false;
    for (let i = 0; i < a.length; i++) {
        const t = a[i];
        if (!isSig(t)) continue;
        visit(t, i, stack.length);
        if (t.type === 'p') {
            if (t.text === '(') { stack.push('('); afterOperand = false; }
            else if (t.text === '{') { stack.push('{'); afterOperand = false; }
            else if (t.text === '[') { if (afterOperand) afterOperand = false; else stack.push('['); }
            else if (t.text === ')') { if (stack[stack.length - 1] === '(') stack.pop(); afterOperand = true; }
            else if (t.text === '}') { if (stack[stack.length - 1] === '{') stack.pop(); afterOperand = true; }
            else if (t.text === ']') { if (stack[stack.length - 1] === '[') { stack.pop(); afterOperand = true; } else afterOperand = false; }
            else afterOperand = false;
        } else {
            afterOperand = true;
        }
    }
}

function splitTop(a: Tok[], sep: string): Tok[][] {
    const cuts: number[] = [];
    scanDepth(a, (t, i, depth) => { if (depth === 0 && isP(t, sep)) cuts.push(i); });
    const out: Tok[][] = [];
    let from = 0;
    for (const c of cuts) { out.push(a.slice(from, c)); from = c + 1; }
    out.push(a.slice(from));
    return out;
}

function findTop(a: Tok[], sep: string): number {
    let r = -1;
    scanDepth(a, (t, i, depth) => { if (r < 0 && depth === 0 && isP(t, sep)) r = i; });
    return r;
}

function findMatching(a: Tok[], openIdx: number): number {
    let d = 0;
    for (let i = openIdx; i < a.length; i++) {
        const t = a[i];
        if (t.type === 'p') {
            if (t.text === '(') d++;
            else if (t.text === ')') { d--; if (d === 0) return i; }
        }
    }
    return -1;
}

// ---------------------------------------------------------------------------------------------
// Class context: `..Method(` / `..Property` / `$this`
// ---------------------------------------------------------------------------------------------

// ClassMethods every persistent / registered class inherits; other %-methods (%Save, %Id, ...) need an instance.
const PERCENT_CLASS_METHODS = new Set(['%new', '%openid', '%open', '%existsid', '%exists', '%deleteid', '%deleteextent',
    '%killextent', '%buildindices', '%purgeindices', '%sortbegin', '%sortend', '%buildindices']);

/** Reads the class name and its ClassMethod / Method declarations from the text of a class file. */
export function parseClassContext(docText: string): ClassContext | undefined {
    const cm = /^[ \t]*Class[ \t]+([%A-Za-z][A-Za-z0-9_.%]*)/im.exec(docText);
    if (!cm) return undefined;
    const classMethods = new Set<string>();
    const instanceMethods = new Set<string>();
    const re = /^[ \t]*(ClassMethod|Method)[ \t]+(?:"([^"\r\n]+)"|([%A-Za-z][A-Za-z0-9%]*))/gim;
    for (let m = re.exec(docText); m; m = re.exec(docText)) {
        const name = (m[2] ?? m[3]).toLowerCase();
        (m[1].toLowerCase() === 'classmethod' ? classMethods : instanceMethods).add(name);
    }
    return { className: cm[1], classMethods, instanceMethods };
}

function isClassMethodCall(cls: ClassContext, name: string): boolean {
    const n = name.toLowerCase();
    if (cls.classMethods.has(n)) return true;
    if (cls.instanceMethods.has(n)) return false;
    if (n.startsWith('%')) return PERCENT_CLASS_METHODS.has(n);
    return true;                      // not declared here (inherited): assume a class method
}

// `..Name(` -> `##class(Cls).Name(` for class methods; anything else that needs the current object is
// recorded, to be replaced once the user says which object to use.
function relRef(ctx: Ctx, t: Tok, isCall: boolean): boolean {
    const cls = ctx.cls;
    if (!cls) return false;
    if (t.text.startsWith('..')) {
        const rest = t.text.slice(2);
        if (isCall && !rest.includes('.') && isClassMethodCall(cls, rest)) {
            ctx.autos.push({ start: t.start, end: t.end, replacement: `##class(${cls.className}).${rest}` });
            return true;
        }
        ctx.objRefs.push({ start: t.start, end: t.end, text: t.text, rest });
        return true;
    }
    ctx.objRefs.push({ start: t.start, end: t.end, text: t.text, rest: t.text.slice(5).replace(/^\./, '') });   // $this[.x]
    return true;
}

function addOcc(ctx: Ctx, tok: Tok, text: string, kind: SlotKind, callRoot = false) {
    ctx.occs.push({ start: tok.start, end: tok.start + text.length, text, kind, callRoot });
}

// `obj.Method(0).Prop` where every call has only literal arguments (numbers, strings): the whole chain is
// one value, so it can be replaced as a whole (`5`). Returns the index of its last token, or -1 when some
// argument is not a literal (the variables inside are asked on their own, so only the object part is).
function literalChainEnd(a: Tok[], j: number): number {
    let last = j;
    for (;;) {
        let open = last + 1;
        while (open < a.length && !isSig(a[open])) open++;
        if (!isP(a[open], '(') || open !== last + 1) break;           // a call must follow directly
        const close = findMatching(a, open);
        if (close < 0) return -1;
        for (let m = open + 1; m < close; m++) {
            const x = a[m];
            if (!isSig(x)) continue;
            const literal = x.type === 'num' || x.type === 'str' || (x.type === 'p' && (x.text === ',' || x.text === '-'));
            if (!literal) return -1;
        }
        last = close;
        const next = a[last + 1];
        if (next && next.type === 'skip' && next.text.startsWith('.') && next.start === a[last].end) last++;   // .Member
        else break;
        if (!isP(a[last + 1], '(')) break;                            // .Member( -> another call
    }
    return last;
}

function analyzeExpr(a: Tok[], ctx: Ctx, labelFirst = false) {
    let first = true;
    for (let j = 0; j < a.length; j++) {
        const t = a[j];
        if (!isSig(t)) continue;
        const isFirst = first;
        first = false;
        switch (t.type) {
            case 'automacro':
                ctx.autos.push({ start: t.start, end: t.end, replacement: AUTO_MACROS[t.text.slice(3).toLowerCase()] });
                break;
            case 'macro': addOcc(ctx, t, t.text, 'macro'); break;
            case 'rel':
                if (!relRef(ctx, t, isP(a[j + 1], '('))) addOcc(ctx, t, t.text, 'relative');
                break;
            case 'byref': {
                addOcc(ctx, t, t.text, 'byref');
                // a by-reference argument is (normally) filled in by the call: later reads of that name are not asked
                const name = t.text.slice(1);
                ctx.assigned.add(name);
                if (!ctx.byref.has(name)) ctx.byref.set(name, `byref:${t.text}`);
                break;
            }
            case 'word': {
                const parts = t.parts!;
                const isCall = isP(a[j + 1], '(');
                // `do label` / `do label(args)` : the first name is an entry point, not a variable
                if (labelFirst && isFirst && parts.length === 1) break;
                if (ctx.assigned.has(parts[0])) {
                    const slotKey = ctx.byref.get(parts[0]);
                    if (slotKey) ctx.deps.push({ slotKey, start: t.start, end: t.start + parts[0].length, name: parts[0] });
                    break;
                }
                if (isCall && parts.length >= 2) {
                    const last = literalChainEnd(a, j);
                    if (last >= 0) {
                        // obj.Get(0).ID -> the whole chain is the variable
                        addOcc(ctx, t, a.slice(j, last + 1).map(x => x.text).join(''), 'variable', true);
                    } else {
                        addOcc(ctx, t, parts.slice(0, -1).join('.'), 'variable', true);   // obj.Method( -> obj
                    }
                } else {
                    addOcc(ctx, t, parts.join('.'), 'variable');
                }
                break;
            }
            default: break;
        }
    }
}

const TARGET_FUNCS = new Set(['$piece', '$p', '$extract', '$e', '$list', '$li', '$bit']);

// A target is written to, not read: its name is not asked for. Subscripts / extra arguments are reads.
function analyzeTarget(a: Tok[], ctx: Ctx): string[] {
    const names: string[] = [];
    const idx = a.findIndex(isSig);
    if (idx < 0) return names;
    const t = a[idx];

    if (isP(t, '(')) {
        const close = findMatching(a, idx);
        const end = close < 0 ? a.length : close;
        for (const seg of splitTop(a.slice(idx + 1, end), ',')) names.push(...analyzeTarget(seg, ctx));
        analyzeExpr(a.slice(end + 1), ctx);
        return names;
    }
    if (t.type === 'skip' && TARGET_FUNCS.has(t.text.toLowerCase()) && isP(a[idx + 1], '(')) {
        const close = findMatching(a, idx + 1);
        const end = close < 0 ? a.length : close;
        splitTop(a.slice(idx + 2, end), ',').forEach((seg, k) => {
            if (k === 0) names.push(...analyzeTarget(seg, ctx));
            else analyzeExpr(seg, ctx);
        });
        analyzeExpr(a.slice(end + 1), ctx);
        return names;
    }
    if (t.type === 'word') {
        names.push(t.parts![0]);
        analyzeExpr(a.slice(idx + 1), ctx);
        return names;
    }
    if (t.type === 'rel') {                                  // set ..Prop = x / set $this.Prop = x
        relRef(ctx, t, false);                               // (needs an object once the class is known)
        analyzeExpr(a.slice(idx + 1), ctx);
        return names;
    }
    analyzeExpr(a, ctx);
    return names;
}

function analyzeStatement(s: Stmt, ctx: Ctx) {
    analyzeExpr(s.post, ctx);
    const a = s.args;
    const assign = (names: string[]) => names.forEach(n => ctx.assigned.add(n));
    switch (s.cmd) {
        case 'set':
            for (const seg of splitTop(a, ',')) {
                const eq = findTop(seg, '=');
                if (eq < 0) { analyzeExpr(seg, ctx); continue; }
                analyzeExpr(seg.slice(eq + 1), ctx);                 // reads first ...
                assign(analyzeTarget(seg.slice(0, eq), ctx));        // ... then the target becomes assigned
            }
            break;
        case 'for': {
            if (a.every(x => !isSig(x))) break;
            const eq = findTop(a, '=');
            if (eq < 0) { analyzeExpr(a, ctx); break; }
            analyzeExpr(a.slice(eq + 1), ctx);
            assign(analyzeTarget(a.slice(0, eq), ctx));
            break;
        }
        case 'new':
            a.forEach(t => { if (t.type === 'word') ctx.assigned.add(t.parts![0]); });
            break;
        case 'kill': case 'zkill': case 'zwrite':
            for (const seg of splitTop(a, ',')) analyzeTarget(seg, ctx);
            break;
        case 'merge':
            for (const seg of splitTop(a, ',')) {
                const eq = findTop(seg, '=');
                if (eq < 0) { analyzeExpr(seg, ctx); continue; }
                analyzeExpr(seg.slice(eq + 1), ctx);
                assign(analyzeTarget(seg.slice(0, eq), ctx));
            }
            break;
        case 'read':
            for (const seg of splitTop(a, ',')) {
                splitTop(seg, ':').forEach((part, k) => {
                    if (k === 0) part.forEach(t => { if (t.type === 'word') ctx.assigned.add(t.parts![0]); });
                    else analyzeExpr(part, ctx);
                });
            }
            break;
        case 'do': case 'goto': case 'job':
            for (const seg of splitTop(a, ',')) analyzeExpr(seg, ctx, true);
            break;
        case 'catch':
            a.forEach(t => { if (t.type === 'word') ctx.assigned.add(t.parts![0]); });
            break;
        default:
            analyzeExpr(a, ctx);
    }
}

export function analyzeSelection(src: string, cls?: ClassContext): Analysis {
    const toks = tokenize(src);
    const ctx: Ctx = { assigned: new Set<string>(), occs: [], autos: [], byref: new Map<string, string>(), deps: [], cls, objRefs: [] };
    for (const s of splitStatements(toks)) analyzeStatement(s, ctx);

    // compute "is this a bare call argument" from the neighbouring significant tokens
    const idxByStart = new Map<number, number>();
    toks.forEach((t, i) => idxByStart.set(t.start, i));
    const sigNeighbour = (from: number, dir: 1 | -1): Tok | undefined => {
        for (let k = from + dir; k >= 0 && k < toks.length; k += dir) if (isSig(toks[k])) return toks[k];
        return undefined;
    };

    ctx.occs.sort((x, y) => x.start - y.start);
    const slots: Slot[] = [];
    const byKey = new Map<string, Slot>();
    for (const o of ctx.occs) {
        const ti = idxByStart.get(o.start);
        let argSlot = false;
        if (ti !== undefined && !o.callRoot) {
            const prev = sigNeighbour(ti, -1);
            const next = sigNeighbour(ti, 1);
            argSlot = (isP(prev, '(') || isP(prev, ',')) && (isP(next, ',') || isP(next, ')'));
        }
        const occ: Occurrence = { ...o, argSlot };
        const key = `${o.kind}:${o.text}`;
        let slot = byKey.get(key);
        if (!slot) {
            slot = { key, kind: o.kind, text: o.text, occurrences: [], argSlot: false };
            byKey.set(key, slot);
            slots.push(slot);
        }
        slot.occurrences.push(occ);
        if (argSlot) slot.argSlot = true;
    }
    ctx.objRefs.sort((a, b) => a.start - b.start);
    return { slots, autoEdits: ctx.autos, dependents: ctx.deps, objectRefs: ctx.objRefs, className: cls?.className };
}

// ---------------------------------------------------------------------------------------------
// Answers: classification, substitution
// ---------------------------------------------------------------------------------------------

export type AnswerKind = 'empty' | 'invalid' | 'number' | 'string' | 'array' | 'object' | 'byref'
    | 'variable' | 'global' | 'call' | 'expression';

export interface AnswerInfo { kind: AnswerKind; label: string; }

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const BYREF_RE = /^\.[%A-Za-z][A-Za-z0-9%]*$/;
const VARIABLE_RE = /^(?:\.\.)?[%A-Za-z][A-Za-z0-9%]*(?:\.[%A-Za-z][A-Za-z0-9%]*)*$/;
const THIS_RE = /^\$this(?:\.[%A-Za-z][A-Za-z0-9%]*)*$/i;

// returns an error text for unbalanced quotes/brackets, else ''
function checkBalance(a: string): string {
    const stack: string[] = [];
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    for (let i = 0; i < a.length; i++) {
        const c = a[i];
        if (c === '"') {
            i++;
            let closed = false;
            while (i < a.length) {
                if (a[i] === '"') {
                    if (a[i + 1] === '"') { i += 2; continue; }
                    closed = true;
                    break;
                }
                i++;
            }
            if (!closed) return 'Unbalanced quote';
            continue;
        }
        if (c === '(' || c === '[' || c === '{') stack.push(c);
        else if (c === ')' || c === ']' || c === '}') {
            if (stack.pop() !== pairs[c]) return 'Unbalanced brackets';
        }
    }
    return stack.length ? 'Unbalanced brackets' : '';
}

// index of the bracket closing the one at `open` (string-aware), or -1
function matchClose(a: string, open: number): number {
    const stack: string[] = [];
    for (let i = open; i < a.length; i++) {
        const c = a[i];
        if (c === '"') {
            i++;
            while (i < a.length) {
                if (a[i] === '"') {
                    if (a[i + 1] === '"') { i += 2; continue; }
                    break;
                }
                i++;
            }
            continue;
        }
        if (c === '(' || c === '[' || c === '{') stack.push(c);
        else if (c === ')' || c === ']' || c === '}') {
            stack.pop();
            if (stack.length === 0) return i;
        }
    }
    return -1;
}

function stringEnd(a: string, start: number): number {
    let i = start + 1;
    while (i < a.length) {
        if (a[i] === '"') {
            if (a[i + 1] === '"') { i += 2; continue; }
            return i + 1;
        }
        i++;
    }
    return -1;
}

// Operators outside any string/bracket. Whitespace is deliberately not counted.
function hasTopLevelOperator(a: string): boolean {
    let depth = 0;
    for (let i = 0; i < a.length; i++) {
        const c = a[i];
        if (c === '"') {
            const e = stringEnd(a, i);
            if (e < 0) return false;
            i = e - 1;
            continue;
        }
        if (c === '(' || c === '[' || c === '{') { if (depth === 0 && c === '[' && i > 0) return true; depth++; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; continue; }
        if (depth !== 0) continue;
        if (i === 0 && (c === '+' || c === '-' || c === "'")) continue;     // unary
        if ('+-*/\\#_=<>\'&!?@,:'.includes(c)) return true;
    }
    return false;
}

export function classifyAnswer(raw: string): AnswerInfo {
    const a = raw.trim();
    if (a === '') return { kind: 'empty', label: '' };
    const bad = checkBalance(a);
    if (bad) return { kind: 'invalid', label: bad };
    if (NUMBER_RE.test(a)) return { kind: 'number', label: 'Number' };
    if (a[0] === '"' && stringEnd(a, 0) === a.length) return { kind: 'string', label: 'String' };
    if (a[0] === '[' && matchClose(a, 0) === a.length - 1) return { kind: 'array', label: 'Dynamic array' };
    if (a[0] === '{' && matchClose(a, 0) === a.length - 1) return { kind: 'object', label: 'Dynamic object' };
    if (BYREF_RE.test(a)) return { kind: 'byref', label: 'By reference' };
    if (hasTopLevelOperator(a)) return { kind: 'expression', label: 'Expression — will be wrapped in ( )' };
    if (VARIABLE_RE.test(a) || THIS_RE.test(a)) return { kind: 'variable', label: 'Variable' };
    if (a[0] === '^') return { kind: 'global', label: 'Global reference' };
    return { kind: 'call', label: 'Call / value' };
}

// ObjectScript evaluates strictly left to right with no precedence, so a compound expression
// dropped into the middle of another one must be parenthesised to keep its meaning.
export function formatReplacement(answer: string): string {
    const a = answer.trim();
    return classifyAnswer(a).kind === 'expression' ? `(${a})` : a;
}

export type ObjectMode = 'var' | 'new' | 'openid';

/** The user's choice for the current object: a variable (or expression), a new instance, or an instance opened by id. */
export interface ObjectChoice { mode: ObjectMode; value: string; }

/** The expression for the object, or '' when none was given (the `..` uses are then left as they are). */
export function objectExpression(analysis: Analysis, choice?: ObjectChoice): string {
    if (!choice) return '';
    const v = choice.value.trim();
    if (choice.mode === 'var') return v;
    if (!analysis.className) return '';
    if (choice.mode === 'new') return `##class(${analysis.className}).%New()`;
    return v === '' ? '' : `##class(${analysis.className}).%OpenId(${v})`;
}

// Edits that point the `..` / $this uses at the object. A plain variable is substituted directly; a
// created / opened object (or any other expression) is created once up front when it is used more than
// once, so every use sees the same object.
function objectEdits(src: string, analysis: Analysis, choice?: ObjectChoice): { edits: Edit[]; prefix: string } {
    const expr = objectExpression(analysis, choice);
    if (expr === '' || analysis.objectRefs.length === 0) return { edits: [], prefix: '' };

    const plain = VARIABLE_RE.test(expr) && !expr.startsWith('..');
    const inline = plain || analysis.objectRefs.length === 1 && expr.startsWith('##class(');
    let target = expr;
    let prefix = '';
    if (!inline) {
        const used = new Set((src.match(/[A-Za-z%][A-Za-z0-9%]*/g) ?? []).map(w => w.toLowerCase()));
        let name = 'obj';
        for (let i = 1; used.has(name); i++) name = `obj${i}`;
        target = name;
        prefix = `set ${name}=${expr}\n`;
    }
    const edits = analysis.objectRefs.map(r => ({
        start: r.start, end: r.end, replacement: r.rest === '' ? target : `${target}.${r.rest}`
    }));
    return { edits, prefix };
}

export function applyAnswers(src: string, analysis: Analysis, answers: Record<string, string>, object?: ObjectChoice): string {
    const edits: Edit[] = analysis.autoEdits.slice();
    const obj = objectEdits(src, analysis, object);
    edits.push(...obj.edits);
    for (const slot of analysis.slots) {
        const raw = answers[slot.key];
        if (raw === undefined || raw.trim() === '') continue;     // empty = keep the original text
        const rep = formatReplacement(raw);
        for (const o of slot.occurrences) edits.push({ start: o.start, end: o.end, replacement: rep });
        // `.out` answered with `.B`: later reads of `out` / `out.data` follow to `B` / `B.data`
        if (slot.kind === 'byref' && classifyAnswer(raw).kind === 'byref') {
            const newName = raw.trim().slice(1);
            for (const d of analysis.dependents) {
                if (d.slotKey === slot.key && newName !== d.name) edits.push({ start: d.start, end: d.end, replacement: newName });
            }
        }
    }
    edits.sort((x, y) => y.start - x.start);
    let out = src;
    for (const e of edits) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    return obj.prefix + out;
}

// ---------------------------------------------------------------------------------------------
// Fill-in view: the selected code with the variables as inline inputs
// ---------------------------------------------------------------------------------------------

/** One piece of the code shown in the fill-in view: fixed text, or one occurrence of a variable. */
export type FillPart =
    | { lit: string }
    | { key: string; text: string; first: boolean };

/** The code cut into fixed text and variable occurrences, in order (the first occurrence of each is the one typed into). */
export function buildFillParts(src: string, analysis: Analysis): FillPart[] {
    const occs: { start: number; end: number; slot: Slot }[] = [];
    for (const slot of analysis.slots) for (const o of slot.occurrences) occs.push({ start: o.start, end: o.end, slot });
    occs.sort((a, b) => a.start - b.start);

    const parts: FillPart[] = [];
    const seen = new Set<string>();
    let pos = 0;
    for (const o of occs) {
        if (o.start > pos) parts.push({ lit: src.slice(pos, o.start) });
        parts.push({ key: o.slot.key, text: o.slot.text, first: !seen.has(o.slot.key) });
        seen.add(o.slot.key);
        pos = o.end;
    }
    if (pos < src.length) parts.push({ lit: src.slice(pos) });
    return parts;
}

/** Typed values (by slot key) → answers as used by applyAnswers: untouched / empty / same as the original = keep. */
export function fillValuesToAnswers(analysis: Analysis, values: Record<string, string>): Record<string, string> {
    const answers: Record<string, string> = {};
    for (const slot of analysis.slots) {
        const v = (values[slot.key] ?? '').trim();
        answers[slot.key] = v === '' || v === slot.text ? '' : v;
    }
    return answers;
}

// ---------------------------------------------------------------------------------------------
// Flatten to one terminal line
// ---------------------------------------------------------------------------------------------

// Comments are removed, line breaks become two spaces (valid between any two ObjectScript statements,
// including argument-less ones), so nothing can execute before the user presses Enter.
export function flattenForTerminal(src: string): string {
    let out = '';
    let pendingBreak = false;
    for (const t of tokenize(src)) {
        if (t.type === 'comment') continue;
        if (t.type === 'ws') {
            if (t.nl) pendingBreak = true;
            else if (!pendingBreak && out !== '') out += t.text.replace(/\t/g, ' ');
            continue;
        }
        if (pendingBreak && out !== '') out = out.trimEnd() + '  ';
        pendingBreak = false;
        out += t.text;
    }
    return out.trim();
}

// ---------------------------------------------------------------------------------------------
// Macro definitions from .inc files (used to prefill the prompt for unknown macros)
// ---------------------------------------------------------------------------------------------

export function parseIncDefines(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*#define\s+([A-Za-z0-9_%]+)\s+(\S.*)$/i.exec(line);
        if (!m) continue;                                          // also skips parameterised: #define Foo(%a) ...
        const val = flattenForTerminal(m[2]);
        if (val === '' || /##(expression|function|continue|lit|quote|safeexpression|unique)/i.test(val)) continue;
        out[m[1].toLowerCase()] = val;
    }
    return out;
}
