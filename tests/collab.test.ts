/**
 * Collab test suite: invite round-trip, hostile codes, sync unit
 * matrix, convergence, real relay integration, client handoff.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "goat-collab-"));
  savedEnv.GOATCODE_HOME = process.env.GOATCODE_HOME;
  process.env.GOATCODE_HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `cond` every 50ms up to ~5s; true if it ever held. */
async function until(cond: () => boolean, budgetMs = 5000): Promise<boolean> {
  for (let waited = 0; waited < budgetMs; waited += 50) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

function inviteFor(host: string, room: string, key: string): string {
  return Buffer.from(JSON.stringify({ v: 1, u: host, r: room, k: key })).toString("base64url");
}

// ---------- invite ----------
describe("invite", () => {
  test("round-trip encode/decode", async () => {
    const { encodeInvite, decodeInvite } = await import("../src/collab/invite.ts");
    const code = encodeInvite({ host: "ws://127.0.0.1:8790", room: "test-room" });
    const p = decodeInvite(code);
    expect(p.v).toBe(1);
    expect(p.u).toBe("ws://127.0.0.1:8790");
    expect(p.r).toBe("test-room");
    expect(p.k).toHaveLength(16);
  });

  test("explicit key survives round-trip", async () => {
    const { encodeInvite, decodeInvite } = await import("../src/collab/invite.ts");
    const code = encodeInvite({ host: "ws://h:1", room: "r", key: "deadbeefcafebabe" });
    expect(decodeInvite(code).k).toBe("deadbeefcafebabe");
  });

  test("hostile codes throw", async () => {
    const { decodeInvite } = await import("../src/collab/invite.ts");
    // not base64url (Buffer.from never throws, so decodeInvite validates the charset)
    expect(() => decodeInvite("not-valid-base64!!!")).toThrow("not valid base64url");
    // wrong version
    const badVer = Buffer.from(JSON.stringify({ v: 99, u: "x", r: "r", k: "a".repeat(16) })).toString("base64url");
    expect(() => decodeInvite(badVer)).toThrow("unknown version");
    // missing key
    const noKey = Buffer.from(JSON.stringify({ v: 1, u: "x", r: "r", k: "" })).toString("base64url");
    expect(() => decodeInvite(noKey)).toThrow("missing or short key");
    // malformed JSON (valid base64url, not JSON)
    const mal = Buffer.from("not-json").toString("base64url");
    expect(() => decodeInvite(mal)).toThrow("malformed JSON");
  });
});

// ---------- sync ----------
describe("sync", () => {
  test("lamport monotonicity across send/recv", async () => {
    const { initState, nextOp, applyOp } = await import("../src/collab/sync.ts");
    const s0 = initState("alice", "host");
    const [s1, op] = nextOp(s0, "msg", { text: "hi" });
    expect(op.lamport).toBe(1); // counter += 1 on send
    expect(s1.counter).toBe(1);
    const bob = initState("bob", "host");
    const bob2 = applyOp(bob, op);
    expect(bob2).not.toBeNull();
    expect(bob2!.counter).toBe(2); // max(0,1)+1 on receive
    // next local send continues above the received lamport
    const [, op2] = nextOp(bob2!, "msg", { text: "yo" });
    expect(op2.lamport).toBe(3);
  });

  test("duplicate op returns null", async () => {
    const { initState, nextOp, applyOp } = await import("../src/collab/sync.ts");
    const s0 = initState("bob", "host");
    const [, op] = nextOp(initState("alice", "host"), "msg", { text: "hi" });
    const s1 = applyOp(s0, op);
    expect(s1).not.toBeNull();
    expect(applyOp(s1!, op)).toBeNull(); // duplicate id
  });

  test("turn reducer — host holds initially, grant flips holder", async () => {
    const { initState, applyOp, canSpeak } = await import("../src/collab/sync.ts");
    const s = initState("alice", "host");
    expect(canSpeak(s, "host")).toBe(true);
    expect(canSpeak(s, "alice")).toBe(false);
    const grant = { id: "g1", lamport: 1, actor: "host", kind: "turn" as const, at: 1, payload: { grant: "alice" } };
    const s2 = applyOp(s, grant)!;
    expect(s2.holder).toBe("alice");
    expect(canSpeak(s2, "alice")).toBe(true);
    expect(canSpeak(s2, "host")).toBe(false);
  });

  test("only holder can grant — non-holder grant ignored", async () => {
    const { initState, applyOp, canSpeak } = await import("../src/collab/sync.ts");
    const s = initState("alice", "host");
    const badGrant = { id: "g0", lamport: 1, actor: "alice", kind: "turn" as const, at: 1, payload: { grant: "bob" } };
    const s2 = applyOp(s, badGrant)!;
    expect(s2.holder).toBe("host"); // alice isn't the holder
    expect(canSpeak(s2, "bob")).toBe(false);
  });

  test("release returns token to host", async () => {
    const { initState, applyOp, canSpeak, nextOp } = await import("../src/collab/sync.ts");
    // local side: nextOp(turn release) when we hold the token
    const alice = initState("alice", "host");
    const [, grantOp] = nextOp(alice, "turn", { grant: "alice" }); // host's view ignored (actor=alice not holder)
    // make alice the holder by receiving the host's grant
    const s1 = applyOp(initState("alice", "host"), {
      id: "hg", lamport: 1, actor: "host", kind: "turn", at: 1, payload: { grant: "alice" },
    })!;
    expect(canSpeak(s1, "alice")).toBe(true);
    const [s2] = nextOp(s1, "turn", { release: true });
    expect(s2.holder).toBe("host");
    // remote side: receiving alice's release
    const bob = applyOp(initState("bob", "host"), {
      id: "rel", lamport: 2, actor: "alice", kind: "turn", at: 2, payload: { release: true },
    })!;
    // bob's own view: holder was host already (bob never saw the grant) -> release keeps host
    expect(bob.holder).toBe("host");
    void grantOp;
  });

  test("request is informational — never moves the token", async () => {
    const { initState, applyOp, canSpeak } = await import("../src/collab/sync.ts");
    const s = initState("bob", "host");
    const req = { id: "rq", lamport: 1, actor: "bob", kind: "turn" as const, at: 1, payload: { request: "bob" } };
    const s2 = applyOp(s, req)!;
    expect(canSpeak(s2, "host")).toBe(true);
    expect(canSpeak(s2, "bob")).toBe(false);
  });

  test("orderOps deterministic sort", async () => {
    const { orderOps } = await import("../src/collab/sync.ts");
    const mk = (id: string, lamport: number, actor: string) =>
      ({ id, lamport, actor, kind: "msg" as const, at: 0, payload: null });
    const ordered = orderOps([mk("z", 2, "b"), mk("y", 1, "b"), mk("x", 1, "a")]);
    expect(ordered.map((o) => o.id)).toEqual(["x", "y", "z"]); // lamport asc, actor asc
    // same lamport+actor -> id asc
    const tie = orderOps([mk("b", 1, "a"), mk("a", 1, "a")]);
    expect(tie.map((o) => o.id)).toEqual(["a", "b"]);
  });

  test("state updates are immutable (no mutation of prior state)", async () => {
    const { initState, nextOp, applyOp } = await import("../src/collab/sync.ts");
    const s0 = initState("alice", "host");
    const [s1, op] = nextOp(s0, "msg", { text: "hi" });
    expect(s0.counter).toBe(0);
    expect(s0.ops).toHaveLength(0);
    expect(s1.counter).toBe(1);
    const s2 = applyOp(s0, { id: "other", lamport: 5, actor: "bob", kind: "msg", at: 1, payload: {} });
    expect(s0.ops).toHaveLength(0); // original untouched
    expect(s2!.ops).toHaveLength(1);
  });
});

// ---------- real relay (127.0.0.1 ephemeral) ----------
describe("relay (real, 127.0.0.1 ephemeral)", () => {
  test("two clients: A->B frame forwarded, B never receives own echo", async () => {
    const { startRelay, registerRoomKey } = await import("../src/collab/relay.ts");
    const { CollabClient } = await import("../src/collab/client.ts");
    const relay = startRelay({ port: 0 });
    const url = `ws://127.0.0.1:${relay.port}`;
    const room = "integration-room";
    registerRoomKey(room, "test-key-12345678");
    const code = inviteFor(url, room, "test-key-12345678");

    const clientA = CollabClient({ invite: code, name: "alice" });
    const clientB = CollabClient({ invite: code, name: "bob" });
    await Promise.all([clientA.ready, clientB.ready]);

    const bSeen: any[] = [];
    clientB.onOp((op) => bSeen.push(op));
    clientA.sendOp("msg", { text: "hello bob" });
    expect(await until(() => bSeen.length > 0)).toBe(true);
    expect(bSeen[0].actor).toBe("alice");
    expect(bSeen[0].payload.text).toBe("hello bob");

    const aSeen: any[] = [];
    clientA.onOp((op) => aSeen.push(op));
    clientB.sendOp("msg", { text: "hi alice" });
    expect(await until(() => aSeen.length > 0)).toBe(true);
    expect(aSeen[0].actor).toBe("bob");
    // B never sees its own frame echoed back
    await sleep(150);
    expect(bSeen.length).toBe(1);

    clientA.close();
    clientB.close();
    relay.close();
  }, 20000);

  test("third client in different room gets nothing", async () => {
    const { startRelay, registerRoomKey } = await import("../src/collab/relay.ts");
    const { CollabClient } = await import("../src/collab/client.ts");
    const relay = startRelay({ port: 0 });
    const url = `ws://127.0.0.1:${relay.port}`;
    registerRoomKey("room-a", "key-aa-123456789");
    registerRoomKey("room-b", "key-bb-123456789");

    const clientA = CollabClient({ invite: inviteFor(url, "room-a", "key-aa-123456789"), name: "alice" });
    const clientB = CollabClient({ invite: inviteFor(url, "room-b", "key-bb-123456789"), name: "eve" });
    await Promise.all([clientA.ready, clientB.ready]);

    const bSeen: any[] = [];
    clientB.onOp((op) => bSeen.push(op));
    clientA.sendOp("msg", { text: "secret room-a" });
    await sleep(1000);
    expect(bSeen.length).toBe(0);
    expect(relay.roomMembers("room-b")).toBe(1);
    expect(relay.roomMembers("room-a")).toBe(1);

    clientA.close();
    clientB.close();
    relay.close();
  }, 20000);

  test("wrong key closes with 4001; malformed JSON keeps socket", async () => {
    const { startRelay, registerRoomKey } = await import("../src/collab/relay.ts");
    const relay = startRelay({ port: 0 });
    const url = `ws://127.0.0.1:${relay.port}`;
    registerRoomKey("secure-room", "correct-key");

    // wrong key -> 4001
    let closeCode = 0;
    const ws = new WebSocket(`${url}/r/secure-room`);
    const closed = new Promise<void>((resolve) => { ws.onclose = (ev: any) => { closeCode = ev.code; resolve(); }; });
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
    ws.send(JSON.stringify({ hello: true, key: "wrong-key", name: "eve" }));
    await closed;
    expect(closeCode).toBe(4001);

    // right key then garbage frames -> error reply, socket stays open
    const ws2 = new WebSocket(`${url}/r/secure-room`);
    let errFrames = 0;
    let welcome = false;
    await new Promise<void>((resolve) => {
      ws2.onopen = () => { ws2.send(JSON.stringify({ hello: true, key: "correct-key", name: "ok" })); };
      ws2.onmessage = (ev: any) => {
        const m = JSON.parse(String(ev.data));
        if (m.welcome) welcome = true;
        if (m.error) errFrames++;
        if (m.error && welcome) resolve();
      };
      setTimeout(resolve, 5000);
    });
    expect(welcome).toBe(true);
    ws2.send("this is not json {{{");
    await new Promise<void>((resolve) => {
      const t = setInterval(() => { if (errFrames > 0) { clearInterval(t); resolve(); } }, 50);
      setTimeout(() => { clearInterval(t); resolve(); }, 5000);
    });
    expect(errFrames).toBe(1);
    expect(ws2.readyState).toBe(1); // still OPEN after malformed frame

    ws2.close();
    relay.close();
  }, 20000);

  test("presence ops produce peers() on both sides after join", async () => {
    const { startRelay, registerRoomKey } = await import("../src/collab/relay.ts");
    const { CollabClient } = await import("../src/collab/client.ts");
    const relay = startRelay({ port: 0 });
    const url = `ws://127.0.0.1:${relay.port}`;
    registerRoomKey("presence-room", "test-key-12345678");
    const code = inviteFor(url, "presence-room", "test-key-12345678");

    const clientA = CollabClient({ invite: code, name: "alice" });
    await clientA.ready;
    const clientB = CollabClient({ invite: code, name: "bob" });
    await clientB.ready;

    expect(await until(() => clientA.peers().some((p) => p.name === "bob")
      && clientB.peers().some((p) => p.name === "alice"))).toBe(true);

    // leave: closing B drops it from A's roster
    clientB.close();
    expect(await until(() => !clientA.peers().some((p) => p.name === "bob"))).toBe(true);

    clientA.close();
    relay.close();
  }, 20000);
});

// ---------- client end-to-end handoff ----------
describe("client handoff (real relay)", () => {
  test("grant op flips canSpeak on both sides", async () => {
    const { startRelay, registerRoomKey } = await import("../src/collab/relay.ts");
    const { CollabClient } = await import("../src/collab/client.ts");
    const relay = startRelay({ port: 0 });
    const url = `ws://127.0.0.1:${relay.port}`;
    registerRoomKey("turn-room", "turn-key-12345678");
    const code = inviteFor(url, "turn-room", "turn-key-12345678");

    // alice is the host: she starts with the token, bob starts without it
    const alice = CollabClient({ invite: code, name: "alice", host: "alice" });
    await alice.ready;
    const bob = CollabClient({ invite: code, name: "bob", host: "alice" });
    await bob.ready;

    expect(alice.canSpeak("alice")).toBe(true);
    expect(bob.canSpeak("bob")).toBe(false);

    alice.grant("bob");
    expect(await until(() => bob.canSpeak("bob") && !alice.canSpeak("alice"))).toBe(true);

    bob.release();
    expect(await until(() => bob.canSpeak("alice") && !bob.canSpeak("bob"))).toBe(true);

    alice.close();
    bob.close();
    relay.close();
  }, 20000);
});
