/**
 * System-prompt augmentation: skills (progressive disclosure) + GOAT.md
 * project memory. Mirrors Claude Code — only name/description/whenToUse
 * enter the prompt; full skill bodies load on invocation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appDir, type GoatConfig } from "./config.ts";
import type { SkillDef } from "./skills/loader.ts";

export function skillsBlock(skills: SkillDef[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => {
    const hint = s.argumentHint ? ` — ${s.argumentHint}` : "";
    const when = s.whenToUse ? ` (use when: ${s.whenToUse})` : "";
    return `- /${s.name}: ${s.description}${hint}${when}`;
  });
  return (
    "# Available skills\n" +
    "Invoke a skill by running its /name as a command, or when a request matches a skill's 'use when', " +
    "read its full body first via the skill tool, then follow it.\n" +
    lines.join("\n")
  );
}

/** Read GOAT.md (project) and ~/.goatcode/GOAT.md (user) memory files. */
export function projectMemory(cwd: string): string {
  const parts: string[] = [];
  const user = join(appDir(), "GOAT.md");
  const proj = join(cwd, "GOAT.md");
  if (existsSync(user)) parts.push("# User memory\n" + readFileSync(user, "utf8").trim());
  if (existsSync(proj)) parts.push("# Project memory (GOAT.md)\n" + readFileSync(proj, "utf8").trim());
  return parts.join("\n\n");
}

export function buildExtraSystem(skills: SkillDef[], cwd: string, repos?: Record<string, string>): string {
  const blocks = [projectMemory(cwd), skillsBlock(skills)];
  if (repos && Object.keys(repos).length) {
    const lines = Object.entries(repos)
      .map(([name, path]) => `  ${name}: ${path}`)
      .join("\n");
    blocks.push(`# Workspace repos (use repo/... path or repo:"name" arg):\n${lines}`);
  }
  return blocks.filter(Boolean).join("\n\n");
}

/**
 * Output styles — Claude-compatible: a style name or a .md file whose body
 * gets appended to the system prompt (frontmatter name/description optional).
 * Built-ins: "default" (nothing), "Explanatory". Custom: ~/.goatcode/output-styles/<name>.md or a path.
 */
export function loadOutputStyle(nameOrPath?: string): string {
  if (!nameOrPath || nameOrPath === "default") return "";
  if (nameOrPath === "Explanatory")
    return "# Output Style: Explanatory\nAfter each tool call, add a 1-2 line note explaining what you found and why it matters, so the user learns the codebase as we work.";
  const candidates = [
    nameOrPath,
    join(appDir(), "output-styles", nameOrPath + ".md"),
    join(process.cwd(), ".goatcode", "output-styles", nameOrPath + ".md"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        let text = readFileSync(p, "utf8");
        const fm = text.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
        if (fm) text = text.slice(fm[0].length);
        const label = nameOrPath.split(/[\\/]/).pop() ?? nameOrPath;
        return `# Output Style: ${label.replace(/\.md$/, "")}\n${text.trim()}`;
      }
    } catch { /* skip */ }
  }
  return "";
}
