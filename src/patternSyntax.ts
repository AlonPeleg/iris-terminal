// The Global Watch pattern language: parse a pattern like  ^g(2:5,,["out"  and describe it in words.
//
// This file is written so that it can run in two places from one source: in the extension (imported by
// globalWatch.ts) and inside the Global Watch page (scripts/embed-media.js transpiles it to plain JavaScript and
// puts it into media/globalWatch.html at the {{PATTERN_JS}} marker). So: no imports, no TypeScript-only runtime
// features (enums, namespaces), nothing but plain functions and constants.
//
// Syntax, per subscript slot (slots are separated by commas):
//     (empty)        any value
//     "text" 5       exactly that value (text needs both quotes, numbers do not)
//     2:5  :5  2:    a number range, both ends included (one end may be left out)
//     >2 >=2 <5 <=5 comparisons (numbers)
//     ["out"         contains            '["out"   does not contain
//     ]"abc"         sorts after         ']"abc"   does not sort after
//     "ab"*          starts with
//     '="x"  '=5     is not
//     ?3N  ?1A.AN    ObjectScript pattern match     '?3N  does not match
//     {"abc","bbb",7,2:5,"x"*}   any one of the listed values / ranges / prefixes
// No closing ) = "that level and everything below"; a closing ) = exactly that level.
// A namespace may lead the reference:  ^["ACC"]g(...)   or   ^|"ACC"|g(...)

export type Item =
    | { type: 'n'; value: string }
    | { type: 's'; value: string }
    | { type: 'range'; lo: string | null; hi: string | null; loInc: boolean; hiInc: boolean }
    | { type: 'starts'; value: string };

export type PatternSlot =
    | null                                                  // any value
    | Item
    | { type: 'neq'; value: string; num: boolean }
    | { type: 'contains'; value: string; not: boolean }
    | { type: 'follows'; value: string; not: boolean }
    | { type: 'match'; value: string; not: boolean }
    | { type: 'list'; items: Item[] };

export interface Pattern {
    name: string;            // global name without the ^
    namespace?: string;      // from ^["NS"]name, if the reference carries one
    slots: PatternSlot[];    // empty = the whole global
    closed: boolean;         // true: exactly slots.length levels; false: that level and everything below
}

export type PatternResult = { ok: true; pattern: Pattern } | { ok: false; error: string };

export const NS_RE = /^[%A-Za-z0-9_-]+$/;
export const MAX_LIST_ITEMS = 100;

const ORD = ['', '1st', '2nd', '3rd'];
export function ordinal(i: number): string { return ORD[i] !== undefined ? ORD[i] : i + 'th'; }

const NUM = /^-?\d+(\.\d+)?$/;
const QUOTE_ERR = 'Close the quote: text subscripts need both quotes (numbers do not)';

type Quoted = { ok: true; value: string; rest: string } | { ok: false; error: string };

/** Reads a "quoted string" at the start of s ("" is a quote inside). */
function readQuoted(s: string): Quoted {
    if (s[0] !== '"') return { ok: false, error: 'Expected "text" in quotes' };
    let i = 1;
    let value = '';
    for (;;) {
        if (i >= s.length) return { ok: false, error: QUOTE_ERR };
        if (s[i] === '"') {
            if (s[i + 1] === '"') { value += '"'; i += 2; continue; }
            break;
        }
        value += s[i++];
    }
    if (/[\u0000-\u001f]/.test(value)) return { ok: false, error: 'Control characters are not allowed in a subscript' };
    return { ok: true, value, rest: s.slice(i + 1) };
}

/** Splits at commas that are outside quotes, parentheses and braces. */
function splitTop(s: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"') {
            if (inQ && s[i + 1] === '"') { cur += '""'; i++; continue; }
            inQ = !inQ; cur += c; continue;
        }
        if (!inQ) {
            if (c === '(' || c === '{') depth++;
            else if (c === ')' || c === '}') depth--;
            else if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        }
        cur += c;
    }
    out.push(cur);
    return out;
}

