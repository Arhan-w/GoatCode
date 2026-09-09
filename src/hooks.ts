/**
 * Hooks — Claude Code wire-compatible.
 *
 * Config (config.json / goatcode.json):
 *   "hooks": {
 *     "PreToolUse":  [{ "matcher": "Bash", "hooks": [{"type":"command","command":"..."}] }],
 *     "PostToolUse": [...],
 *     "Stop":        [{ "hooks": [...] }]
 *   }
 *
 * Protocol, matching Claude Code:
 * - Hook runs via the platform shell, stdin gets a JSON payload:
 *     { session_id, transcript_path, cwd, hook_event_name, tool_name?, tool_input?, tool_response? }
 * - exit 0: stdout JSON is parsed; for PreToolUse
 *     { hookSpecificOutput: { permissionDecision: "allow" | "deny", permissionDecisionReason } }
 *   overrides the permission prompt. Any other stdout is informational.
 * - exit 2: BLOCK. stderr is shown to the model as the denial reason
 *   (Pre/Post) or fed back as the next user turn (Stop).
 * - other non-zero: shown as a warning, execution continues.
 * - matchers compare case-insensitively against the tool name, or as a
 *   comma-separated list ("Bash,Edit"); empty/`*` matches everything.
 */
import { spawn } from "node:child_process";
import { DEFAULT_HOOK_TIMEOUT_MS } from "./constants.ts";

export interface HookCommand { type?: "command"; command: string; timeout?: number }
export interface HookMatcher { matcher?: string; hooks: HookCommand[] }
export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop";
export interface HooksConfig { PreToolUse?: HookMatcher[]; PostToolUse?: HookMatcher[]; Stop?: HookMatcher[] }

export interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  /** Claude sends this camelCased; snake is echoed for hand-written hooks. */
  hook_event_name: HookEvent;
  hookEventName: HookEvent;
  tool_name?: string;
  /** Schema-projected input: read/write/edit expose file_path, bash command. */
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

/** Stop-hook block feedback is re-injected as a user turn, capped. */
export const MAX_STOP_HOOK_CONTINUES = 4;

export interface HookResult {
  /** PreToolUse stdout permissionDecision; undefined = no opinion. */
  decision?: "allow" | "deny" | "ask";
  reason?: string;
  /** exit 2 — block the action; reason carries stderr. */
  blocked: boolean;
  /** hook replaced tool_input wholesale. */
  updatedInput?: Record<string, unknown>;
  /** systemMessage the hook wants shown to the user. */
  systemMessage?: string;
  /** non-fatal failures, for UI display. */
  notes: string[];
}

/** Claude semantics: empty or "*" matches all; otherwise REGEX.test(toolName),
 * falling back to a comma-separated exact list if the regex fails to compile. */
export function matcherMatches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === "*") return true;
  try {
    return new RegExp(matcher, "i").test(toolName ?? "");
  } catch {
    return matcher.split(",").map((s) => s.trim().toLowerCase()).includes((toolName ?? "").toLowerCase());
  }
}

function runOne(cmd: string, payload: HookPayload, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const shell = process.platform === "win32" ? (process.env.COMSPEC || "cmd.exe") : "/bin/bash";
    const child = spawn(shell, process.platform === "win32" ? ["/c", cmd] : ["-c", cmd], {
      cwd: payload.cwd, env: process.env,
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); done({ code: -1, stdout, stderr: stderr + "\n[hook timed out]" }); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => { clearTimeout(timer); done({ code: code ?? 0, stdout, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); done({ code: -1, stdout: "", stderr: String(e?.message ?? e) }); });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/**
 * Fire all matchers registered for `event`. Results merge: any blocking hook
 * wins; PreToolUse permission decisions: first allow/deny wins.
 */
export async function fireHooks(
  hooks: HooksConfig | undefined, event: HookEvent, payload: HookPayload, sessionId: string,
): Promise<HookResult> {
  const out: HookResult = { blocked: false, notes: [] };
  const matchers = (hooks?.[event] ?? []).filter((m) => matcherMatches(m.matcher, payload.tool_name));
  for (const m of matchers) {
    for (const h of m.hooks) {
      if (h.type && h.type !== "command") continue; // only command hooks supported
      const r = await runOne(h.command, { ...payload }, h.timeout ?? DEFAULT_HOOK_TIMEOUT_MS);
      if (r.code === 2) {
        out.blocked = true;
        out.reason = (out.reason ? out.reason + "\n" : "") + (r.stderr.trim() || `${event} hook blocked (exit 2)`);
        continue;
      }
      if (r.code !== 0) { out.notes.push(`hook failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`); continue; }
      if (r.stdout.trim().startsWith("{")) {
        try {
          const j = JSON.parse(r.stdout);
          if (typeof j?.systemMessage === "string") out.systemMessage = j.systemMessage;
          if (j?.continue === false) { out.blocked = true; out.reason = String(j.stopReason ?? "hook requested stop"); }
          if (event === "PreToolUse") {
            const hso = j?.hookSpecificOutput;
            const d = hso?.permissionDecision ?? j?.decision;
            if (d === "allow" || d === "approve") out.decision = "allow";
            else if (d === "ask") out.decision = "ask";
            else if (d === "deny" || d === "block") { out.decision = "deny"; out.reason = hso?.permissionDecisionReason ?? j?.reason; }
            if (hso?.updatedInput && typeof hso.updatedInput === "object") out.updatedInput = hso.updatedInput;
          } else if (j?.decision === "block") {
            // PostToolUse / Stop: stdout JSON can block too, with a reason
            out.blocked = true;
            out.reason = (out.reason ? out.reason + "\n" : "") + String(j.reason ?? `${event} hook requested block`);
          }
        } catch { out.notes.push(`${event} hook stdout was not valid JSON — ignored`); }
      }
    }
  }
  return out;
}
