// Keeps the last few command outputs of an IRIS terminal, so a Ctrl+Click on any row of a zw output can open the
// whole output in the Global Viewer (a long value wraps over many terminal rows; VS Code hands the link provider one
// row at a time, so the row alone is not enough).
//
// It works from what the server sends, not from the keys typed: the server echoes the command after the prompt, then
// prints the output, then the next prompt. So a block is "everything between two prompts", and its first line is the
// command as echoed (after backspaces and line recall have been applied, the way the screen shows it).

import { vtParseZwLine } from './valueTree';

export interface OutputBlock {
    id: number;
    cmd: string;          // the command line as echoed, e.g. "zw out"
    lines: string[];      // the output lines after it
    kind: 'zw' | 'json' | 'other';
    time: string;
    truncated: boolean;
}

const MAX_BLOCKS = 30;                  // the last 30 command outputs per terminal
const MAX_BLOCK_CHARS = 2_000_000;      // a huge output is cut here (the viewer would not show more anyway)
// Same prompt as the terminal's namespace tracking: NS> or NS 2d0> at the end of the text.
const PROMPT_AT_END = /(?:^|\n)[A-Z0-9%_-]+(?:\s+\S+)?>\s*$/i;

/** Takes the escape sequences out of terminal output (colors, cursor moves, titles, telnet bytes), keeping the
 *  characters that move the cursor on a line (\r, \b) so a line can be replayed the way it ends up on screen. */
export function stripTerminalCodes(s: string): string {
    return s
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')      // OSC (window title ...)
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')               // CSI (colors, cursor)
        .replace(/\x1b[()][A-Za-z0-9]/g, '')                     // character set selection
        .replace(/\x1b[@-_]/g, '')                               // other two-character escapes
        .replace(/[\x00-\x07\x0B\x0C\x0E-\x1F\x7F�]/g, ''); // other control characters (keeps \b \t \n \r)
}

/** One line as it ends up on screen: \r goes back to the start (and later text overwrites), \b goes back one. */
export function replayLine(raw: string): string {
    const out: string[] = [];
    let at = 0;
    for (const ch of raw) {
        if (ch === '\r') { at = 0; continue; }
        if (ch === '\b') { at = Math.max(0, at - 1); continue; }
        out[at++] = ch;
    }
    return out.join('').replace(/\s+$/, '');
}

/** zw / zwrite (alone or after other commands on the line). */
export function isZwCommand(cmd: string): boolean {
    return /(^|\s)(zw|zwrite)(\s|$)/i.test(cmd);
}
/** w / write, whose output may be JSON (w obj.%ToJSON()). */
function isWriteCommand(cmd: string): boolean {
    return /(^|\s)(w|write)\s/i.test(cmd);
}
function looksLikeJson(lines: string[]): boolean {
    const text = lines.join('').trim();
    if (!text || (text[0] !== '{' && text[0] !== '[')) return false;
    try { JSON.parse(text); return true; } catch { return false; }
}

export class OutputBlocks {
    private buf = '';
    private tail = '';          // the end of what came in, for spotting the prompt even after a cut
    private truncated = false;
    private promptSeen = false; // a prompt has been shown since the last command started
    private nextId = 1;
    readonly blocks: OutputBlock[] = [];   // newest last

    /** Drops the half-read block (after a reconnect: the next prompt starts fresh). */
    reset() { this.buf = ''; this.tail = ''; this.truncated = false; this.promptSeen = false; }

    /** True while the terminal waits at an empty prompt (so the extension may type a command there). */
    atPrompt(): boolean {
        // At a prompt, and what is on the line after it is empty once backspaces are applied (typed and deleted).
        return this.promptSeen && !this.buf.includes('\n') && replayLine(this.buf) === '';
    }

