// Saved snippets: code from the Fill-in view kept with its variables as they are (no values), to run again later.
// Not tied to a terminal or a namespace: running one picks the terminal the usual way, then asks which namespace to
// run in, then opens the Fill-in view for its variables. Stored in globalState, so they are the same in every workspace
// on this machine. Listed in the "Snippets" tab of the bottom panel and in "IRIS: Run Snippet...".

import * as vscode from 'vscode';
import { analyzeSelection, ClassContext, findGlobalKills, parseClassContext } from './sendSelection';

/** A kill on a global that the code does not show itself (inside the method a Run in Terminal call runs). */
export interface KillNote { text: string; whole: boolean; indirect: boolean; where?: string }

export interface SavedClass { className: string; classMethods: string[]; instanceMethods: string[] }

export interface Snippet {
    id: string;
    name: string;
    /** the code as it was in the Fill-in view, variables left as written */
    code: string;
    /** (0.1.45 only - no longer used: the namespace is chosen each time a snippet runs) */
    namespace?: string;
    /** the class the code came from, so `..Method(` / `$this` still resolve */
    cls?: SavedClass;
    bodyKills?: KillNote[];
    created: number;
}

const STORE_KEY = 'iris-terminal.snippets';

export function saveClass(cls: ClassContext | undefined): SavedClass | undefined {
    if (!cls) return undefined;
    return { className: cls.className, classMethods: [...cls.classMethods], instanceMethods: [...cls.instanceMethods] };
}

export function loadClass(c: SavedClass | undefined): ClassContext | undefined {
    if (!c || typeof c.className !== 'string') return undefined;
    return { className: c.className, classMethods: new Set(c.classMethods ?? []), instanceMethods: new Set(c.instanceMethods ?? []) };
}

