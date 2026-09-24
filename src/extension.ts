import * as vscode from 'vscode';
import * as net from 'net';
import * as tls from 'tls';

let viewerPanel: vscode.WebviewPanel | undefined;

type SslMode = 'require' | 'prefer' | 'off';

interface IrisSession {
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
const sessions = new Map<vscode.Terminal, IrisSession>();

function getSecretKey(serverId: string, user: string): string {
    return `iris-terminal.password:${serverId}:${user}`;
}

export function activate(context: vscode.ExtensionContext) {

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
            const pieces = valuePart.split('*');

            showInWebview(terminalName, globalName, pieces, time);
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

    context.subscriptions.push(disposable, linkProvider, pinListener, switchNamespaceDisposable, reconnectDisposable, clearPasswordDisposable, terminalCloseListener);
}

function showInWebview(server: string, global: string, pieces: string[], time: string) {
    if (!viewerPanel) {
        viewerPanel = vscode.window.createWebviewPanel(
            'globalViewer',
            'Global Viewer',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        viewerPanel.webview.onDidReceiveMessage(message => {
            if (message.command === 'pinTab') {
                vscode.commands.executeCommand('workbench.action.keepEditor');
            }
        });

        viewerPanel.onDidDispose(() => { viewerPanel = undefined; });
        viewerPanel.webview.html = getWebviewContent();
    }

    viewerPanel.webview.postMessage({
        command: 'addEntry',
        server,
        global,
        pieces,
        time
    });
    viewerPanel.reveal(vscode.ViewColumn.Two, true);
}

function getWebviewContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
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
            }
            .entry {
                border: 1px solid var(--vscode-panel-border);
                margin-bottom: 20px;
                border-radius: 4px;
                background: var(--vscode-editor-background);
                display: flex;
                flex-direction: column;
            }
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
            .header-text { flex-grow: 1; display: flex; justify-content: space-between; align-items: center; margin-right: 10px; }
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
                gap: 15px;
                border-bottom: 1px solid var(--vscode-panel-border);
                padding: 8px 12px;
                font-size: 12px;
            }
            .piece:last-child { border-bottom: none; }
            .num { color: var(--vscode-descriptionForeground); font-weight: bold; min-width: 25px; text-align: right; font-family: monospace; opacity: 0.6; }
            .piece-val { white-space: pre-wrap; word-break: break-all; }
            .arrow { display: inline-block; width: 10px; transition: transform 0.1s; margin-right: 8px; font-size: 10px; }
            .server-info { font-weight: bold; color: var(--vscode-textLink-foreground); }
            .toolbar-actions { display: flex; gap: 4px; align-items: center; }
            .btn { border: none; padding: 4px; cursor: pointer; border-radius: 3px; display: flex; align-items: center; background: transparent; color: var(--vscode-foreground); }
            .btn:hover { background: var(--vscode-toolbar-hoverBackground); }
            .btn-flip { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid #80808066; margin-right: 10px; padding: 2px 8px; font-size: 11px; }
            .btn-flip.active { background: #007acc; color: white; border-color: transparent; }
            .btn-delete { color: var(--vscode-errorForeground); cursor: pointer; font-weight: bold; padding: 0 10px; font-size: 18px; opacity: 0.7; }
            .btn-delete:hover { opacity: 1; }
            .v-sep { border-left: 1px solid var(--vscode-panel-border); height: 16px; margin: 0 8px; }
        </style>
    </head>
    <body>
        <div class="toolbar">
            <h3 style="margin:0; font-size: 14px;">Global Viewer</h3>
            <div class="toolbar-actions">
                <button class="btn" title="Expand All" onclick="setAllCollapse(false)">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M11 11H5V5h6v6zm3-9H2v12h12V2zM3 13V3h10v10H3z"/></svg>
                </button>
                <button class="btn" title="Collapse All" onclick="setAllCollapse(true)">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M9 9H5V5h4v4zm5-7H2v12h12V2zM3 13V3h10v10H3z"/></svg>
                </button>
                <div class="v-sep"></div>
                <button class="btn" style="padding: 4px 10px; font-size: 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground);" onclick="pinTab()">Keep Open</button>
                <button class="btn" style="padding: 4px 10px; font-size: 12px; background: var(--vscode-button-secondaryBackground);" onclick="clearAll()">Clear All</button>
            </div>
        </div>
        <div id="container"></div>
        <script>
            const vscode = acquireVsCodeApi();
            const HEB_RANGE = /[\\u0590-\\u05FF]/;

            function setAllCollapse(shouldCollapse) {
                document.querySelectorAll('.entry').forEach(e => {
                    shouldCollapse ? e.classList.add('collapsed') : e.classList.remove('collapsed');
                });
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

            function toggleFlip(btn) {
                const entry = btn.closest('.entry');
                const isNowActive = btn.classList.toggle('active');
                btn.innerText = isNowActive ? 'Flipped' : 'Original';
                entry.querySelectorAll('.piece-val').forEach(span => {
                    const original = span.getAttribute('data-orig');
                    span.innerText = isNowActive ? WG(original) : original;
                });
            }

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'addEntry') {
                    setAllCollapse(true);
                    const { server, global, pieces, time } = message;
                    const container = document.getElementById('container');
                    const entry = document.createElement('div');
                    entry.className = 'entry';
                    const pieceHtml = pieces.map((p, i) => \`
                        <div class="piece">
                            <span class="num">\${i+1}</span>
                            <span class="piece-val" data-orig="\${p}">\${p === "" ? "<span style='opacity:0.3'>[empty]</span>" : p}</span>
                        </div>\`).join('');
                    entry.innerHTML = \`
                        <div class="header" onclick="toggleEntry(this)">
                            <span class="arrow">▼</span>
                            <div class="header-text">
                                <span><span class="server-info">\${server}</span> » <b>\${global}</b></span>
                                <span>
                                    <button class="btn btn-flip" onclick="event.stopPropagation(); toggleFlip(this)">Original</button>
                                </span>
                            </div>
                            <span style="font-size: 11px; opacity: 0.6; margin-right: 10px;">\${time}</span>
                            <div class="btn-delete" onclick="deleteEntry(this, event)">×</div>
                        </div>
                        <div class="content">\${pieceHtml}</div>\`;
                    container.prepend(entry);
                }
            });

            function pinTab() { vscode.postMessage({ command: 'pinTab' }); }
            function clearAll() { document.getElementById('container').innerHTML = ''; }
            function deleteEntry(btn, e) { e.stopPropagation(); btn.closest('.entry').remove(); }
            function toggleEntry(header) { header.parentElement.classList.toggle('collapsed'); }
        </script>
    </body>
    </html>`;
}

function getTerminalTitle(serverDisplayName: string, ns: string) {
    return `IRIS: ${serverDisplayName}${ns ? ' - ' + ns : ''}`;
}

function getSslMode(): SslMode {
    const mode = vscode.workspace.getConfiguration('iris-terminal').get<string>('sslMode', 'prefer');
    return (mode === 'require' || mode === 'off') ? mode : 'prefer';
}

function getRejectUnauthorized(): boolean {
    return vscode.workspace.getConfiguration('iris-terminal').get<boolean>('tls.rejectUnauthorized', false);
}

function getTelnetPort(): number {
    return vscode.workspace.getConfiguration('iris-terminal').get<number>('port', 23);
}

const encodeInput = (data: string, encoding: string): Buffer => {
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