type ItemResult = { ok: true; item: Item } | { ok: false; error: string };

/** A single value, a number range or a "prefix"* - what may stand alone in a slot or inside { }. */
function parseItem(raw: string): ItemResult {
    const s = raw.trim();
    if (s[0] === '"') {
        const q = readQuoted(s);
        if (!q.ok) return q;
        const rest = q.rest.trim();
        if (rest === '') return { ok: true, item: { type: 's', value: q.value } };
        if (rest === '*') {
            if (q.value === '') return { ok: false, error: 'Starts-with needs some text: "abc"*' };
            return { ok: true, item: { type: 'starts', value: q.value } };
        }
        if (rest[0] === ':') return { ok: false, error: 'A range (2:5) works on numbers only' };
        return { ok: false, error: 'Unexpected text after the closing quote: ' + rest };
    }
    if (NUM.test(s)) return { ok: true, item: { type: 'n', value: s } };
    const colon = s.indexOf(':');
    if (colon >= 0) {
        const lo = s.slice(0, colon).trim();
        const hi = s.slice(colon + 1).trim();
        if (lo.includes('"') || hi.includes('"')) return { ok: false, error: 'A range (2:5) works on numbers only' };
        if ((lo !== '' && !NUM.test(lo)) || (hi !== '' && !NUM.test(hi))) return { ok: false, error: 'A range needs numbers, like 2:5' };
        if (lo === '' && hi === '') return { ok: false, error: 'A range needs at least one number, like 2:5, :5 or 2:' };
        if (lo !== '' && hi !== '' && Number(lo) > Number(hi)) return { ok: false, error: 'The range ' + lo + ':' + hi + ' is backwards (the first number must not be bigger)' };
        return { ok: true, item: { type: 'range', lo: lo === '' ? null : lo, hi: hi === '' ? null : hi, loInc: true, hiInc: true } };
    }
    return { ok: false, error: s + ' must be "text" or a number' };
}

/** The ObjectScript pattern-match codes: counts, A C E L N P U, "literals", (alternatives). */
function validMatchPattern(p: string): string | null {
    if (p === '') return 'Write a pattern after ?, for example ?3N or ?1A.AN';
    let inQ = false;
    let depth = 0;
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === '"') {
            if (inQ && p[i + 1] === '"') { i++; continue; }
            inQ = !inQ; continue;
        }
        if (inQ) { if (/[\u0000-\u001f]/.test(c)) return 'Control characters are not allowed in a pattern'; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth < 0) return 'Unbalanced ) in the pattern'; }
        else if (!/[0-9.,ACELNPUacelnpu]/.test(c)) return 'The pattern may only use counts, the codes A C E L N P U, "text" and ( ) , - got ' + c;
    }
    if (inQ) return 'Close the quote inside the pattern';
    if (depth !== 0) return 'Unbalanced ( in the pattern';
    return null;
}

type SlotResult = { ok: true; slot: PatternSlot } | { ok: false; error: string };

