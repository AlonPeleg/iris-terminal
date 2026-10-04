import * as vscode from 'vscode';
import * as net from 'net';
import * as tls from 'tls';
import { registerGlobalWatch } from './watchPanel';
import { Analysis, analyzeSelection, applyAnswers, buildFillParts, classifyAnswer, fillValuesToAnswers, flattenForTerminal, ObjectChoice, objectExpression, parseClassContext, parseIncDefines, Slot } from './sendSelection';

let viewerPanel: vscode.WebviewPanel | undefined;
// True once the currently-open Global Viewer webview's script has announced itself as 'ready'
// (registered its message listener). Reset to false whenever a fresh panel is created, since a
// brand-new webview's script hasn't run yet and would silently drop a message sent too early.
let viewerPanelReady = false;
// Adds that arrive before the (re)created panel is ready get queued here and flushed once it is,
// instead of being lost to the classic "postMessage before the listener exists" race.
let queuedViewerAdds: { server: string; global: string; value: string; time: string }[] = [];
// Extension-wide handle used for globalState access from functions outside activate().
let extContext: vscode.ExtensionContext | undefined;
const VIEWER_STATE_KEY = 'iris-terminal.globalViewerState';
// The webview is the source of truth for its own rich entry objects (delimiter, flipped, collapsed,
// pieceSearch, hideEmpty, ...); every time it persists, it also mirrors that state here via
// 'syncState' so a fully-closed-and-reopened panel can be hydrated from something durable instead of
// starting empty (a webview's own vscode.setState() doesn't survive the panel being disposed).
let lastKnownViewerState: { entries: any[]; viewMode: string } = { entries: [], viewMode: 'grid' };
// The terminal that was focused right when a brand-new Global Viewer panel got created — stashed so
// the 'ready' handler can briefly focus the panel (to make "keep editor" unambiguous) and then hand
// focus straight back, instead of leaving it stuck on the panel.
let pendingKeepEditorTerminal: vscode.Terminal | undefined;

export type SslMode = 'require' | 'prefer' | 'off';

export interface IrisSession {
    terminal?: vscode.Terminal;
    client?: net.Socket | tls.TLSSocket;
    writeEmitter: vscode.EventEmitter<string>;
    nameEmitter: vscode.EventEmitter<string>;
    closeEmitter: vscode.EventEmitter<number | void>;
    decoder: InstanceType<typeof TextDecoder>;

    host: string;
    user: string;
    pass: string;
    serverId: string;
    serverDisplayName: string;
    initialNamespace: string;
    encoding: string;

    lastKnownNS: string;
    targetNamespace: string; // namespace to `zn` into once logged in, frozen at the start of each connect attempt
    userSent: boolean;
    passSent: boolean;
    nsSent: boolean;
    isConnected: boolean;   // socket has produced data at least once
    isAlive: boolean;       // false once the socket has closed/errored and we're waiting for reconnect

    context: vscode.ExtensionContext;
    passSource: 'settings' | 'secret' | 'manual' | 'none';
    reauthPromptShown: boolean; // guards against firing multiple password prompts for one failed login
}

// Keep track of live sessions by their owning vscode.Terminal (not by name/title,
// which changes as the namespace changes and can collide across tabs).
export const sessions = new Map<vscode.Terminal, IrisSession>();

function getSecretKey(serverId: string, user: string): string {
    return `iris-terminal.password:${serverId}:${user}`;
}

export function activate(context: vscode.ExtensionContext) {

    extContext = context;
    lastKnownViewerState = context.globalState.get<{ entries: any[]; viewMode: string }>(VIEWER_STATE_KEY, { entries: [], viewMode: 'grid' });

    // --- ENHANCED AUTO-PIN LISTENER ---
    const pinListener = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor && editor.document.uri.scheme === 'isfs') {
            // Strike 1: Immediate
            await vscode.commands.executeCommand('workbench.action.keepEditor');

            // Strike 2 & 3: After server handshake/refresh
            [200, 500].forEach(delay => {
                setTimeout(async () => {
                    if (vscode.window.activeTextEditor === editor) {
                        await vscode.commands.executeCommand('workbench.action.keepEditor');
                    }
                }, delay);
            });
        }
    });

    let disposable = vscode.commands.registerCommand('iris-terminal.open', async (uri?: vscode.Uri) => {
        const config = vscode.workspace.getConfiguration();
        const serverList: any = config.get('intersystems.servers') || config.get('interSystems.servers') || {};

        let activeServerName = '';
        let detectedNamespace = '';
        let targetUri = uri || vscode.window.activeTextEditor?.document.uri;

        if (targetUri && targetUri.scheme.startsWith('isfs')) {
            const parts = targetUri.authority.split(':');
            activeServerName = parts[0];
            detectedNamespace = parts[1] || '';
        } else if (targetUri) {
            const folder = vscode.workspace.getWorkspaceFolder(targetUri);
            if (folder) {
                activeServerName = vscode.workspace.getConfiguration('objectscript', folder.uri).get<string>('conn.server') || '';
                detectedNamespace = vscode.workspace.getConfiguration('objectscript', folder.uri).get<string>('conn.ns') || '';
            }
        }

        const serverItems: vscode.QuickPickItem[] = Object.keys(serverList).map(name => {
            const serverEntry = serverList[name];
            const isMatch = (name === activeServerName);
            const displayName = serverEntry.description && serverEntry.description.trim() !== "" ? serverEntry.description : name;
            return {
                label: isMatch ? `$(star-full) ${displayName}` : `$(server) ${displayName}`,
                description: serverEntry.webServer?.host || serverEntry.host || '',
                detail: name
            };
        });

        // Sort matched (starred) server to the top; stable otherwise.
        serverItems.sort((a, b) => Number(b.label.includes('star-full')) - Number(a.label.includes('star-full')));

        const selection = await vscode.window.showQuickPick(serverItems, { placeHolder: 'Select an IRIS server' });
        if (!selection || !selection.detail) return;

        const chosenId = selection.detail;
        const entry = serverList[chosenId];
        const serverLabel = selection.label.replace('$(star-full) ', '').replace('$(server) ', '');

        // detectedNamespace was read from whatever isfs file/editor happened to be active,
        // which is only meaningful if it actually belongs to the server just picked. If the
        // user picked a different server than the one detected, that namespace belongs to the
        // OTHER server and must not be carried over — otherwise we'd try to `zn` into a
        // namespace name that may not even exist on this server.
        if (chosenId !== activeServerName) {
            detectedNamespace = '';
        }

        const host = entry?.webServer?.host || entry?.host || '';
        const user = entry?.username || '';
        let pass = entry?.password || '';
        let passSource: IrisSession['passSource'] = pass ? 'settings' : 'none';

        // --- Secure password handling ---
        // Prefer a password already in settings.json for backward compatibility, but never
        // require plaintext storage: if none is configured, check SecretStorage, and if that's
        // empty too, prompt once and offer to remember it securely.
        if (!pass && user) {
            const secretKey = getSecretKey(chosenId, user);
            pass = (await context.secrets.get(secretKey)) || '';
            if (pass) {
                passSource = 'secret';
            } else {
                const entered = await vscode.window.showInputBox({
                    prompt: `Password for ${user}@${chosenId} (leave blank to skip auto-login)`,
                    password: true,
                    ignoreFocusOut: true
                });
                if (entered) {
                    pass = entered;
                    passSource = 'manual';
                    const remember = await vscode.window.showQuickPick(['Yes', 'No'], {
                        placeHolder: 'Remember this password securely (VS Code Secret Storage)?'
                    });
                    if (remember === 'Yes') {
                        await context.secrets.store(secretKey, entered);
                        passSource = 'secret';
                    }
                }
            }
        } else if (pass) {
            vscode.window.showWarningMessage(
                `IRIS Terminal: the password for "${chosenId}" is stored in plain text in settings.json. ` +
                `Remove it from settings.json and reconnect to store it securely instead.`,
                'Got it'
            );
        }

        const encodingSelection = await vscode.window.showQuickPick([
            { label: "Hebrew (Windows-1255)", description: "Cache servers", detail: "windows1255" },
            { label: "UTF-8", description: "IRIS servers", detail: "utf8" }
        ], { placeHolder: `Select Encoding for ${chosenId}` });

        if (!encodingSelection) return;
        const chosenEncoding = encodingSelection.detail;

        const finalHost = await vscode.window.showInputBox({
            prompt: `Connect to ${chosenId} (${encodingSelection.label})`,
            value: host,
            ignoreFocusOut: true
        });

        if (!finalHost) return;

        openTerminal(context, {
            host: finalHost,
            user,
            pass,
            passSource,
            serverId: chosenId,
            serverDisplayName: serverLabel,
            initialNamespace: detectedNamespace,
            encoding: chosenEncoding || 'utf8'
        });
    });

    // --- GLOBAL VIEWER LINK PROVIDER (only inside IRIS terminals) ---
    let linkProvider = vscode.window.registerTerminalLinkProvider({
        provideTerminalLinks: (context: vscode.TerminalLinkContext) => {
            if (!sessions.has(context.terminal)) return [];
            const line = context.line.trim();
            if (line.includes('=')) {
                return [{
                    startIndex: 0,
                    length: context.line.length,
                    tooltip: 'Ctrl+Click to view in Global Viewer',
                    data: { line: context.line, terminal: context.terminal }
                }];
            }
            return [];
        },
        handleTerminalLink: (link: any) => {
            const rawLine: string = link.data.line.trim();
            const time = new Date().toLocaleTimeString();
            const terminalName: string = link.data.terminal?.name || "IRIS Server";

            const eqIndex = rawLine.indexOf('=');
            let globalName = eqIndex >= 0 ? rawLine.slice(0, eqIndex).trim() : "Global Reference";
            let valuePart = eqIndex >= 0 ? rawLine.slice(eqIndex + 1).trim() : rawLine;

            // Strip a single pair of wrapping quotes, then unescape doubled quotes ("" -> ").
            valuePart = valuePart.replace(/^"|"$/g, '').replace(/""/g, '"');

            // The raw value is sent as-is; the webview splits it by whichever delimiter the
            // user has selected (default '*'), so the choice can be changed after the fact
            // without losing data.
            showInWebview(terminalName, globalName, valuePart, time);
        }
    });

    // --- RIGHT-CLICK SWITCH NAMESPACE COMMAND ---
    let switchNamespaceDisposable = vscode.commands.registerCommand('iris-terminal.switchNamespace', async (terminalContext?: any) => {
        let targetTerminal: vscode.Terminal | undefined;

        if (terminalContext && terminalContext.terminalId) {
            targetTerminal = vscode.window.terminals.find(t => (t as any).id === terminalContext.terminalId);
        }
        if (!targetTerminal) {
            targetTerminal = vscode.window.activeTerminal;
        }
        if (!targetTerminal) return;

        const session = sessions.get(targetTerminal);
        if (!session || !session.client || !session.isAlive) {
            vscode.window.showWarningMessage('IRIS Terminal: this session is not connected.');
            return;
        }

        targetTerminal.show();

        // One line execution context string to safely pause for terminal inputs before modifying instances
        const singleLineInteractivePrompt =
            "d ##class(%SYS.Namespace).ListAll(.res) s num=0,ns=\"\" f { s ns=$o(res(ns)) q:ns=\"\"  s num=num+1,idx(num)=ns w !,num,\" - \",ns } r !!, \"Select Namespace Number: \",input s target=$g(idx(input)) i target'=\"\" { zn target } else { w \" -> Selection Canceled.\" } k res,num,ns,idx,input,target w !" + "\r\n";

        session.client.write(singleLineInteractivePrompt);
    });

    // --- RECONNECT COMMAND (also reachable by pressing 'r' after a disconnect) ---
    let reconnectDisposable = vscode.commands.registerCommand('iris-terminal.reconnect', async (terminalContext?: any) => {
        let targetTerminal: vscode.Terminal | undefined;
        if (terminalContext && terminalContext.terminalId) {
            targetTerminal = vscode.window.terminals.find(t => (t as any).id === terminalContext.terminalId);
        }
        if (!targetTerminal) {
            targetTerminal = vscode.window.activeTerminal;
        }
        if (!targetTerminal) return;

        const session = sessions.get(targetTerminal);
        if (!session) return;
        reconnectSession(session);
    });

    // --- CLEAR A STORED PASSWORD ---
    let clearPasswordDisposable = vscode.commands.registerCommand('iris-terminal.clearStoredPassword', async () => {
        const config = vscode.workspace.getConfiguration();
        const serverList: any = config.get('intersystems.servers') || config.get('interSystems.servers') || {};

        const items: vscode.QuickPickItem[] = [];
        for (const serverId of Object.keys(serverList)) {
            const user = serverList[serverId]?.username;
            if (user) items.push({ label: serverId, description: user });
        }
        if (items.length === 0) {
            vscode.window.showInformationMessage('IRIS Terminal: no servers with a username are configured.');
            return;
        }

        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Clear stored password for which server?' });
        if (!picked) return;

        await context.secrets.delete(getSecretKey(picked.label, picked.description!));
        vscode.window.showInformationMessage(`IRIS Terminal: cleared the stored password for ${picked.description}@${picked.label} (if one was stored).`);
    });

    let terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
        const session = sessions.get(terminal);
        if (session?.client) {
            session.client.removeAllListeners();
            session.client.destroy();
        }
        sessions.delete(terminal);
    });

    registerViewerPanelSerializer(context);

    // Tracks the Global Viewer tab's real preview/pinned status (whatever the cause — our own
    // auto-keep, the manual pin button, or the user pinning it themselves via the tab's context
    // menu) so the webview can hide its pin icon once there's genuinely nothing left to pin.
    const viewerTabsListener = vscode.window.tabGroups.onDidChangeTabs(() => updateViewerPinnedState());

    context.subscriptions.push(disposable, linkProvider, pinListener, switchNamespaceDisposable, reconnectDisposable, clearPasswordDisposable, terminalCloseListener, viewerTabsListener);
    context.subscriptions.push(...registerSendSelectionCommands(context));
    context.subscriptions.push(...registerGlobalWatch(context, {
        getSslMode, getRejectUnauthorized, getPort: getTelnetPort, getSecretKey
    }));
}

