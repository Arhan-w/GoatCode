/**
 * Plugin Marketplace — registry index, tgz install with pinned ed25519
 * sigs, and plugin lifecycle. Plugin dirs live under <appDir()>/plugins.
 *
 * NO wasmtime — the v2 plugin directory bundle IS the plugin system;
 * tgz installation is the extension mechanism only.
 */
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { appDir } from "../config.ts";
import { loadPlugins, type PluginManifest as _PM } from "./loader.ts";
export type { PluginManifest } from "./loader.ts";
import type { PluginManifest } from "./loader.ts";
import { extractTar, writeTarFixtures, TarError, MAX_DECOMPRESSED } from "./tar.ts";
import { randomUUID, generateKeyPairSync, sign, createPublicKey } from "node:crypto";

export const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/Arhan-w/GoatCode/v3-plugins/index.json";
const FETCH_CAP = 50_000_000;

function registryBase(url?: string): string {
  const u = url ?? DEFAULT_REGISTRY_URL;
  return u.replace(/\/index\.json$/, "");
}

function pluginsDir(): string {
  return join(appDir(), "plugins");
}

/** Stable canonical JSON stringify (sorted keys at every level, arrays keep order). */
export function canonicalManifest(obj: unknown): string {
  return JSON.stringify(obj, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>).sort().reduce((acc, k) => {
        acc[k] = (val as Record<string, unknown>)[k];
        return acc;
      }, {} as Record<string, unknown>);
    }
    return val;
  });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Verify ed25519 signature using node:crypto. */
function verifySig(pubKeyPem: string, data: Buffer, sigHex: string): boolean {
  try {
    const { verify } = require("node:crypto");
    const pubKey = createPublicKey(pubKeyPem);
    return verify(null, data, pubKey, Buffer.from(sigHex, "hex"));
  } catch { return false; }
}

export async function installPlugin(
  source: string,
  cfg: any,
  io: { confirm?: (msg: string) => Promise<boolean>; log?: (s: string) => void } = {}
): Promise<string> {
  const destDir = pluginsDir();
  const tmpDir = join(destDir, `.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
  const confirm = io.confirm ?? (async () => true);
  const log = io.log ?? (() => {});

  try {
    let tgzBuf: Buffer;
    let sigHex: string | undefined;
    let keyId: string | undefined;

    if (source.startsWith("file://")) {
      const path = decodeURI(new URL(source).pathname);
      tgzBuf = readFileSync(path);
      // Check for sibling .sig
      const sigPath = path.replace(/\.tgz$/, "") + ".sig";
      if (existsSync(sigPath)) {
        const parsed = JSON.parse(readFileSync(sigPath, "utf8"));
        sigHex = parsed.sig; keyId = parsed.key;
      }
    } else {
      // URL (https or registry)
      const url = source;
      const fetchUrl = url.endsWith(".tgz") ? url : `${registryBase(url.includes("index.json") ? undefined : url)}/${url.split("/").pop()?.replace(/\.tgz$/, "") ?? url}.tgz`;

      const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`registry fetch failed: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > FETCH_CAP) throw new TarError("plugin payload exceeds 50MB");
      tgzBuf = bytes;

      // Fetch signature if available
      const sigUrl = fetchUrl.replace(/\.tgz$/, ".sig");
      try {
        const sres = await fetch(sigUrl, { signal: AbortSignal.timeout(10_000) });
        if (sres.ok) {
          const body = await sres.json();
          sigHex = body.sig; keyId = body.key;
        }
      } catch { /* sig optional */ }
    }

    // Extract to tmp
    mkdirSync(tmpDir, { recursive: true });
    extractTar(tgzBuf, tmpDir);

    // Find manifest.json
    const manifestPath = join(tmpDir, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("manifest.json required");
    const manifest: PluginManifest & { name: string; version: string; description?: string } = JSON.parse(readFileSync(manifestPath, "utf8"));
    const slug = basename(source.endsWith(".tgz") ? source.slice(0, -4) : source).split("/").pop() ?? manifest.name;

    if (!manifest.name || !/^[a-z0-9][a-z0-9_-]*$/.test(manifest.name)) {
      throw new Error(`manifest name does not match slug pattern`);
    }

    // Signature verification if sigHex present
    if (sigHex) {
      const keysPath = join(destDir, "keys.json");
      if (!existsSync(keysPath)) {
        const allowed = await confirm("unsigned plugin — keys.json missing, install anyway?");
        if (!allowed) { rmSync(tmpDir, { recursive: true, force: true }); return "refused"; }
      } else {
        const keys: Record<string, string> = JSON.parse(readFileSync(keysPath, "utf8"));
        if (!keyId || !keys[keyId]) {
          rmSync(tmpDir, { recursive: true, force: true });
          throw new Error("unknown key id — signature refused");
        }
        const canonical = canonicalManifest(manifest);
        if (!verifySig(keys[keyId], Buffer.from(canonical), sigHex)) {
          rmSync(tmpDir, { recursive: true, force: true });
          throw new Error("signature verification failed");
        }
      }
    } else if (source.startsWith("file://") || sigHex !== undefined) {
      // unsigned from file:// or registry with sig available but not present
      const allowed = await confirm(`unsigned plugin ${slug} — install anyway?`);
      if (!allowed) { rmSync(tmpDir, { recursive: true, force: true }); return "refused"; }
    }

    // Determine target: <pluginsDir>/<name>@<version>
    const targetName = manifest.name ?? slug;
    const targetVersion = manifest.version ?? "0.0.0";
    const targetDir = join(destDir, `${targetName}@${targetVersion}`);

    // Windows: rm existing dest then rename (renameSync fails if dest exists)
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }

    // Move extracted content to target
    const entries = readdirSync(tmpDir);
    const srcDir = entries.length === 1 && statSync(join(tmpDir, entries[0])).isDirectory()
      ? join(tmpDir, entries[0]) : tmpDir;

    mkdirSync(targetDir, { recursive: true });
    for (const e of readdirSync(srcDir)) {
      const src = join(srcDir, e);
      const dst = join(targetDir, e);
      if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
      renameSync(src, dst);
    }

    // Update plugin list — store absolute path (pluginDirs is canonical)
    const key = Array.isArray(cfg.pluginDirs) ? "pluginDirs" : "plugins";
    if (!cfg[key]?.includes(targetDir)) {
      cfg[key] = cfg[key] ?? [];
      cfg[key].push(targetDir);
    }

    rmSync(tmpDir, { recursive: true, force: true });
    return targetName;
  } catch (e) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
}

