/**
 * RemoteGoat — JSON-RPC client for `goat serve` peers, plus the ToolSpec/handler
 * pair that exposes a remote agent as a local tool. Tokens are NEVER persisted:
 * callers read GOAT_REMOTE_TOKEN_<UPPERNAME> at use time (see cli.ts).
 */
import { LLMError, type ToolSpec } from "../llm.ts";

export interface RemoteGoatOpts {
  url: string;
  name?: string;
  token: string;
}

const RUN_TIMEOUT_MS = 120_000;
const RPC_TIMEOUT_MS = 10_000;
/** Remote tool output cap fed back to the local model. */
const MAX_REMOTE_OUTPUT = 30_000;

export class RemoteGoat {
  readonly url: string;
  readonly name: string;
  readonly token: string;

  constructor(opts: RemoteGoatOpts) {
    this.url = (opts.url ?? "").replace(/\/+$/, "");
    this.name = opts.name ?? "agent";
    this.token = opts.token;
  }

  /** One JSON-RPC 2.0 request; throws LLMError on transport or protocol error. */
  async rpc(method: string, params: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.url + "/rpc", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${this.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new LLMError(`remote '${this.name}' unreachable: ${(e as Error).message}`);
    }
    let obj: any;
    try { obj = JSON.parse(await res.text()); } catch { throw new LLMError(`remote '${this.name}' sent a non-JSON response (HTTP ${res.status})`); }
    if (res.status === 401) throw new LLMError(`remote '${this.name}' rejected the token (401)`);
    if (obj?.error) throw new LLMError(`remote '${this.name}' error ${obj.error.code}: ${obj.error.message}`);
    return obj?.result;
  }

  capabilities(): Promise<{ name: string; version: string; methods: string[]; tools: string[] }> {
    return this.rpc("agent.capabilities", {}) as any;
  }

  run(prompt: string, cwd?: string): Promise<{ text: string; result?: string; session_id: string; model: string; usage: unknown }> {
    const params: Record<string, unknown> = { prompt };
    if (cwd) params.cwd = cwd;
    return this.rpc("agent.run", params, RUN_TIMEOUT_MS) as any;
  }

  listSessions(limit?: number): Promise<{ rows: { id: string; model: string; title: string }[] }> {
    const params: Record<string, unknown> = {};
    if (typeof limit === "number") params.limit = limit;
    return this.rpc("sessions.list", params) as any;
  }
}

/** ToolSpec advertising a remote agent as a local tool (name: remote_<name>). */
export function remoteToolSpec(remote: Pick<RemoteGoat, "name">): ToolSpec {
  return {
    name: `remote_${remote.name}`,
    description: "Call remote GoatCode agent over JSON-RPC. It runs the prompt with its own tools and returns the answer.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt for the remote agent" },
        cwd: { type: "string", description: "Optional working directory on the remote machine (must be inside its allowed roots)" },
      },
      required: ["prompt"],
    },
  };
}

/** Dispatch handler for the spec above — output truncated to 30k chars. */
export function makeRemoteToolHandler(remote: RemoteGoat): (args: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> {
  return async (args) => {
    try {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      if (!prompt) return { ok: false, output: "remote: prompt must be a non-empty string" };
      const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
      const r = await remote.run(prompt, cwd);
      const text = typeof r.text === "string" ? r.text : typeof (r as any).result === "string" ? (r as any).result : JSON.stringify(r);
      return { ok: true, output: text.length > MAX_REMOTE_OUTPUT ? text.slice(0, MAX_REMOTE_OUTPUT) + "\n…[truncated]" : text };
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
  };
}

/** Env var holding the token for a registered remote agent (GOAT_REMOTE_TOKEN_<UPPERNAME>). */
export function remoteTokenEnv(name: string): string {
  return `GOAT_REMOTE_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
