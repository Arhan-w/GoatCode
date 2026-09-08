/**
 * Plugin loader — bundles of commands + skills, loaded from plugin
 * directories listed under "plugins" in config. Claude Code compatible
 * directory layout:
 *
 *   <plugin>/manifest.json        (optional — name/version/description)
 *   <plugin>/commands/<name>.md   frontmatter + $ARGUMENTS body → /name prompt
 *   <plugin>/skills/<name>/SKILL.md   progressive-disclosure skills
 *
 * Everything a plugin contributes becomes a SkillDef, so plugin commands
 * and skills flow through the same invocation path (/name, body on demand,
 * listed by /skills) as native ones.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills, type SkillDef } from "../skills/loader.ts";

export interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
}

export interface Plugin {
  manifest: PluginManifest;
  dir: string;
}

function readManifest(dir: string): Plugin {
  let manifest: PluginManifest = { name: dir.split(/[\\/]/).pop() };
  const p = join(dir, "manifest.json");
  if (existsSync(p)) {
    try { manifest = { name: manifest.name, ...JSON.parse(readFileSync(p, "utf8")) }; } catch { /* keep dir name */ }
  }
  return { manifest, dir };
}

export function loadPlugins(dirs: string[]): Plugin[] {
  return dirs.filter((d) => existsSync(d)).map(readManifest);
}

/** Commands a plugin dir contributes: <dir>/commands/<name>.md → SkillDefs. */
export function pluginCommandSkills(dir: string): SkillDef[] {
  const cmdDir = join(dir, "commands");
  if (!existsSync(cmdDir)) return [];
  const out: SkillDef[] = [];
  for (const f of readdirSync(cmdDir)) {
    if (!f.endsWith(".md")) continue;
    const name = f.replace(/\.md$/, "");
    const text = readFileSync(join(cmdDir, f), "utf8");
    const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    let description = `/${name} from plugin ${dir.split(/[\\/]/).pop()}`;
    let body = text;
    if (m) {
      body = text.slice(m[0].length);
      for (const line of m[1].split("\n")) {
        const i = line.indexOf(":");
        if (i > 0 && line.slice(0, i).trim() === "description") {
          description = line.slice(i + 1).trim().replace(/^"|"$/g, "");
        }
      }
    }
    // $ARGUMENTS / $1..$9 placeholders stay in the body; substituted at invocation
    out.push({ name, description, _body: body, _path: join(cmdDir, f) });
  }
  return out;
}

/** All SkillDefs a set of plugin dirs contributes (commands + skills). */
export function pluginSkills(plugins: Plugin[]): SkillDef[] {
  const out: SkillDef[] = [];
  for (const p of plugins) {
    out.push(...pluginCommandSkills(p.dir));
    const skillRoot = join(p.dir, "skills");
    if (existsSync(skillRoot)) out.push(...loadSkills(skillRoot));
  }
  return out;
}
