/**
 * Custom status line — Claude Code compatible.
 * Config: "status_line": { "command": "your-script" } (or "statusLine").
 * The command receives JSON on stdin (session/model/workspace/cost/context)
 * and its trimmed stdout lines replace the built-in footer. 5s timeout;
 * on failure the built-in footer is kept.
 */
import { spawn } from "node:child_process";
import type { Session } from "./session.ts";

export interface StatusLineInput {
  session_id: string;
  session_name?: string;
  cwd: string;
  model: { id: string; display_name: string };
  workspace: { current_dir: string; project_dir: string };
  version: string;
  output_style: { name: string };
  cost: { total_tokens_in: number; total_tokens_out: number; total_lines_added?: number };
  context_window: { total_input_tokens: number; current_usage: number; used_percentage: number | null };
  thinking: boolean;
}

export function statusInput(
  session: Session, modelId: string, style: string | undefined, usedChars: number, thinking: boolean,
): StatusLineInput {
  const ctxTokens = Math.round(usedChars / 4);
  return {
    session_id: session.id,
    session_name: session.title || undefined,
    cwd: session.cwd,
    model: { id: modelId, display_name: modelId },
    workspace: { current_dir: session.cwd, project_dir: session.cwd },
    version: "2.1.1",
    output_style: { name: style ?? "default" },
    cost: { total_tokens_in: session.usage.in, total_tokens_out: session.usage.out },
    context_window: {
      total_input_tokens: session.usage.in, current_usage: ctxTokens,
      used_percentage: null,
    },
    thinking,
  };
}

/** Run the command; resolve with stdout lines, or null on any failure. */
export function runStatusLine(command: string, input: StatusLineInput): Promise<string[] | null> {
  return new Promise((done) => {
    const shell = process.platform === "win32" ? (process.env.COMSPEC || "cmd.exe") : "/bin/bash";
    let child;
    try {
      child = spawn(shell, process.platform === "win32" ? ["/c", command] : ["-c", command], {
        cwd: input.cwd, env: process.env,
      });
    } catch { return done(null); }
    let stdout = "", failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); done(null); }, 5000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", () => { /* statusline stderr ignored */ });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) return done(null);
      const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3);
      done(lines.length ? lines : null);
    });
    child.on("error", () => { clearTimeout(timer); done(null); });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
