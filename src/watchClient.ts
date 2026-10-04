// The hidden IRIS connection behind Global Watch. It is its own Telnet session (separate from every visible
// terminal), logs in the same way the terminal does, and then runs one request at a time: the typed ObjectScript
// prints a framed answer (see globalWatch.ts) that is read back here. No vscode import: testable on its own.

import * as net from 'net';
import * as tls from 'tls';
import { EventEmitter } from 'events';
import {
    buildListProgram, buildQueryProgram, encodeText, extractFrame, NS_RE, parseNamespaces, parseQueryOutput,
    Pattern, programToLines, QueryResult
} from './globalWatch';

export type WatchSslMode = 'require' | 'prefer' | 'off';

export interface WatchClientOptions {
    host: string;
    port: number;
    user: string;
    pass: string;
    encoding: string;                 // 'utf8' | 'windows1255'
    sslMode: WatchSslMode;
    rejectUnauthorized: boolean;
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
}

export type WatchClientStatus = 'idle' | 'connecting' | 'ready' | 'closed';

/** Removes Telnet option negotiation (IAC ...) from the byte stream, keeping partial sequences for the next chunk. */
class IacStripper {
    private carry: Buffer = Buffer.alloc(0);
    private inSub = false;
    push(chunk: Buffer): Buffer {
        const b = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
        this.carry = Buffer.alloc(0);
        const out: number[] = [];
        for (let i = 0; i < b.length; i++) {
            const c = b[i];
            if (this.inSub) {                 // inside IAC SB ... IAC SE
                if (c === 0xFF) {
                    if (i + 1 >= b.length) { this.carry = b.subarray(i); break; }
                    if (b[i + 1] === 0xF0) { this.inSub = false; i++; }
                }
                continue;
            }
            if (c !== 0xFF) { out.push(c); continue; }
            if (i + 1 >= b.length) { this.carry = b.subarray(i); break; }
            const n = b[i + 1];
            if (n >= 0xFB && n <= 0xFE) {     // WILL / WON'T / DO / DON'T <option>
                if (i + 2 >= b.length) { this.carry = b.subarray(i); break; }
                i += 2;
            } else if (n === 0xFA) { this.inSub = true; i++; }
            else i++;                         // IAC IAC and the two-byte commands
        }
        return Buffer.from(out);
    }
}

interface Pending {
    id: number;
    resolve: (payload: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

export class WatchClient extends EventEmitter {
    status: WatchClientStatus = 'idle';
    /** Namespace the login landed in (read from the first prompt). */
    defaultNs = '';
    currentNs = '';
    closeReason = '';
    /** The last ObjectScript typed (for the "show last query" command). */
    lastProgram = '';

    private socket?: net.Socket | tls.TLSSocket;
    private decoder: InstanceType<typeof TextDecoder>;
    private iac = new IacStripper();
    private buffer = '';
    private nextId = 1;
    private pending?: Pending;
    private chain: Promise<unknown> = Promise.resolve();

    constructor(private readonly opts: WatchClientOptions) {
        super();
        this.decoder = new TextDecoder(opts.encoding === 'windows1255' ? 'windows-1255' : 'utf-8');
    }

    // ---- connecting ----------------------------------------------------------------------------

    connect(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.status = 'connecting';
            let settled = false;
            const finish = (err?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (err) { this.close(err.message); reject(err); } else resolve();
            };
            const timer = setTimeout(() => finish(new Error('Timed out waiting for the IRIS prompt')), this.opts.connectTimeoutMs ?? 20000);
            this.open(this.opts.sslMode !== 'off', finish);
        });
    }