// ---------------------------------------------------------------------------------------------
// Send editor selection to an IRIS terminal (with variable / macro substitution)
// ---------------------------------------------------------------------------------------------

function registerSendSelectionCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('iris-terminal.sendSelection', () => sendSelectionToIris(context, false)),
        vscode.commands.registerCommand('iris-terminal.runSelection', () => sendSelectionToIris(context, true)),
        vscode.window.registerWebviewViewProvider(FILL_IN_VIEW_ID, new FillInViewProvider(),
            { webviewOptions: { retainContextWhenHidden: true } })
    ];
}

// The IRIS terminal to send to: the only one, or - when several are open - the one picked from a list
// (the active one is listed first).
async function pickIrisSession(): Promise<IrisSession | undefined> {
    const all = [...sessions.values()].filter(s => s.terminal);
    if (all.length === 0) {
        const act = await vscode.window.showWarningMessage('IRIS Terminal: no IRIS terminal is open.', 'Open IRIS Terminal');
        if (act) await vscode.commands.executeCommand('iris-terminal.open');
        return undefined;
    }

    let chosen: IrisSession | undefined;
    if (all.length === 1) {
        chosen = all[0];
    } else {
        const active = vscode.window.activeTerminal;
        all.sort((a, b) => Number(b.terminal === active) - Number(a.terminal === active));
        const pick = await vscode.window.showQuickPick(
            all.map(s => ({
                label: s.terminal!.name,
                description: [s.terminal === active ? 'active' : '', (!s.isAlive || !s.client) ? 'disconnected' : ''].filter(Boolean).join(' · '),
                session: s
            })),
            { title: 'Send to which IRIS terminal?', placeHolder: 'Pick the terminal to send the code to' }
        );
        chosen = pick?.session;
    }
    if (!chosen) return undefined;

    if (!chosen.isAlive || !chosen.client) {
        vscode.window.showWarningMessage(`IRIS Terminal: "${chosen.terminal?.name}" is disconnected. Reconnect it first (right-click the terminal tab).`);
        return undefined;
    }
    return chosen;
}

function slotKindLabel(slot: Slot): string {
    switch (slot.kind) {
        case 'byref': return 'By-reference argument';
        case 'macro': return 'Macro';
        case 'relative': return 'Instance reference (only works inside a class)';
        default: return 'Variable';
    }
}

function validateSlotAnswer(slot: Slot, value: string): vscode.InputBoxValidationMessage | undefined {
    const info = classifyAnswer(value);
    if (info.kind === 'empty') return undefined;
    if (info.kind === 'invalid') {
        return { message: info.label, severity: vscode.InputBoxValidationSeverity.Warning };
    }
    if (info.kind === 'byref' && !slot.argSlot) {
        return { message: 'By reference — only valid where the original is a bare call argument', severity: vscode.InputBoxValidationSeverity.Warning };
    }
    if (slot.kind === 'byref' && info.kind !== 'byref') {
        return { message: `${info.label} — passed by value (type .name to keep it by reference)`, severity: vscode.InputBoxValidationSeverity.Info };
    }
    return { message: info.label, severity: vscode.InputBoxValidationSeverity.Info };
}

// Simple `#define Name value` macros found in the workspace's .inc files, to prefill the prompt.
async function findMacroDefinitions(): Promise<Record<string, string>> {
    const defs: Record<string, string> = {};
    try {
        const files = await vscode.workspace.findFiles('**/*.inc', '**/{node_modules,.git}/**', 300);
        const decoder = new TextDecoder('utf-8');
        for (const f of files) {
            try {
                Object.assign(defs, parseIncDefines(decoder.decode(await vscode.workspace.fs.readFile(f))));
            } catch { /* unreadable file: skip */ }
        }
    } catch { /* no workspace / search failed: no prefill */ }
    return defs;
}

// --- Send Selection ---------------------------------------------------------------------------

async function sendSelectionToIris(context: vscode.ExtensionContext, run: boolean) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('IRIS Terminal: open a file and select some code first.');
        return;
    }

    let text = editor.selections.map(s => editor.document.getText(s)).filter(t => t.trim() !== '').join('\n');
    if (text.trim() === '') text = editor.document.lineAt(editor.selection.active.line).text;   // no selection: current line
    if (text.trim() === '') {
        vscode.window.showInformationMessage('IRIS Terminal: nothing to send.');
        return;
    }
    text = text.replace(/\r\n/g, '\n');

    const session = await pickIrisSession();
    if (!session) return;
    const terminalName = session.terminal?.name ?? 'IRIS';

    const cfg = vscode.workspace.getConfiguration('iris-terminal.sendSelection');
    // The class the code comes from: lets `..Method(` become `##class(Pkg.Class).Method(` and tells instance methods apart.
    // (only looked up when the code uses `..` or $this: nothing to translate otherwise)
    const usesCurrentClass = /\.\.[A-Za-z%]|\$this/i.test(text);
    const analysis = analyzeSelection(text, usesCurrentClass ? parseClassContext(editor.document.getText()) : undefined);
    const wantsMacroLookup = cfg.get<boolean>('lookupMacros', true) &&
        analysis.slots.some(s => s.kind === 'macro' && !s.text.includes('('));
    const macroDefs = wantsMacroLookup ? await findMacroDefinitions() : {};

    const prefillFor = (slot: Slot): string =>
        slot.kind === 'macro' && !slot.text.includes('(') ? (macroDefs[slot.text.slice(3).toLowerCase()] ?? '') : '';

    // Nothing to ask (no variables, no object needed): send right away.
    if (analysis.slots.length === 0 && analysis.objectRefs.length === 0) {
        await deliverToIris(session, terminalName, flattenForTerminal(applyAnswers(text, analysis, {})), run);
        return;
    }

    // Otherwise open the fill-in view. Every field starts empty (= keep the original); only a macro found
    // in a workspace .inc file starts with its value.
    const initial: Record<string, string> = {};
    for (const slot of analysis.slots) {
        const v = prefillFor(slot);
        if (v.trim() !== '') initial[slot.key] = v;
    }
    await openFillIn(session, terminalName, text, analysis, run, initial);
}