    /** Feeds what the server sent (already decoded). Closes a block whenever the text ends at a prompt and returns
     *  that command and its output (also a command that printed nothing: lines is then empty). */
    feed(chunk: string, now: () => string = () => new Date().toLocaleTimeString()): { cmd: string; lines: string[]; block?: OutputBlock } | undefined {
        const clean = stripTerminalCodes(chunk);
        if (!clean) return undefined;
        if (!this.truncated) {
            if (this.buf.length + clean.length > MAX_BLOCK_CHARS) {
                this.buf += clean.slice(0, Math.max(0, MAX_BLOCK_CHARS - this.buf.length));
                this.truncated = true;
            } else this.buf += clean;
        }
        this.tail = (this.tail + clean).slice(-300);
        if (!PROMPT_AT_END.test(this.tail.replace(/\r/g, ''))) return undefined;

        // The text up to the prompt's own line is the block: the echoed command, then the output.
        let text = this.buf.replace(/\r\n/g, '\n');
        const cut = text.lastIndexOf('\n');
        text = cut >= 0 ? text.slice(0, cut) : '';
        const wasCut = this.truncated;
        this.reset();
        this.promptSeen = true;
        if (!text) return undefined;
        const lines = text.split('\n').map(replayLine);
        const cmd = (lines.shift() || '').trim();
        while (lines.length && !lines[lines.length - 1]) lines.pop();
        if (!cmd) return undefined;
        if (!lines.length) return { cmd, lines };
        let kind: OutputBlock['kind'] = 'other';
        if (isZwCommand(cmd)) kind = 'zw';
        else if (isWriteCommand(cmd) && looksLikeJson(lines)) kind = 'json';
        const block: OutputBlock = { id: this.nextId++, cmd, lines, kind, time: now(), truncated: wasCut };
        this.blocks.push(block);
        if (this.blocks.length > MAX_BLOCKS) this.blocks.shift();
        return { cmd, lines, block };
    }

    byId(id: number): OutputBlock | undefined { return this.blocks.find(b => b.id === id); }

    /** The newest zw / JSON output, for "Open Last zw Output". */
    lastCapture(): OutputBlock | undefined {
        for (let i = this.blocks.length - 1; i >= 0; i--) if (this.blocks[i].kind !== 'other') return this.blocks[i];
        return undefined;
    }

    /** Which zw / JSON output a terminal row belongs to (newest first): the row is one of its lines, or a piece of
     *  one (a long line the terminal wrapped). Global rows (^g(1)=...) are left to the normal global link. */
    findCaptureLine(row: string): { block: OutputBlock; lineIndex: number } | undefined {
        const text = row.replace(/\s+$/, '');
        const probe = text.trim();
        if (!probe) return undefined;
        for (let b = this.blocks.length - 1; b >= 0; b--) {
            const block = this.blocks[b];
            if (block.kind === 'other') continue;
            let idx = block.lines.findIndex(l => l === text || l.trim() === probe);
            if (idx < 0 && probe.length >= 8) idx = block.lines.findIndex(l => l.includes(probe));
            if (idx < 0) continue;
            if (block.lines[idx].trimStart().startsWith('^')) return undefined;
            return { block, lineIndex: idx };
        }
        return undefined;
    }
}

/** The tree path to open at for a clicked line: the variable (and array node) that line is about. A row of an
 *  object dump (| Name = ...) or of "(other output)" opens on the variable printed above it. */
export function selectPathFor(block: OutputBlock, lineIndex: number): string[] {
    for (let i = lineIndex; i >= 0; i--) {
        const z = vtParseZwLine(block.lines[i]);
        if (z) return [z.name, ...z.subs];
    }
    return [];
}

// ------------------------------------------------------------- long lines ----------------------------------------
// VS Code does not ask an extension for links on a line longer than 2,000 characters (wrapped rows included): it
// hands the provider nothing for any row of it, so a long global / zw line could not be Ctrl+Clicked at all.
// So a long data line is cut into pieces of whole rows (under 2,000 characters each) by ending a row exactly where
// the terminal wraps it anyway: the screen looks the same, but every piece is a line VS Code asks links for, and each
// piece is mapped back to the full line here. (Copying the line out of the terminal then has a line break between
// pieces; the viewer's Copy has the exact value.)

/** Most characters in one piece (VS Code's limit is 2,000; wide characters and rounding stay under it). */
export const LONG_LINE_CHARS = 1900;
const PROMPT_START = /^[A-Z0-9%_-]+(?:\s+\S+)?>/i;

/** Terminal cells a character takes: 0 for combining marks (Hebrew points, accents), 2 for wide (CJK, emoji). */
export function cellWidth(cp: number): number {
    if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x591 && cp <= 0x5c7 && cp !== 0x5be && cp !== 0x5c0 && cp !== 0x5c3 && cp !== 0x5c6)
        || (cp >= 0x200b && cp <= 0x200f)) return 0;
    if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
        || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f300) return 2;
    return 1;
}