    private open(trySSL: boolean, finish: (err?: Error) => void) {
        const { host, port } = this.opts;
        const socket: net.Socket | tls.TLSSocket = trySSL
            ? tls.connect({ host, port, rejectUnauthorized: this.opts.rejectUnauthorized, timeout: 4000 })
            : net.createConnection(port, host);
        this.socket = socket;
        this.iac = new IacStripper();
        this.decoder = new TextDecoder(this.opts.encoding === 'windows1255' ? 'windows-1255' : 'utf-8');
        const current = () => this.socket === socket;
        let gotData = false;
        let userSent = false;
        let passSent = false;
        let loginText = '';

        const abandon = () => { socket.removeAllListeners(); socket.destroy(); };
        const fallback = () => { abandon(); this.open(false, finish); };

        socket.on('timeout', () => {
            if (!current()) return;
            if (this.status === 'connecting' && !gotData) {
                if (trySSL && this.opts.sslMode !== 'require') fallback();
                else finish(new Error('Connection timed out'));
            }
        });

        socket.on('data', (raw: Buffer) => {
            if (!current()) return;
            gotData = true;
            const str = this.decoder.decode(this.iac.push(raw), { stream: true });

            if (this.status === 'ready') {
                // Line breaks are dropped on arrival: a terminal may wrap long output anywhere, even inside a
                // marker, and genuine line breaks in values travel escaped, so none are needed to read answers.
                this.buffer += str.replace(/[\r\n]/g, '');
                this.pump();
                return;
            }
            if (this.status !== 'connecting') return;

            loginText = (loginText + str).slice(-2000);
            const lower = str.toLowerCase();
            if (lower.includes('login:') || lower.includes('username:')) {
                if (this.opts.user && !userSent) { userSent = true; socket.write(encodeText(this.opts.user + '\r\n', this.opts.encoding)); }
                else if (!this.opts.user) { finish(new Error('The server asks for a login but no username is configured for it')); return; }
            }
            if (lower.includes('password:')) {
                if (this.opts.pass && !passSent) { passSent = true; socket.write(encodeText(this.opts.pass + '\r\n', this.opts.encoding)); }
                else if (passSent) { finish(new Error('Login failed (the server asked for the password again)')); return; }
                else { finish(new Error('The server asks for a password but none is stored for it')); return; }
            }
            // Same prompt test the terminal uses: "NAMESPACE>" at the very end of the received text.
            const m = str.match(/(?:^|\r|\n)([A-Z0-9%_-]+)(?:\s+\S+)?>\s*$/i);
            if (m && m[1]) {
                this.defaultNs = m[1].toUpperCase();
                this.currentNs = this.defaultNs;
                this.buffer = '';
                this.status = 'ready';
                finish();
                this.emit('status', 'ready');
            }
        });

        socket.on('error', (err: Error) => {
            if (!current()) return;
            if (this.status === 'connecting') {
                if (trySSL && !gotData && this.opts.sslMode !== 'require') { fallback(); return; }
                finish(new Error('Connection error: ' + err.message));
                return;
            }
            this.close('Connection error: ' + err.message);
        });

        socket.on('close', () => {
            if (!current()) return;
            if (this.status === 'connecting') finish(new Error('The server closed the connection'));
            else if (this.status === 'ready') this.close('The server closed the connection');
        });
    }

    close(reason = '') {
        const wasClosed = this.status === 'closed';
        this.status = 'closed';
        if (reason && !this.closeReason) this.closeReason = reason;
        if (this.socket) {
            const s = this.socket;
            this.socket = undefined;
            s.removeAllListeners();
            s.on('error', () => { /* ignore errors while closing */ });
            s.destroy();
        }
        if (this.pending) {
            const p = this.pending;
            this.pending = undefined;
            clearTimeout(p.timer);
            p.reject(new Error(this.closeReason || 'Disconnected'));
        }
        if (!wasClosed) this.emit('status', 'closed');
    }

    // ---- requests ------------------------------------------------------------------------------

    private enqueue<T>(job: () => Promise<T>): Promise<T> {
        const run = this.chain.then(job, job);
        this.chain = run.catch(() => undefined);
        return run;
    }

    private pump() {
        const p = this.pending;
        if (!p) { this.buffer = this.buffer.slice(-2000); return; }
        const frame = extractFrame(this.buffer, p.id);
        if (!frame) return;
        this.pending = undefined;
        clearTimeout(p.timer);
        this.buffer = frame.rest;
        p.resolve(frame.payload);
    }

    /** Types the program into the session and resolves with the text between its markers. */
    private exec(id: number, program: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            if (this.status !== 'ready' || !this.socket) { reject(new Error(this.closeReason || 'Not connected')); return; }
            this.lastProgram = program;
            const timer = setTimeout(() => {
                this.close('A request timed out - the connection was closed');
            }, this.opts.requestTimeoutMs ?? 60000);
            this.pending = { id, resolve, reject, timer };
            this.buffer = '';
            for (const line of programToLines(program)) {
                this.socket.write(encodeText(line + '\r\n', this.opts.encoding));
            }
        });
    }

    listNamespaces(): Promise<string[]> {
        return this.enqueue(async () => {
            const id = this.nextId++;
            const payload = await this.exec(id, buildListProgram(id));
            const r = parseNamespaces(payload, id, this.opts.encoding);
            if (r.error) throw new Error(r.error);
            return r.names;
        });
    }

    query(pattern: Pattern, namespace: string, limit: number, valueLimit = 4000): Promise<QueryResult> {
        if (!NS_RE.test(namespace)) return Promise.reject(new Error(`"${namespace}" is not a valid namespace name`));
        return this.enqueue(async () => {
            const id = this.nextId++;
            const program = buildQueryProgram(pattern, {
                id, limit, valueLimit, namespace, currentNamespace: this.currentNs || this.defaultNs
            });
            const payload = await this.exec(id, program);
            return parseQueryOutput(payload, id, this.opts.encoding);
        });
    }
}
