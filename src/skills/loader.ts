/**
 * Skills loader — progressive-disclosure model like Claude Code.
 *
 * Skills are SKILL.md folders (or .md files with frontmatter) in:
 *   ~/.goatcode/skills/<name>/SKILL.md
 *   ./skills/<name>/SKILL.md
 *   ./skills/<name>.md
 *
 * Frontmatter fields: name, description, whenToUse, argumentHint,
 * allowedTools, model.
 *
 * Only name/description/whenToUse enter the system prompt. Full
 * content is loaded on invocation (progressively disclosed).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "../config.ts";
import type { ToolSpec } from "../llm.ts";

export interface SkillDef {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  /** The markdown body — loaded lazily on first invocation. */
  _body?: string;
  /** Path to the SKILL.md for lazy loading. */
  _path?: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
  whenToUse?: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
}

function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  const fm: Frontmatter = {};
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
        case "whenToUse": case "when_to_use": fm.whenToUse = val; break;
        case "argumentHint": case "argument-hint": fm.argumentHint = val; break;
        case "allowedTools": case "allowed-tools": fm.allowedTools = val.split(",").map((s) => s.trim()); break;
        case "model": fm.model = val; break;
      }
    }
  }
  return { fm, body };
}

function loadMdFile(path: string): SkillDef | null {
  const text = readFileSync(path, "utf8");
  const { fm, body } = parseFrontmatter(text);
  const name = fm.name ?? path.match(/([\w-]+)\.md$/)?.[1] ?? path;
  if (!fm.description) return null; // .md without frontmatter isn't a skill
  return {
    name,
    description: fm.description,
    whenToUse: fm.whenToUse,
    argumentHint: fm.argumentHint,
    allowedTools: fm.allowedTools,
    model: fm.model,
    _body: body,
    _path: path,
  };
}

export function loadSkills(...roots: string[]): SkillDef[] {
  const skills: SkillDef[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // accept both "<root>/skills" and a root that IS a skills dir (e.g. .claude/skills)
    const skillDir = root.endsWith("skills") ? root : join(root, "skills");
    if (!existsSync(skillDir)) continue;
    // folder-per-skill
    for (const name of readdirSync(skillDir)) {
      const f = join(skillDir, name, "SKILL.md");
      if (existsSync(f) && !seen.has(name)) {
        seen.add(name);
        const s = loadMdFile(f);
        if (s) { s.name = name; skills.push(s); }
      }
    }
    // flat .md files
    for (const f of readdirSync(skillDir)) {
      if (f.endsWith(".md") && !f.endsWith("SKILL.md")) {
        const s = loadMdFile(join(skillDir, f));
        if (s && !seen.has(s.name)) { seen.add(s.name); skills.push(s); }
      }
    }
  }
  return skills;
}

export function loadSkillBody(s: SkillDef): string {
  if (s._body) return s._body;
  if (s._path) {
    s._body = readFileSync(s._path, "utf8");
    const { body } = parseFrontmatter(s._body);
    return body;
  }
  return "";
}

/** Tool spec for invoking a skill via the /skill-name command. */
export function skillToolSpec(s: SkillDef): ToolSpec {
  return {
    name: `skill__${s.name}`,
    description: s.description,
    parameters: {
      type: "object",
      properties: { prompt: { type: "string", description: "The task to run" } },
      required: ["prompt"],
    },
  };
}

export function skillSpecs(skills: SkillDef[]): ToolSpec[] {
  return skills.map(skillToolSpec);
}