function parseSlot(raw: string): SlotResult {
    let s = raw.trim();
    if (s === '') return { ok: true, slot: null };

    if (s[0] === '{') {
        if (s[s.length - 1] !== '}') return { ok: false, error: 'Close the list with }' };
        const parts = splitTop(s.slice(1, -1)).map(x => x.trim()).filter(x => x !== '');
        if (parts.length === 0) return { ok: false, error: 'The list { } is empty' };
        if (parts.length > MAX_LIST_ITEMS) return { ok: false, error: 'A list can hold at most ' + MAX_LIST_ITEMS + ' entries' };
        const items: Item[] = [];
        for (const part of parts) {
            const r = parseItem(part);
            if (!r.ok) return { ok: false, error: 'In the list: ' + r.error };
            items.push(r.item);
        }
        return { ok: true, slot: { type: 'list', items } };
    }

    let not = false;
    if (s[0] === "'") {
        not = true;
        s = s.slice(1).trim();
        if (s === '' || '[]?='.indexOf(s[0]) < 0) return { ok: false, error: "After ' use [ (contains), ] (sorts after), ? (pattern) or = (is)" };
    }
    const op = s[0];

    if (op === '[' || op === ']') {
        const q = readQuoted(s.slice(1).trim());
        if (!q.ok) return q;
        if (q.rest.trim() !== '') return { ok: false, error: 'Unexpected text after the closing quote: ' + q.rest.trim() };
        if (op === '[' && q.value === '') return { ok: false, error: 'Contains needs some text: ["abc"' };
        return { ok: true, slot: { type: op === '[' ? 'contains' : 'follows', value: q.value, not } };
    }
    if (op === '?') {
        const pat = s.slice(1).trim();
        const bad = validMatchPattern(pat);
        if (bad) return { ok: false, error: bad };
        return { ok: true, slot: { type: 'match', value: pat, not } };
    }
    if (op === '=') {
        const lit = s.slice(1).trim();
        if (lit[0] === '"') {
            const q = readQuoted(lit);
            if (!q.ok) return q;
            if (q.rest.trim() !== '') return { ok: false, error: 'Unexpected text after the closing quote: ' + q.rest.trim() };
            return { ok: true, slot: { type: 'neq', value: q.value, num: false } };
        }
        if (NUM.test(lit)) return { ok: true, slot: { type: 'neq', value: lit, num: true } };
        return { ok: false, error: "After '= write \"text\" or a number" };
    }
    if (op === '>' || op === '<') {
        const inc = s[1] === '=';
        const num = s.slice(inc ? 2 : 1).trim();
        if (!NUM.test(num)) return { ok: false, error: 'After ' + op + (inc ? '=' : '') + ' write a number, like ' + op + '5' };
        return {
            ok: true,
            slot: op === '>'
                ? { type: 'range', lo: num, hi: null, loInc: inc, hiInc: false }
                : { type: 'range', lo: null, hi: num, loInc: false, hiInc: inc }
        };
    }
    const r = parseItem(s);
    return r.ok ? { ok: true, slot: r.item } : r;
}

