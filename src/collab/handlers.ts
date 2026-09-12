/**
 * Collab handlers: handleShare and handleJoin.
 * Both console-based so they work anywhere.
 */
import { GoatConfig } from "../config.ts";
import { encodeInvite } from "./invite.ts";
import { startRelay, registerRoomKey } from "./relay.ts";
import { CollabClient } from "./client.ts";
import { CollabOp } from "./sync.ts";

export async function handleShare(argv: string[], cfg: GoatConfig): Promise<number> {
  const portArg = argv.find((a) => a.startsWith("--port"));
  const port = portArg ? parseInt(portArg.split("=")[1] ?? argv[argv.indexOf(portArg) + 1], 10) : 8790;

  const relay = startRelay({ port });
  const room = `room-${Date.now()}`;
  const host = `ws://localhost:${relay.port}`;

  const inviteCode = encodeInvite({ host, room });
  const payload = JSON.parse(Buffer.from(inviteCode, "base64url").toString("utf8"));
  registerRoomKey(room, payload.k);

  const client = CollabClient({ invite: inviteCode, name: "host" });

  console.log(`\n  Collab room active`);
  console.log(`  Host: ${host}`);
  console.log(`  Room: ${room}`);
  console.log(`  Invite code:`);
  console.log(`\n  ${inviteCode}\n`);

  client.onPeers((peers) => {
    console.log(`  peers: ${peers.length}`);
  });

  client.onOp((op: CollabOp) => {
    if (op.kind === "msg") {
      const text = String((op.payload as { text?: string }).text ?? "");
      console.log(`\n  ◈ ${op.actor}: ${text}`);
    } else if (op.kind === "write") {
      const p = op.payload as { repo?: string; path?: string };
      console.log(`  peer ${op.actor} wrote ${p.repo ? p.repo + "/" : ""}${p.path ?? ""}`);
    }
  });

  // stdin for messaging
  const stdin = process.stdin;
  stdin.resume();
  stdin.setEncoding("utf8");

  const sendLine = (line: string) => {
    const text = line.trim();
    if (!text) return;
    client.sendOp("msg", { text });
  };

  console.log("  Type messages and hit Enter to broadcast. Ctrl+C to exit.");

  const onInput = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) sendLine(line);
    }
  };
  stdin.on("data", onInput);

  const cleanup = () => {
    stdin.off("data", onInput);
    client.close();
    relay.close();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => { cleanup(); resolve(); });
    process.once("SIGTERM", () => { cleanup(); resolve(); });
  });

  return 0;
}

export async function handleJoin(code: string, argv: string[], cfg: GoatConfig): Promise<number> {
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  } catch {
    console.log("  ✗ invalid invite code");
    return 1;
  }

  const host = payload.u;
  const room = payload.r;
  const key = payload.k;
  const inviteCode = code;
  const name = argv.find((a) => !a.startsWith("--")) ?? "peer";

  const client = CollabClient({ invite: inviteCode, name });

  client.onOp((op: CollabOp) => {
    if (op.kind === "msg") {
      const text = String((op.payload as { text?: string }).text ?? "");
      console.log(`\n  ◈ ${op.actor}: ${text}`);
    } else if (op.kind === "write") {
      const p = op.payload as { repo?: string; path?: string };
      console.log(`  peer ${op.actor} wrote ${p.repo ? p.repo + "/" : ""}${p.path ?? ""}`);
    } else if (op.kind === "turn") {
      const p = op.payload as { grant?: string; release?: boolean };
      if (p.grant && p.grant === name) console.log("  ✡ turn granted to you");
      else if (p.release) console.log("  Turn released.");
    } else if (op.kind === "presence") {
      const p = op.payload as { join?: string; leave?: string };
      if (p.join) console.log(`  ${p.join} joined`);
      if (p.leave) console.log(`  ${p.leave} left`);
    }
  });

  client.onPeers((peers) => {
    console.log(`  peers: ${peers.length}`);
  });

  client.ready.then(() => {
    console.log(`\n  Joined ${room} as ${name}`);
    console.log("  Type messages and hit Enter. /quit to exit.\n");
  });

  const stdin = process.stdin;
  stdin.resume();
  stdin.setEncoding("utf8");

  const onInput = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      if (text === "/quit") { client.close(); process.exit(0); }
      client.sendOp("msg", { text });
    }
  };
  stdin.on("data", onInput);

  await new Promise<void>(() => { /* lives until process.exit */ });
  return 0;
}