// Writes the line to the terminal. Returns false if it was not sent (nothing to send, or the session
// dropped) so a caller can keep its UI open.
async function deliverToIris(session: IrisSession, terminalName: string, finalText: string,
    run: boolean, beforeWrite?: () => Promise<void>): Promise<boolean> {
    if (finalText === '') {
        vscode.window.showInformationMessage('IRIS Terminal: nothing to send.');
        return false;
    }

    // The session may have dropped while the fill-in view was open.
    if (!session.isAlive || !session.client) {
        vscode.window.showWarningMessage(`IRIS Terminal: "${terminalName}" disconnected before the text could be sent.`);
        return false;
    }

    if (beforeWrite) await beforeWrite();

    // Same path as the keyboard: bytes straight to the server, which echoes them. "Send" stops before
    // Enter so the line can be reviewed or edited in the terminal; "Send and Run" adds Enter.
    session.client.write(encodeInput(finalText + (run ? '\r' : ''), session.encoding));
    session.terminal?.show(false);                // focus the terminal (Send: Enter is one key away; Run: see the output)
    return true;
}

// --- the fill-in view: the code with the variables as inline inputs ------------------------------
// A small tab in the bottom panel (next to Terminal), shown only while it is being used, so it never
// splits or covers the editor. Opens right after the terminal is chosen.

const FILL_IN_VIEW_ID = 'iris-terminal.fillIn';
const FILL_IN_CONTEXT_KEY = 'iris-terminal.fillInActive';

interface FillInState {
    session: IrisSession;
    terminalName: string;
    src: string;
    analysis: Analysis;
    run: boolean;
}

let fillInView: vscode.WebviewView | undefined;
let fillInReady = false;
let fillInState: FillInState | undefined;
let fillInBusy = false;

function postFillInLoad(initial: Record<string, string>) {
    const st = fillInState;
    if (!st || !fillInView) return;
    const info: Record<string, string> = {};
    for (const slot of st.analysis.slots) {
        const uses = slot.occurrences.length > 1 ? ` (used ${slot.occurrences.length}×)` : '';
        info[slot.key] = `${slotKindLabel(slot)}${uses}`;
    }
    fillInView.webview.postMessage({
        type: 'load',
        terminal: st.terminalName,
        runLabel: st.run ? 'Run' : 'Send',
        parts: buildFillParts(st.src, st.analysis),
        info,
        initial,
        object: st.analysis.objectRefs.length === 0 ? null : {
            className: st.analysis.className ?? '',
            count: st.analysis.objectRefs.length,
            uses: [...new Set(st.analysis.objectRefs.map(r => r.text))].slice(0, 4)
        }
    });
}

let fillInInitial: Record<string, string> = {};

async function openFillIn(session: IrisSession, terminalName: string, src: string, analysis: Analysis, run: boolean,
    initial: Record<string, string>) {
    fillInState = { session, terminalName, src, analysis, run };
    fillInInitial = initial;
    await vscode.commands.executeCommand('setContext', FILL_IN_CONTEXT_KEY, true);
    if (fillInView && fillInReady) postFillInLoad(initial);       // else: sent when the view reports it is ready
    await vscode.commands.executeCommand(`${FILL_IN_VIEW_ID}.focus`);
}

async function closeFillIn() {
    fillInState = undefined;
    fillInInitial = {};
    fillInView?.webview.postMessage({ type: 'clear' });
    await vscode.commands.executeCommand('setContext', FILL_IN_CONTEXT_KEY, false);
}

class FillInViewProvider implements vscode.WebviewViewProvider {
    resolveWebviewView(view: vscode.WebviewView) {
        fillInView = view;
        fillInReady = false;
        view.webview.options = { enableScripts: true };
        view.webview.html = fillInHtml(getFillInNonce(), view.webview.cspSource);
        view.onDidDispose(() => { if (fillInView === view) { fillInView = undefined; fillInReady = false; } });

        view.webview.onDidReceiveMessage(async (msg: any) => {
            if (msg?.type === 'ready') {
                fillInReady = true;
                postFillInLoad(fillInInitial);
                return;
            }
            const st = fillInState;
            if (!st) return;

            if (msg?.type === 'cancel') {
                await closeFillIn();
                await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                return;
            }

            if (msg?.type === 'check') {
                const slot = st.analysis.slots.find(s => s.key === msg.key);
                if (!slot) return;
                const m = validateSlotAnswer(slot, String(msg.value ?? ''));
                view.webview.postMessage({
                    type: 'hint', key: msg.key, text: m?.message ?? '',
                    warn: m?.severity === vscode.InputBoxValidationSeverity.Warning
                });
                return;
            }

            if (msg?.type === 'submit' && !fillInBusy) {
                fillInBusy = true;
                try {
                    const answers = fillValuesToAnswers(st.analysis, msg.values ?? {});

                    // which object the `..Method(` / `..Property` / `$this` uses should run on
                    let object: ObjectChoice | undefined;
                    const problems: string[] = [];
                    if (st.analysis.objectRefs.length > 0) {
                        const mode = msg.object?.mode === 'new' || msg.object?.mode === 'openid' ? msg.object.mode : 'var';
                        object = { mode, value: String(msg.object?.value ?? '') };
                        const expr = objectExpression(st.analysis, object);
                        const uses = [...new Set(st.analysis.objectRefs.map(r => r.text))].slice(0, 3).join(', ');
                        if (expr === '') {
                            problems.push(`${uses}: no object given - it will fail at the terminal`);
                        } else if (mode !== 'new') {
                            const info = classifyAnswer(object.value);
                            if (info.kind === 'invalid') problems.push(`object: ${info.label}`);
                        }
                    }
                    for (const slot of st.analysis.slots) {
                        const a = answers[slot.key];
                        if (!a) continue;
                        const m = validateSlotAnswer(slot, a);
                        if (m && m.severity === vscode.InputBoxValidationSeverity.Warning) problems.push(`${slot.text}: ${m.message}`);
                    }
                    if (problems.length > 0) {
                        const pick = await vscode.window.showWarningMessage(`IRIS Terminal: ${problems.join(' · ')}`, 'Send anyway');
                        if (pick !== 'Send anyway') return;     // stays open so it can be fixed
                    }

                    const finalText = flattenForTerminal(applyAnswers(st.src, st.analysis, answers, object));
                    await deliverToIris(st.session, st.terminalName, finalText, st.run, closeFillIn);
                } finally {
                    fillInBusy = false;
                }
            }
        });
    }
}

function getFillInNonce(): string {
    let out = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}

