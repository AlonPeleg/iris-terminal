// Which IRIS terminal should code from an editor go to? Pure (no VS Code API) so it can be tested on its own.
//
// target: the server / namespace the editor belongs to (from its address or the workspace connection), if known.
//   - no terminal for that server at all        -> open one (on the editor's namespace)
//   - terminals for it, but all disconnected    -> ask the user to reconnect
//   - a live terminal already on the namespace  -> use it (the active one first)
//   - live terminals, none on that namespace    -> use one and `zn` it to the editor's namespace first
//   - editor's server unknown                   -> the old behaviour: any terminal (asked when there are several)

export interface Candidate { serverId: string; ns: string; alive: boolean; active: boolean }

export type Choice =
    | { kind: 'use'; index: number; switchTo?: string }
    | { kind: 'open' }
    | { kind: 'reconnect' }
    | { kind: 'generic' };

export function chooseSession(candidates: Candidate[], target: { serverId?: string; namespace?: string }): Choice {
    if (!target.serverId) return { kind: 'generic' };
    const sid = target.serverId.toLowerCase();
    const same = candidates.map((c, index) => ({ c, index })).filter(o => o.c.serverId.toLowerCase() === sid);
    if (same.length === 0) return { kind: 'open' };
    const alive = same.filter(o => o.c.alive);
    if (alive.length === 0) return { kind: 'reconnect' };
    alive.sort((a, b) => Number(b.c.active) - Number(a.c.active));
    const ns = (target.namespace || '').trim();
    if (ns === '') return { kind: 'use', index: alive[0].index };
    const onNs = alive.find(o => o.c.ns.toUpperCase() === ns.toUpperCase());
    if (onNs) return { kind: 'use', index: onNs.index };
    return { kind: 'use', index: alive[0].index, switchTo: ns };
}
