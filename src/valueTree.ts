// Turns values into a tree the Data Inspector can draw: JSON (a global's value, or a dynamic object printed by zw) and
// whole zw outputs (local variables, local arrays, dynamic objects, the object dump zw prints for an oref).
//
// One source, used twice: the extension imports it (to parse a zw block from the terminal) and scripts/embed-media.js
// transpiles it into the Data Inspector page at {{VALUE_TREE_JS}} (to show a global's JSON value), like patternSyntax.ts.
// So: no imports, nothing that needs Node or the DOM.

/** A node of the tree. Kept small and plain, because the viewer saves its entries.
 *  t: obj / arr = JSON object / array, str / num / bool / null = JSON leaves,
 *     node = a local variable or a subscript level (may have a value in v and children in k),
 *     sec = a section of zw's object dump ("attribute values"), raw = any other text.
 *  v: the value as shown. k: children as [label, node]. p: ObjectScript that reaches this node (for "Copy path"). */
export interface VNode {
    t: 'obj' | 'arr' | 'str' | 'num' | 'bool' | 'null' | 'node' | 'sec' | 'raw';
    v?: string;
    k?: [string, VNode][];
    p?: string;
}

/** Stops a huge value from freezing the viewer or bloating its saved state. */
export const VT_MAX_NODES = 50000;

/** The JSON text in a value, or undefined when it is not JSON. Takes the comment zw adds after a dynamic object
 *  ("  ; <DYNAMIC OBJECT,refs=1>") off first. Only objects and arrays count: a bare number or string stays a value. */
export function vtJsonText(value: string): string | undefined {
    if (typeof value !== 'string') return undefined;
    let s = value.replace(/\s*;\s*<DYNAMIC (?:OBJECT|ARRAY)[^>]*>\s*$/i, '').trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) return undefined;
    const last = s[s.length - 1];
    if ((s[0] === '{' && last !== '}') || (s[0] === '[' && last !== ']')) return undefined;
    try { JSON.parse(s); return s; } catch { return undefined; }
}

