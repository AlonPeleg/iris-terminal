import * as vscode from 'vscode';
import * as net from 'net';
import * as tls from 'tls';

// Variable to store the dedicated output channel
let globalInspector: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext) {
    // 1. Create the dedicated Tab (Output Channel)
    globalInspector = vscode.window.createOutputChannel("Global Inspector");

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
        // Capture the display name to show in the Inspector header
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

    // 2. NEW FEATURE: Universal Global Decoder (Ctrl+Click)
    let linkProvider = vscode.window.registerTerminalLinkProvider({
        provideTerminalLinks: (context: vscode.TerminalLinkContext) => {
            const line = context.line.trim();
            // Match any line that looks like a global output
            if (line.startsWith('^') || line.includes('=^')) {
                return [{
                    startIndex: 0,
                    length: context.line.length,
                    tooltip: 'Ctrl+Click to Decode in Global Inspector Tab',
                    data: context.line
                }];
            }
            return [];
        },
        handleTerminalLink: (link: any) => {
            if (!globalInspector) return;

            const rawLine: string = link.data.trim();
            const time = new Date().toLocaleTimeString();
            
            // Parse Global name and Value
            let globalName = rawLine.includes('=') ? rawLine.split('=')[0].trim() : "Global Reference";
            let valuePart = rawLine.includes('=') ? rawLine.split('=')[1].trim() : rawLine;
            
            // Clean quotes and split by delimiter
            valuePart = valuePart.replace(/^"|"$/g, '');
            const pieces = valuePart.split('*');
            
            // Get the Terminal name (which contains the server/namespace)
            const terminalName = vscode.window.activeTerminal?.name || "IRIS Server";

            // Output to the separate Tab
            globalInspector.show(true); // Bring tab to front
            globalInspector.appendLine(`[${time}] SERVER: ${terminalName}`);
            globalInspector.appendLine(`INSPECTING: ${globalName}`);
            globalInspector.appendLine(`--------------------------------------------------`);
            
            pieces.forEach((val: string, index: number) => {
                const num = (index + 1).toString().padEnd(4);
                globalInspector?.appendLine(`${num}: ${val}`);
            });
            
            globalInspector.appendLine(`--------------------------------------------------\n`);
        }
    });

    context.subscriptions.push(disposable, linkProvider);
}

function openTerminal(host: string, user: string, pass: string, serverId: string, serverDisplayName: string, initialNamespace: string, encoding: string) {
    const writeEmitter = new vscode.EventEmitter<string>();
    let client: any; 
    let userSent = false, passSent = false, nsSent = false;
    let terminal: vscode.Terminal | undefined;
    let lastKnownNS = initialNamespace.toUpperCase();
    let isConnected = false;

    // Helper for terminal naming
    const getTerminalTitle = (ns: string) => `IRIS: ${serverDisplayName}${ns ? ' - ' + ns : ''}`;

    const decodeBuffer = (buf: Buffer): string => {
        if (encoding !== 'windows1255') return buf.toString(encoding as BufferEncoding);
        let result = "";
        for (let i = 0; i < buf.length; i++) {
            const byte = buf[i];
            if ((byte >= 0x80 && byte <= 0x9A) || (byte >= 0xE0 && byte <= 0xFA)) {
                const base = byte >= 0xE0 ? 0xE0 : 0x80;
                result += String.fromCharCode(byte - base + 0x05D0);
            } else {
                result += String.fromCharCode(byte);
            }
        }
        return result;
    };

    const encodeString = (str: string): Buffer => {
        if (encoding !== 'windows1255') return Buffer.from(str, encoding as BufferEncoding);
        const buf = Buffer.alloc(str.length);
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            if (code >= 0x05D0 && code <= 0x05EA) {
                buf[i] = code - 0x05D0 + 0x80;
            } else {
                buf[i] = code & 0xFF;
            }
        }
        return buf;
    };

    const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        open: () => {
            const port = 23;
            const connect = (trySSL: boolean) => {
                if (trySSL) {
                    client = tls.connect({ host, port, rejectUnauthorized: false, timeout: 1500 });
                } else {
                    client = net.createConnection(port, host);
                }

                client.on('data', (data: Buffer) => {
                    if (!isConnected && trySSL) {
                        writeEmitter.fire(`\x1b[32m[Encrypted SSL Connection]\x1b[0m\r\n`);
                    }
                    isConnected = true;
                    const str = decodeBuffer(data);
                    writeEmitter.fire(str.replace(/\n/g, '\r\n'));

                    const promptMatch = str.match(/([A-Z0-9%]+)>/i);
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
                        setTimeout(() => client.write(encodeString(user + '\r\n')), 300);
                    }
                    if (pass && !passSent && lowerStr.includes('password:')) {
                        passSent = true;
                        setTimeout(() => client.write(encodeString(pass + '\r\n')), 300);
                    }
                    if (initialNamespace && !nsSent && passSent && str.includes('>')) {
                        nsSent = true;
                        setTimeout(() => client.write(encodeString(`zn "${initialNamespace}"\r\n`)), 600);
                    }
                });

                client.on('error', (err: any) => {
                    const errMsg = err.message || "";
                    if (trySSL && !isConnected && (errMsg.includes('WRONG_VERSION_NUMBER') || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT')) {
                        client.destroy();
                        connect(false); 
                    } else {
                        writeEmitter.fire(`\r\n\x1b[31m[ERROR]: ${errMsg}\x1b[0m\r\n`);
                    }
                });

                client.on('timeout', () => { if (trySSL && !isConnected) { client.destroy(); connect(false); } });
                client.on('close', () => { if (isConnected) writeEmitter.fire('\r\n\x1b[33m--- Disconnected ---\x1b[0m\r\n'); });
            };
            connect(true);
        },
        close: () => client?.destroy(),
        handleInput: (data) => {
            if (client && !client.destroyed) {
                if (data === '\x7f') client.write(encodeString('\x08'));
                else client.write(encodeString(data));
            }
        }
    };

    terminal = vscode.window.createTerminal({ 
        name: getTerminalTitle(initialNamespace), 
        pty 
    });
    terminal.show();
}
// npm run compile - to compile the extension
// vsce package --skip-license