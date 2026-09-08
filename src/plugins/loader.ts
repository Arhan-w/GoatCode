/**
 * Plugin loader — bundles of commands + agents + hooks, loaded
 * from plugin directories. Claude Code compatible format.
 *
 * A plugin is a directory containing:
 *   commands/<name>/index.ts  (or .js) — slash command definitions
 *   agents/<name>.md          — agent prompts
 *   skills/<name>/SKILL.md    — skill files
 *
 * GoatCode's plugin format intentionally mirrors Claude Code's so
 * existing plugin packs work unchanged.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolSpec } from "../llm.ts";
import { loadSkills, type SkillDef } from "../skills/loader";

export interface PluginCommand {
  name: string;
  description: string;
  argumentHint?: string;
  handler: (...args: any[]) => Promise<any>;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  commands?: PluginCommand[];
  skills?: SkillDef[];
}

export interface Plugin {
  manifest: PluginManifest;
  dir: string;
}

export function loadPlugins(dirs: string[]): Plugin[] {
  const plugins: Plugin[] = [];
  for (const dir of dirs) {
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      plugins.push({ manifest, dir });
    } catch { continue; }
  }
  return plugins;
}

export function pluginCommands(plugins: Plugin[]): PluginCommand[] {
  const out: PluginCommand[] = [];
  for (const p of plugins)
    for (const c of (p.manifest.commands ?? []))
      out.push(c);
  return out;
}

export function pluginSpecs(plugins: Plugin[]): ToolSpec[] {
  const out: ToolSpec[] = [];
  for (const p of plugins)
    for (const c of (p.manifest.commands ?? []))
      out.push({
        name: `plugin__${p.manifest.name}__${c.name}`,
        description: c.description,
        parameters: { type: "object", properties: {}, required: [] },
      });
  return out;
}