/** True for a JSON key that can be written as .key in ObjectScript; others need .%Get("key"). */
function vtPlainProp(key: string): boolean {
    return /^%?[A-Za-z][A-Za-z0-9]*$/.test(key);
}
function vtQuote(s: string): string { return '"' + s.replace(/"/g, '""') + '"'; }

/** ObjectScript that reads `key` from the dynamic entity `base` points at. */
export function vtMember(base: string, key: string, isArray: boolean): string {
    if (isArray) return base + '.%Get(' + key + ')';
    return vtPlainProp(key) ? base + '.' + key : base + '.%Get(' + vtQuote(key) + ')';
}

/** Parsed JSON -> tree. `base` is the ObjectScript for the dynamic entity at the top (its paths start there). */
export function vtFromJson(data: any, base: string, budget?: { n: number }): VNode {
    const b = budget || { n: 0 };
    const walk = (x: any, p: string): VNode => {
        b.n++;
        if (x === null) return { t: 'null', v: 'null', p };
        if (Array.isArray(x)) {
            const k: [string, VNode][] = [];
            for (let i = 0; i < x.length; i++) {
                if (b.n >= VT_MAX_NODES) { k.push(['…', { t: 'raw', v: (x.length - i) + ' more not shown' }]); break; }
                k.push([String(i), walk(x[i], vtMember(p, String(i), true))]);
            }
            return { t: 'arr', k, p };
        }
        if (typeof x === 'object') {
            const k: [string, VNode][] = [];
            const keys = Object.keys(x);
            for (let i = 0; i < keys.length; i++) {
                if (b.n >= VT_MAX_NODES) { k.push(['…', { t: 'raw', v: (keys.length - i) + ' more not shown' }]); break; }
                k.push([keys[i], walk(x[keys[i]], vtMember(p, keys[i], false))]);
            }
            return { t: 'obj', k, p };
        }
        if (typeof x === 'number') return { t: 'num', v: String(x), p };
        if (typeof x === 'boolean') return { t: 'bool', v: String(x), p };
        return { t: 'str', v: String(x), p };
    };
    return walk(data, base);
}

/** Tree -> JSON again (Copy value / Open as JSON on a branch). Only obj / arr / leaves; anything else is its text. */
export function vtToJson(n: VNode): any {
    switch (n.t) {
        case 'obj': { const o: any = {}; (n.k || []).forEach(([key, c]) => { if (key !== '…') o[key] = vtToJson(c); }); return o; }
        case 'arr': return (n.k || []).filter(([key]) => key !== '…').map(([, c]) => vtToJson(c));
        case 'num': return Number(n.v);
        case 'bool': return n.v === 'true';
        case 'null': return null;
        case 'str': return n.v || '';
        default: {
            if (!n.k || !n.k.length) return n.v === undefined ? '' : n.v;
            const o: any = {};
            if (n.v !== undefined && n.v !== '') o[''] = n.v;
            n.k.forEach(([key, c]) => { o[key] = vtToJson(c); });
            return o;
        }
    }
}

/** Number of nodes (for "N nodes" in the sidebar list). */
export function vtCount(n: VNode): number {
    let c = 1;
    (n.k || []).forEach(([, x]) => { c += vtCount(x); });
    return c;
}

/** Path -> shown value for every leaf, for comparing two trees key by key. A node with a value and children
 *  (a local array level that is also set) is listed with its own value too. */
export function vtFlatten(n: VNode, out?: Map<string, string>, prefix?: string): Map<string, string> {
    const m = out || new Map<string, string>();
    const here = prefix || '';
    const kids = n.k || [];
    if (!kids.length) {
        m.set(here || '(value)', n.t === 'obj' ? '{}' : n.t === 'arr' ? '[]' : n.t === 'str' ? JSON.stringify(n.v || '') : (n.v || ''));
        return m;
    }
    if (n.t === 'node' && n.v !== undefined && n.v !== '') m.set(here || '(value)', n.v);
    kids.forEach(([key, c]) => {
        if (key === '…') return;
        const seg = n.t === 'arr' ? '[' + key + ']' : (here ? '.' : '') + key;
        vtFlatten(c, m, here + seg);
    });
    return m;
}

// ---------------------------------------------------------------- zw output ----------------------------------------

/** One line of zw output split into its parts: name, subscripts (as written, e.g. ['1', '"abc"']) and the value text. */
export interface ZwLine { name: string; subs: string[]; value: string; }

/** Reads `name(subs)=value` the way zw prints it: a local (not ^global) name, subscripts that may hold quoted
 *  strings with commas, ')' or '=' in them, then '=' and the value. Undefined for any other line. */
export function vtParseZwLine(line: string): ZwLine | undefined {
    const m = /^(%?[A-Za-z][A-Za-z0-9]*)/.exec(line);
    if (!m) return undefined;
    const name = m[1];
    let i = name.length;
    const subs: string[] = [];
    if (line[i] === '(') {
        i++;
        let cur = '', q = false, depth = 0, closed = false;
        for (; i < line.length; i++) {
            const ch = line[i];
            if (q) {
                cur += ch;
                if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
                continue;
            }
            if (ch === '"') { q = true; cur += ch; continue; }
            if (ch === '(') { depth++; cur += ch; continue; }
            if (ch === ')') {
                if (depth === 0) { subs.push(cur); closed = true; i++; break; }
                depth--; cur += ch; continue;
            }
            if (ch === ',' && depth === 0) { subs.push(cur); cur = ''; continue; }
            cur += ch;
        }
        if (!closed) return undefined;
    }
    if (line[i] !== '=') return undefined;
    return { name, subs, value: line.slice(i + 1) };
}

/** zw's form of a string, "abc""def", back to the text; undefined if the value is not one plain quoted string
 *  (a number, $lb(...), "a"_$c(13,10)_"b" ... stay as written). */
function vtUnquote(v: string): string | undefined {
    if (!/^"(?:[^"]|"")*"$/.test(v)) return undefined;
    return v.slice(1, -1).replace(/""/g, '"');
}

/** The value of a clicked terminal line (the text after '=') as the Data Inspector keeps it: zw's quoted string
 *  ("abc""def") becomes its text; anything else is kept exactly as printed. Only a value that is one whole quoted
 *  string is unquoted: JSON printed as is ({"a":"","b":""}) has "" in it that must stay. */
export function vtLineValue(value: string): string {
    const v = value.trim();
    return vtUnquote(v) ?? v;
}

/** The value part of a zw line as a node. `ref` is the ObjectScript for that variable / node. */
function vtZwValue(value: string, ref: string, budget: { n: number }): VNode {
    const v = value.trim();
    const dyn = /;\s*<DYNAMIC (?:OBJECT|ARRAY)[^>]*>\s*$/i.test(v);
    const js = vtJsonText(v);
    if (js !== undefined) {
        // A dynamic object (zw printed its JSON and the comment): ref is the object itself.
        // A string that holds JSON text: it has to be parsed first.
        return vtFromJson(JSON.parse(js), dyn ? ref : '{}.%FromJSON(' + ref + ')', budget);
    }
    const s = vtUnquote(v);
    if (s !== undefined) {
        const inner = vtJsonText(s);
        if (inner !== undefined) return vtFromJson(JSON.parse(inner), '{}.%FromJSON(' + ref + ')', budget);
        return { t: 'str', v: s, p: ref };
    }
    if (/^[-+]?(\d+\.?\d*|\.\d+)(E[-+]?\d+)?$/i.test(v)) return { t: 'num', v, p: ref };
    return { t: 'raw', v, p: ref };
}

/** zw output (the lines after the command) -> one tree: a child per variable; local arrays become subscript levels;
 *  dynamic objects and JSON strings are expanded; an oref's dump (+--- general information --- / | name = value)
 *  is attached to that variable, a child per section. Lines that are none of these are kept under "(other output)". */
export function vtFromZw(lines: string[], expr?: string): VNode {
    const root: VNode = { t: 'node', k: [] };
    const budget = { n: 0 };
    const other: string[] = [];
    let lastVar: VNode | undefined;
    let section: VNode | undefined;
    let sectionName = '';

    const child = (parent: VNode, label: string, p: string): VNode => {
        parent.k = parent.k || [];
        const hit = parent.k.find(([key]) => key === label);
        if (hit) return hit[1];
        const n: VNode = { t: 'node', p };
        parent.k.push([label, n]);
        return n;
    };

    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (!line) continue;
        if (budget.n >= VT_MAX_NODES) { other.push('… output too large, the rest is not shown'); break; }

        const head = /^\+-{3,}\s*(.*?)\s*-*\s*$/.exec(line);
        if (head) {
            if (!lastVar) { other.push(line); continue; }
            sectionName = head[1] || '';
            section = sectionName ? child(lastVar, sectionName, lastVar.p || '') : undefined;
            if (section) { section.t = 'sec'; delete section.p; }
            continue;
        }
        const bar = /^\|\s*(.*)$/.exec(line);
        if (bar && lastVar) {
            const body = bar[1];
            const host = section || lastVar;
            const eq = /^(.+?)\s*(=|:)\s+(.*)$/.exec(body);
            budget.n++;
            if (eq) {
                const key = eq[1].trim();
                const val = eq[3].replace(/\s+<(?:Set|Get|Set,Get)>\s*$/, '').trim();
                // Only "attribute values" / "... references" rows are properties of the object; the general
                // information rows (oref value, class name, reference count) are not.
                const prop = !!section && /attribute|reference/i.test(sectionName);
                const p = prop && /^%?[A-Za-z][A-Za-z0-9]*$/.test(key) ? (lastVar.p || '') + '.' + key : undefined;
                const n = vtZwValue(val, p || '', budget);
                if (!p) delete n.p;
                (host.k = host.k || []).push([key, n]);
            } else (host.k = host.k || []).push([body, { t: 'raw', v: '' }]);
            continue;
        }

        let z = vtParseZwLine(line);
        // zw of an expression (zw out.list, zw obj.%Get(0)) prints only the value, without "name=": the expression
        // from the command is its name. Only the first line can be that value.
        if (!z && expr && !lastVar && !(root.k || []).length && !other.length) z = { name: expr, subs: [], value: line };
        if (!z) { other.push(line); lastVar = undefined; section = undefined; continue; }
        budget.n++;
        let node = child(root, z.name, z.name);
        const used: string[] = [];
        z.subs.forEach(s => { used.push(s); node = child(node, s, z.name + '(' + used.join(',') + ')'); });
        const ref = z.subs.length ? z.name + '(' + z.subs.join(',') + ')' : z.name;
        const val = vtZwValue(z.value, ref, budget);
        if (val.t === 'obj' || val.t === 'arr') {
            // Expanded JSON at this level; subscripts already under it (rare) stay next to its keys.
            node.t = val.t; node.p = val.p; node.k = (val.k || []).concat(node.k || []);
        } else {
            node.v = val.v; node.p = ref;
            if (!node.k || !node.k.length) node.t = val.t === 'raw' ? 'node' : val.t;
        }
        lastVar = node;
        section = undefined;
        sectionName = '';
    }
    if (other.length) (root.k = root.k || []).push(['(other output)', { t: 'raw', v: other.join('\n') }]);
    return root;
}

/** The variable names at the top of a zw tree, for a title such as "out" or "out, arr". */
export function vtTopNames(n: VNode): string[] {
    return (n.k || []).map(([key]) => key).filter(key => key !== '(other output)');
}