export function getSnippets(context: vscode.ExtensionContext): Snippet[] {
    const raw = context.globalState.get<unknown>(STORE_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((s: any) => s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.code === 'string');
}

const changed = new vscode.EventEmitter<void>();
/** Fires whenever a snippet is added, renamed or deleted. */
export const onDidChangeSnippets = changed.event;

async function putSnippets(context: vscode.ExtensionContext, list: Snippet[]) {
    await context.globalState.update(STORE_KEY, list);
    changed.fire();
}

export function getSnippet(context: vscode.ExtensionContext, id: string): Snippet | undefined {
    return getSnippets(context).find(x => x.id === id);
}

/** Replaces a snippet's code (edited in the Fill-in tab). Returns the updated snippet. */
export async function updateSnippetCode(context: vscode.ExtensionContext, id: string, code: string): Promise<Snippet | undefined> {
    const list = getSnippets(context);
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return undefined;
    list[i] = { ...list[i], code };
    await putSnippets(context, list);
    return list[i];
}

export async function renameSnippet(context: vscode.ExtensionContext, id: string): Promise<void> {
    const list = getSnippets(context);
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return;
    const name = (await vscode.window.showInputBox({ title: 'Rename snippet', value: list[i].name, validateInput: v => v.trim() === '' ? 'Type a name' : undefined }))?.trim();
    if (!name || name === list[i].name) return;
    const fresh = getSnippets(context);
    const j = fresh.findIndex(x => x.id === id);
    if (j >= 0) { fresh[j] = { ...fresh[j], name }; await putSnippets(context, fresh); }
}

export async function deleteSnippet(context: vscode.ExtensionContext, id: string, confirm: boolean): Promise<void> {
    const s = getSnippets(context).find(x => x.id === id);
    if (!s) return;
    if (confirm) {
        const ok = await vscode.window.showWarningMessage(`Delete the snippet "${s.name}"?`, { modal: true }, 'Delete');
        if (ok !== 'Delete') return;
    }
    await putSnippets(context, getSnippets(context).filter(x => x.id !== id));
}

function oneLine(code: string, max = 90): string {
    const s = code.replace(/\s*\n\s*/g, '  ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Asks for a name and stores the snippet (no namespace: that is chosen each time it runs). Returns its name, or
 *  undefined when cancelled. */
export async function promptSaveSnippet(context: vscode.ExtensionContext,
    data: { code: string; cls?: ClassContext; bodyKills?: KillNote[] }): Promise<string | undefined> {
    const suggested = oneLine(data.code, 40);
    const name = (await vscode.window.showInputBox({
        title: 'Save as snippet',
        prompt: 'Name for this snippet (shown in the Snippets tab and in "IRIS: Run Snippet...")',
        value: suggested,
        valueSelection: [0, suggested.length],
        validateInput: v => v.trim() === '' ? 'Type a name' : undefined
    }))?.trim();
    if (!name) return undefined;

    const list = getSnippets(context);
    const existing = list.findIndex(s => s.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0) {
        const ok = await vscode.window.showWarningMessage(`A snippet named "${name}" already exists. Replace it?`, { modal: true }, 'Replace');
        if (ok !== 'Replace') return undefined;
    }
    const snip: Snippet = {
        id: existing >= 0 ? list[existing].id : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        name,
        code: data.code,
        cls: saveClass(data.cls),
        bodyKills: data.bodyKills && data.bodyKills.length ? data.bodyKills : undefined,
        created: Date.now()
    };
    if (existing >= 0) list[existing] = snip; else list.push(snip);
    await putSnippets(context, list);
    return name;
}

const RENAME_BTN: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Rename' };
const DELETE_BTN: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete' };

type SnipItem = vscode.QuickPickItem & { snip: Snippet };

/** "IRIS: Run Snippet": a searchable list; Enter runs the picked one, the row buttons rename / delete. */
export async function pickAndRunSnippet(context: vscode.ExtensionContext, run: (s: Snippet) => Promise<void>) {
    if (getSnippets(context).length === 0) {
        vscode.window.showInformationMessage('IRIS Terminal: no snippets yet. Use "Save as snippet" in the Fill-in tab to keep one.');
        return;
    }
    const qp = vscode.window.createQuickPick<SnipItem>();
    qp.title = 'IRIS: Run Snippet';
    qp.placeholder = 'Pick a snippet to run (it opens the Fill-in tab for its variables)';
    qp.matchOnDetail = true;
    const refresh = () => {
        const list = getSnippets(context).sort((a, b) => a.name.localeCompare(b.name));
        qp.items = list.map(s => ({
            label: s.name,
            detail: oneLine(s.code),
            buttons: [RENAME_BTN, DELETE_BTN],
            snip: s
        }));
        if (list.length === 0) qp.hide();
    };
    refresh();

    let chosen: Snippet | undefined;
    qp.onDidTriggerItemButton(async e => {
        const s = e.item.snip;
        if (e.button === DELETE_BTN) {
            qp.busy = true;
            await deleteSnippet(context, s.id, false);
            qp.busy = false;
            refresh();
            return;
        }
        if (e.button === RENAME_BTN) {
            qp.hide();
            await renameSnippet(context, s.id);
            void pickAndRunSnippet(context, run);
        }
    });
    qp.onDidAccept(() => { chosen = qp.selectedItems[0]?.snip; qp.hide(); });
    qp.onDidHide(() => {
        qp.dispose();
        if (chosen) void run(chosen);
    });
    qp.show();
}

// ---- the "Snippets" tab in the bottom panel ----------------------------------------------------------------------
// A native list: a row per snippet (name + what it needs), its first lines of code underneath when expanded, the full
// code in the hover. Two clicks on a row within DOUBLE_CLICK_MS run it (a tree has no real double-click event).

const MAX_CODE_LINES = 5;
const TAB_SIZE_KEY = 'iris-terminal.snippets.tabSize';

/** How many spaces a tab takes in the Snippets tab (hover and code lines). Display only: the saved code keeps its tabs. */
function tabSize(): number {
    const n = vscode.workspace.getConfiguration().get<number>(TAB_SIZE_KEY, 1);
    return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 1;
}

const INDENT_UNIT = 4;        // columns in one indentation level (VS Code's default tab size)

/** The code with its indentation drawn at the chosen width: leading tabs and every INDENT_UNIT leading spaces are one
 *  level each, shown as tabSize() spaces (left-over spaces stay); tabs inside a line also become tabSize() spaces. */
function showTabs(code: string): string {
    const w = tabSize();
    return code.split('\n').map(line => {
        const m = /^[ \t]*/.exec(line)![0];
        let cols = 0;
        for (const c of m) cols = c === '\t' ? (Math.floor(cols / INDENT_UNIT) + 1) * INDENT_UNIT : cols + 1;
        const lead = ' '.repeat(Math.floor(cols / INDENT_UNIT) * w + (cols % INDENT_UNIT));
        return lead + line.slice(m.length).replace(/\t/g, ' '.repeat(w));
    }).join('\n');
}
const DOUBLE_CLICK_MS = 500;
const VIEW_ID = 'iris-terminal.snippets';

type CodeLineNode = { kind: 'line'; snip: Snippet; n: number; text: string };
type MoreNode = { kind: 'more'; snip: Snippet; rest: number };
type Node = Snippet | CodeLineNode | MoreNode;

const isSnippet = (n: unknown): n is Snippet => !!n && typeof (n as any).id === 'string' && typeof (n as any).code === 'string' && !(n as any).kind;

/** What running the snippet will ask for and kill, for the row's description and the hover. */
function summary(s: Snippet): { fill: string[]; kills: string[] } {
    const fill: string[] = [];
    const kills: string[] = [];
    try {
        const a = analyzeSelection(s.code, loadClass(s.cls));
        for (const slot of a.slots) fill.push(slot.text);
        if (a.objectRefs.length > 0) fill.push('object');
        for (const k of findGlobalKills(s.code)) kills.push(k.text);
    } catch { /* unreadable code: show the name only */ }
    for (const k of s.bodyKills ?? []) kills.push(k.text + (k.where ? ` (in ${k.where})` : ''));
    return { fill, kills };
}

function codeLines(code: string): string[] {
    const lines = code.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
    return lines;
}

function cmdLink(command: string, id: string, text: string): string {
    return `[${text}](command:${command}?${encodeURIComponent(JSON.stringify([id]))})`;
}

class SnippetTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;
    private readonly sub: vscode.Disposable;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.sub = vscode.Disposable.from(
            onDidChangeSnippets(() => this.emitter.fire()),
            vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(TAB_SIZE_KEY)) this.emitter.fire(); }));
    }

    getChildren(element?: Node): Node[] {
        if (!element) return getSnippets(this.context).sort((a, b) => a.name.localeCompare(b.name));
        if (!isSnippet(element)) return [];
        const lines = codeLines(element.code);
        const out: Node[] = lines.slice(0, MAX_CODE_LINES).map((text, i) => ({ kind: 'line', snip: element, n: i + 1, text }));
        if (lines.length > MAX_CODE_LINES) out.push({ kind: 'more', snip: element, rest: lines.length - MAX_CODE_LINES });
        return out;
    }

    getParent(element: Node): Node | undefined {
        return isSnippet(element) ? undefined : element.snip;
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (!isSnippet(node)) {
            if (node.kind === 'more') {
                const item = new vscode.TreeItem(`… ${node.rest} more line${node.rest === 1 ? '' : 's'} - open the code`, vscode.TreeItemCollapsibleState.None);
                item.id = `${node.snip.id}:more`;
                item.command = { command: 'iris-terminal.snippet.edit', title: 'Edit code', arguments: [node.snip.id] };
                item.contextValue = 'irisSnippetMore';
                return item;
            }
            // leading blanks would be trimmed from a label: keep the indentation with no-break spaces
            const shown = showTabs(node.text).replace(/^ +/, m => '\u00a0'.repeat(m.length));
            const item = new vscode.TreeItem({ label: `${node.n}  ${shown || ' '}` }, vscode.TreeItemCollapsibleState.None);
            item.id = `${node.snip.id}:L${node.n}`;
            item.contextValue = 'irisSnippetLine';
            return item;
        }

        const s = node;
        const { fill, kills } = summary(s);
        const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = s.id;
        const parts: string[] = [];
        if (fill.length) parts.push(`fill in: ${fill.join(' · ')}`);
        if (kills.length) parts.push(`kills ${kills.slice(0, 2).join(', ')}${kills.length > 2 ? ` +${kills.length - 2}` : ''}`);
        item.description = parts.length ? parts.join(' · ') : 'runs as is';
        item.iconPath = kills.length
            ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'))
            : new vscode.ThemeIcon('symbol-snippet');

        const tip = new vscode.MarkdownString(undefined, true);
        tip.isTrusted = { enabledCommands: ['iris-terminal.snippet.run', 'iris-terminal.snippet.edit', 'iris-terminal.snippet.rename'] };
        tip.appendMarkdown('**');
        tip.appendText(s.name);
        tip.appendMarkdown('**\n\n');
        tip.appendCodeblock(showTabs(s.code), 'objectscript');
        if (kills.length) tip.appendMarkdown(`\n\n$(warning) Running it kills ${kills.map(k => '`' + k.replace(/`/g, '') + '`').join(', ')}`);
        tip.appendMarkdown(`\n\n---\n\n${cmdLink('iris-terminal.snippet.run', s.id, '$(play) Run')} &nbsp;&nbsp; ${cmdLink('iris-terminal.snippet.edit', s.id, '$(code) Edit code')} &nbsp;&nbsp; ${cmdLink('iris-terminal.snippet.rename', s.id, '$(edit) Rename')}`);
        item.tooltip = tip;
        item.contextValue = 'irisSnippet';
        item.command = { command: 'iris-terminal.snippet.click', title: 'Select', arguments: [s.id] };
        return item;
    }

    dispose() { this.sub.dispose(); this.emitter.dispose(); }
}

