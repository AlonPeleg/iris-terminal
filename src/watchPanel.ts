// Global Watch: the bottom-panel tab. Owns the hidden IRIS connections (one per server tab), the watch lists,
// the auto-refresh timers and the messages to / from the webview (media/globalWatch.html).

import * as vscode from 'vscode';
import { NS_RE, parsePattern, QueryResult } from './globalWatch';
import { WatchClient, WatchSslMode } from './watchClient';
import { GLOBAL_WATCH_HTML } from './globalWatchHtml';

export interface WatchDeps {
    getSslMode(): WatchSslMode;
    getRejectUnauthorized(): boolean;
    getPort(): number;
    getSecretKey(serverId: string, user: string): string;
}

export const GLOBAL_WATCH_VIEW_ID = 'iris-terminal.globalWatch';
const STATE_KEY = 'iris-terminal.globalWatchState';
const ENCODING_KEY = 'iris-terminal.globalWatchEncoding:';
const PAGE = 500;

interface WatchDef { id: number; ns: string; pat: string; on: boolean; open: boolean; limit: number }

interface Conn {
    // saved between sessions
    id: number;
    serverId: string;
    label: string;
    host: string;
    user: string;
    encoding: string;
    watches: WatchDef[];
    secs: number;
    nextWid: number;
    // runtime only
    auto: boolean;
    status: 'connecting' | 'connected' | 'disconnected';
    err?: string;
    nsList?: string[];
    defNs: string;
    refreshing: boolean;
    lastRefresh?: string;
    nextAt?: number;
    client?: WatchClient;
    timer?: NodeJS.Timeout;
    pass: string;
    passSource: 'settings' | 'secret' | 'manual' | 'none';
    gen: number;
}

interface Options { pieces: boolean; delim: string; cdelim: string }

export class GlobalWatchManager implements vscode.WebviewViewProvider, vscode.Disposable {
    private conns: Conn[] = [];
    private active: number | null = null;
    private opts: Options = { pieces: false, delim: '*', cdelim: '' };
    private nextCid = 1;
    private view?: vscode.WebviewView;
    private visible = false;
    private output?: vscode.OutputChannel;

    constructor(private readonly ctx: vscode.ExtensionContext, private readonly deps: WatchDeps) {
        const saved = ctx.globalState.get<any>(STATE_KEY);
        if (saved && Array.isArray(saved.conns)) {
            for (const s of saved.conns) {
                if (!s || typeof s.serverId !== 'string') continue;
                this.conns.push({
                    id: s.id, serverId: s.serverId, label: s.label || s.serverId, host: s.host || '', user: s.user || '',
                    encoding: s.encoding === 'windows1255' ? 'windows1255' : 'utf8',
                    watches: (Array.isArray(s.watches) ? s.watches : []).map((w: any) => ({
                        id: w.id, ns: String(w.ns), pat: String(w.pat), on: w.on !== false, open: w.open !== false, limit: PAGE
                    })),
                    secs: Math.min(3600, Math.max(1, Number(s.secs) || 10)), nextWid: s.nextWid || 1,
                    auto: false, status: 'disconnected', defNs: '', refreshing: false,
                    pass: '', passSource: 'none', gen: 0
                });
            }
            this.nextCid = Math.max(saved.nextCid || 1, ...this.conns.map(c => c.id + 1), 1);
            this.active = this.conns.some(c => c.id === saved.active) ? saved.active : (this.conns[0]?.id ?? null);
            if (saved.opts) this.opts = { pieces: !!saved.opts.pieces, delim: String(saved.opts.delim || '*'), cdelim: String(saved.opts.cdelim || '') };
        }
    }

    // ---- view ----------------------------------------------------------------------------------

