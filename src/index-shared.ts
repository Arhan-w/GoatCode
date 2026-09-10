/**
 * Helpers shared between the CLI entry (index.ts), the TUI, and the web UI —
 * kept out of index.ts so importing them never re-runs main().
 */
import { join } from "node:path";
import { appDir, type GoatConfig } from "./config.ts";
import { loadSkills, type SkillDef } from "./skills/loader.ts";
import { loadPlugins, pluginSkills } from "./plugins/loader.ts";

/** Native skills (user/project/claude dirs) extended by anything plugins provide. */
export function allSkills(cfg: GoatConfig): SkillDef[] {
  const native = loadSkills(
    join(appDir(), "skills"),
    join(process.cwd(), "skills"),
    join(process.cwd(), ".claude", "skills"),
  );
  const fromPlugins = pluginSkills(loadPlugins(cfg.pluginDirs.map((d) => join(process.cwd(), d))));
  const names = new Set(native.map((s) => s.name));
  return [...native, ...fromPlugins.filter((s) => !names.has(s.name))];
}