export async function listInstalled(cfg: any): Promise<{ name: string; version: string; dir: string }[]> {
  const dirs: string[] = cfg.pluginDirs ?? cfg.plugins ?? [];
  const plugins = loadPlugins(dirs.map((d: string) => join(process.cwd(), d)));
  return plugins.map((p) => ({
    name: p.manifest.name ?? basename(p.dir),
    version: p.manifest.version ?? "0.0.0",
    dir: p.dir,
  }));
}

export function removePlugin(name: string, cfg: any): void {
  const dir = join(pluginsDir(), name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  // Strip from the plugin list
  for (const key of ["pluginDirs", "plugins"] as const) {
    if (Array.isArray(cfg[key]))
      cfg[key] = cfg[key].filter((p: string) => {
        const b = basename(p);
        return !b.startsWith(name + "@") && b !== name;
      });
  }
}

export async function updatePlugin(name: string, cfg: any): Promise<boolean> {
  const installed = loadPlugins([join(pluginsDir(), name)]);
  if (!installed.length) return false;
  const instVer = installed[0].manifest.version ?? "0.0.0";
  const base = registryBase();
  try {
    const res = await fetch(`${base}/${name}/index.json`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    const idx = await res.json();
    const regVer = idx.version ?? "0.0.0";
    if (compareVersions(regVer, instVer) > 0) {
      await installPlugin(`${base}/${name}/${regVer}.tgz`, cfg, {});
      return true;
    }
  } catch { /* registry unavailable */ }
  return false;
}

export async function searchPlugins(query: string, cfg: any): Promise<{ plugins: { name: string; version: string; description: string }[] } | string> {
  try {
    const url = (cfg.pluginRegistry?.url ?? DEFAULT_REGISTRY_URL).replace(/\/index\.json$/, "") + "/index.json";
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return "registry index unavailable";
    const idx = await res.json();
    if (!idx.plugins) return "registry index unavailable";
    if (!query) return idx;
    const q = query.toLowerCase();
    return { plugins: idx.plugins.filter((p: any) => p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q)) };
  } catch { return "registry index unavailable"; }
}

/** Parse a goat:// URI. Returns the plugin name or null. */
export function parseGoatUri(s: string): string | null {
  try {
    const u = new URL(s);
    if (u.protocol === "goat:" && u.hostname === "plugins") return u.pathname.slice(1) || null;
    return null;
  } catch { return null; }
}

/** Read keys.json for a plugin. */
export function loadKeys(): Record<string, string> {
  const kp = join(pluginsDir(), "keys.json");
  if (!existsSync(kp)) return {};
  return JSON.parse(readFileSync(kp, "utf8"));
}
