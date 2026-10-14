/**
 * Custom subagents — user-defined agent types loadable as `task` subagent_type.
 *
 * Agents are AGENT.md files (or .md files with frontmatter) in (highest
 * priority first — a name defined in several roots uses the first hit):
 *   ./.goat/agents/<name>.md
 *   ./agents/<name>.md
 *   ~/.goatcode/agents/<name>.md
 *
 * Frontmatter fields:
 *   name          — the subagent_type id (defaults to the filename)
 *   description   — one-liner shown in the system prompt so the model knows
 *                   when to pick this agent
 *   tools         — comma-separated allowlist; omit = all tools. A tool not
 *                   in the list is refused at dispatch (agent guardrail).
 *   model         — optional model override for this agent
 *
 * The markdown body is the agent's system prompt — its persona, rules and
 * output format. It is injected as extra system context on top of the base
 * prompt for every turn the subagent runs.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "../config.ts";

export interface AgentDef {
  name: string;
  description: string;
  /** Tool allowlist; undefined/empty = all tools. */
  tools?: string[];
  /** Optional model override (provider/model). */
  model?: string;
  /** The markdown body — the agent's system prompt. */
  body: string;
  /** Where it was loaded from (for /agents listing). */
  _path?: string;
}

interface AgentFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
  model?: string;
}

function parseFrontmatter(text: string): { fm: AgentFrontmatter; body: string } {
  const fm: AgentFrontmatter = {};
  let body = text;
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (m) {
    body = text.slice(m[0].length).trimStart();
    for (const line of m[1].trim().split("\n")) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim().replace(/^"|"$/g, "");
      switch (key) {
        case "name": fm.name = val; break;
        case "description": fm.description = val; break;
        case "tools": case "allowedTools": case "allowed-tools":
          fm.tools = val.split(",").map((s) => s.trim()).filter(Boolean);
          break;
        case "model": fm.model = val; break;
      }
    }
  }
  return { fm, body };
}

export function loadCustomAgents(...roots: string[]): AgentDef[] {
  const agents: AgentDef[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const f of readdirSync(root)) {
      if (!f.endsWith(".md")) continue;
      try {
        const text = readFileSync(join(root, f), "utf8");
        const { fm, body } = parseFrontmatter(text);
        const name = fm.name ?? f.replace(/\.md$/, "");
        if (!fm.description) continue; // a .md without description isn't an agent
        if (seen.has(name)) continue;
        seen.add(name);
        agents.push({ name, description: fm.description, tools: fm.tools, model: fm.model, body, _path: join(root, f) });
      } catch { /* unreadable file — skip */ }
    }
  }
  return agents;
}

/** Default agent search paths, highest priority first: project beats user.
 *  When the same agent name exists in several roots, the first root wins. */
export function agentDirs(cwd: string): string[] {
  return [
    join(cwd, ".goat", "agents"),
    join(cwd, "agents"),
    join(appDir(), "agents"),
  ];
}

/**
 * The system-prompt block describing custom agents, or "" when none exist.
 * Tells the model which subagent_type values exist and when to use each.
 */
export function customAgentsPrompt(agents: AgentDef[]): string {
  if (!agents.length) return "";
  const lines = agents.map((a) =>
    `- ${a.name}: ${a.description}${a.tools?.length ? ` (tools: ${a.tools.join(", ")})` : ""}`);
  return `Custom subagents available via task subagent_type:\n${lines}\nPick one when its description matches the work; otherwise use "general" or "explore".`;
}
