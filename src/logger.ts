/**
 * Rolling session log — ~/.goatcode/logs/goat.log (or $GOAT_LOG_PATH).
 * Off when GOAT_LOG=0. Records startup, resolve failures, hook blocks,
 * and agent errors so a crashed session leaves a trail.
 */
import { appendFileSync, mkdirSync, statSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "./config.ts";

const MAX_LOG_BYTES = 2_000_000;
let enabled = process.env.GOAT_LOG !== "0";
let path = join(appDir(), "logs", "goat.log");

export function configureLogger(opts: { enabled?: boolean; path?: string }) {
  if (opts.enabled !== undefined) enabled = opts.enabled;
  if (opts.path) path = opts.path;
}

export function logPath(): string { return path; }

export function log(tag: string, msg: string): void {
  if (!enabled) return;
  try {
    const d = path.slice(0, path.lastIndexOf("/"));
    mkdirSync(d, { recursive: true });
    const line = `${new Date().toISOString()} [${tag}] ${msg}\n`;
    let size = 0;
    try { size = statSync(path).size; } catch { /* */ }
    if (size > MAX_LOG_BYTES) {
      // rotate: keep the tail half
      try {
        const prev = path + ".1";
        unlinkSync(prev);
        renameSync(path, prev);
      } catch { /* */ }
    }
    appendFileSync(path, line, "utf8");
  } catch { /* logging must never break the agent */ }
}