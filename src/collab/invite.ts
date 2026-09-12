/**
 * Collab invite codes: base64url(JSON {v, u, r, k}).
 * v=version, u=host url, r=room, k=8-byte hex key.
 */
import { randomUUID } from "node:crypto";

export const INVITE_VERSION = 1;
export const KEY_BYTES = 8;

export interface InvitePayload {
  v: number;
  u: string;
  r: string;
  k: string;
}

export function encodeInvite(opts: { host: string; room: string; key?: string }): string {
  const key = opts.key ?? randomUUID().replace(/-/g, "").slice(0, KEY_BYTES * 2);
  const payload: InvitePayload = { v: INVITE_VERSION, u: opts.host, r: opts.room, k: key };
  const json = JSON.stringify(payload);
  return Buffer.from(json).toString("base64url");
}

export function decodeInvite(code: string): InvitePayload {
  if (!/^[A-Za-z0-9_-]*$/.test(code)) throw new Error("invite: not valid base64url");
  const raw = Buffer.from(code, "base64url").toString("utf8");
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("invite: malformed JSON");
  }
  if (!obj || typeof obj !== "object") throw new Error("invite: not an object");
  if (obj.v !== INVITE_VERSION) throw new Error(`invite: unknown version ${obj.v}`);
  if (typeof obj.u !== "string" || !obj.u) throw new Error("invite: missing host");
  if (typeof obj.r !== "string" || !obj.r) throw new Error("invite: missing room");
  if (typeof obj.k !== "string" || obj.k.length < KEY_BYTES * 2) throw new Error("invite: missing or short key");
  return { v: obj.v, u: obj.u, r: obj.r, k: obj.k };
}