export class LongLines {
    /** Terminal width in columns (from the terminal; pieces end exactly at a row's end). */
    cols = 80;
    private cells = 0;          // cells used in the current piece
    private piece = '';         // text of the current piece
    private pieces: string[] = [];
    private line = '';          // the whole current line (plain text), up to MAX_BLOCK_CHARS
    private plain = true;       // no escape codes / cursor moves in this line, so cell counting is exact
    private noSplit = false;    // decided not to cut this line
    private esc: '' | 'esc' | 'csi' | 'osc' = '';
    private cr = false;
    private nextId = 1;
    private readonly full = new Map<number, string>();          // id -> full line (the last 50 cut lines)
    private readonly byPiece = new Map<string, number>();       // piece text -> id

    private pieceCells(): number {
        const cols = Math.max(10, this.cols || 80);
        return cols >= LONG_LINE_CHARS ? LONG_LINE_CHARS : Math.max(1, Math.floor(LONG_LINE_CHARS / cols)) * cols;
    }

    /** Returns the chunk to show: the same text, with a line end put in where a long data line wraps from one piece
     *  to the next. Only lines that hold '=' (a global or variable and its value), are not the command typed at the
     *  prompt, and have no escape codes are cut. */
    annotate(chunk: string): string {
        let out = '';
        const limit = this.pieceCells();
        for (const ch of chunk) {
            const cp = ch.codePointAt(0) as number;
            if (this.esc) {                                         // inside an escape sequence: pass it through
                out += ch;
                if (this.esc === 'esc') this.esc = ch === '[' ? 'csi' : ch === ']' ? 'osc' : '';
                else if (this.esc === 'csi') { if (cp >= 0x40 && cp <= 0x7e) this.esc = ''; }
                else if (ch === '\x07' || ch === '\\') this.esc = '';
                continue;
            }
            if (ch === '\x1b') { this.esc = 'esc'; this.plain = false; out += ch; continue; }
            if (ch === '\n') { this.endLine(); out += ch; continue; }
            if (ch === '\r') { this.cr = true; out += ch; continue; }
            if (this.cr) { this.cr = false; this.plain = false; this.cells = 0; }   // \r then more text: overwriting
            if (cp < 0x20 || cp === 0x7f) { this.plain = false; out += ch; continue; }  // \b, \t, ...
            const w = cellWidth(cp);
            if (this.cells + w > limit && !this.noSplit) {
                if (this.plain && this.line.includes('=') && !PROMPT_START.test(this.line)) {
                    out += '\r\n';
                    this.pieces.push(this.piece);
                    this.piece = '';
                    this.cells = 0;
                } else this.noSplit = true;
            }
            out += ch;
            this.cells += w;
            this.piece += ch;
            if (this.line.length < MAX_BLOCK_CHARS) this.line += ch;
        }
        return out;
    }

    private endLine() {
        if (this.pieces.length) {
            this.pieces.push(this.piece);
            const id = this.nextId++;
            this.full.set(id, this.line);
            for (const p of this.pieces) { const k = p.replace(/\s+$/, ''); if (k) this.byPiece.set(k, id); }
            while (this.full.size > 50) {
                const old = this.full.keys().next().value as number;
                this.full.delete(old);
                for (const [k, v] of this.byPiece) if (v === old) this.byPiece.delete(k);
            }
        }
        this.cells = 0; this.piece = ''; this.pieces = []; this.line = ''; this.plain = true; this.noSplit = false; this.cr = false;
    }

    /** The full line a terminal row belongs to, when that row is a piece of a cut long line (else undefined). */
    lineForRow(row: string): string | undefined {
        const id = this.byPiece.get(row.replace(/\s+$/, ''));
        return id === undefined ? undefined : this.full.get(id);
    }

    reset() { this.endLine(); this.pieces = []; this.esc = ''; }
}

/** The single expression a "zw" command line writes (zw out.list -> out.list), or undefined for zw alone, several
 *  arguments, or a plain variable / array (those print "name=value" lines themselves). */
export function zwExpression(cmd: string): string | undefined {
    const m = /(?:^|\s)(?:zw|zwrite)\s+(.+)$/i.exec(cmd.trim());
    if (!m) return undefined;
    let arg = m[1].trim(), depth = 0, q = false;
    for (let i = 0; i < arg.length; i++) {
        const c = arg[i];
        if (c === '"') q = !q;
        else if (!q && c === '(') depth++;
        else if (!q && c === ')') depth--;
        else if (!q && depth === 0 && (c === ',' || c === ' ')) { if (c === ',') return undefined; arg = arg.slice(0, i); break; }
    }
    return /^%?[A-Za-z][A-Za-z0-9]*(\(.*\))?$/.test(arg) ? undefined : arg;
}
