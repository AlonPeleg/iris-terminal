import * as vscode from 'vscode';
import * as net from 'net';
import * as tls from 'tls';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('iris-terminal.open', async (uri?: vscode.Uri) => {
        
        const config = vscode.workspace.getConfiguration();
        const serverList: any = config.get('intersystems.servers') || config.get('interSystems.servers') || {};
        
        let activeServerName = '';
        let detectedNamespace = '';
        let targetUri = uri || vscode.window.activeTextEditor?.document.uri;

        // 1. Context Detection
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

        // 2. Build Server List
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
        const host = entry?.webServer?.host || entry?.host || '';
        const user = entry?.username || '';
        const pass = entry?.password || '';
        const useSSL = entry?.SSL === true;

        // 3. Select Encoding
        const encodingSelection = await vscode.window.showQuickPick([
            { label: "Hebrew (Windows-1255)", description: "Cache servers", detail: "windows1255" },
            { label: "UTF-8", description: "IRIS servers", detail: "utf8" }
        ], { placeHolder: `Select Encoding for ${chosenId}` });

        if (!encodingSelection) return;
        const chosenEncoding = encodingSelection.detail;

        // 4. Confirm Host
        const finalHost = await vscode.window.showInputBox({
            prompt: `Connect to ${chosenId} (${encodingSelection.label}) ${useSSL ? '[SSL]' : ''}`,
            value: host,
            ignoreFocusOut: true
        });

        if (!finalHost) return;

        openTerminal(finalHost, user, pass, chosenId, detectedNamespace, chosenEncoding, useSSL);
    });

    context.subscriptions.push(disposable);
}

function openTerminal(host: string, user: string, pass: string, serverName: string, initialNamespace: string, encoding: string, useSSL: boolean) {
    const writeEmitter = new vscode.EventEmitter<string>();
    let client: any; 
    let userSent = false, passSent = false, nsSent = false;
    let terminal: vscode.Terminal | undefined;
    let lastKnownNS = initialNamespace.toUpperCase();

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
            const sslMsg = useSSL ? " (SECURE SSL)" : "";
            writeEmitter.fire(`\x1b[36m--- IRIS Terminal: ${serverName}${sslMsg} ---\x1b[0m\r\n`);
            
            if (useSSL) {
                client = tls.connect({ host, port, rejectUnauthorized: false });
            } else {
                client = net.createConnection(port, host);
            }

            client.on('data', (data: Buffer) => {
                const str = decodeBuffer(data);
                writeEmitter.fire(str.replace(/\n/g, '\r\n'));

                // --- NAMESPACE DETECTION & RENAME ---
                const promptMatch = str.match(/([A-Z0-9%]+)>/i);
                if (promptMatch && promptMatch[1] && terminal) {
                    const currentNS = promptMatch[1].toUpperCase();
                    if (currentNS !== lastKnownNS) {
                        lastKnownNS = currentNS;
                        // This updates the tab name in the terminal list
                        vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', {
                            name: `IRIS: ${serverName} - ${currentNS}`
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

            client.on('error', (err: Error) => writeEmitter.fire(`\r\n\x1b[31m[ERROR]: ${err.message}\x1b[0m\r\n`));
            client.on('close', () => writeEmitter.fire('\r\n\x1b[33m--- Disconnected ---\x1b[0m\r\n'));
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
        name: `IRIS: ${serverName}${initialNamespace ? ' - ' + initialNamespace : ''}`, 
        pty 
    });
    terminal.show();
}
// npm run compile - to compile the extension
// vsce package --skip-license