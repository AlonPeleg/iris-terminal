// Works out which IRIS server and namespace an editor belongs to, from the document's URI and the workspace's
// "objectscript.conn" setting (the InterSystems ObjectScript extension's own settings). Pure - the caller
// reads the VS Code settings and passes them in - so it can be tested on its own.

export interface EditorUri { scheme: string; authority: string; query: string }

/** objectscript.conn: new style { server, ns } or old style { host, port, ns } */
export interface ObjectScriptConn { server?: string; ns?: string; host?: string; port?: number; active?: boolean }

export interface EditorServer {
    serverId?: string;      // key of intersystems.servers, as written there
    namespace?: string;
    problem?: string;       // why serverId is missing
}

function findServer(name: string, servers: Record<string, any>): string | undefined {
    if (Object.prototype.hasOwnProperty.call(servers, name)) return name;
    const lower = name.toLowerCase();
    return Object.keys(servers).find(k => k.toLowerCase() === lower);
}

function decode(s: string): string {
    try { return decodeURIComponent(s); } catch { return s; }
}

export function resolveEditorServer(uri: EditorUri, conn: ObjectScriptConn | undefined, servers: Record<string, any>): EditorServer {
    const query = new URLSearchParams(uri.query || '');

    // isfs://server:NAMESPACE/path   isfs://server/path?ns=NAMESPACE   (also isfs-readonly, and objectscript:// documents)
    if (/^isfs/i.test(uri.scheme) || uri.scheme === 'objectscript') {
        let name = decode(uri.authority);
        let ns = query.get('ns') || query.get('namespace') || undefined;
        const colon = name.indexOf(':');
        if (colon >= 0) {
            if (!ns) ns = name.slice(colon + 1) || undefined;
            name = name.slice(0, colon);
        }
        const fromQuery = query.get('server');
        const serverId = findServer(name, servers) || (fromQuery ? findServer(fromQuery, servers) : undefined);
        if (serverId) return { serverId, namespace: ns };
        return { namespace: ns, problem: name ? `the server "${name}" in this editor's address is not in intersystems.servers` : undefined };
    }

    // a local file: use the workspace connection
    if (conn && conn.active !== false) {
        if (conn.server) {
            const serverId = findServer(conn.server, servers);
            if (serverId) return { serverId, namespace: conn.ns };
            return { namespace: conn.ns, problem: `the server "${conn.server}" from objectscript.conn is not in intersystems.servers` };
        }
        if (conn.host) {
            const host = conn.host.toLowerCase();
            const hit = Object.keys(servers).find(k => {
                const e = servers[k] || {};
                const h = String(e.webServer?.host || e.host || '').toLowerCase();
                return h !== '' && h === host;
            });
            if (hit) return { serverId: hit, namespace: conn.ns };
            return { namespace: conn.ns, problem: `objectscript.conn points at ${conn.host}, which no entry of intersystems.servers matches` };
        }
    }
    return { problem: 'this file is not tied to an IRIS server (no objectscript.conn for this workspace)' };
}