function fillInHtml(nonce: string, cspSource: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    [hidden] { display: none !important; }
    body { margin: 0; padding: 8px 12px; color: var(--vscode-foreground); background: var(--vscode-panel-background, var(--vscode-editor-background)); font-family: var(--vscode-font-family); }
    .head { font-size: 12px; opacity: .85; margin-bottom: 6px; }
    .peek {
        border-top: 1px solid var(--vscode-peekView-border, var(--vscode-focusBorder));
        border-bottom: 1px solid var(--vscode-peekView-border, var(--vscode-focusBorder));
        background: var(--vscode-peekViewEditor-background, var(--vscode-editor-background));
        padding: 8px 10px; overflow: auto; max-height: 60vh;
    }
    #code { margin: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px);
            line-height: 1.7; white-space: pre-wrap; word-break: break-word; tab-size: 4; }
    input {
        font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder)); border-radius: 3px;
        padding: 0 3px; margin: 0 1px; box-sizing: content-box; outline: none; vertical-align: baseline; max-width: 80vw;
    }
    input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }
    input:focus { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
    input.mirror { background: transparent; border-style: dashed; cursor: default; }
    input.bad { border-color: var(--vscode-inputValidation-warningBorder, orange); }
    .info { min-height: 18px; margin-top: 6px; font-size: 12px; }
    .info .warn { color: var(--vscode-editorWarning-foreground, orange); }
    .bar { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
    button { font: inherit; font-size: 12px; padding: 3px 12px; border: 1px solid transparent; border-radius: 2px; cursor: pointer;
             color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .keys { margin-left: auto; font-size: 11px; opacity: .65; }
    .objrow { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; font-size: 12px; }
    .objrow code, .objrow .static { font-family: var(--vscode-editor-font-family, monospace); }
    .objrow .static { opacity: .85; }
    select { font: inherit; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
             border: 1px solid var(--vscode-dropdown-border, var(--vscode-focusBorder)); border-radius: 2px; padding: 2px 4px; }
    select:focus { outline: 1px solid var(--vscode-focusBorder); }
    .types { margin-top: 6px; font-size: 11px; opacity: .65; font-family: var(--vscode-editor-font-family, monospace); }
    .empty { opacity: .6; font-size: 12px; }
</style>
</head>
<body>
<div id="idle" class="empty">Nothing to fill in.</div>
<div id="main" hidden>
    <div class="head" id="head"></div>
    <div class="objrow" id="objrow" hidden>
        <span>Object for <code id="objfor"></code>:</span>
        <select id="objmode" aria-label="How to get the object">
            <option value="var">Variable</option>
            <option value="new">%New</option>
            <option value="openid">%OpenId</option>
        </select>
        <span class="static" id="objpre"></span>
        <input id="objval" type="text" spellcheck="false" autocomplete="off">
        <span class="static" id="objpost"></span>
    </div>
    <div class="peek"><pre id="code"></pre></div>
    <div class="info" id="info"></div>
    <div class="types">type: 123 &middot; "text" &middot; [1,2] &middot; {"ID":1} &middot; name &middot; .byRef &middot; empty = keep as is</div>
    <div class="bar">
        <button id="go"></button>
        <button id="cancel" class="secondary">Cancel</button>
        <span class="keys" id="keys"></span>
    </div>
</div>
<script nonce="${nonce}">
(function () {
    const vscode = acquireVsCodeApi();
    const main = document.getElementById('main');
    const idle = document.getElementById('idle');
    const code = document.getElementById('code');
    const info = document.getElementById('info');
    const objrow = document.getElementById('objrow');
    const objmode = document.getElementById('objmode');
    const objval = document.getElementById('objval');
    let objectData = null;
    let byKey = {};          // key -> inputs (the first one is the editable one)
    let firsts = [];
    let hints = {};
    let infoText = {};

    function size(inp) {
        inp.style.width = (Math.max(inp.value.length, inp.placeholder.length, 1) + 1) + 'ch';
    }
    function showInfo(key) {
        info.textContent = '';
        const label = document.createElement('span');
        label.textContent = infoText[key] || '';
        info.appendChild(label);
        const h = hints[key];
        if (h && h.text) {
            const t = document.createElement('span');
            t.className = h.warn ? 'warn' : '';
            t.textContent = '  \\u2014  ' + h.text;
            info.appendChild(t);
        }
    }
    function submit() {
        const values = {};
        for (const key of Object.keys(byKey)) values[key] = byKey[key][0].value;
        const msg = { type: 'submit', values };
        if (objectData) msg.object = { mode: objmode.value, value: objmode.value === 'new' ? '' : objval.value };
        vscode.postMessage(msg);
    }

    // ---- the "Object for ..." row (only when the code uses ..Method( / ..Property / $this on an instance) ----
    function objFocusables() {
        const list = [];
        if (objectData) {
            list.push(objmode);
            if (!objval.hidden) list.push(objval);
        }
        return list.concat(firsts);
    }
    function showObjInfo() {
        if (!objectData) return;
        info.textContent = '';
        const d = objectData;
        const mode = objmode.value;
        const t = document.createElement('span');
        const many = d.count > 1;
        if (mode === 'var') {
            const v = objval.value.trim() || 'obj';
            t.textContent = 'Uses the object in ' + v + ':  ' + v + '.\u2026' + '   (type the variable that holds the object)';
        } else if (mode === 'new') {
            t.textContent = many
                ? 'Created once: set obj=##class(' + d.className + ').%New()  \u2014 then obj.\u2026 (used ' + d.count + '\u00d7)'
                : '##class(' + d.className + ').%New().\u2026';
        } else {
            const id = objval.value.trim() || '\u2026';
            t.textContent = many
                ? 'Opened once: set obj=##class(' + d.className + ').%OpenId(' + id + ')  \u2014 then obj.\u2026 (used ' + d.count + '\u00d7)'
                : '##class(' + d.className + ').%OpenId(' + id + ').\u2026';
        }
        info.appendChild(t);
    }
    function syncObjMode() {
        const mode = objmode.value;
        const d = objectData;
        objval.hidden = mode === 'new';
        document.getElementById('objpre').textContent = mode === 'openid' ? '##class(' + d.className + ').%OpenId(' : (mode === 'new' ? '##class(' + d.className + ').%New()' : '');
        document.getElementById('objpost').textContent = mode === 'openid' ? ')' : '';
        objval.placeholder = mode === 'openid' ? 'Id' : 'obj';
        objval.style.width = (mode === 'openid' ? 12 : 14) + 'ch';
    }
    function bindObjectRow() {
        for (const el of [objmode, objval]) {
            el.addEventListener('focus', () => { if (el === objval) objval.select(); showObjInfo(); });
            el.addEventListener('keydown', (e) => {
                const list = objFocusables();
                const i = list.indexOf(el);
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (i < list.length - 1) list[i + 1].focus(); else submit();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    vscode.postMessage({ type: 'cancel' });
                }
            });
        }
        objmode.addEventListener('change', () => { syncObjMode(); showObjInfo(); if (!objval.hidden) objval.focus(); });
        objval.addEventListener('input', showObjInfo);
    }
    bindObjectRow();

    function render(data) {
        code.textContent = '';
        info.textContent = '';
        byKey = {}; firsts = []; hints = {}; infoText = data.info || {};
        objectData = data.object || null;
        objrow.hidden = !objectData;
        if (objectData) {
            objmode.value = 'var';
            objval.value = '';
            document.getElementById('objfor').textContent = objectData.uses.join(', ') + (objectData.count > objectData.uses.length ? ', \u2026' : '');
            syncObjMode();
        }
        document.getElementById('head').textContent = data.runLabel + ' to ' + data.terminal + ' \\u2014 fill in the variables';
        document.getElementById('go').textContent = data.runLabel;
        document.getElementById('keys').textContent =
            'Tab / Enter: next \\u00b7 Shift+Tab: back \\u00b7 Enter on the last: ' + data.runLabel.toLowerCase() + ' \\u00b7 Esc: cancel';

        for (const p of data.parts) {
            if (p.lit !== undefined) { code.appendChild(document.createTextNode(p.lit)); continue; }
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.spellcheck = false;
            inp.autocomplete = 'off';
            inp.placeholder = p.text;
            inp.value = (data.initial && data.initial[p.key]) || '';
            inp.dataset.key = p.key;
            (byKey[p.key] = byKey[p.key] || []).push(inp);
            if (p.first) {
                firsts.push(inp);
            } else {
                inp.classList.add('mirror');
                inp.readOnly = true;
                inp.tabIndex = -1;
                const first = byKey[p.key][0];
                inp.addEventListener('focus', () => first.focus());
            }
            size(inp);
            code.appendChild(inp);
        }

        for (const inp of firsts) {
            const key = inp.dataset.key;
            inp.addEventListener('focus', () => { inp.select(); showInfo(key); });
            inp.addEventListener('input', () => {
                for (const other of byKey[key]) { other.value = inp.value; size(other); }
                vscode.postMessage({ type: 'check', key, value: inp.value });
            });
            inp.addEventListener('keydown', (e) => {
                const list = objFocusables();
                const i = list.indexOf(inp);
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (i < list.length - 1) list[i + 1].focus(); else submit();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    vscode.postMessage({ type: 'cancel' });
                }
            });
            if (inp.value) vscode.postMessage({ type: 'check', key, value: inp.value });
        }

        idle.hidden = true;
        main.hidden = false;
        if (objectData) { objval.focus(); showObjInfo(); }   // the object comes first: type its variable (or pick %New / %OpenId)
        else if (firsts.length) firsts[0].focus();
    }

    window.addEventListener('message', (ev) => {
        const m = ev.data;
        if (!m) return;
        if (m.type === 'load') render(m);
        else if (m.type === 'clear') { main.hidden = true; idle.hidden = false; code.textContent = ''; }
        else if (m.type === 'hint') {
            hints[m.key] = m;
            for (const inp of byKey[m.key] || []) inp.classList.toggle('bad', !!m.warn);
            const a = document.activeElement;
            if (a && a.dataset && a.dataset.key === m.key) showInfo(m.key);
        }
    });

    document.getElementById('go').addEventListener('click', submit);
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Finds the Global Viewer's own tab (if it's currently open) across all tab groups/windows.
// Returns undefined if it can't be found (e.g. the panel was just disposed).
function findViewerTab(): vscode.Tab | undefined {
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('globalViewer')) {
                return tab;
            }
        }
    }
    return undefined;
}

// Tells the webview whether its tab is still a preview tab, so it can show/hide its pin icon.
function updateViewerPinnedState() {
    if (!viewerPanel) return;
    const tab = findViewerTab();
    if (tab) viewerPanel.webview.postMessage({ command: 'previewState', isPreview: !!tab.isPreview });
}

// A brand-new tab opens as a "preview" tab (italic title, silently replaced by the next
// preview-opened editor) until something explicitly keeps it. `workbench.action.keepEditor` only
// acts on whatever VS Code currently considers the active editor pane, and `panel.reveal()` gives no
// promise to await before that registers — so a single fire-and-forget attempt right after reveal
// can still lose that race. This instead checks the tab's REAL state via the Tabs API after each
// attempt (rather than hoping one call landed in time) and keeps retrying with backoff until it
// actually reports not-preview, or it runs out of attempts.
async function ensureViewerTabKept(terminalToRestore: vscode.Terminal | undefined) {
    const delaysMs = [0, 80, 250, 600];
    for (const delay of delaysMs) {
        if (delay > 0) await sleep(delay);
        try { await vscode.commands.executeCommand('workbench.action.keepEditor'); } catch { /* command missing on very old VS Code */ }
        const tab = findViewerTab();
        if (tab && tab.isPreview === false) break; // confirmed — stop retrying
    }
    if (terminalToRestore) terminalToRestore.show(false);
    updateViewerPinnedState();
}

function createViewerPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
        'globalViewer',
        'Global Viewer',
        vscode.ViewColumn.Two,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );
    viewerPanelReady = false;
    queuedViewerAdds = [];
    wireViewerPanel(panel);
    return panel;
}

function wireViewerPanel(panel: vscode.WebviewPanel) {
    panel.webview.onDidReceiveMessage(message => {
        if (message.command === 'pinTab') {
            ensureViewerTabKept(undefined);
        } else if (message.command === 'moveToNewWindow') {
            vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
        } else if (message.command === 'ready') {
            // Briefly give the panel real focus (removing all ambiguity about which editor is
            // "active" before pinning it), then hand focus straight back to whatever terminal the
            // user was in, so nothing visibly changes for them beyond the tab losing its italics.
            const terminalToRestore = pendingKeepEditorTerminal;
            pendingKeepEditorTerminal = undefined;
            panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Two, false);
            ensureViewerTabKept(terminalToRestore);
            // The fresh webview's script has registered its message listener — safe to hydrate it
            // now. Send the durable snapshot first, then flush anything that tried to arrive while
            // this panel was still loading (see showInWebview).
            viewerPanelReady = true;
            panel.webview.postMessage({ command: 'initEntries', entries: lastKnownViewerState.entries, viewMode: lastKnownViewerState.viewMode });
            queuedViewerAdds.forEach(add => panel.webview.postMessage({ command: 'addEntry', ...add }));
            queuedViewerAdds = [];
        } else if (message.command === 'syncState') {
            lastKnownViewerState = {
                entries: Array.isArray(message.entries) ? message.entries : [],
                viewMode: message.viewMode === 'grid' ? 'grid' : 'list'
            };
            if (extContext) extContext.globalState.update(VIEWER_STATE_KEY, lastKnownViewerState);
        }
    });
    panel.onDidDispose(() => {
        if (viewerPanel === panel) { viewerPanel = undefined; viewerPanelReady = false; queuedViewerAdds = []; }
    });
    panel.webview.html = getWebviewContent(panel.webview.cspSource);
}

// Lets VS Code recreate the Global Viewer after the window reloads while the tab was open. The
// panel is hydrated the same way a freshly-created one is (see the 'ready' handler above), from the
// durable extension-side snapshot rather than relying on the webview's own transient state.
function registerViewerPanelSerializer(context: vscode.ExtensionContext) {
    if (!vscode.window.registerWebviewPanelSerializer) return;
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('globalViewer', {
            deserializeWebviewPanel: async (panel: vscode.WebviewPanel) => {
                panel.webview.options = { enableScripts: true };
                viewerPanel = panel;
                viewerPanelReady = false;
                queuedViewerAdds = [];
                wireViewerPanel(panel);
            }
        })
    );
}

function showInWebview(server: string, global: string, value: string, time: string) {
    if (!viewerPanel) {
        viewerPanel = createViewerPanel();
    }

    // If the panel's webview script hasn't announced itself as 'ready' yet (it just got (re)created
    // and is still loading), sending 'addEntry' now would race the listener registration and the
    // message would simply be dropped — queue it instead; the 'ready' handler flushes the queue.
    if (viewerPanelReady) {
        viewerPanel.webview.postMessage({ command: 'addEntry', server, global, value, time });
    } else {
        queuedViewerAdds.push({ server, global, value, time });
    }
    viewerPanel.reveal(vscode.ViewColumn.Two, true);
}