let snippetsView: vscode.TreeView<Node> | undefined;

/** Brings the Snippets tab to the front with that snippet selected (after editing it in the Fill-in tab). */
export async function focusSnippet(context: vscode.ExtensionContext, id?: string): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    const s = id ? getSnippet(context, id) : undefined;
    if (s && snippetsView) {
        try { await snippetsView.reveal(s, { select: true, focus: true }); } catch { /* not shown yet: the tab is focused anyway */ }
    }
}

/** The Snippets tab and its commands. `run` runs a snippet (terminal, namespace, Fill-in); `edit` opens it in the
 *  Fill-in tab's edit mode. Commands take a snippet id (hover links), a node (row icons / context menu) or nothing
 *  (keyboard: the selected row). */
export function registerSnippetsView(context: vscode.ExtensionContext,
    actions: { run: (s: Snippet) => Promise<void>; edit: (s: Snippet) => Promise<void> }): vscode.Disposable[] {
    const provider = new SnippetTreeProvider(context);
    const view = vscode.window.createTreeView<Node>(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });
    snippetsView = view;

    const resolve = (arg?: unknown): Snippet | undefined => {
        if (typeof arg === 'string') return getSnippet(context, arg);
        const node = (arg ?? view.selection[0]) as Node | undefined;
        if (!node) return undefined;
        const s = isSnippet(node) ? node : node.snip;
        return getSnippet(context, s.id);                          // the stored one (the node may be stale)
    };

    let lastClick = { id: '', at: 0 };
    return [
        view, provider,
        vscode.commands.registerCommand('iris-terminal.snippet.click', (id: string) => {
            const now = Date.now();
            if (lastClick.id === id && now - lastClick.at < DOUBLE_CLICK_MS) {
                lastClick = { id: '', at: 0 };
                const s = getSnippet(context, id);
                if (s) void actions.run(s);
                return;
            }
            lastClick = { id, at: now };
        }),
        vscode.commands.registerCommand('iris-terminal.snippet.run', (arg?: unknown) => {
            const sel = view.selection[0];
            if (arg === undefined && sel && !isSnippet(sel) && sel.kind === 'more') {       // Enter on "… more lines": open the code
                const m = getSnippet(context, sel.snip.id);
                return m && actions.edit(m);
            }
            const s = resolve(arg);
            return s ? actions.run(s) : pickAndRunSnippet(context, actions.run);
        }),
        vscode.commands.registerCommand('iris-terminal.snippet.edit', (arg?: unknown) => { const s = resolve(arg); return s && actions.edit(s); }),
        vscode.commands.registerCommand('iris-terminal.snippet.rename', (arg?: unknown) => { const s = resolve(arg); return s && renameSnippet(context, s.id); }),
        vscode.commands.registerCommand('iris-terminal.snippet.delete', (arg?: unknown) => { const s = resolve(arg); return s && deleteSnippet(context, s.id, true); }),
        vscode.commands.registerCommand('iris-terminal.snippet.saveSelection', () => saveSelectionAsSnippet(context)),
        ...[1, 2, 3, 4].flatMap(n => ['', '.on'].map(suffix =>
            vscode.commands.registerCommand(`iris-terminal.snippet.tabSize.${n}${suffix}`, () => setTabSize(n))))
    ];
}

/** Tab Width submenu (right-click, or the dropdown in the tab's title bar): 1-4 spaces, saved as a user setting. */
async function setTabSize(n: number) {
    if (n === tabSize()) return;
    await vscode.workspace.getConfiguration().update(TAB_SIZE_KEY, n, vscode.ConfigurationTarget.Global);
}

/** "+" in the Snippets tab: the editor's selection (or current line) straight into a snippet, without the Fill-in step. */
async function saveSelectionAsSnippet(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage('IRIS Terminal: open a file and select the code to save as a snippet.'); return; }
    let text = editor.selections.map(sel => editor.document.getText(sel)).filter(t => t.trim() !== '').join('\n');
    if (text.trim() === '') text = editor.document.lineAt(editor.selection.active.line).text;
    text = text.replace(/\r\n/g, '\n');
    if (text.trim() === '') { vscode.window.showInformationMessage('IRIS Terminal: nothing selected to save.'); return; }
    const cls = /\.\.[A-Za-z%]|\$this/i.test(text) ? parseClassContext(editor.document.getText()) : undefined;
    const name = await promptSaveSnippet(context, { code: text, cls });
    if (name) vscode.window.setStatusBarMessage(`IRIS Terminal: saved snippet "${name}"`, 5000);
}
