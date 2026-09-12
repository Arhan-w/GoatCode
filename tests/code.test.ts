/**
 * GoatCode v3 code intelligence tests.
 * Covers wasm resolution order, tree-sitter real extraction, regex
 * fallback, incremental indexing (fast-path, changed, deleted, clear),
 * workspaceHash, find ranking, tool handler, runCodeSlash, autoIndexOnce.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const savedEnv: Record<string, string | undefined> = {};
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "code-test-"));
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

// ---------- wasm resolution ----------
describe("grammars resolveWasmFile order", () => {
  test("real wasm found in node_modules", async () => {
    const { resolveWasmFile } = await import("../src/code/grammars.ts");
    const p = resolveWasmFile("tsx");
    expect(p).toBeTruthy();
    expect(p).toContain("tree-sitter-tsx.wasm");
  });

  test("fake exeDir/vendor dir wins when node_modules has no match", async () => {
    const fake = mkdtempSync(join(tmpdir(), "fake-vendor-"));
    mkdirSync(join(fake, "vendor"), { recursive: true });
    // "fortran" has no tree-sitter-wasms entry, so the node_modules
    // candidate cannot shadow the vendor fallback.
    writeFileSync(join(fake, "vendor", "tree-sitter-fortran.wasm"), "FAKE");
    const { resolveWasmFile } = await import("../src/code/grammars.ts");
    const p = resolveWasmFile("fortran", fake);
    expect(p).toBeTruthy();
    expect(p).toContain("vendor");
    rmSync(fake, { recursive: true, force: true });
  });

  test("node_modules candidate is cwd-based, not exeDir-based", async () => {
    const fake = mkdtempSync(join(tmpdir(), "fake-exe-"));
    // fake/node_modules holds a grammar file; a cwd-resolvable one must
    // still win, proving exeDir is not used for candidate 1.
    mkdirSync(join(fake, "node_modules", "tree-sitter-wasms", "out"), { recursive: true });
    writeFileSync(join(fake, "node_modules", "tree-sitter-wasms", "out", "tree-sitter-tsx.wasm"), "FAKE");
    const { resolveWasmFile } = await import("../src/code/grammars.ts");
    const p = resolveWasmFile("tsx", fake);
    expect(p).toBeTruthy();
    expect(p).not.toContain(fake);
    expect(p).toContain(join("tree-sitter-wasms", "out"));
    rmSync(fake, { recursive: true, force: true });
  });

  test("null when nothing found", async () => {
    const fake = mkdtempSync(join(tmpdir(), "empty-vendor-"));
    const { resolveWasmFile } = await import("../src/code/grammars.ts");
    const p = resolveWasmFile("nonexistent", fake);
    expect(p).toBeNull();
    rmSync(fake, { recursive: true, force: true });
  });

  test("runtime wasm resolves in node_modules", async () => {
    const { resolveRuntimeWasm } = await import("../src/code/grammars.ts");
    const p = resolveRuntimeWasm();
    expect(p).toBeTruthy();
    expect(p).toContain("tree-sitter.wasm");
  });
});

// ---------- tree-sitter real extraction ----------
describe("extract real tree-sitter", () => {
  const src = `import { foo } from "./bar";\nexport function greet(name: string): string { return foo(name); }\nclass A { method() { return foo(); } }\n`;

  test("tsx extracts symbols, imports, edges", async () => {
    const { extractFile } = await import("../src/code/extract.ts");
    const tmp = mkdtempSync(join(tmpdir(), "tsx-"));
    const f = join(tmp, "test.tsx");
    writeFileSync(f, src);
    const result = await extractFile(f, src);
    expect(result.heuristic).toBe(false);
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain("greet");
    expect(names).toContain("A");
    expect(result.imports.length).toBeGreaterThanOrEqual(1);
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("ts extracts symbols from .ts file", async () => {
    const { extractFile } = await import("../src/code/extract.ts");
    const tmp = mkdtempSync(join(tmpdir(), "ts-"));
    const f = join(tmp, "test.ts");
    writeFileSync(f, src);
    const result = await extractFile(f, src);
    expect(result.heuristic).toBe(false);
    expect(result.symbols.map((s) => s.name)).toContain("greet");
    rmSync(tmp, { recursive: true, force: true });
  });

  test("py real tree-sitter: symbols + imports + kinds + lines", async () => {
    const { extractFile } = await import("../src/code/extract.ts");
    const py = `import os\nfrom sys import argv\n\ndef helper(x):\n    return x\n\nclass Widget:\n    def render(self):\n        return helper(1)\n`;
    const tmp = mkdtempSync(join(tmpdir(), "py-"));
    const f = join(tmp, "m.py");
    writeFileSync(f, py);
    const r = await extractFile(f, py);
    expect(r.heuristic).toBe(false);
    const names = r.symbols.map((s) => s.name);
    expect(names).toContain("helper");
    expect(names).toContain("Widget");
    expect(names).toContain("render");
    expect(r.imports).toContain("os");
    expect(r.imports).toContain("sys");
    const helper = r.symbols.find((s) => s.name === "helper")!;
    expect(helper.line).toBe(4);
    expect(r.edges.some((e) => e.callee === "helper")).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("go real tree-sitter: symbols + imports + edges", async () => {
    const { extractFile } = await import("../src/code/extract.ts");
    const go = `package main\n\nimport "fmt"\n\nfunc Greeter(name string) string {\n\treturn fmt.Sprintf("hi", name)\n}\n\ntype Config struct{}\n`;
    const tmp = mkdtempSync(join(tmpdir(), "go-"));
    const f = join(tmp, "m.go");
    writeFileSync(f, go);
    const r = await extractFile(f, go);
    expect(r.heuristic).toBe(false);
    const names = r.symbols.map((s) => s.name);
    expect(names).toContain("Greeter");
    expect(names).toContain("Config");
    expect(r.imports.some((i) => i.includes("fmt"))).toBe(true);
    expect(r.edges.length).toBeGreaterThanOrEqual(1);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("unknown extension yields empty heuristic result, never throws", async () => {
    const { extractFile } = await import("../src/code/extract.ts");
    const r = await extractFile(join("x.zz"), `function whatever() {}\n`);
    expect(r.heuristic).toBe(true);
    expect(r.symbols.length).toBe(0);
  });
});

// ---------- regex fallback ----------
describe("extract regex fallback", () => {
  test("py regex fallback forces heuristic", async () => {
    const { extractFileRegexFallback } = await import("../src/code/extract.ts");
    const py = `def foo(x):\n    return x\n\nclass Bar:\n    pass\nimport os\nfrom sys import argv\n`;
    const result = await extractFileRegexFallback(py, ".py");
    expect(result.heuristic).toBe(true);
    expect(result.symbols.map((s) => s.name)).toContain("foo");
    expect(result.symbols.map((s) => s.name)).toContain("Bar");
    expect(result.imports).toContain("os");
  });

  test("go regex fallback forces heuristic", async () => {
    const { extractFileRegexFallback } = await import("../src/code/extract.ts");
    const go = `package main\n\nfunc Foo(x int) int { return x }\ntype Bar struct {}\nimport "fmt"\n`;
    const result = await extractFileRegexFallback(go, ".go");
    expect(result.heuristic).toBe(true);
    expect(result.symbols.map((s) => s.name)).toContain("Foo");
    expect(result.symbols.map((s) => s.name)).toContain("Bar");
  });

  test("ts regex fallback forces heuristic", async () => {
    const { extractFileRegexFallback } = await import("../src/code/extract.ts");
    const ts = `export function baz() {}\nclass MyClass {}\nconst X = 1;\nimport { a } from "b";\n`;
    const result = await extractFileRegexFallback(ts, ".ts");
    expect(result.heuristic).toBe(true);
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain("baz");
    expect(names).toContain("MyClass");
    expect(names).toContain("X");
  });
});

// ---------- incremental index ----------
describe("indexer", () => {
  test("workspaceHash stable and insertion-order independent", async () => {
    const { workspaceHash } = await import("../src/code/indexer.ts");
    const r1 = new Map([["a", "/x"], ["b", "/y"]]);
    const r2 = new Map([["b", "/y"], ["a", "/x"]]);
    expect(workspaceHash(r1)).toBe(workspaceHash(r2));
  });

  test("hash changes when repo path changes", async () => {
    const { workspaceHash } = await import("../src/code/indexer.ts");
    expect(workspaceHash(new Map([["a", "/x"]]))).not.toBe(workspaceHash(new Map([["a", "/y"]])));
  });

  test("unchanged file not reparsed (fast path)", async () => {
    const { incrementalIndex, readIndex, workspaceHash } = await import("../src/code/indexer.ts");
    const tmp = mkdtempSync(join(tmpdir(), "idx-"));
    writeFileSync(join(tmp, "a.ts"), `export function hello() {}\n`, "utf8");
    const roots = new Map([["repo", tmp]]);
    const idx1 = await incrementalIndex(roots);
    expect(idx1.files).toBe(1);
    const idx2 = await incrementalIndex(roots);
    expect(idx2.files).toBe(1); // same count, fast-path
    rmSync(tmp, { recursive: true, force: true });
  });

  test("changed content reparsed and hash updated", async () => {
    const { incrementalIndex, readIndex, workspaceHash } = await import("../src/code/indexer.ts");
    const tmp = mkdtempSync(join(tmpdir(), "chg-"));
    const f = join(tmp, "a.ts");
    writeFileSync(f, `export function a() {}\n`, "utf8");
    const roots = new Map([["repo", tmp]]);
    await incrementalIndex(roots);
    const hash = workspaceHash(roots);
    writeFileSync(f, `export function b() {}\n`, "utf8");
    await incrementalIndex(roots, undefined, { force: true });
    const stored = readIndex(hash);
    expect(stored!.files[`repo/a.ts`].symbols.some((s: any) => s.name === "b")).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("deleted file pruned from edges", async () => {
    const { incrementalIndex, readIndex, workspaceHash } = await import("../src/code/indexer.ts");
    const tmp = mkdtempSync(join(tmpdir(), "del-"));
    writeFileSync(join(tmp, "a.ts"), `export function a() {}\n`, "utf8");
    writeFileSync(join(tmp, "b.ts"), `export function b() {}\n`, "utf8");
    const roots = new Map([["repo", tmp]]);
    await incrementalIndex(roots);
    const hash = workspaceHash(roots);
    let stored = readIndex(hash)!;
    expect(Object.keys(stored.files).length).toBe(2);
    rmSync(join(tmp, "a.ts"));
    await incrementalIndex(roots, undefined, { force: true });
    stored = readIndex(hash)!;
    expect(Object.keys(stored.files).length).toBe(1);
    expect(stored.edges.every((e: any) => !e.file.includes("a.ts"))).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("clearIndex removes index file", async () => {
    const { incrementalIndex, clearIndex, workspaceHash, indexPathFor } = await import("../src/code/indexer.ts");
    const tmp = mkdtempSync(join(tmpdir(), "clr-"));
    writeFileSync(join(tmp, "a.ts"), `export function a() {}\n`, "utf8");
    const roots = new Map([["repo", tmp]]);
    await incrementalIndex(roots);
    const hash = workspaceHash(roots);
    expect(existsSync(indexPathFor(hash))).toBe(true);
    clearIndex(hash);
    expect(existsSync(indexPathFor(hash))).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------- find ranking ----------
describe("find", () => {
  function makeIndex(symbols: { name: string; kind: string; line: number }[], edges: { caller: string; callee: string }[], files: string[] = ["repo/a.ts"]): any {
    return {
      files: Object.fromEntries(files.map((f) => [f, { repo: "repo", hash: "x", mtime: 1, size: 1, symbols, imports: [], heuristic: false }])),
      edges: edges.map((e) => ({ ...e, repo: "repo", file: files[0], line: 1 })),
    };
  }

  test("exact 10 > prefix/camel 6 > substring 3 > edge 2 > filename 2", async () => {
    const { findSymbols } = await import("../src/code/find.ts");
    const idx = makeIndex([{ name: "userInfo", kind: "function", line: 1 }], [{ caller: "local", callee: "userInfo" }]);
    expect(findSymbols(idx, "userInfo", { limit: 12 })[0].score).toBe(10);
    const hump = findSymbols(idx, "usrInfo", { limit: 12 });
    expect(hump.find((r: any) => r.name === "userInfo")?.score).toBe(6);
    const sub = findSymbols(idx, "info", { limit: 12 });
    expect(sub.find((r: any) => r.name === "userInfo")?.score).toBe(3);
  });

  test("cap 12", async () => {
    const { findSymbols } = await import("../src/code/find.ts");
    const syms = Array.from({ length: 20 }, (_, i) => ({ name: `func${i}`, kind: "function", line: i }));
    const idx = makeIndex(syms, []);
    expect(findSymbols(idx, "func", { limit: 12 }).length).toBeLessThanOrEqual(12);
  });

  test("edge bonus is limited to direct partners of original over-3 symbols", async () => {
    const { findSymbols } = await import("../src/code/find.ts");
    // file path deliberately excludes "a" so the FILE_BONUS can't mask edge logic
    const idx = makeIndex(
      ["A", "B", "C", "D"].map((name) => ({ name, kind: "function", line: 1 })),
      [
        { caller: "A", callee: "B" },
        { caller: "B", callee: "C" },
        { caller: "C", callee: "D" },
      ],
      ["repo/x.ts"],
    );
    const results = findSymbols(idx, "A", { limit: 12 });
    expect(Object.fromEntries(results.map((r: any) => [r.name, r.score]))).toEqual({
      A: 10,
      B: 2,
      C: 0,
      D: 0,
    });
  });

  test("empty index returns no matches", async () => {
    const { findSymbols } = await import("../src/code/find.ts");
    expect(findSymbols({ files: {}, edges: [] }, "x", { limit: 12 }).length).toBe(0);
  });
});

// ---------- tool handler ----------
describe("tool", () => {
  test("no-index message for empty roots", async () => {
    const { makeFindTool } = await import("../src/code/tool.ts");
    const tool = makeFindTool({ roots: new Map(), getIndex: () => null });
    expect((await tool({ query: "x" })).ok).toBe(false);
    expect((await tool({ query: "x" })).output).toContain("no index yet");
  });

  test("single-repo hint when roots nonempty but no index", async () => {
    const { makeFindTool } = await import("../src/code/tool.ts");
    const tool = makeFindTool({ roots: new Map([["repo", "/x"]]), getIndex: () => null });
    expect((await tool({ query: "x" })).ok).toBe(false);
    expect((await tool({ query: "x" })).output).toContain("no index yet");
  });
});

// ---------- runCodeSlash ----------
describe("slash", () => {
  test("/index then /find happy path", async () => {
    const { runCodeSlash } = await import("../src/code/slash.ts");
    const tmp = mkdtempSync(join(tmpdir(), "slash-"));
    writeFileSync(join(tmp, "a.ts"), `export function hello() {}\n`, "utf8");
    const pushes: any[] = [];
    const io = { roots: { repo: tmp }, push: (n: any) => pushes.push(n) };
    expect(await runCodeSlash("/index", io)).toBe(true);
    const text = pushes.filter((p: any) => p.type === "text").map((p: any) => p.text);
    expect(text.some((t: string) => t.includes("force-reindexed"))).toBe(true);
    pushes.length = 0;
    await runCodeSlash("/find hello", io);
    const ft = pushes.filter((p: any) => p.type === "text").map((p: any) => p.text);
    expect(ft.some((t: string) => t.includes("hello"))).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("/find before index shows helpful error", async () => {
    const { runCodeSlash } = await import("../src/code/slash.ts");
    const pushes: any[] = [];
    const io = { roots: { repo: "/tmp/does-not-exist" }, push: (n: any) => pushes.push(n) };
    await runCodeSlash("/find x", io);
    const txt = pushes.filter((p: any) => p.type === "text").map((p: any) => p.text);
    expect(txt.some((t: string) => t.includes("no index yet"))).toBe(true);
  });

  test("unknown line returns false", async () => {
    const { runCodeSlash } = await import("../src/code/slash.ts");
    const io = { roots: {}, push: () => {} };
    expect(await runCodeSlash("/unknown", io)).toBe(false);
  });

  test("isCodeCommand identifies /index and /find", async () => {
    const { isCodeCommand } = await import("../src/code/slash.ts");
    expect(isCodeCommand("/index")).toBe(true);
    expect(isCodeCommand("/find foo")).toBe(true);
    expect(isCodeCommand("/foo")).toBe(false);
  });

  test("autoIndexOnce second call is no-op", async () => {
    const { autoIndexOnce } = await import("../src/code/slash.ts");
    const { indexPathFor, workspaceHash } = await import("../src/code/indexer.ts");
    const tmp = mkdtempSync(join(tmpdir(), "auto-"));
    writeFileSync(join(tmp, "a.ts"), `export function a() {}\n`, "utf8");
    const roots = new Map([["repo", tmp]]);
    const p1: any[] = [];
    const p2: any[] = [];
    await autoIndexOnce(roots, (p: any) => p1.push(p));
    expect(existsSync(indexPathFor(workspaceHash(roots)))).toBe(true);
    await autoIndexOnce(roots, (p: any) => p2.push(p));
    expect(p2.length).toBe(0);
    rmSync(tmp, { recursive: true, force: true });
  });
});
