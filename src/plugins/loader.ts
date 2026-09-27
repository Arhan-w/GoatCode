/**
 * Plugin loader — bundles of commands + skills, loaded from plugin
 * directories listed under "plugins" in config. Claude Code compatible
 * directory layout:
 *
 *   <plugin>/manifest.json        (optional — name/version/description)
 *   <plugin>/commands/<name>.md   frontmatter + $ARGUMENTS body → /name prompt
 *   <plugin>/skills/<name>/SKILL.md   progressive-disclosure skills
 *   <plugin>/sandbox/            optional sandboxed entry point for untrusted plugins
 *
 * Everything a plugin contributes becomes a SkillDef, so plugin commands
 * and skills flow through the same invocation path (/name, body on demand,
 * listed by /skills) as native ones.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills, type SkillDef } from "../skills/loader.ts";
import { createSandbox, type SandboxConfig, type SandboxResult, executeSandbox } from "./sandbox.ts";

export interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
  /** If true, plugin commands run in a sandbox (untrusted plugins) */
  sandboxed?: boolean;
  /** Sandbox entry point (default: commands/main.ts) */
  sandboxEntry?: string;
}

export interface Plugin {
  manifest: PluginManifest;
  dir: string;
  sandboxed: boolean;
}

function readManifest(dir: string): Plugin {
  let manifest: PluginManifest = { name: dir.split(/[\\/]/).pop() };
  const p = join(dir, "manifest.json");
  if (existsSync(p)) {
    try { manifest = { name: manifest.name, ...JSON.parse(readFileSync(p, "utf8")) }; } catch { /* keep dir name */ }
  }
  return { manifest, dir, sandboxed: manifest.sandboxed ?? false };
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

/**
 * Execute a sandboxed plugin command via the sandbox runner.
 * Returns the result as a string (stdout).
 */
export async function executeSandboxedPlugin(
  plugin: Plugin,
  args: Record<string, unknown>,
): Promise<SandboxResult> {
  const entryPoint = plugin.manifest.sandboxEntry ?? join(plugin.dir, "sandbox", "main.ts");
  if (!existsSync(entryPoint)) {
    return { ok: false, output: `sandbox entry not found: ${entryPoint}`, exitCode: null, signal: null, durationMs: 0, timedOut: false };
  }

  // Write args to temp file for the sandbox to read
  const argsFile = join(plugin.dir, ".sandbox-args.json");
  try {
    writeFileSync(argsFile, JSON.stringify(args), "utf8");
  } catch { /* best effort */ }

  const result = await createSandbox({
    entryPoint,
    workDir: plugin.dir,
    env: { GOAT_PLUGIN_ARGS_FILE: argsFile },
    timeoutMs: 30_000,
    onStdout: (data) => process.stdout.write(data),
    onStderr: (data) => process.stderr.write(data),
  });

  // Clean up args file
  try { unlinkSync(argsFile); } catch { /* ignore */ }

  return result;
}

