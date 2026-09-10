/**
 * Update checks + self-update.
 *
 * `goat self-update` downloads the standalone binary for this platform from
 * the GitHub release matching (or newer than) the running version and
 * swaps it in atomically. `goat --version` style checks are cheap and cached
 * so the TUI can show a one-line "update available" hint without hammering
 * the API.
 */
import { chmodSync, createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { get } from "node:https";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDir } from "./config.ts";
import { REPO_SLUG, VERSION } from "./constants.ts";
import { log } from "./logger.ts";

export const UPDATE_CHECK_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
export const CHECK_CACHE_MS = 6 * 60 * 60 * 1000; // re-check at most every 6h
const FETCH_TIMEOUT_MS = 8_000;

export interface LatestRelease {
  tag: string;        // "v2.2.0"
  version: string;    // "2.2.0"
  url: string;        // release page
  assets: { name: string; url: string }[];
}

export function parseVer(v: string): number[] {
  return (v.replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n) || 0));
}

/** true when `a` is older than `b` (numeric semver compare, missing parts = 0). */
export function versionLess(a: string, b: string): boolean {
  const pa = parseVer(a), pb = parseVer(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

export function assetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const osMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archMap: Record<string, string> = { x64: "x64", arm64: "arm64" };
  const os = osMap[platform], a = archMap[arch];
  if (!os || !a) return null;
  return `goat-${os}-${a}${os === "windows" ? ".exe" : ""}`;
}

function httpsJson(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { "user-agent": `goatcode/${VERSION}`, accept: "application/json" } }, (res) => {
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 && res.headers.location) {
        res.resume();
        httpsJson(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("timeout")); });
  });
}

export async function latestRelease(): Promise<LatestRelease> {
  const j = await httpsJson(UPDATE_CHECK_URL);
  const tag = String(j.tag_name ?? "");
  return {
    tag,
    version: tag.replace(/^v/, ""),
    url: String(j.html_url ?? `https://github.com/${REPO_SLUG}/releases`),
    assets: (j.assets ?? []).map((a: any) => ({ name: String(a.name), url: String(a.browser_download_url) })),
  };
}

/** Quick check: newer version available? Returns the release or null. */
export async function checkForUpdate(current = VERSION): Promise<LatestRelease | null> {
  try {
    const rel = await latestRelease();
    return versionLess(current, rel.version) ? rel : null;
  } catch (e: any) {
    log("update", `check failed: ${e?.message ?? e}`);
    return null;
  }
}

// ---------- cached hint (TUI boot) ----------

function hintPath(): string { return join(appDir(), "update-check.json"); }

export interface UpdateHint { latest: string; checkedAt: number; shownFor?: string }

/** Read the cached hint; undefined when stale/absent/same-version. */
export function cachedUpdateHint(current = VERSION): UpdateHint | undefined {
  try {
    const h = JSON.parse(readFileSync(hintPath(), "utf8")) as UpdateHint;
    if (!h?.latest || !versionLess(current, h.latest)) return undefined;
    return h;
  } catch { return undefined; }
}

/** Refresh the cache in the background (fire-and-forget from the TUI). */
export function refreshUpdateHint(current = VERSION): void {
  if (["1", "true", "yes"].includes(String(process.env.GOAT_NO_UPDATE_CHECK ?? "").toLowerCase())) return;
  let raw: { checkedAt?: number } | null = null;
  try { raw = JSON.parse(readFileSync(hintPath(), "utf8")); } catch { /* first run */ }
  if (raw && Date.now() - (raw.checkedAt ?? 0) < CHECK_CACHE_MS) return;
  void checkForUpdate(current).then((rel) => {
    try {
      writeFileSync(hintPath(), JSON.stringify({
        latest: rel?.version ?? current, checkedAt: Date.now(),
      }), "utf8");
    } catch { /* best effort */ }
  });
}

// ---------- download + swap ----------

function download(url: string, dest: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const req = get(url, { headers: { "user-agent": `goatcode/${VERSION}` } }, (res) => {
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 && res.headers.location) {
        res.resume();
        file.close();
        download(new URL(res.headers.location, url).toString(), dest, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { file.close(); rmSync(dest, { force: true }); return reject(new Error(`HTTP ${res.statusCode}`)); }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    });
    req.on("error", (e) => { file.close(); rmSync(dest, { force: true }); reject(e); });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("download timed out")); });
  });
}

