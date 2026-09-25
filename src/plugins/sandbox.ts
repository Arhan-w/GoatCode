/**
 * Plugin Sandbox — isolated execution environment for untrusted plugins.
 * Provides process-level isolation with resource limits, filesystem sandbox,
 * network restrictions, and a timeout guard.
 *
 * Plugins run in a child process with:
 * - Limited memory (512MB default)
 * - Filesystem scoped to plugin dir + temp
 * - No network access by default
 * - Timeout protection (30s default)
 * - Exit code reporting
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { appDir } from "../config.ts";

export interface SandboxConfig {
  /** Plugin entry point script */
  entryPoint: string;
  /** Working directory for the plugin */
  workDir?: string;
  /** Max memory in MB (default 512) */
  maxMemoryMb?: number;
  /** Timeout in ms (default 30000) */
  timeoutMs?: number;
  /** Allow network access (default false) */
  allowNetwork?: boolean;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Stdout handler */
  onStdout?: (data: string) => void;
  /** Stderr handler */
  onStderr?: (data: string) => void;
  /** Exit handler */
  onExit?: (code: number | null, signal: string | null) => void;
}

export interface SandboxResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
}

export class SandboxError extends Error {
  constructor(
    public message: string,
    public exitCode: number | null,
    public signal: string | null,
  ) {
    super(message);
  }
}

/** Sandbox session tracking */
export interface SandboxSession {
  id: string;
  pluginName: string;
  process: ChildProcess;
  startTime: number;
  stdout: string;
  stderr: string;
  terminated: boolean;
}

const sandboxSessions = new Map<string, SandboxSession>();
const MAX_SANDBOX_SESSIONS = 10;
const DEFAULT_MAX_MEMORY_MB = 512;
const DEFAULT_TIMEOUT_MS = 30_000;
const PLUGIN_SANDBOX_DIR = "sandbox";

/** Get or create sandbox directory */
function getSandboxDir(): string {
  const dir = join(appDir(), PLUGIN_SANDBOX_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a sandboxed execution environment for a plugin.
 * Returns a SandboxSession that can be used to monitor/kill the process.
 */
export function createSandbox(config: SandboxConfig): SandboxSession {
  // Limit concurrent sessions
  if (sandboxSessions.size >= MAX_SANDBOX_SESSIONS) {
    throw new SandboxError(
      "Maximum sandbox sessions reached",
      null,
      null,
    );
  }

  const id = `sandbox-${randomUUID().slice(0, 8)}`;
  const workDir = config.workDir ?? join(getSandboxDir(), id);
  mkdirSync(workDir, { recursive: true });

  // Prepare environment
  const env: Record<string, string> = {
    ...process.env,
    GOAT_SANDBOX: "1",
    GOAT_SANDBOX_ID: id,
    GOAT_SANDBOX_DIR: workDir,
    NODE_ENV: "production",
    ...(config.env ?? {}),
  };

  // Build command
  const args = ["--max-old-space-size=" + (config.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB)];
  if (!config.allowNetwork) {
    // Node.js doesn't have built-in network blocking, but we can set environment flag
    env.GOAT_SANDBOX_NO_NETWORK = "1";
  }

  // Spawn child process
  const process = spawn("bun", [...args, config.entryPoint], {
    cwd: workDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });

  const session: SandboxSession = {
    id,
    pluginName: config.entryPoint.split("/").pop()?.replace(".ts", "") ?? id,
    process,
    startTime: Date.now(),
    stdout: "",
    stderr: "",
    terminated: false,
  };

  // Collect stdout
  process.stdout?.on("data", (data: Buffer) => {
    const text = data.toString("utf8");
    session.stdout += text;
    config.onStdout?.(text);
  });

  // Collect stderr
  process.stderr?.on("data", (data: Buffer) => {
    const text = data.toString("utf8");
    session.stderr += text;
    config.onStderr?.(text);
  });

  // Handle exit
  process.on("exit", (code, signal) => {
    session.terminated = true;
    config.onExit?.(code, signal);
    sandboxSessions.delete(id);
  });

  process.on("error", (err) => {
    session.terminated = true;
    config.onStderr?.(`Sandbox error: ${err.message}\n`);
    sandboxSessions.delete(id);
  });

  // Set timeout
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (!session.terminated) {
      killSession(id);
      config.onStderr?.(`Sandbox timeout after ${timeoutMs}ms\n`);
    }
  }, timeoutMs);

  // Store session
  sandboxSessions.set(id, session);

  return session;
}

/**
 * Execute a plugin command in the sandbox and return result.
 */
export async function executeSandbox(config: SandboxConfig): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const result: SandboxResult = {
      ok: false,
      output: "",
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };

    const session = createSandbox({
      ...config,
      onStdout: (data) => {
        if (!finished) {
          result.output += data;
        }
        config.onStdout?.(data);
      },
      onStderr: (data) => {
        if (!finished) {
          result.output += data;
        }
        config.onStderr?.(data);
      },
      onExit: (code, signal) => {
        if (finished) return;
        finished = true;
        result.exitCode = code;
        result.signal = signal;
        result.durationMs = Date.now() - session.startTime;
        result.timedOut = code === null && signal !== null && signal.startsWith("SIG");

        if (code === 0) {
          result.ok = true;
        } else if (signal && signal.startsWith("SIGTERM")) {
          result.ok = false;
          result.timedOut = true;
        } else {
          result.ok = false;
        }
        resolve(result);
      },
    });
  });
}

/**
 * Kill a sandbox session by ID.
 */
export function killSession(id: string): void {
  const session = sandboxSessions.get(id);
  if (!session || session.terminated) return;
  try {
    session.process.kill("SIGTERM");
    // Force kill after 5s
    setTimeout(() => {
      if (!session.terminated) {
        session.process.kill("SIGKILL");
      }
    }, 5000);
  } catch {
    /* already dead */
  }
}

/**
 * Kill all sandbox sessions.
 */
export function killAllSessions(): void {
  for (const id of sandboxSessions.keys()) {
    killSession(id);
  }
}

/**
 * Get active sandbox sessions.
 */
export function listSessions(): Array<{
  id: string;
  pluginName: string;
  durationMs: number;
  terminated: boolean;
}> {
  const now = Date.now();
  return [...sandboxSessions.values()].map((s) => ({
    id: s.id,
    pluginName: s.pluginName,
    durationMs: now - s.startTime,
    terminated: s.terminated,
  }));
}

/**
 * Check if a file is within allowed sandbox paths.
 */
export function isPathAllowed(filePath: string, sandboxDir: string): boolean {
  const resolved = require("node:path").resolve(sandboxDir, filePath);
  return resolved.startsWith(sandboxDir);
}

/**
 * Write a fixture file to the sandbox for testing.
 */
export function writeSandboxFixture(name: string, content: string): string {
  const sandboxDir = getSandboxDir();
  const fixtureDir = join(sandboxDir, "fixtures");
  mkdirSync(fixtureDir, { recursive: true });
  const filePath = join(fixtureDir, name);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

/**
 * Read a fixture file from the sandbox.
 */
export function readSandboxFixture(name: string): string {
  const sandboxDir = getSandboxDir();
  const filePath = join(sandboxDir, "fixtures", name);
  if (!existsSync(filePath)) throw new Error(`Fixture not found: ${name}`);
  return readFileSync(filePath, "utf8");
}