    resolveWebviewView(view: vscode.WebviewView) {
        this.view = view;
        this.visible = view.visible;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.ctx.extensionUri] };
        try {
            const nonce = makeNonce();
            view.webview.html = GLOBAL_WATCH_HTML.split('{{NONCE}}').join(nonce).split('{{CSP}}').join(view.webview.cspSource);
            view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.visible = false; this.pauseTimers(); } });
            view.onDidChangeVisibility(() => this.onVisibility(view.visible));
            view.webview.onDidReceiveMessage((m: any) => { void this.onMessage(m); });
        } catch (e: any) {
            // Show the real reason in the tab instead of VS Code's generic "error occurred while loading view".
            const msg = String(e?.stack || e?.message || e).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
            view.webview.html = `<body style="font-family:sans-serif;padding:12px"><b>Global Watch could not start.</b><pre style="white-space:pre-wrap">${msg}</pre></body>`;
            console.error('IRIS Global Watch: could not start the view', e);
        }
    }

    private post(msg: unknown) { void this.view?.webview.postMessage(msg); }

    private pushState() {
        this.post({
            type: 'state',
            state: {
                active: this.active,
                opts: this.opts,
                conns: this.conns.map(c => ({
                    id: c.id, label: c.label, host: c.host, status: c.status, err: c.err, nsList: c.nsList, defNs: c.defNs,
                    auto: c.auto, secs: c.secs, refreshing: c.refreshing, nextAt: c.nextAt, lastRefresh: c.lastRefresh,
                    watches: c.watches
                }))
            }
        });
    }

    private persist() {
        void this.ctx.globalState.update(STATE_KEY, {
            active: this.active, nextCid: this.nextCid, opts: this.opts,
            conns: this.conns.map(c => ({
                id: c.id, serverId: c.serverId, label: c.label, host: c.host, user: c.user, encoding: c.encoding,
                watches: c.watches.map(w => ({ id: w.id, ns: w.ns, pat: w.pat, on: w.on, open: w.open })),
                secs: c.secs, nextWid: c.nextWid
            }))
        });
    }

    private conn(cid: unknown): Conn | undefined { return this.conns.find(c => c.id === cid); }

    private onVisibility(visible: boolean) {
        this.visible = visible;
        if (!visible) { this.pauseTimers(); this.pushState(); return; }
        for (const c of this.conns) if (c.auto && c.status === 'connected') void this.refresh(c);
        this.pushState();
    }

    private pauseTimers() {
        for (const c of this.conns) { this.clearTimer(c); c.nextAt = undefined; }
    }

    private clearTimer(c: Conn) { if (c.timer) { clearTimeout(c.timer); c.timer = undefined; } }

    private schedule(c: Conn) {
        this.clearTimer(c);
        c.nextAt = undefined;
        if (!c.auto || c.status !== 'connected' || !this.visible || !c.watches.some(w => w.on)) return;
        c.nextAt = Date.now() + c.secs * 1000;
        c.timer = setTimeout(() => { void this.refresh(c); }, c.secs * 1000);
    }

    // ---- messages from the webview ---------------------------------------------------------------

    private async onMessage(m: any) {
        if (!m || typeof m.type !== 'string') return;
        switch (m.type) {
            case 'ready': this.pushState(); return;
            case 'connect': await this.addConnection(); return;
            case 'options':
                this.opts = {
                    pieces: !!m.opts?.pieces,
                    delim: ['*', '^', '|', '~', 'other'].includes(m.opts?.delim) ? m.opts.delim : '*',
                    cdelim: String(m.opts?.cdelim ?? '').slice(0, 8)
                };
                this.persist(); this.pushState(); return;
        }
        const c = this.conn(m.cid);
        if (!c) return;
        switch (m.type) {
            case 'select': this.active = c.id; this.persist(); this.pushState(); return;
            case 'closeConn': this.closeConn(c); return;
            case 'disconnect': this.disconnect(c); return;
            case 'reconnect': await this.connect(c); return;
            case 'refresh': await this.refresh(c); return;
            case 'setSecs':
                c.secs = Math.min(3600, Math.max(1, Math.floor(Number(m.secs)) || 10));
                this.persist();
                if (c.auto && !c.refreshing) this.schedule(c);
                this.pushState(); return;
            case 'setAuto': {
                const on = !!m.auto && c.status === 'connected' && c.watches.some(w => w.on);
                c.auto = on;
                if (on) { await this.refresh(c); } else { this.clearTimer(c); c.nextAt = undefined; this.pushState(); }
                return;
            }
            case 'addWatch': this.addWatch(c, String(m.ns ?? ''), String(m.pat ?? '')); return;
            case 'removeWatch':
                c.watches = c.watches.filter(w => w.id !== m.wid);
                if (!c.watches.some(w => w.on)) { c.auto = false; this.clearTimer(c); c.nextAt = undefined; }
                this.persist(); this.pushState(); return;
            case 'setWatch': {
                const w = c.watches.find(x => x.id === m.wid);
                if (!w) return;
                if (typeof m.on === 'boolean') w.on = m.on;
                if (typeof m.open === 'boolean') w.open = m.open;
                if (!c.watches.some(x => x.on)) { c.auto = false; this.clearTimer(c); c.nextAt = undefined; }
                this.persist(); this.pushState(); return;
            }
            case 'more': {
                const w = c.watches.find(x => x.id === m.wid);
                if (!w) return;
                w.limit += PAGE;
                await this.refresh(c, w.id);
                return;
            }
        }
    }

    private addWatch(c: Conn, ns: string, patText: string) {
        const pat = patText.trim();
        const fail = (error: string) => this.post({ type: 'addError', cid: c.id, error, text: patText });
        const r = parsePattern(pat);
        if (!r.ok) return fail(r.error);
        if (!NS_RE.test(ns)) return fail(`"${ns}" is not a valid namespace name`);
        if (c.watches.some(w => w.ns.toUpperCase() === ns.toUpperCase() && w.pat === pat)) return fail('That namespace and pattern are already watched');
        c.watches.push({ id: c.nextWid++, ns, pat, on: true, open: true, limit: PAGE });
        this.persist();
        this.pushState();
    }

    // ---- connections -----------------------------------------------------------------------------

    /** The "+ Connect to server" flow: pick a server, an encoding, and open a hidden connection to it. */
    async addConnection() {
        const picked = await this.pickServer();
        if (!picked) return;
        let c = this.conns.find(x => x.serverId === picked.serverId);
        if (c) {
            this.active = c.id;
            c.host = picked.host; c.encoding = picked.encoding;
            this.persist();
            if (c.status === 'disconnected') await this.connect(c); else this.pushState();
            return;
        }
        c = {
            id: this.nextCid++, serverId: picked.serverId, label: picked.label, host: picked.host, user: '', encoding: picked.encoding,
            watches: [], secs: 10, nextWid: 1, auto: false, status: 'disconnected', defNs: '', refreshing: false,
            pass: '', passSource: 'none', gen: 0
        };
        this.conns.push(c);
        this.active = c.id;
        this.persist();
        await this.connect(c);
    }

    private serverEntry(serverId: string): any {
        const config = vscode.workspace.getConfiguration();
        const list: any = config.get('intersystems.servers') || config.get('interSystems.servers') || {};
        return list[serverId];
    }

    private async pickServer(): Promise<{ serverId: string; label: string; host: string; encoding: string } | undefined> {
        const config = vscode.workspace.getConfiguration();
        const list: any = config.get('intersystems.servers') || config.get('interSystems.servers') || {};
        const names = Object.keys(list);
        if (names.length === 0) {
            void vscode.window.showWarningMessage('IRIS Global Watch: no servers are configured (intersystems.servers).');
            return undefined;
        }
        const items: vscode.QuickPickItem[] = names.map(name => {
            const e = list[name];
            const display = e.description && String(e.description).trim() !== '' ? e.description : name;
            const open = this.conns.some(c => c.serverId === name);
            return { label: `$(server) ${display}`, description: e.webServer?.host || e.host || '', detail: open ? `${name} (already open)` : name };
        });
        const sel = await vscode.window.showQuickPick(items, { placeHolder: 'Open Global Watch on which IRIS server?' });
        if (!sel || !sel.detail) return undefined;
        const serverId = sel.detail.replace(/ \(already open\)$/, '');
        const entry = list[serverId];
        const label = sel.label.replace('$(server) ', '');

        const last = this.ctx.globalState.get<string>(ENCODING_KEY + serverId);
        const encItems = [
            { label: 'Hebrew (Windows-1255)', description: 'Cache servers', detail: 'windows1255' },
            { label: 'UTF-8', description: 'IRIS servers', detail: 'utf8' }
        ];
        if (last === 'utf8') encItems.reverse();
        const enc = await vscode.window.showQuickPick(encItems, { placeHolder: `Select encoding for ${serverId}` });
        if (!enc) return undefined;
        await this.ctx.globalState.update(ENCODING_KEY + serverId, enc.detail);

        let host: string = entry?.webServer?.host || entry?.host || '';
        if (!host) {
            host = (await vscode.window.showInputBox({ prompt: `Host of ${serverId}`, ignoreFocusOut: true })) || '';
            if (!host) return undefined;
        }
        return { serverId, label, host, encoding: enc.detail };
    }

    /** Password: settings.json, then Secret Storage, then ask once (same order the terminal uses). */
    private async credentials(c: Conn): Promise<void> {
        const entry = this.serverEntry(c.serverId);
        const user: string = entry?.username || c.user || '';
        c.user = user;
        const fromSettings: string = entry?.password || '';
        if (fromSettings) { c.pass = fromSettings; c.passSource = 'settings'; return; }
        if (c.pass) return;
        if (!user) { c.pass = ''; c.passSource = 'none'; return; }
        const secretKey = this.deps.getSecretKey(c.serverId, user);
        const stored = (await this.ctx.secrets.get(secretKey)) || '';
        if (stored) { c.pass = stored; c.passSource = 'secret'; return; }
        const entered = await vscode.window.showInputBox({
            prompt: `Password for ${user}@${c.serverId} (Global Watch)`, password: true, ignoreFocusOut: true
        });
        if (!entered) throw new Error('No password entered');
        c.pass = entered;
        c.passSource = 'manual';
        const remember = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Remember this password securely (VS Code Secret Storage)?' });
        if (remember === 'Yes') { await this.ctx.secrets.store(secretKey, entered); c.passSource = 'secret'; }
    }

    async connect(c: Conn) {
        this.dropClient(c);
        const gen = ++c.gen;
        c.status = 'connecting';
        c.err = undefined;
        c.nsList = undefined;
        c.auto = false;
        this.pushState();
        let client: WatchClient | undefined;
        try {
            await this.credentials(c);
            client = new WatchClient({
                host: c.host, port: this.deps.getPort(), user: c.user, pass: c.pass, encoding: c.encoding,
                sslMode: this.deps.getSslMode(), rejectUnauthorized: this.deps.getRejectUnauthorized()
            });
            c.client = client;
            const mine = client;
            mine.on('status', (s: string) => {
                if (s === 'closed' && c.client === mine && c.gen === gen && c.status === 'connected') this.onDropped(c, mine.closeReason);
            });
            await mine.connect();
            if (c.gen !== gen) { mine.close(); return; }
            c.status = 'connected';
            c.defNs = mine.defaultNs;
            c.nsList = [mine.defaultNs];
            this.pushState();
            try {
                const list = await mine.listNamespaces();
                if (c.gen !== gen) return;
                c.nsList = list.length ? list : [mine.defaultNs];
            } catch { /* keep just the default namespace; the dropdown still works for it */ }
            this.pushState();
        } catch (e: any) {
            if (c.gen !== gen) return;
            client?.close();
            c.client = undefined;
            c.status = 'disconnected';
            let msg: string = e?.message || String(e);
            if (/^Login failed/.test(msg) && c.passSource === 'secret') {
                await this.ctx.secrets.delete(this.deps.getSecretKey(c.serverId, c.user));
                c.pass = '';
                msg += ' - the stored password was cleared; press Reconnect to enter it again';
            } else if (/^Login failed/.test(msg)) {
                c.pass = '';
            }
            c.err = msg;
            this.pushState();
        }
    }

    private dropClient(c: Conn) {
        this.clearTimer(c);
        c.nextAt = undefined;
        if (c.client) { const cl = c.client; c.client = undefined; cl.removeAllListeners(); cl.close(); }
    }

    private onDropped(c: Conn, reason: string) {
        this.clearTimer(c);
        c.nextAt = undefined;
        c.client = undefined;
        c.status = 'disconnected';
        c.auto = false;
        c.refreshing = false;
        c.err = reason || 'The connection was lost';
        this.pushState();
    }

    disconnect(c: Conn) {
        c.gen++;
        this.dropClient(c);
        c.status = 'disconnected';
        c.auto = false;
        c.refreshing = false;
        c.err = undefined;
        this.pushState();
    }

    private closeConn(c: Conn) {
        this.disconnect(c);
        this.conns = this.conns.filter(x => x !== c);
        if (this.active === c.id) this.active = this.conns[0]?.id ?? null;
        this.persist();
        this.pushState();
    }

    // ---- reading ---------------------------------------------------------------------------------

    private async refresh(c: Conn, only?: number) {
        const client = c.client;
        if (c.status !== 'connected' || !client || c.refreshing) return;
        const list = c.watches.filter(w => w.on && (only === undefined || w.id === only));
        if (list.length === 0) { this.schedule(c); this.pushState(); return; }
        c.refreshing = true;
        this.clearTimer(c);
        c.nextAt = undefined;
        this.pushState();
        try {
            for (const w of list) {
                if (c.client !== client || client.status !== 'ready') break;
                const parsed = parsePattern(w.pat);
                let result: QueryResult;
                if (!parsed.ok) {
                    result = { exists: false, truncated: false, rows: [], error: parsed.error };
                } else {
                    try {
                        result = await client.query(parsed.pattern, w.ns, w.limit);
                    } catch (e: any) {
                        if (client.status !== 'ready') break;
                        result = { exists: false, truncated: false, rows: [], error: e?.message || String(e) };
                    }
                }
                this.post({ type: 'result', cid: c.id, wid: w.id, result, time: Date.now() });
            }
        } finally {
            c.refreshing = false;
            c.lastRefresh = new Date().toTimeString().slice(0, 8);
            this.schedule(c);
            this.pushState();
        }
    }

    // ---- commands --------------------------------------------------------------------------------

    async open() {
        await vscode.commands.executeCommand(`${GLOBAL_WATCH_VIEW_ID}.focus`);
        if (this.conns.length === 0) await this.addConnection();
    }

    showLastQuery() {
        if (!this.output) this.output = vscode.window.createOutputChannel('IRIS Global Watch');
        const out = this.output;
        out.clear();
        let any = false;
        for (const c of this.conns) {
            if (!c.client?.lastProgram) continue;
            any = true;
            out.appendLine(`=== ${c.label} (${c.serverId}) - the ObjectScript typed for the last request ===`);
            out.appendLine(c.client.lastProgram);
            out.appendLine('');
        }
        if (!any) out.appendLine('Nothing has been sent yet: connect to a server and press refresh first.');
        out.show(true);
    }

    dispose() {
        for (const c of this.conns) { c.gen++; this.dropClient(c); }
        this.output?.dispose();
    }
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}

export function registerGlobalWatch(context: vscode.ExtensionContext, deps: WatchDeps): vscode.Disposable[] {
    const mgr = new GlobalWatchManager(context, deps);
    return [
        mgr,
        vscode.window.registerWebviewViewProvider(GLOBAL_WATCH_VIEW_ID, mgr, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand('iris-terminal.openGlobalWatch', () => mgr.open()),
        vscode.commands.registerCommand('iris-terminal.globalWatchShowQuery', () => mgr.showLastQuery())
    ];
}
