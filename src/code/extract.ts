/**
 * Symbol/import/call extraction per source file: tree-sitter when a grammar
 * wasm resolves, regex fallback (heuristic:true) otherwise. Never throws.
 */
import { readFileSync } from "node:fs";
import { Parser, Language } from "web-tree-sitter";
import { EXT_GRAMMAR, resolveWasmFile, resolveRuntimeWasm } from "./grammars.ts";

export type SymbolEntry = { name: string; kind: string; line: number };
export type EdgeEntry = { caller: string; callee: string; line: number };
export interface ExtractedFile {
  symbols: SymbolEntry[];
  imports: string[];
  edges: EdgeEntry[];
  heuristic: boolean;
}

/** Minimal parser shape — a parserFactory can inject a mock to count calls. */
export interface ParserLike {
  parse(source: string): { rootNode: any } | null;
}

let parserInitPromise: Promise<void> | null = null;
const langCache = new Map<string, any>();

/** Initialize the web-tree-sitter runtime once. Throws clearly if wasm missing. */
export async function initParserOnce(): Promise<void> {
  if (!parserInitPromise) {
    const runtime = resolveRuntimeWasm();
    if (!runtime) {
      throw new Error(
        "tree-sitter runtime wasm not found — install tree-sitter-wasms or vendor tree-sitter.wasm next to the executable",
      );
    }
    parserInitPromise = Parser.init({ locateFile: () => resolveRuntimeWasm()! }).then(() => undefined);
  }
  await parserInitPromise;
}

/** Reset init state (tests isolate wasm-missing scenarios). */
export function resetParserInit(): void {
  parserInitPromise = null;
  langCache.clear();
}

function grammarFor(absPath: string): string | null {
  const i = absPath.lastIndexOf(".");
  if (i < 0) return null;
  return EXT_GRAMMAR[absPath.slice(i + 1).toLowerCase()] ?? null;
}

/**
 * Extract symbols, imports and call edges from one file.
 * Tree-sitter when the grammar wasm resolves and parses; otherwise the regex
 * fallback for ts/tsx/js/jsx/py/go with heuristic:true. Never throws — the
 * worst case is empty + heuristic:true.
 */
export async function extractFile(
  absPath: string,
  content: string,
  parserFactory?: (grammar: string) => Promise<ParserLike>,
): Promise<ExtractedFile> {
  try {
    const grammar = grammarFor(absPath);
    if (grammar) {
      const wasm = resolveWasmFile(grammar);
      if (wasm) {
        try {
          const parser = parserFactory
            ? await parserFactory(grammar)
            : await getParser(wasm);
          const tree = parser.parse(content);
          if (tree?.rootNode) return walkTree(tree.rootNode);
        } catch { /* fall through to regex */ }
      }
    }
    return regexFallback(content, extOf(absPath));
  } catch {
    return { symbols: [], imports: [], edges: [], heuristic: true };
  }
}

/** Force the regex-fallback branch directly (missing wasm / tests). */
export async function extractFileRegexFallback(content: string, ext: string): Promise<ExtractedFile> {
  return regexFallback(content, ext.startsWith(".") ? ext : "." + ext);
}

async function getParser(wasmPath: string): Promise<ParserLike> {
  await initParserOnce();
  let lang = langCache.get(wasmPath);
  if (!lang) {
    lang = await Language.load(new Uint8Array(readFileSync(wasmPath)));
    langCache.set(wasmPath, lang);
  }
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser as unknown as ParserLike;
}

const DEF_TYPES = new Set([
  "function_declaration", "generator_function_declaration", "function_signature",
  "abstract_class_declaration", "class_declaration", "method_definition",
  "interface_declaration", "type_alias_declaration", "enum_declaration",
  "function_definition", "class_definition", "decorated_definition",
  "method_declaration", "constructor_declaration",
  "struct_type", "union_type", "interface_type", "enum_type", "type_declaration",
  "const_declaration", "var_declaration",
  "function_item", "struct_item", "enum_item", "union_item", "trait_item", "impl_item",
  "type_definition", "struct_specifier", "enum_specifier", "union_specifier",
  "record_declaration", "class",
]);

const NAME_TOKENS = new Set([
  "type_identifier", "identifier", "field_identifier", "constant",
  "scoped_identifier", "qualified_identifier", "word",
]);

function nameOf(n: any): string | null {
  const f = n.childForFieldName?.("name");
  if (f?.text) return f.text;
  for (const c of n.children ?? []) {
    if (NAME_TOKENS.has(c.type) && c.text) {
      // skip the "extends X" / type-name collisions in go/rust decl wrappers
      if (c.type === "identifier" && (n.type === "const_declaration" || n.type === "var_declaration")) continue;
      return c.text.split(".").pop() || c.text;
    }
    if (["type_spec", "base_type_specifier", "element_type", "declarator"].includes(c.type)) {
      const inner = nameOf(c);
      if (inner) return inner;
    }
  }
  return null;
}

function calleeOf(n: any): string | null {
  const f = n.childForFieldName?.("function") ?? n.childForFieldName?.("name");
  const text = f?.text ?? null;
  if (!text) return null;
  // strip member paths and generics: obj.method<T>(x) -> method
  const cleaned = text.replace(/<[^<>]*>/g, "").trim();
  const parts = cleaned.split(/[.::]/);
  const last = parts[parts.length - 1]?.trim();
  return last && /^\w+$/.test(last) ? last : null;
}