/** Where the running executable lives (compiled binary path, or the shim). */
export function currentBinaryPath(): string | null {
  // Bun compiled binaries expose the executable itself; `bun run src/...` does not.
  try {
    const self = process.execPath;
    if (self && existsSync(self) && !/[\\/]bun(\.exe)?$/i.test(self)) return self;
    // also accept the case where we were launched AS goat.exe via PATH
    const argv0 = process.argv[0];
    if (argv0 && existsSync(argv0) && !/[\\/]bun(\.exe)?$/i.test(argv0)) return argv0;
  } catch { /* */ }
  return null;
}

export interface UpdateResult { ok: boolean; from: string; to: string; path?: string; message: string }

/**
 * Self-update: download the release binary for this platform, verify size +
 * `--version`, then swap it in over the current executable (rename dance
 * handles Windows "file in use" via a .old suffix).
 */
export async function selfUpdate(logf: (s: string) => void = (s) => log("update", s)): Promise<UpdateResult> {
  const target = assetName();
  if (!target)
    return { ok: false, from: VERSION, to: "?", message: `no release binary for ${process.platform}/${process.arch}` };
  let rel: LatestRelease;
  try {
    rel = await latestRelease();
  } catch (e: any) {
    return { ok: false, from: VERSION, to: "?", message: `release lookup failed: ${e?.message ?? e}` };
  }
  if (!versionLess(VERSION, rel.version))
    return { ok: true, from: VERSION, to: VERSION, message: `already on the latest version (${VERSION})` };
  const asset = rel.assets.find((a) => a.name === target);
  if (!asset) return { ok: false, from: VERSION, to: rel.version, message: `release ${rel.tag} has no ${target}` };

  const tmp = join(tmpdir(), `goat-update-${Date.now()}.bin`);
  logf(`downloading ${target} (${rel.tag})…`);
  try {
    await download(asset.url, tmp);
  } catch (e: any) {
    rmSync(tmp, { force: true });
    return { ok: false, from: VERSION, to: rel.version, message: `download failed: ${e?.message ?? e}` };
  }
  const size = statSync(tmp).size;
  if (size < 10_000_000) {
    rmSync(tmp, { force: true });
    return { ok: false, from: VERSION, to: rel.version, message: `downloaded file looks wrong (${size} bytes) — aborted` };
  }
  // verify the fresh binary actually runs and reports the new version
  try { chmodx(tmp); } catch { /* */ }
  const probe = spawnSync(tmp, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  const out = String(probe.stdout ?? "").trim();
  if (probe.status !== 0 || !out.includes(rel.version)) {
    rmSync(tmp, { force: true });
    return { ok: false, from: VERSION, to: rel.version, message: `new binary failed its --version probe (${out || probe.status}) — aborted, nothing replaced` };
  }

  const cur = currentBinaryPath();
  if (!cur) {
    // running from `bun run` — nothing to overwrite; install to ~/.goatcode/bin
    const dest = join(appDir(), "bin");
    mkdirSync(dest, { recursive: true });
    const final = join(dest, process.platform === "win32" ? "goat.exe" : "goat");
    try { if (existsSync(final)) unlinkSync(final); } catch { /* */ }
    renameSync(tmp, final);
    chmodx(final);
    return { ok: true, from: VERSION, to: rel.version, path: final, message: `installed ${rel.tag} → ${final}\n  add it to PATH or re-run the installer` };
  }
  try {
    if (process.platform === "win32") {
      // Windows allows renaming a running exe but not overwriting it
      const old = cur + ".old";
      try { if (existsSync(old)) unlinkSync(old); } catch { /* */ }
      renameSync(cur, old);
    } else {
      try { unlinkSync(cur); } catch { /* */ }
    }
    renameSync(tmp, cur);
    chmodx(cur);
  } catch (e: any) {
    rmSync(tmp, { force: true });
    return { ok: false, from: VERSION, to: rel.version, message: `swap failed: ${e?.message ?? e} — downloaded binary kept at ${tmp}` };
  }
  return { ok: true, from: VERSION, to: rel.version, path: cur, message: `updated ${VERSION} → ${rel.version} at ${cur}` };
}

function chmodx(p: string): void {
  try { chmodSync(p, 0o755); } catch { /* windows ignores exec bits */ }
}


