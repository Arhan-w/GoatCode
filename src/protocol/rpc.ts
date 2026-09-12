/** JSON-RPC 2.0 pure parser/encoder — single-request only, no batches. */

export interface JsonRpcRequest { ok: true; id: string | number; method: string; params: Record<string, unknown> | undefined }
export interface JsonRpcError { ok: false; error: { code: number; message: string; data?: unknown } }
export type JsonRpcParseResult = JsonRpcRequest | JsonRpcError

const PARSE_ERROR = { ok: false as const, error: { code: -32700, message: "Parse error" } }
const INVALID_REQUEST = { ok: false as const, error: { code: -32600, message: "Invalid Request" } }
const METHOD_NOT_FOUND = { ok: false as const, error: { code: -32601, message: "Method not found" } }
const INVALID_PARAMS = { ok: false as const, error: { code: -32602, message: "Invalid params" } }

export function parseRequest(text: string): JsonRpcParseResult {
  let obj: unknown
  try { obj = JSON.parse(text) } catch { return PARSE_ERROR }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return INVALID_REQUEST
  const rpc = obj as Record<string, unknown>
  if (rpc.jsonrpc !== "2.0") return INVALID_REQUEST
  const method = rpc.method
  if (typeof method !== "string" || method === "") return INVALID_REQUEST
  const id = rpc.id
  if (id === undefined || id === null || typeof id === "boolean") return INVALID_REQUEST
  const params = rpc.params as unknown
  return { ok: true, id: typeof id === "number" || typeof id === "string" ? id : String(id), method, params: params && typeof params === "object" ? params as Record<string, unknown> : undefined }
}

export function encodeResult(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", result, id })
}

export function encodeError(id: string | number, code: number, message: string, data?: unknown): string {
  const e: Record<string, unknown> = { jsonrpc: "2.0", error: { code, message } }
  if (data !== undefined) (e.error as Record<string, unknown>).data = data
  e.id = id
  return JSON.stringify(e)
}

/** Constant-time-ish string compare — length mismatch returns false immediately without leaking equality. */
export function tokenOk(got: string, want: string): boolean {
  if (got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
}