const EXT_NS = /^\^(?:\[\s*"([^"]*)"\s*\]|\|\s*"([^"]*)"\s*\|)/;

/** Splits a leading ["NS"] / |"NS"| off a reference: ^["ACC"]g(1) -> { namespace: "ACC", text: "^g(1)" }. */
export function splitNamespace(text: string): { namespace?: string; text: string } {
    const t = text.trim();
    const m = EXT_NS.exec(t);
    if (!m) return { text: t };
    const ns = m[1] !== undefined ? m[1] : m[2];
    return { namespace: ns, text: '^' + t.slice(m[0].length) };
}

export function parsePattern(text: string): PatternResult {
    let t = text.trim();
    let namespace: string | undefined;
    if (/^\^(\[|\|)/.test(t)) {
        const sp = splitNamespace(t);
        if (sp.namespace === undefined) return { ok: false, error: 'A namespace goes in quotes before the global name: ^["ACC"]mtemp' };
        if (!NS_RE.test(sp.namespace)) return { ok: false, error: '"' + sp.namespace + '" is not a valid namespace name' };
        namespace = sp.namespace;
        t = sp.text;
    }
    const m = /^\^(%?[A-Za-z][A-Za-z0-9.]*)([\s\S]*)$/.exec(t);
    if (!m) return { ok: false, error: 'A pattern must start with ^ and a global name, e.g. ^mtemp' };
    const name = m[1];
    let rest = m[2];
    const base = (slots: PatternSlot[], closed: boolean): PatternResult =>
        ({ ok: true, pattern: namespace !== undefined ? { name, namespace, slots, closed } : { name, slots, closed } });
    if (rest === '') return base([], false);
    if (rest[0] !== '(') return { ok: false, error: 'Expected ( after the global name' };
    rest = rest.slice(1);
    let closed = false;

    // Walk the text once: split on commas outside quotes/brackets, and notice the closing ) of the reference.
    const rawSlots: string[] = [];
    let cur = '';
    let inQ = false;
    let depth = 0;
    for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        if (c === '"') {
            if (inQ && rest[i + 1] === '"') { cur += '""'; i++; continue; }   // doubled quote inside a string
            inQ = !inQ; cur += c; continue;
        }
        if (!inQ) {
            if (c === '(' || c === '{') { depth++; cur += c; continue; }
            if (c === '}') { depth--; cur += c; continue; }
            if (c === ')') {
                if (depth > 0) { depth--; cur += c; continue; }
                if (rest.slice(i + 1).trim() !== '') return { ok: false, error: 'Nothing is allowed after the closing )' };
                closed = true;
                break;
            }
            if (c === ',' && depth === 0) { rawSlots.push(cur); cur = ''; continue; }
        }
        cur += c;
    }
    if (inQ) return { ok: false, error: QUOTE_ERR };
    if (depth > 0) return { ok: false, error: 'A { or ( is not closed' };
    rawSlots.push(cur);

    const slots: PatternSlot[] = [];
    for (let i = 0; i < rawSlots.length; i++) {
        const r = parseSlot(rawSlots[i]);
        if (!r.ok) return { ok: false, error: ordinal(i + 1) + ' subscript: ' + r.error };
        slots.push(r.slot);
    }
    return base(slots, closed);
}

// ---- in words ------------------------------------------------------------------------------------

const q = (v: string) => '"' + v + '"';

function describeRange(it: { lo: string | null; hi: string | null; loInc: boolean; hiInc: boolean }, subject: string): string {
    if (it.lo !== null && it.hi !== null && it.loInc && it.hiInc) return subject + ' from ' + it.lo + ' to ' + it.hi;
    const parts: string[] = [];
    if (it.lo !== null) parts.push((it.loInc ? '>= ' : '> ') + it.lo);
    if (it.hi !== null) parts.push((it.hiInc ? '<= ' : '< ') + it.hi);
    return subject + ' ' + parts.join(' and ');
}

function describeItem(it: Item): string {
    if (it.type === 'n') return it.value;
    if (it.type === 's') return q(it.value);
    if (it.type === 'starts') return q(it.value) + '*';
    if (it.lo !== null && it.hi !== null && it.loInc && it.hiInc) return it.lo + ' to ' + it.hi;
    const parts: string[] = [];
    if (it.lo !== null) parts.push((it.loInc ? '>= ' : '> ') + it.lo);
    if (it.hi !== null) parts.push((it.hiInc ? '<= ' : '< ') + it.hi);
    return parts.join(' and ');
}

function describeSlot(s: Exclude<PatternSlot, null>, o: string): string {
    switch (s.type) {
        case 'n': return o + ' = ' + s.value;
        case 's': return o + ' = ' + q(s.value);
        case 'neq': return o + ' is not ' + (s.num ? s.value : q(s.value));
        case 'range': return describeRange(s, o);
        case 'starts': return o + ' starts with ' + q(s.value);
        case 'contains': return o + (s.not ? " doesn't contain " : ' contains ') + q(s.value);
        case 'follows': return o + (s.not ? ' does not sort after ' : ' sorts after ') + q(s.value);
        case 'match': return o + (s.not ? " doesn't match pattern " : ' matches pattern ') + s.value;
        case 'list': return o + ' is one of ' + s.items.map(describeItem).join(', ');
    }
    return '';
}

export function describePattern(p: Pattern): string {
    if (p.slots.length === 0) return 'Everything in the global';
    const L = p.slots.length;
    const conds: string[] = [];
    p.slots.forEach((s, i) => { if (s) conds.push(describeSlot(s, ordinal(i + 1))); });
    const cond = conds.length ? ' where ' + conds.join(' and ') : '';
    if (p.closed) return 'Level ' + L + ' only' + cond;
    if (p.slots[L - 1] === null && L > 1) return 'Everything below level ' + (L - 1) + ', not that node itself' + cond;
    return 'That node and everything below it' + cond;
}
