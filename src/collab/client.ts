/**
 * CollabSession: a live relay connection for one actor.
 *
 * Connects to the relay from an invite code, authenticates (hello frame),
 * sends/receives CollabOps through a pure sync.ts state (local dedupe via
 * op ids, Lamport counters). Presence frames (relay-generated) maintain
 * the peer roster. Backoff reconnect 0.5/1/2s, max 3 tries, then
 * onClosed(reason). ready resolves after the relay's {"welcome":true}.
 */
import { applyOp, canSpeak, initState, nextOp, type CollabOp, type SyncState2 } from "./sync.ts";
import { decodeInvite } from "./invite.ts";

export interface PeerInfo {
  id: string;
  name: string;
}

/** A live collab session (TUI or console join loop). */
export interface CollabSession {
  /** Local actor name carried on every outbound op. */
  readonly actor: string;
  /** Invite code (for /share). */
  readonly inviteCode: string;
  peers: () => PeerInfo[];
  /** Lamport-stamp the op from sync state, apply locally, broadcast it. */
  sendOp: (kind: CollabOp["kind"], payload: any) => CollabOp;
  onOp: (cb: (op: CollabOp) => void) => void;
  onPeers: (cb: (peers: PeerInfo[]) => void) => void;
  /** Set a callback fired when reconnect attempts are exhausted. */
  onClosed: (cb: (reason: string) => void) => void;
  close: () => void;
  /** Resolves after the relay's welcome ack. */
  ready: Promise<void>;
  /** Actor currently holding the turn token, per local sync state. */
  holder: () => string | null;
  /** True when `actor` may speak (holds the turn). */
  canSpeak: (actor: string) => boolean;
  /** Broadcast a turn grant to `name`. */
  grant: (name: string) => void;
  /** Broadcast a turn release (token returns to host). */
  release: () => void;
}

export function CollabClient(opts: { invite: string; name: string; host?: string }): CollabSession {
  const { invite, name } = opts;
  let host = "", room = "", key = "";
  try {
    const p = decodeInvite(invite);
    host = p.u; room = p.r; key = p.k;
  } catch { /* connect stays failed */ }

  let sync = initState(name, opts.host ?? name);
  const peers = new Map<string, PeerInfo>();
  const opCbs: Array<(op: CollabOp) => void> = [];
  const peerCbs: Array<(peers: PeerInfo[]) => void> = [];
  let ws: any = null;
  let attempts = 0;
  let closed = false;
  let onClosedCb: ((reason: string) => void) | null = null;
  let resolveReady: () => void = () => {};
  let readySettled = false;
  const ready = new Promise<void>((r) => { resolveReady = r; });

  function connect() {
    if (closed || !host) return;
    try {
      ws = new WebSocket(`${host}/r/${encodeURIComponent(room)}`);
    } catch {
      scheduleReconnect("connect failed");
      return;
    }
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ hello: true, key, room, name })); } catch { /* */ }
    };
    ws.onmessage = (ev: any) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg?.welcome) {
        attempts = 0;
        if (!readySettled) { readySettled = true; resolveReady(); }
        return;
      }
      if (msg?.error || !msg?.kind) return;
      const op = msg as CollabOp;
      if (op.actor === name) return; // never re-apply our own ids
      if (op.kind === "presence") {
        const p = op.payload ?? {};
        if (p.join && p.join !== name) peers.set(p.join, { id: p.join, name: p.join });
        else if (p.leave) peers.delete(p.leave);
        notifyPeers();
        return;
      }
      const next = applyOp(sync, op);
      if (!next) return; // duplicate id
      sync = next;
      for (const cb of opCbs) { try { cb(op); } catch { /* */ } }
    };
    ws.onclose = (ev: any) => scheduleReconnect(ev?.reason || `closed${ev?.code ? ` (${ev.code})` : ""}`);
    ws.onerror = () => { /* onclose follows */ };
  }

  function scheduleReconnect(reason: string) {
    if (closed) return;
    if (attempts >= 3) { onClosedCb?.(reason); return; }
    const delay = [500, 1000, 2000][attempts];
    attempts++;
    setTimeout(connect, delay);
  }

  function notifyPeers() {
    const list = [...peers.values()];
    for (const cb of peerCbs) { try { cb(list); } catch { /* */ } }
  }

  connect();

  const session: CollabSession = {
    actor: name,
    inviteCode: invite,
    peers: () => [...peers.values()],
    sendOp: (kind, payload) => {
      let op: CollabOp;
      [sync, op] = nextOp(sync, kind, payload);
      if (ws?.readyState === 1) ws.send(JSON.stringify(op));
      return op;
    },
    onOp: (cb) => { opCbs.push(cb); },
    onPeers: (cb) => { peerCbs.push(cb); },
    onClosed: (cb) => { onClosedCb = cb; },
    close: () => {
      closed = true;
      try { ws?.close(); } catch { /* */ }
    },
    ready,
    holder: () => sync.holder,
    canSpeak: (a) => canSpeak(sync, a),
    grant: (peer) => session.sendOp("turn", { grant: peer }),
    release: () => session.sendOp("turn", { release: true }),
  };
  return session;
}