function getWebviewContent(cspSource: string) {
    // Random per-load nonce so only this exact inline script may run (CSP script-src).
    const nonce = require('crypto').randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <style>
            body {
                font-family: var(--vscode-editor-font-family);
                color: var(--vscode-editor-foreground);
                background: var(--vscode-editor-background);
                padding: 15px;
                margin: 0;
            }
            .toolbar {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 15px;
                border-bottom: 1px solid var(--vscode-panel-border);
                position: sticky;
                top: 0;
                background: var(--vscode-editor-background);
                z-index: 1000;
                gap: 10px;
                flex-wrap: wrap;
            }
            #searchBox {
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border, transparent);
                border-radius: 3px;
                padding: 4px 8px;
                font-size: 12px;
                min-width: 160px;
            }
            .entry {
                border: 1px solid var(--vscode-panel-border);
                margin-bottom: 20px;
                border-radius: 4px;
                background: var(--vscode-editor-background);
                display: flex;
                flex-direction: column;
            }
            .entry.hidden { display: none; }
            .header {
                background: var(--vscode-sideBar-background);
                padding: 10px 12px;
                cursor: pointer;
                display: flex;
                align-items: center;
                font-size: 13px;
                position: sticky;
                top: 42px;
                z-index: 100;
                border-bottom: 1px solid var(--vscode-panel-border);
            }
            .header:hover { background: var(--vscode-list-hoverBackground); }
            .header-text { flex-grow: 1; display: flex; justify-content: space-between; align-items: center; margin-right: 10px; gap: 8px; }
            .content {
                max-height: 400px;
                overflow-y: auto;
                background: var(--vscode-editor-background);
            }
            .entry.collapsed .content { display: none; }
            .entry.collapsed .header { position: static; border-bottom: none; }
            .entry.collapsed .arrow { transform: rotate(-90deg); }
            .piece {
                display: flex;
                align-items: center;
                gap: 15px;
                border-bottom: 1px solid var(--vscode-panel-border);
                padding: 8px 12px;
                font-size: 12px;
            }
            .piece:last-child { border-bottom: none; }
            .num { color: var(--vscode-descriptionForeground); font-weight: bold; min-width: 25px; text-align: right; font-family: monospace; opacity: 0.6; }
            .piece-val { white-space: pre-wrap; word-break: break-all; flex: 1; }
            .piece-empty { opacity: 0.3; }
            .arrow { display: inline-block; width: 10px; transition: transform 0.1s; margin-right: 8px; font-size: 10px; }
            .server-info { font-weight: bold; color: var(--vscode-textLink-foreground); }
            .toolbar-actions { display: flex; gap: 4px; align-items: center; }
            .btn { border: none; padding: 4px; cursor: pointer; border-radius: 3px; display: flex; align-items: center; background: transparent; color: var(--vscode-foreground); }
            .btn:hover { background: var(--vscode-toolbar-hoverBackground); }
            .btn-flip { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid #80808066; padding: 2px 8px; font-size: 11px; }
            .btn-flip.active { background: #007acc; color: white; border-color: transparent; }
            .btn-copy { opacity: 0.6; font-size: 11px; padding: 2px 6px; border: 1px solid #80808044; }
            .btn-copy:hover { opacity: 1; }
            .btn-delete { color: var(--vscode-errorForeground); cursor: pointer; font-weight: bold; padding: 0 10px; font-size: 18px; opacity: 0.7; }
            .btn-delete:hover { opacity: 1; }
            .v-sep { border-left: 1px solid var(--vscode-panel-border); height: 16px; margin: 0 8px; }
            .delim-select, .delim-custom {
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border, transparent);
                border-radius: 3px;
                font-size: 11px;
                padding: 2px 4px;
            }
            .delim-custom { width: 40px; }
            .view-btn.active { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
            .entry-toolbar {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 6px 12px;
                background: var(--vscode-sideBar-background);
                border-bottom: 1px solid var(--vscode-panel-border);
                flex-wrap: wrap;
            }
            .entry.collapsed .entry-toolbar { display: none; }
            .piece-search {
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border, transparent);
                border-radius: 3px;
                padding: 3px 7px;
                font-size: 11.5px;
                flex: 1;
                min-width: 110px;
            }
            .hide-empty-label {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 11.5px;
                opacity: 0.85;
                cursor: pointer;
                white-space: nowrap;
                user-select: none;
            }
            .piece-stats {
                font-size: 11px;
                opacity: 0.6;
                white-space: nowrap;
                font-family: monospace;
            }
            .piece.piece-search-hidden { display: none; }
            #container.grid-view {
                display: flex;
                flex-wrap: wrap;
                gap: 14px;
                align-items: flex-start;
            }
            #container.grid-view .entry {
                flex: 1 1 320px;
                max-width: calc(33.333% - 10px);
                min-width: 280px;
                margin-bottom: 0;
            }
        </style>
    </head>
    <body>
        <div class="toolbar">
            <h3 style="margin:0; font-size: 14px;">Global Viewer</h3>
            <input id="searchBox" type="text" placeholder="Filter entries by global name...">
            <div class="toolbar-actions">
                <button class="btn" title="Expand All" data-action="expandAll">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M11 11H5V5h6v6zm3-9H2v12h12V2zM3 13V3h10v10H3z"/></svg>
                </button>
                <button class="btn" title="Collapse All" data-action="collapseAll">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M9 9H5V5h4v4zm5-7H2v12h12V2zM3 13V3h10v10H3z"/></svg>
                </button>
                <div class="v-sep"></div>
                <button class="btn view-btn" data-action="viewList" title="List view">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M2 3h12v2H2V3zm0 4h12v2H2V7zm0 4h12v2H2v-2z"/></svg>
                </button>
                <button class="btn view-btn" data-action="viewGrid" title="Grid view">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h5v5H2V2zm7 0h5v5H9V2zM2 9h5v5H2V9zm7 0h5v5H9V9z"/></svg>
                </button>
                <div class="v-sep"></div>
                <button class="btn" title="Move to New Window" data-action="moveToNewWindow">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M9 2h5v5h-1.5V4.56L7.03 10.03 6 9l5.44-5.44H9V2zM3 4h4v1.5H4.5v6h6V9H12v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/></svg>
                </button>
                <div class="v-sep"></div>
                <button class="btn" id="pinTabBtn" title="Keep Open (tab is in preview mode)" data-action="pinTab">
                    <svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                </button>
                <button class="btn" title="Clear All" data-action="clearAll">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M6 2h4a1 1 0 0 1 1 1v1h3v1.5h-1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9H2V4h3V3a1 1 0 0 1 1-1zm0 2h4V3.5H6V4zM4.5 5.5v9h7v-9h-7zM6.5 7H8v6H6.5V7zm3 0h1.5v6H9.5V7z"/></svg>
                </button>
            </div>
        </div>
        <div id="container"></div>
        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            const HEB_RANGE = /[\\u0590-\\u05FF]/;
            const DELIMS = ['*', '^', '|', '~'];

            // Single source of truth. Rendering always rebuilds the DOM from this array via
            // createElement/textContent — never innerHTML with interpolated data — so a global
            // value containing HTML-special characters can't inject markup or script.
            let entries = [];
            let searchTerm = '';
            let viewMode = 'grid'; // 'list' or 'grid' — grid is the default

            const prevState = vscode.getState();
            if (prevState && Array.isArray(prevState.entries)) {
                entries = prevState.entries;
            }
            if (prevState && (prevState.viewMode === 'list' || prevState.viewMode === 'grid')) {
                viewMode = prevState.viewMode;
            }
            // Older persisted entries won't have these fields yet — default them in.
            entries.forEach(en => {
                if (typeof en.pieceSearch !== 'string') en.pieceSearch = '';
                if (typeof en.hideEmpty !== 'boolean') en.hideEmpty = false;
            });

            function persist() {
                vscode.setState({ entries, viewMode });
                // Also mirror to the extension host, which keeps its own durable copy (globalState).
                // The webview's own state above only survives the panel being hidden, not fully
                // closed — this is what lets closing the Global Viewer tab and then clicking another
                // global bring back everything that was registered before, instead of starting empty.
                vscode.postMessage({ command: 'syncState', entries, viewMode });
            }

            function splitValue(entry) {
                const delim = entry.delimiter === 'other' ? (entry.customDelim || '') : entry.delimiter;
                return delim ? entry.value.split(delim) : [entry.value];
            }

            function invpr(t) {
                if (!t) return t;
                let chars = t.split('');
                const pairs = {'(':')', ')':'(', '<':'>', '>':'<', '{':'}', '}':'{', '[':']', ']':'['};
                if (pairs[chars[0]]) chars[0] = pairs[chars[0]];
                if (pairs[chars[chars.length-1]]) chars[chars.length-1] = pairs[chars[chars.length-1]];
                return chars.join('');
            }

            function WG(str) {
                if (!str) return "";
                let s = str.replace(/\\u00A0/g, ' ').trim();
                let words = s.split(' ');
                let processed = words.map(w => {
                    if (w.endsWith('%')) w = '%' + w.slice(0, -1);
                    if (HEB_RANGE.test(w)) w = invpr(w);
                    return w;
                });
                let resultWords = [];
                let i = 0;
                while (i < processed.length) {
                    if (!HEB_RANGE.test(processed[i])) {
                        let j = i;
                        while (j < processed.length && !HEB_RANGE.test(processed[j])) { j++; }
                        let block = processed.slice(i, j).reverse().map(w => w.split('').reverse().join(''));
                        resultWords.push(...block);
                        i = j;
                    } else {
                        resultWords.push(processed[i]);
                        i++;
                    }
                }
                return resultWords.join(' ').split('').reverse().join('');
            }

            // Top toolbar filter: looks at the global reference alone (e.g. ^["ACC"]LRTAB(1,400,26)),
            // never the server/namespace shown in blue before it, and never piece contents — that's
            // what the per-entry piece search below is for.
            function matchesTopSearch(entry) {
                if (!searchTerm) return true;
                return entry.global.toLowerCase().includes(searchTerm.toLowerCase());
            }

            // Per-entry piece search matches against whatever is currently on screen for that piece —
            // the flipped/RTL-processed text when the entry is flipped, the raw text otherwise.
            function matchesPieceSearch(entry, shownText) {
                const term = (entry.pieceSearch || '').trim().toLowerCase();
                if (!term) return true;
                return shownText.toLowerCase().includes(term);
            }

            // Splits into pieces by the current delimiter, then (if the entry's "hide empty" toggle
            // is on) drops empty pieces from the list. The remaining pieces keep their REAL/original
            // position number (piece 7 stays "7" even if pieces 2-6 are hidden) — hide-empty only
            // removes rows, it never renumbers what's left.
            function getDisplayPieces(entry) {
                const raw = splitValue(entry);
                let list = raw.map((p, i) => ({ originalIndex: i + 1, raw: p }));
                if (entry.hideEmpty) list = list.filter(p => p.raw !== '');
                return { total: raw.length, list };
            }

            function copyToClipboard(text, btn) {
                const done = () => {
                    const original = btn.textContent;
                    btn.textContent = 'Copied';
                    setTimeout(() => { btn.textContent = original; }, 900);
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(done, done);
                } else {
                    done();
                }
            }

            function buildEntryEl(entry) {
                const el = document.createElement('div');
                el.className = 'entry';
                el.dataset.id = entry.id;
                if (entry.collapsed) el.classList.add('collapsed');
                if (!matchesTopSearch(entry)) el.classList.add('hidden');

                const header = document.createElement('div');
                header.className = 'header';

                const arrow = document.createElement('span');
                arrow.className = 'arrow';
                arrow.textContent = '\\u25BC';
                header.appendChild(arrow);

                const headerText = document.createElement('div');
                headerText.className = 'header-text';

                const left = document.createElement('span');
                const serverSpan = document.createElement('span');
                serverSpan.className = 'server-info';
                serverSpan.textContent = entry.server;
                left.appendChild(serverSpan);
                left.appendChild(document.createTextNode(' \\u00BB '));
                const globalB = document.createElement('b');
                globalB.textContent = entry.global;
                left.appendChild(globalB);
                headerText.appendChild(left);

                const controls = document.createElement('span');
                controls.style.display = 'flex';
                controls.style.alignItems = 'center';
                controls.style.gap = '6px';

                const delimSelect = document.createElement('select');
                delimSelect.className = 'delim-select';
                [['*','*'], ['^','^'], ['|','|'], ['~','~'], ['other','Other:']].forEach(([val, label]) => {
                    const opt = document.createElement('option');
                    opt.value = val;
                    opt.textContent = label;
                    if (entry.delimiter === val) opt.selected = true;
                    delimSelect.appendChild(opt);
                });
                delimSelect.addEventListener('click', e => e.stopPropagation());
                delimSelect.addEventListener('change', () => {
                    entry.delimiter = delimSelect.value;
                    persist();
                    render();
                });
                controls.appendChild(delimSelect);

                if (entry.delimiter === 'other') {
                    const customInput = document.createElement('input');
                    customInput.className = 'delim-custom';
                    customInput.value = entry.customDelim || '';
                    customInput.placeholder = 'delim';
                    customInput.addEventListener('click', e => e.stopPropagation());
                    customInput.addEventListener('change', () => {
                        entry.customDelim = customInput.value;
                        persist();
                        render();
                    });
                    controls.appendChild(customInput);
                }

                const flipBtn = document.createElement('button');
                flipBtn.className = 'btn btn-flip' + (entry.flipped ? ' active' : '');
                flipBtn.textContent = entry.flipped ? 'Flipped' : 'Original';
                flipBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    entry.flipped = !entry.flipped;
                    persist();
                    render();
                });
                controls.appendChild(flipBtn);

                headerText.appendChild(controls);
                header.appendChild(headerText);

                const timeSpan = document.createElement('span');
                timeSpan.style.fontSize = '11px';
                timeSpan.style.opacity = '0.6';
                timeSpan.style.marginRight = '10px';
                timeSpan.textContent = entry.time;
                header.appendChild(timeSpan);

                const delBtn = document.createElement('div');
                delBtn.className = 'btn-delete';
                delBtn.textContent = '\\u00D7';
                delBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    entries = entries.filter(en => en.id !== entry.id);
                    persist();
                    render();
                });
                header.appendChild(delBtn);

                header.addEventListener('click', () => {
                    entry.collapsed = !entry.collapsed;
                    persist();
                    render();
                });

                // --- Per-entry toolbar: piece search, "hide empty" toggle, piece-count stats.
                // Lives as its own row (a sibling of .header, not inside it) so clicks in it never
                // bubble into the header's collapse-toggle handler.
                const entryToolbar = document.createElement('div');
                entryToolbar.className = 'entry-toolbar';

                const pieceSearchInput = document.createElement('input');
                pieceSearchInput.className = 'piece-search';
                pieceSearchInput.type = 'text';
                pieceSearchInput.placeholder = 'Search pieces...';
                pieceSearchInput.value = entry.pieceSearch || '';
                pieceSearchInput.addEventListener('click', e => e.stopPropagation());
                pieceSearchInput.addEventListener('input', () => {
                    entry.pieceSearch = pieceSearchInput.value;
                    persist();
                    // Targeted update: rebuilds only this entry's pieces + stats, never this input
                    // itself, so focus and cursor position survive every keystroke.
                    updateEntryPieces(entry);
                });
                entryToolbar.appendChild(pieceSearchInput);

                const hideEmptyLabel = document.createElement('label');
                hideEmptyLabel.className = 'hide-empty-label';
                hideEmptyLabel.addEventListener('click', e => e.stopPropagation());
                const hideEmptyCheckbox = document.createElement('input');
                hideEmptyCheckbox.type = 'checkbox';
                hideEmptyCheckbox.checked = !!entry.hideEmpty;
                hideEmptyCheckbox.addEventListener('change', () => {
                    entry.hideEmpty = hideEmptyCheckbox.checked;
                    persist();
                    updateEntryPieces(entry);
                });
                hideEmptyLabel.appendChild(hideEmptyCheckbox);
                hideEmptyLabel.appendChild(document.createTextNode('Hide empty'));
                entryToolbar.appendChild(hideEmptyLabel);

                const statsSpan = document.createElement('span');
                statsSpan.className = 'piece-stats';
                entryToolbar.appendChild(statsSpan);

                const content = document.createElement('div');
                content.className = 'content';
                populatePieces(entry, content, statsSpan);

                el.appendChild(header);
                el.appendChild(entryToolbar);
                el.appendChild(content);
                return el;
            }

            // Builds the piece rows for one entry into contentEl (and updates statsEl, if given).
            // Factored out of buildEntryEl so a piece-search keystroke or a "hide empty" toggle can
            // refresh just this content/stats pair without rebuilding — and stealing focus from —
            // the rest of the entry (see updateEntryPieces below).
            function populatePieces(entry, contentEl, statsEl) {
                contentEl.innerHTML = '';
                const { total, list } = getDisplayPieces(entry);
                let shownCount = 0;
                list.forEach(p => {
                    const shown = entry.flipped ? WG(p.raw) : p.raw;
                    const isMatch = matchesPieceSearch(entry, shown);
                    if (isMatch) shownCount++;
                    const row = document.createElement('div');
                    row.className = 'piece' + (isMatch ? '' : ' piece-search-hidden');
                    const num = document.createElement('span');
                    num.className = 'num';
                    num.textContent = String(p.originalIndex);
                    row.appendChild(num);
                    const val = document.createElement('span');
                    val.className = 'piece-val';
                    if (p.raw === '') {
                        const emptyTag = document.createElement('span');
                        emptyTag.className = 'piece-empty';
                        emptyTag.textContent = '[empty]';
                        val.appendChild(emptyTag);
                    } else {
                        val.textContent = shown;
                    }
                    row.appendChild(val);
                    const copyBtn = document.createElement('button');
                    copyBtn.className = 'btn btn-copy';
                    copyBtn.textContent = 'Copy';
                    copyBtn.addEventListener('click', () => copyToClipboard(shown, copyBtn));
                    row.appendChild(copyBtn);
                    contentEl.appendChild(row);
                });
                if (statsEl) {
                    let text = total + ' piece' + (total === 1 ? '' : 's');
                    if (shownCount !== total) text += ' \\u00B7 ' + shownCount + ' shown';
                    statsEl.textContent = text;
                }
            }

            function updateEntryPieces(entry) {
                const entryEl = document.querySelector('.entry[data-id="' + entry.id + '"]');
                if (!entryEl) return;
                const contentEl = entryEl.querySelector('.content');
                const statsEl = entryEl.querySelector('.piece-stats');
                if (contentEl) populatePieces(entry, contentEl, statsEl);
            }

            function updateViewButtons() {
                document.querySelectorAll('.view-btn').forEach(btn => {
                    const isActive = (btn.dataset.action === 'viewGrid' && viewMode === 'grid')
                        || (btn.dataset.action === 'viewList' && viewMode === 'list');
                    btn.classList.toggle('active', isActive);
                });
            }

            function render() {
                const container = document.getElementById('container');
                container.className = viewMode === 'grid' ? 'grid-view' : '';
                container.innerHTML = '';
                entries.forEach(entry => container.appendChild(buildEntryEl(entry)));
                updateViewButtons();
            }

            // Grid view only: keeps whichever cards land in the top row expanded, and collapses
            // anything pushed into a later row. Row membership is measured from the actual rendered
            // layout (offsetTop) rather than a hardcoded "3 per row", so it adapts to however many
            // cards the current window width actually fits (1, 2, or 3). Must be called after a
            // render() so the cards exist to measure, and is followed by another render() to apply
            // the resulting collapsed flags. Only ever runs on the two triggers the user asked for —
            // switching into grid view, and a new global arriving while already in grid view — never
            // on every render, so it doesn't fight a manual expand/collapse click afterwards.
            function applyGridAutoCollapse() {
                if (viewMode !== 'grid') return;
                const container = document.getElementById('container');
                const cards = Array.from(container.children).filter(c => c.classList.contains('entry') && !c.classList.contains('hidden'));
                if (cards.length === 0) return;
                const firstTop = cards[0].offsetTop;
                const topRowIds = new Set(cards.filter(c => Math.abs(c.offsetTop - firstTop) < 2).map(c => c.dataset.id));
                entries.forEach(en => { en.collapsed = !topRowIds.has(en.id); });
            }

            document.getElementById('searchBox').addEventListener('input', e => {
                searchTerm = e.target.value;
                render();
            });

            document.querySelector('.toolbar').addEventListener('click', e => {
                const action = e.target.closest('[data-action]')?.dataset.action;
                if (!action) return;
                if (action === 'expandAll') { entries.forEach(en => en.collapsed = false); persist(); render(); }
                if (action === 'collapseAll') { entries.forEach(en => en.collapsed = true); persist(); render(); }
                if (action === 'viewList') { viewMode = 'list'; persist(); render(); }
                if (action === 'viewGrid') {
                    viewMode = 'grid';
                    render();
                    applyGridAutoCollapse();
                    persist();
                    render();
                }
                if (action === 'moveToNewWindow') { vscode.postMessage({ command: 'moveToNewWindow' }); }
                if (action === 'pinTab') { vscode.postMessage({ command: 'pinTab' }); }
                if (action === 'clearAll') { entries = []; persist(); render(); }
            });

            function makeEntryFromMessage(message) {
                return {
                    id: Date.now() + '-' + Math.random().toString(36).slice(2),
                    server: message.server,
                    global: message.global,
                    value: message.value,
                    time: message.time,
                    delimiter: '*',
                    customDelim: '',
                    flipped: false,
                    collapsed: false,
                    pieceSearch: '',
                    hideEmpty: false
                };
            }

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'addEntry') {
                    if (viewMode === 'grid') {
                        // List view's "collapse everything else, expand only the new one" doesn't
                        // apply here — the top row stays expanded, only entries pushed past it
                        // collapse, per applyGridAutoCollapse().
                        entries.unshift(makeEntryFromMessage(message));
                        render();
                        applyGridAutoCollapse();
                        persist();
                        render();
                    } else {
                        entries.forEach(en => en.collapsed = true);
                        entries.unshift(makeEntryFromMessage(message));
                        persist();
                        render();
                    }
                } else if (message.command === 'initEntries') {
                    // Sent once, right after this fresh webview announces itself as 'ready' — hydrates
                    // from the extension-side copy of the last known state, so closing the Global
                    // Viewer tab and then clicking another global doesn't start from empty and quietly
                    // discard everything that was registered before.
                    entries = Array.isArray(message.entries) ? message.entries : [];
                    entries.forEach(en => {
                        if (typeof en.pieceSearch !== 'string') en.pieceSearch = '';
                        if (typeof en.hideEmpty !== 'boolean') en.hideEmpty = false;
                    });
                    if (message.viewMode === 'grid' || message.viewMode === 'list') viewMode = message.viewMode;
                    persist();
                    render();
                } else if (message.command === 'previewState') {
                    // Whatever pinned it — our own auto-keep on open, the manual pin button, or the
                    // user pinning the tab themselves — there's nothing left to pin once it's not a
                    // preview tab anymore, so the icon just disappears.
                    document.getElementById('pinTabBtn').style.display = message.isPreview ? '' : 'none';
                }
            });

            render();
            // Tells the extension host this fresh webview is ready to receive 'initEntries' (and any
            // 'addEntry' queued while the panel was still loading) — see showInWebview/wireViewerPanel.
            vscode.postMessage({ command: 'ready' });
        </script>
    </body>
    </html>`;
}

function getTerminalTitle(serverDisplayName: string, ns: string) {
    return `IRIS: ${serverDisplayName}${ns ? ' - ' + ns : ''}`;
}

export function getSslMode(): SslMode {
    const mode = vscode.workspace.getConfiguration('iris-terminal').get<string>('sslMode', 'prefer');
    return (mode === 'require' || mode === 'off') ? mode : 'prefer';
}

export function getRejectUnauthorized(): boolean {
    return vscode.workspace.getConfiguration('iris-terminal').get<boolean>('tls.rejectUnauthorized', false);
}

export function getTelnetPort(): number {
    return vscode.workspace.getConfiguration('iris-terminal').get<number>('port', 23);
}

export const encodeInput = (data: string, encoding: string): Buffer => {
    if (encoding !== 'windows1255') return Buffer.from(data, 'utf8');
    const bytes: number[] = [];
    for (let i = 0; i < data.length; i++) {
        const charCode = data.charCodeAt(i);
        if (charCode >= 0x05D0 && charCode <= 0x05EA) bytes.push(charCode - 0x05D0 + 0xE0);
        else if (charCode < 256) bytes.push(charCode);
        else bytes.push(0x3F);
    }
    return Buffer.from(bytes);
};

function openTerminal(context: vscode.ExtensionContext, opts: {
    host: string; user: string; pass: string; passSource: IrisSession['passSource']; serverId: string;
    serverDisplayName: string; initialNamespace: string; encoding: string;
}) {
    const writeEmitter = new vscode.EventEmitter<string>();
    const nameEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();

    const session: IrisSession = {
        writeEmitter,
        nameEmitter,
        closeEmitter,
        decoder: new TextDecoder(opts.encoding === 'windows1255' ? 'windows-1255' : 'utf-8'),
        host: opts.host,
        user: opts.user,
        pass: opts.pass,
        serverId: opts.serverId,
        serverDisplayName: opts.serverDisplayName,
        initialNamespace: opts.initialNamespace,
        encoding: opts.encoding,
        lastKnownNS: opts.initialNamespace.toUpperCase(),
        targetNamespace: opts.initialNamespace.toUpperCase(),
        userSent: false,
        passSent: false,
        nsSent: false,
        isConnected: false,
        isAlive: false,
        context,
        passSource: opts.passSource,
        reauthPromptShown: false
    };

    const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidChangeName: nameEmitter.event,
        onDidClose: closeEmitter.event,
        open: () => { connectSession(session); },
        close: () => {
            if (session.client) {
                session.client.removeAllListeners();
                session.client.destroy();
            }
        },
        handleInput: (data) => {
            if (!session.isAlive) {
                // Session is down: any keypress offers to reconnect.
                if (data === 'r' || data === 'R' || data === '\r') {
                    reconnectSession(session);
                }
                return;
            }
            if (!session.client) return;
            if (data === '\x1b[H' || data === '\x1b[1~') {
                session.client.write('\x1b[1~');
                return;
            }
            if (data === '\x1b[F' || data === '\x1b[4~') {
                session.client.write('\x1b[4~');
                return;
            }
            session.client.write(encodeInput(data, session.encoding));
        }
    };

    const initialTitle = getTerminalTitle(opts.serverDisplayName, opts.initialNamespace);
    const terminal = vscode.window.createTerminal({ name: initialTitle, pty });
    session.terminal = terminal;
    sessions.set(terminal, session);
    terminal.show();
}

function connectSession(session: IrisSession) {
    const sslMode = getSslMode();
    session.userSent = false;
    session.passSent = false;
    session.nsSent = false;
    session.isConnected = false;
    session.reauthPromptShown = false;
    // Freeze the namespace to `zn` into for this connect attempt now, before any data arrives.
    // lastKnownNS is also live-updated below as prompts stream in (for the tab title), and that
    // update can happen before this attempt gets to send its own `zn` — using a separate,
    // frozen field stops the live tracker from overwriting the target out from under it.
    session.targetNamespace = session.lastKnownNS;

    const connect = (trySSL: boolean) => {
        const port = getTelnetPort();
        const client: net.Socket | tls.TLSSocket = trySSL
            ? tls.connect({ host: session.host, port, rejectUnauthorized: getRejectUnauthorized(), timeout: 4000 })
            : net.createConnection(port, session.host);

        session.client = client;
        session.isAlive = true;

        // When we abandon this socket (SSL handshake failed, falling back to plaintext),
        // its 'close'/'error'/'data' events can still fire later, asynchronously, once the
        // real (fallback) connection is already up and working. Every handler below must
        // check isCurrent() before touching session state, otherwise a delayed event from a
        // dead socket falsely marks a perfectly healthy session as disconnected.
        const isCurrent = () => session.client === client;
        const abandon = () => {
            client.removeAllListeners();
            client.destroy();
        };

        // A TLS timeout only emits 'timeout', it does not error or close the socket on its own.
        client.on('timeout', () => {
            if (!isCurrent()) return;
            if (trySSL && !session.isConnected) {
                abandon();
                connect(false);
            } else if (!session.isConnected) {
                abandon();
                session.isAlive = false;
                session.writeEmitter.fire('\r\n\x1b[31m[Connection timed out]\x1b[0m\r\n');
                session.writeEmitter.fire('\x1b[33m[Disconnected — press Enter or R to reconnect]\x1b[0m\r\n');
            }
        });

        client.on('data', (data: Buffer) => {
            if (!isCurrent()) return;
            if (!session.isConnected) {
                if (trySSL) {
                    session.writeEmitter.fire('\x1b[32m[Encrypted SSL Connection]\x1b[0m\r\n');
                } else if (sslMode === 'prefer') {
                    session.writeEmitter.fire('\x1b[33m[UNENCRYPTED Telnet connection — SSL was not available]\x1b[0m\r\n');
                }
            }
            session.isConnected = true;

            // { stream: true } keeps partial multi-byte sequences that land on a chunk
            // boundary (common with Hebrew/UTF-8) until the rest of the bytes arrive.
            const str = session.decoder.decode(data, { stream: true });
            session.writeEmitter.fire(str.replace(/\n/g, '\r\n'));

            // Match a namespace prompt at the END of the chunk only, so we don't pick up
            // unrelated "WORD>" text elsewhere in the output. Namespace names may contain
            // letters, digits, '%', '-' and '_', and may be followed by a stack-level suffix
            // such as "USER 2d0>".
            const promptMatch = str.match(/(?:^|\r|\n)([A-Z0-9%_-]+)(?:\s+\S+)?>\s*$/i);
            if (promptMatch && promptMatch[1] && session.terminal) {
                const currentNS = promptMatch[1].toUpperCase();
                if (currentNS !== session.lastKnownNS) {
                    session.lastKnownNS = currentNS;
                    session.nameEmitter.fire(getTerminalTitle(session.serverDisplayName, currentNS));
                }
            }

            const lowerStr = str.toLowerCase();
            if (session.user && !session.userSent && (lowerStr.includes('login:') || lowerStr.includes('username:'))) {
                session.userSent = true;
                client.write(session.user + '\r\n');
            }
            if (lowerStr.includes('password:')) {
                if (session.pass && !session.passSent) {
                    session.passSent = true;
                    client.write(session.pass + '\r\n');
                } else if (session.passSent && !session.reauthPromptShown) {
                    // The server is asking for the password again after we already sent one:
                    // that means the previous attempt was rejected. Don't resend the same
                    // (likely wrong) password automatically — repeated wrong attempts can trip
                    // an account lockout policy. Ask the user instead.
                    session.reauthPromptShown = true;
                    handleFailedLogin(session);
                }
            }
            // Target the namespace the session was last known to be in — for a first connect
            // that's simply the requested initial namespace; for a reconnect it's wherever the
            // user had actually navigated to before the disconnect. Uses the frozen
            // targetNamespace, not the live-updating lastKnownNS, which may already have been
            // bumped to the server's default namespace (e.g. "USER") by the prompt right after
            // login, before this check runs.
            //
            // Trigger on an actual detected namespace prompt (promptMatch, computed above),
            // not on session.passSent — some servers never show a literal "password:" text we
            // can react to (pre-authenticated sessions, certificate-based auth, a differently
            // worded login flow), which left passSent permanently false and this zn command
            // never sent at all, even though login had clearly already succeeded.
            if (promptMatch && session.targetNamespace && !session.nsSent) {
                session.nsSent = true;
                client.write('zn "' + session.targetNamespace + '"\r\n');
            }
        });

        client.on('error', (err: any) => {
            if (!isCurrent()) return;
            if (trySSL && !session.isConnected && sslMode !== 'require') {
                abandon();
                connect(false);
                return;
            }
            session.isAlive = false;
            session.writeEmitter.fire('\r\n\x1b[31mConnection Error: ' + err.message + '\x1b[0m\r\n');
            session.writeEmitter.fire('\x1b[33m[Disconnected — press Enter or R to reconnect]\x1b[0m\r\n');
        });

        client.on('close', () => {
            if (!isCurrent()) return;
            if (session.isAlive) {
                session.isAlive = false;
                session.writeEmitter.fire('\r\n\x1b[33m[Session disconnected — press Enter or R to reconnect]\x1b[0m\r\n');
            }
        });
    };

    if (sslMode === 'off') {
        connect(false);
    } else {
        connect(true);
    }
}

function reconnectSession(session: IrisSession) {
    if (session.isAlive) return; // already connected
    if (session.client) {
        session.client.removeAllListeners();
        session.client.destroy();
    }
    session.writeEmitter.fire('\r\n\x1b[36m[Reconnecting...]\x1b[0m\r\n');
    connectSession(session);
}

// Called when the server prompts for a password a second time, which we treat as the
// previous attempt having been rejected. If the password we sent came from Secret Storage,
// it's now known to be stale, so it's cleared rather than left to fail silently again on
// every future connect. The user is asked for the correct one and can choose to save it.
async function handleFailedLogin(session: IrisSession) {
    session.writeEmitter.fire('\r\n\x1b[31m[Login failed — not retrying automatically to avoid an account lockout]\x1b[0m\r\n');

    if (session.passSource === 'secret') {
        await session.context.secrets.delete(getSecretKey(session.serverId, session.user));
    }

    const entered = await vscode.window.showInputBox({
        prompt: `Login to ${session.user}@${session.serverId} failed. Enter the correct password (leave blank to cancel):`,
        password: true,
        ignoreFocusOut: true
    });

    if (!entered) {
        session.writeEmitter.fire('\x1b[33m[No password entered — type it directly in the terminal, or use "IRIS: Reconnect Terminal" to try again]\x1b[0m\r\n');
        return;
    }

    session.pass = entered;
    session.passSource = 'manual';
    if (session.client && session.isAlive) {
        session.client.write(entered + '\r\n');
    }

    const remember = await vscode.window.showQuickPick(['Yes', 'No'], {
        placeHolder: 'Remember this password securely (VS Code Secret Storage)?'
    });
    if (remember === 'Yes') {
        await session.context.secrets.store(getSecretKey(session.serverId, session.user), entered);
        session.passSource = 'secret';
    }
}
// npm run compile - to compile the extension
// vsce package --skip-license
