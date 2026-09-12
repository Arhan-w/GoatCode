import type { ToolSpec } from "../llm.ts";
import type { Index } from "./indexer.ts";
import { findSymbols } from "./find.ts";

export interface ToolResult {
  ok: boolean;
  output: string;
}

export const FIND_TOOL_SPEC: ToolSpec = {
  name: "find",
  description:
    "Search INDEXED symbols across all workspace repos; ranked definitions. Needs /index for freshness. Heuristic when tree-sitter wasm is missing.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Symbol name or fragment to search for" },
      kind: { type: "string", description: "Filter by kind (function, class, etc.)" },
      limit: { type: "integer", description: "Max results (default 12)" },
    },
    required: ["query"],
  },
};

export function makeFindTool(deps: { roots: Map<string, string>; getIndex: () => Index | null }): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const index = deps.getIndex();
    if (!index || Object.keys(index.files).length === 0) {
      if (deps.roots.size === 0) return { ok: false, output: "no index yet — run /index" };
      const names = [...deps.roots.keys()].join(", ");
      return { ok: false, output: `no index yet — run /index for repo(s): ${names}` };
    }
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, output: "find requires a query" };
    const results = findSymbols(index, query, { limit: Number(args.limit) ?? 12 });
    const lines = results.map((r) => `${r.kind} ${r.name}  ${r.file}:${r.line}${r.heuristic ? " [heuristic]" : ""}`);
    const count = results.length;
    return { ok: true, output: lines.join("\n") + (count ? `\n${count} result(s)` : "(no matches)") };
  };
}
