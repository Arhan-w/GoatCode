/**
 * System-prompt augmentation: skills (progressive disclosure) + GOAT.md
 * project memory. Mirrors Claude Code — only name/description/whenToUse
 * enter the prompt; full skill bodies load on invocation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "./config.ts";
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

export function buildExtraSystem(skills: SkillDef[], cwd: string): string {
  return [projectMemory(cwd), skillsBlock(skills)].filter(Boolean).join("\n\n");
}