/** Walk a tree-sitter tree collecting definitions, call edges, import sources. */
function walkTree(root: any): ExtractedFile {
  const symbols: SymbolEntry[] = [];
  const imports: string[] = [];
  const edges: EdgeEntry[] = [];

  const lineOf = (n: any): number => (n.startPosition?.row ?? 0) + 1;

  function walk(n: any, enclosing: string) {
    const t = n.type;
    let next = enclosing;
    if (DEF_TYPES.has(t)) {
      const name = nameOf(n);
      if (name) {
        symbols.push({ name, kind: t, line: lineOf(n) });
        next = name;
      }
    }
    if (t === "call_expression" || t === "call" || t === "invocation_expression") {
      const callee = calleeOf(n);
      if (callee) edges.push({ caller: enclosing || "<module>", callee, line: lineOf(n) });
    }
    if (
      t === "import_statement" || t === "import_declaration" || t === "import_from_statement" ||
      t === "use_declaration" || t === "namespace_use_declaration" || t === "using_directive"
    ) {
      const src = n.childForFieldName?.("source") ?? n.childForFieldName?.("module_name") ?? n.childForFieldName?.("argument");
      if (src?.text) imports.push(stripQuotes(src.text));
      else {
        for (const c of n.children ?? []) {
          if (["dotted_name", "path", "relative_path", "scoped_identifier"].includes(c.type)) {
            imports.push(c.text);
            break;
          }
          if (c.type === "import_spec") {
            const p = c.childForFieldName?.("path");
            if (p?.text) { imports.push(stripQuotes(p.text)); break; }
          }
          if (c.type === "string") { imports.push(stripQuotes(c.text)); break; }
        }
      }
    }
    if (t === "export_statement") {
      const src = n.childForFieldName?.("source");
      if (src?.text) imports.push(stripQuotes(src.text));
    }
    for (const c of n.children ?? []) walk(c, next);
  }

  walk(root, "");
  return { symbols, imports, edges, heuristic: false };
}

function stripQuotes(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, "");
}

function extOf(absPath: string): string {
  const i = absPath.lastIndexOf(".");
  return i < 0 ? "" : absPath.slice(i).toLowerCase();
}

function lineNum(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") n++;
  return n;
}

const KEYWORD_CALLS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "typeof", "await", "new", "do", "else", "match", "case", "range"]);

/** Regex fallback for ts/tsx/js/jsx/py/go — always heuristic:true. */
function regexFallback(content: string, ext: string): ExtractedFile {
  const symbols: SymbolEntry[] = [];
  const imports: string[] = [];
  const edges: EdgeEntry[] = [];

  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    for (const m of content.matchAll(/(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*(?:\*)?\s*(\w+)/g))
      symbols.push({ name: m[1], kind: "function", line: lineNum(content, m.index ?? 0) });
    for (const m of content.matchAll(/(?:export\s+(?:default\s+)?)?class\s+(\w+)/g))
      symbols.push({ name: m[1], kind: "class", line: lineNum(content, m.index ?? 0) });
    for (const m of content.matchAll(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g))
      symbols.push({ name: m[1], kind: "const", line: lineNum(content, m.index ?? 0) });
    for (const m of content.matchAll(/import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g))
      imports.push(m[1]);
    for (const m of content.matchAll(/export\s+(?:\{[^}]*\}|\*(?: as \w+)?)\s+from\s+["']([^"']+)["']/g))
      imports.push(m[1]);
    const known = new Set(symbols.map((s) => s.name));
    for (const m of content.matchAll(/(\w+)\s*\(/g)) {
      if (known.has(m[1]) && !KEYWORD_CALLS.has(m[1]))
        edges.push({ caller: "<local>", callee: m[1], line: lineNum(content, m.index ?? 0) });
    }
  } else if (ext === ".py") {
    for (const m of content.matchAll(/^(?:async\s+)?def\s+(\w+)/gm))
      symbols.push({ name: m[1], kind: "function", line: lineNum(content, m.index ?? 0) });
    for (const m of content.matchAll(/^class\s+(\w+)/gm))
      symbols.push({ name: m[1], kind: "class", line: lineNum(content, m.index ?? 0) });
    for (const m of content.matchAll(/^\s*import\s+([\w.]+)/gm)) imports.push(m[1]);
    for (const m of content.matchAll(/^\s*from\s+([\w.]+)/gm)) imports.push(m[1]);
  } else if (ext === ".go") {
    for (const m of content.matchAll(/^func\s+(?:\([^)]*\)\s*)?(\w+)/gm))
      symbols.push({ name: m[1], kind: "function", line: lineNum(content, m.index ?? 0) });
    for (const m of content.matchAll(/^type\s+(\w+)/gm))
      symbols.push({ name: m[1], kind: "type", line: lineNum(content, m.index ?? 0) });
    for (const m of content.matchAll(/import\s+"([^"]+)"/g)) imports.push(m[1]);
    for (const m of content.matchAll(/^\s+[\w.]*\s*"([^"]+)"/gm)) imports.push(m[1]);
  }
  return { symbols, imports, edges, heuristic: true };
}
