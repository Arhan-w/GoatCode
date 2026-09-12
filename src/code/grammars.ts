/** Extension → tree-sitter grammar name map. */
export const EXT_GRAMMAR: Record<string, string> = {
  ts: "tsx",
  tsx: "tsx",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "c_sharp",
  rb: "ruby",
  php: "php",
};

const WASM_SUBDIR = "tree-sitter-wasms/out";
const RUNTIME_WASM = "web-tree-sitter/tree-sitter.wasm";

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { appDir } from "../config.ts";

/**
 * Resolve the path to a tree-sitter grammar .wasm file.
 * Candidate order:
 *   1) <cwd>/node_modules/tree-sitter-wasms/out/tree-sitter-<g>.wasm
 *   2) <exeDir ?? dirname(process.execPath)>/vendor/tree-sitter-<g>.wasm  (exeDir overrides dirname(execPath))
 *   3) ~/.goatcode/vendor/tree-sitter-<g>.wasm
 * Returns null when no candidate exists.
 */
export function resolveWasmFile(
  grammName: string,
  exeDir?: string,
): string | null {
  const cand = (p: string): string | null => {
    try { return existsSync(p) ? p : null; } catch { return null; }
  };
  const candidates = [
    join(process.cwd(), "node_modules", WASM_SUBDIR, `tree-sitter-${grammName}.wasm`),
    join(exeDir ?? dirname(process.execPath), "vendor", `tree-sitter-${grammName}.wasm`),
    join(appDir(), "vendor", `tree-sitter-${grammName}.wasm`),
  ];
  for (const c of candidates) {
    const r = cand(c);
    if (r) return r;
  }
  return null;
}

/** Resolve the runtime web-tree-sitter .wasm (node_modules first). */
export function resolveRuntimeWasm(exeDir?: string): string | null {
  const cand = (p: string): string | null => {
    try { return existsSync(p) ? p : null; } catch { return null; }
  };
  const candidates = [
    join(process.cwd(), "node_modules", RUNTIME_WASM),
    join(exeDir ?? dirname(process.execPath), "vendor", RUNTIME_WASM),
    join(appDir(), "vendor", RUNTIME_WASM),
  ];
  for (const c of candidates) {
    const r = cand(c);
    if (r) return r;
  }
  return null;
}
