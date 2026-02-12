import * as vscode from 'vscode';
import * as net from 'net';
import * as tls from 'tls';

let viewerPanel: vscode.WebviewPanel | undefined;

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

        serverItems.sort((a, b) => (a.label.includes('star-full') ? -1 : 1));

        const selection = await vscode.window.showQuickPick(serverItems, { placeHolder: 'Select an IRIS server' });
        if (!selection || !selection.detail) return;

        const chosenId = selection.detail; 
        const entry = serverList[chosenId];
        const serverLabel = selection.label.replace('$(star-full) ', '').replace('$(server) ', '');

        const host = entry?.webServer?.host || entry?.host || '';
        const user = entry?.username || '';
        const pass = entry?.password || '';

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

        openTerminal(finalHost, user, pass, chosenId, serverLabel, detectedNamespace, chosenEncoding);
    });

    // --- GLOBAL VIEWER LINK PROVIDER ---
    let linkProvider = vscode.window.registerTerminalLinkProvider({
        provideTerminalLinks: (context: vscode.TerminalLinkContext) => {
            const line = context.line.trim();
            if (line.startsWith('^') || line.includes('=^') || (line.includes('^') && line.includes('='))) {
                return [{
                    startIndex: 0,
                    length: context.line.length,
                    tooltip: 'Ctrl+Click to view in Global Viewer',
                    data: context.line
                }];
            }
            return [];
        },
        handleTerminalLink: (link: any) => {
            const rawLine: string = link.data.trim();
            const time = new Date().toLocaleTimeString();
            const terminalName = vscode.window.activeTerminal?.name || "IRIS Server";

            let globalName = rawLine.includes('=') ? rawLine.split('=')[0].trim() : "Global Reference";
            let valuePart = rawLine.includes('=') ? rawLine.split('=')[1].trim() : rawLine;
            
            valuePart = valuePart.replace(/^"|"$/g, '');
            const pieces = valuePart.split('*');

            showInWebview(terminalName, globalName, pieces, time);
        }
    });

    context.subscriptions.push(disposable, linkProvider, pinListener);
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
        
        // Handle messages from the webview (The Keep Open button)
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
            body { font-family: var(--vscode-editor-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 15px; }
            .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; }
            .toolbar-actions { display: flex; gap: 8px; }
            .btn { border: none; padding: 4px 10px; cursor: pointer; border-radius: 2px; font-size: 12px; }
            .btn-pin { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
            .btn-pin:hover { background: var(--vscode-button-hoverBackground); }
            .btn-clear { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
            .btn-clear:hover { background: var(--vscode-button-secondaryHoverBackground); }
            .entry { border: 1px solid var(--vscode-panel-border); margin-bottom: 12px; border-radius: 4px; overflow: hidden; position: relative; }
            .header { background: var(--vscode-editor-lineHighlightBackground); padding: 10px; cursor: pointer; display: flex; align-items: center; font-size: 13px; }
            .header:hover { background: var(--vscode-list-hoverBackground); }
            .header-text { flex-grow: 1; display: flex; justify-content: space-between; align-items: center; margin-right: 10px; }
            .btn-delete { color: var(--vscode-errorForeground); cursor: pointer; font-weight: bold; padding: 5px 10px; font-size: 16px; border-radius: 4px; line-height: 1; }
            .btn-delete:hover { background: var(--vscode-toolbar-hoverBackground); }
            .content { padding: 10px; display: block; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
            .hidden { display: none; }
            .piece { display: flex; gap: 15px; border-bottom: 1px solid #80808033; padding: 4px 5px; font-size: 12px; }
            .num { color: var(--vscode-symbolIcon-numberForeground); font-weight: bold; min-width: 25px; text-align: right; }
            .arrow { display: inline-block; width: 10px; transition: transform 0.1s; margin-right: 8px; }
            .entry.collapsed .arrow { transform: rotate(-90deg); }
            .server-info { font-weight: bold; color: var(--vscode-textLink-foreground); }
        </style>
    </head>
    <body>
        <div class="toolbar">
            <h3 style="margin:0">Global Viewer</h3>
            <div class="toolbar-actions">
                <button class="btn btn-pin" onclick="pinTab()">Keep Open</button>
                <button class="btn btn-clear" onclick="clearAll()">Clear All</button>
            </div>
        </div>
        <div id="container"></div>
        <script>
            const vscode = acquireVsCodeApi();
            
            function pinTab() {
                vscode.postMessage({ command: 'pinTab' });
            }

            function clearAll() { document.getElementById('container').innerHTML = ''; }
            
            function deleteEntry(btn, event) { 
                event.stopPropagation();
                btn.closest('.entry').remove(); 
            }

            function toggleEntry(headerElement) {
                const entry = headerElement.parentElement;
                const content = headerElement.nextElementSibling;
                entry.classList.toggle('collapsed');
                content.classList.toggle('hidden');
            }

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'addEntry') {
                    const { server, global, pieces, time } = message;
                    const container = document.getElementById('container');
                    const entry = document.createElement('div');
                    entry.className = 'entry';
                    const pieceHtml = pieces.map((p, i) => \`
                        <div class="piece">
                            <span class="num">\${i+1}</span> 
                            <span>\${p === "" ? "<span style='opacity:0.3'>[empty]</span>" : p}</span>
                        </div>\`).join('');
                    
                    entry.innerHTML = \`
                        <div class="header" onclick="toggleEntry(this)">
                            <span class="arrow">▼</span>
                            <div class="header-text">
                                <span><span class="server-info">\${server}</span> » <b>\${global}</b></span>
                                <span style="font-size: 11px; opacity: 0.6;">\${time}</span>
                            </div>
                            <div class="btn-delete" title="Delete entry" onclick="deleteEntry(this, event)">×</div>
                        </div>
                        <div class="content">\${pieceHtml}</div>
                    \`;
                    container.prepend(entry);
                }
            });
        </script>
    </body>
    </html>`;
}

function openTerminal(host: string, user: string, pass: string, serverId: string, serverDisplayName: string, initialNamespace: string, encoding: string) {
    const writeEmitter = new vscode.EventEmitter<string>();
    let client: any; 
    let userSent = false, passSent = false, nsSent = false;
    let isConnected = false;
    
    let terminal: vscode.Terminal | undefined;
    let lastKnownNS = initialNamespace.toUpperCase();
    const getTerminalTitle = (ns: string) => `IRIS: ${serverDisplayName}${ns ? ' - ' + ns : ''}`;

    const decoder = new TextDecoder(encoding === 'windows1255' ? 'windows-1255' : 'utf-8');

    const encodeInput = (data: string): Buffer => {
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

    const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        open: () => {
            const connect = (trySSL: boolean) => {
                client = trySSL ? tls.connect({ host, port: 23, rejectUnauthorized: false, timeout: 1500 }) : net.createConnection(23, host);
                
                client.on('data', (data: Buffer) => {
                    if (!isConnected && trySSL) writeEmitter.fire('\x1b[32m[Encrypted SSL Connection]\x1b[0m\r\n');
                    isConnected = true;
                    
                    const str = decoder.decode(data);
                    writeEmitter.fire(str.replace(/\n/g, '\r\n'));

                    // --- IMPROVED TRACKING REGEX ---
                    // This matches patterns like USER> or NAMESPACE> only when they appear 
                    // after a newline, avoiding <SYNTAX> or <UNDEFINED> errors.
                    const promptMatch = str.match(/(?:\r\n|\n|^)([A-Z0-9%]+)>/i);
                    if (promptMatch && promptMatch[1] && terminal) {
                        const currentNS = promptMatch[1].toUpperCase();
                        if (currentNS !== lastKnownNS) {
                            lastKnownNS = currentNS;
                            vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { 
                                name: getTerminalTitle(currentNS) 
                            });
                        }
                    }

                    const lowerStr = str.toLowerCase();
                    if (user && !userSent && (lowerStr.includes('login:') || lowerStr.includes('username:'))) {
                        userSent = true; 
                        client.write(user + '\r\n');
                    }
                    if (pass && !passSent && lowerStr.includes('password:')) {
                        passSent = true; 
                        client.write(pass + '\r\n');
                    }
                    if (initialNamespace && !nsSent && passSent && str.includes('>')) {
                        nsSent = true; 
                        client.write('zn "' + initialNamespace + '"\r\n');
                    }
                });

                client.on('error', (err: any) => {
                    if (trySSL && !isConnected) connect(false); 
                    else writeEmitter.fire('\r\n\x1b[31mConnection Error: ' + err.message + '\x1b[0m\r\n');
                });
            };
            connect(true);
        },
        close: () => { if (client) client.destroy(); },
        handleInput: (data) => { if (client) client.write(encodeInput(data)); }
    };

    terminal = vscode.window.createTerminal({ name: getTerminalTitle(initialNamespace), pty });
    terminal.show();
}
// npm run compile - to compile the extension
// vsce package --skip-license