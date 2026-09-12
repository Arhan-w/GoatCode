/**
 * WebSocket relay: per-room, first-frame auth, dumb transport.
 *
 * ws clients join a room via path /r/<room>; the first frame must be
 * {"hello":true,"key":...}. Non-matching key -> close(4001). After auth
 * the relay echoes {"welcome":true}, sends the newcomer presence-join
 * frames for existing members, and announces the newcomer to them.
 * Each subsequent text frame is forwarded to all OTHER authenticated
 * members of the same room only. No ordering, no storage — a relay.
 */
interface RelayMember {
  room: string;
  actor: string;
}

export interface RelayHost {
  port: number;
  roomMembers: (room: string) => number;
  close: () => void;
}

/** room -> shared key (empty/undefined = open room). */
const roomKeys = new Map<string, string>();

export function registerRoomKey(room: string, key: string): void {
  roomKeys.set(room, key);
}

export function startRelay(opts: { port?: number } = {}): RelayHost {
  // ws handle -> member record; identity-keyed so close() removes exactly it
  const members = new Map<any, RelayMember>();
  const port: number = opts.port ?? 0;

  const send = (ws: any, obj: any) => {
    try { ws.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  };

  /** Forward raw text to every authenticated member of `room` except `sender`. */
  const broadcast = (room: string, sender: any, data: string) => {
    for (const [ws, m] of members) {
      if (m.room !== room || ws === sender) continue;
      try { ws.send(data); } catch { /* */ }
    }
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    websocket: {
      message(ws: any, data: string | Buffer) {
        const text = typeof data === "string" ? data : data.toString("utf8");
        let msg: any;
        try {
          msg = JSON.parse(text);
        } catch {
          send(ws, { error: "malformed JSON" }); // keep the socket alive
          return;
        }
        if (!members.has(ws)) {
          // first frame must be the hello/auth handshake
          if (!msg || msg.hello !== true) { send(ws, { error: "expected hello frame" }); return; }
          const room: string = msg.room ?? ws.data?.room ?? "";
          if (!room) { try { ws.close(4000, "missing room"); } catch { /* */ } return; }
          const stored = roomKeys.get(room);
          if (stored && stored !== msg.key) { try { ws.close(4001, "bad key"); } catch { /* */ } return; }
          const actor: string = String(msg.name ?? "anon");
          members.set(ws, { room, actor });
          send(ws, { welcome: true });
          // catch the newcomer up on existing members, then announce it
          for (const [other, m] of members) {
            if (m.room !== room || other === ws) continue;
            send(ws, { kind: "presence", payload: { join: m.actor, actor: m.actor } });
            send(other, { kind: "presence", payload: { join: actor, actor } });
          }
          return;
        }
        const d = members.get(ws)!;
        broadcast(d.room, ws, text);
      },
      close(ws: any) {
        const d = members.get(ws);
        if (!d) return;
        members.delete(ws);
        broadcast(d.room, ws, JSON.stringify({ kind: "presence", payload: { leave: d.actor, actor: d.actor } }));
      },
    },
    fetch(req: any, srv: any) {
      const room = new URL(req.url).pathname.match(/^\/r\/([^/?]+)$/)?.[1];
      if (!room) return new Response("not found", { status: 404 });
      return srv.upgrade(req, { data: { room } }) || new Response("upgrade required", { status: 426 });
    },
  });

  return {
    port: server.port ?? 0,
    roomMembers: (room: string) => {
      let n = 0;
      for (const m of members.values()) if (m.room === room) n++;
      return n;
    },
    close: () => {
      for (const ws of members.keys()) { try { ws.close(1001, "relay shutting down"); } catch { /* */ } }
      members.clear();
      server.stop(true);
    },
  };
}
