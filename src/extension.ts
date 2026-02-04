import * as vscode from 'vscode';
import * as net from 'net';

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

        // 3. Select Encoding (The Switcher)
        const encodingSelection = await vscode.window.showQuickPick([
            { label: "Hebrew (Windows-1255)", description: "Cache servers", detail: "windows1255" },
            { label: "UTF-8", description: "IRIS servers", detail: "utf8" }
        ], { placeHolder: `Select Encoding for ${chosenId}` });

        if (!encodingSelection) return;
        const chosenEncoding = encodingSelection.detail;

        // 4. Confirm IP
        const finalHost = await vscode.window.showInputBox({
            prompt: `Connect to ${chosenId} (${encodingSelection.label})`,
            value: host,
            ignoreFocusOut: true
        });

        if (!finalHost) return;

        openTerminal(finalHost, user, pass, chosenId, detectedNamespace, chosenEncoding);
    });

    context.subscriptions.push(disposable);
}

function openTerminal(host: string, user: string, pass: string, serverName: string, namespace: string, encoding: string) {
    const writeEmitter = new vscode.EventEmitter<string>();
    const client = new net.Socket();
    let userSent = false, passSent = false, nsSent = false;

    // Helper: Correctly maps incoming IRIS bytes to Unicode Hebrew Alphabet
    const decodeBuffer = (buf: Buffer): string => {
        if (encoding !== 'windows1255') return buf.toString(encoding as BufferEncoding);
        
        let result = "";
        for (let i = 0; i < buf.length; i++) {
            const byte = buf[i];
            
            // Map 0x80-0x9A range or 0xE0-0xFA range to Hebrew Aleph-Tav
            if (byte >= 0x80 && byte <= 0x9A) {
                result += String.fromCharCode(byte - 0x80 + 0x05D0);
            } else if (byte >= 0xE0 && byte <= 0xFA) {
                result += String.fromCharCode(byte - 0xE0 + 0x05D0);
            } else {
                result += String.fromCharCode(byte);
            }
        }
        return result;
    };

    // Helper: Converts your typed Hebrew characters back to bytes IRIS understands
    const encodeString = (str: string): Buffer => {
        if (encoding !== 'windows1255') return Buffer.from(str, encoding as BufferEncoding);
        
        const buf = Buffer.alloc(str.length);
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            // Map Unicode Hebrew back to the 0x80 range (common for IRIS Windows)
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
            writeEmitter.fire(`\x1b[36m--- IRIS Terminal: ${serverName} [${encoding.toUpperCase()}] ---\x1b[0m\r\n`);
            
            client.connect(23, host);

            client.on('data', (data) => {
                const str = decodeBuffer(data);
                writeEmitter.fire(str.replace(/\n/g, '\r\n'));

                const lowerStr = str.toLowerCase();
                // Auto-login logic
                if (user && !userSent && (lowerStr.includes('login:') || lowerStr.includes('username:'))) {
                    userSent = true;
                    setTimeout(() => client.write(encodeString(user + '\r\n')), 300);
                }
                if (pass && !passSent && lowerStr.includes('password:')) {
                    passSent = true;
                    setTimeout(() => client.write(encodeString(pass + '\r\n')), 300);
                }
                if (namespace && !nsSent && passSent && str.includes('>')) {
                    nsSent = true;
                    setTimeout(() => client.write(encodeString(`zn "${namespace}"\r\n`)), 600);
                }
            });

            client.on('error', (err) => writeEmitter.fire(`\r\n\x1b[31m[ERROR]: ${err.message}\x1b[0m\r\n`));
            client.on('close', () => writeEmitter.fire('\r\n\x1b[33m--- Disconnected ---\x1b[0m\r\n'));
        },
        close: () => client.destroy(),
        handleInput: (data) => {
            if (!client.destroyed) {
                // We encode typed input so Hebrew letters are sent as the correct bytes
                if (data === '\x7f') client.write(encodeString('\x08'));
                else client.write(encodeString(data));
            }
        }
    };

    vscode.window.createTerminal({ name: `IRIS: ${serverName}`, pty }).show();
}

// npm run compile - to compile the extension
// vsce package --skip-license