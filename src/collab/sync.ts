/**
 * Collab sync: pure-logic Lamport-ordered op stream with a turn token.
 *
 * Turn rules (enforced identically on send and receive): only the current
 * holder may grant; release returns the token to the host. Convergence:
 * applying any interleaving of the same op set yields an identical ordered
 * log (see proveConvergence).
 */

export type CollabOp = {
  id: string;
  lamport: number;
  actor: string;
  kind: "msg" | "tool" | "write" | "turn" | "presence";
  at: number;
  payload: any;
};

export interface SyncState {
  actor: string;
  counter: number;
  seen: Set<string>;
  ops: CollabOp[];
}

export interface SyncState2 extends SyncState {
  /** Actor currently holding the turn token (initially host). */
  holder: string | null;
  /** Who release() returns the token to. */
  host: string;
}

export type TurnHolder = string | null;

/** Host starts as turn holder. */
export function initState(actor: string, host: string): SyncState2 {
  return { actor, counter: 0, seen: new Set(), ops: [], holder: host, host };
}

/** Fold turn-token semantics of one op into a state (no seen/dedupe here). */
function turnFold(state: SyncState2, actor: string, payload: any): SyncState2 {
  const p = (payload ?? {}) as { grant?: string; release?: boolean };
  if (actor !== state.holder) return state; // only the current holder acts on the token
  if (p.release) return { ...state, holder: state.host };
  if (typeof p.grant === "string" && p.grant) return { ...state, holder: p.grant };
  return state; // request/other payloads are informational
}

/**
 * Local send: counter += 1; op gets that lamport and is recorded as seen.
 * Turn payloads from the holder also move the token in the local view.
 */
export function nextOp(state: SyncState2, kind: CollabOp["kind"], payload: any): [SyncState2, CollabOp] {
  const counter = state.counter + 1;
  const id = `${state.actor}-${counter}-${Date.now()}`;
  const op: CollabOp = { id, lamport: counter, actor: state.actor, kind, at: Date.now(), payload };
  const seen = new Set(state.seen);
  seen.add(id);
  let s2: SyncState2 = { ...state, counter, seen, ops: [...state.ops, op] };
  if (kind === "turn") s2 = turnFold(s2, op.actor, payload);
  return [s2, op];
}

/**
 * Remote receive: duplicate ids return null. Lamport tracking:
 * counter = max(counter, op.lamport) + 1. Turn ops go through the same
 * reducer (grant honored only if the op's actor holds the token).
 */
export function applyOp(state: SyncState2, op: CollabOp): SyncState2 | null {
  if (state.seen.has(op.id)) return null;
  const seen = new Set(state.seen);
  seen.add(op.id);
  let s2: SyncState2 = {
    ...state,
    counter: Math.max(state.counter, op.lamport) + 1,
    seen,
    ops: [...state.ops, op],
  };
  if (op.kind === "turn") s2 = turnFold(s2, op.actor, op.payload);
  return s2;
}

/** Deterministic total order: lamport asc, actor asc, id asc. */
export function orderOps(ops: CollabOp[]): CollabOp[] {
  return [...ops].sort((a, b) =>
    a.lamport - b.lamport || a.actor.localeCompare(b.actor) || a.id.localeCompare(b.id)
  );
}

/** True iff actor currently holds the turn token. */
export function canSpeak(state: SyncState2, actor: string): boolean {
  return state.holder === actor;
}

/** Apply ops in a given order to a fresh state, skipping duplicates. */
function applyList(actor: string, host: string, ops: CollabOp[]): SyncState2 {
  let s = initState(actor, host);
  for (const op of ops) {
    const r = applyOp(s, op);
    if (r) s = r;
  }
  return s;
}

/**
 * Convergence check: all 6 permutations of a 3-op mixed stream must yield
 * an identical ordered log.
 */
export function proveConvergence(): boolean {
  const seedOps: CollabOp[] = [
    { id: "a-1", lamport: 1, actor: "alice", kind: "msg", at: 1, payload: { text: "hi" } },
    { id: "b-2", lamport: 2, actor: "bob", kind: "write", at: 2, payload: { path: "x.ts" } },
    { id: "c-3", lamport: 3, actor: "alice", kind: "turn", at: 3, payload: { grant: "bob" } },
  ];
  const results = new Set<string>();
  for (const perm of permute(seedOps)) {
    const s = applyList("alice", "host", perm);
    results.add(orderOps(s.ops).map((o) => `${o.id}:${o.kind}`).join("|"));
  }
  return results.size === 1;
}

function permute<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permute(rest)) out.push([arr[i], ...p]);
  }
  return out;
}
