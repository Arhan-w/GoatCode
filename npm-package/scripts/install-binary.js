#!/usr/bin/env node
/*
 * GoatCode binary installer (runs as npm postinstall; also importable by the
 * launcher for self-heal). Downloads the standalone binary for this platform
 * from GitHub releases into goatcode/bin/goat(.exe).
 *
 * Never fails the install: a network hiccup here just means the launcher
 * re-tries on first run.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const REPO = "Arhan-w/GoatCode";
const VERSION = require("../../package.json").version; // keep in lock-step with releases
const PKG_BIN = path.join(__dirname, "..", "..", "bin");

function assetName() {
  const osMap = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archMap = { x64: "x64", arm64: "arm64" };
  const os = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) return null;
  // Release assets are named goat-<os>-<arch>[.exe] — e.g. goat-windows-x64.exe,
  // goat-darwin-arm64, goat-linux-x64 (see .github/workflows/release.yml).
  return `goat-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}

/** Alternate asset name tried when the primary is missing (legacy releases). */
function assetNameFallback() {
  if (process.platform === "win32") return "goat.exe";
  return null;
}

/** Name of the -ide archive that bundles the vendored Monaco assets.
 *  Windows ships .zip (Compress-Archive); unix ships .tar.gz. */
function ideArchiveName() {
  const osMap = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archMap = { x64: "x64", arm64: "arm64" };
  const os = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) return null;
  if (os === "windows") return `goat-${os}-${arch}-ide.zip`;
  return `goat-${os}-${arch}-ide.tar.gz`;
}

/** Where `goat ide` looks for the vendored Monaco assets (ide/server.ts). */
function ideVendorPath() {
  const base = process.env.GOATCODE_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".goatcode");
  return path.join(base, "ide-vendor");
}

function targetPath() {
  return path.join(PKG_BIN, process.platform === "win32" ? "goat.exe" : "goat");
}

function get(url, redirects, file, done) {
  https.get(url, { headers: { "User-Agent": "goatcode-npm" } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
      res.resume();
      return get(new URL(res.headers.location, url).toString(), redirects - 1, file, done);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return done(new Error(`HTTP ${res.statusCode}`));
    }
    const out = fs.createWriteStream(file);
    res.pipe(out);
    out.on("finish", () => out.close(() => done(null)));
    out.on("error", done);
  }).on("error", done);
}

function install(cb) {
  const name = assetName();
  if (!name) return cb(new Error(`unsupported platform ${process.platform}/${process.arch}`));
  fs.mkdirSync(PKG_BIN, { recursive: true });
  const target = targetPath();
  const part = target + ".download";
  const archive = ideArchiveName();
  const archivePart = path.join(PKG_BIN, (archive || "ide.tar.gz") + ".download");
  const urls = [
    `https://github.com/${REPO}/releases/download/v${VERSION}/${name}`,
    ...(assetNameFallback()
      ? [`https://github.com/${REPO}/releases/download/v${VERSION}/${assetNameFallback()}`]
      : []),
    `https://github.com/${REPO}/releases/latest/download/${name}`,
  ];
  (function next(i) {
    if (i >= urls.length) return cb(new Error("all download URLs failed"));
    get(urls[i], 5, part, (err) => {
      if (!err) {
        try {
          // sanity: real binaries are ~90 MB; anything small is an error page
          if (fs.statSync(part).size < 1_000_000) throw new Error("downloaded file too small");
          fs.renameSync(part, target);
          fs.chmodSync(target, 0o755);
          // best-effort: fetch the -ide archive for the vendored Monaco assets.
          // Failure here only means `goat ide` 404s its editor assets until
          // the next install; the agent + TUI are unaffected.
          if (archive) {
            get(`https://github.com/${REPO}/releases/download/v${VERSION}/${archive}`, 3, archivePart, (aerr) => {
              if (aerr) return cb(null, target);
              try {
                if (fs.statSync(archivePart).size < 100_000) throw new Error("ide archive too small");
                const { execFileSync } = require("child_process");
                const stage = path.join(PKG_BIN, ".ide-stage");
                fs.rmSync(stage, { recursive: true, force: true });
                fs.mkdirSync(stage, { recursive: true });
                if (archive.endsWith(".zip")) {
                  // bsdtar (bundled with Windows 10+/macOS) extracts zip; fall
                  // back to PowerShell Expand-Archive when tar can't.
                  try {
                    execFileSync("tar", ["-xf", archivePart, "-C", stage], { stdio: "ignore" });
                  } catch {
                    execFileSync("powershell", [
                      "-NoProfile", "-NonInteractive", "-Command",
                      `Expand-Archive -LiteralPath '${archivePart}' -DestinationPath '${stage}' -Force`,
                    ], { stdio: "ignore" });
                  }
                } else {
                  execFileSync("tar", ["-xzf", archivePart, "-C", stage], { stdio: "ignore" });
                }
                const src = path.join(stage, "ide-vendor");
                if (fs.existsSync(src)) {
                  const dest = ideVendorPath();
                  fs.rmSync(dest, { recursive: true, force: true });
                  fs.mkdirSync(path.dirname(dest), { recursive: true });
                  fs.renameSync(src, dest);
                }
                fs.rmSync(stage, { recursive: true, force: true });
              } catch { /* non-fatal */ }
              try { fs.rmSync(archivePart, { force: true }); } catch { /* */ }
              cb(null, target);
            });
          } else {
            cb(null, target);
          }
          return;
        } catch (e) { err = e; }
      }
      try { fs.rmSync(part, { force: true }); } catch { /* */ }
      next(i + 1);
    });
  })(0);
}

if (require.main === module) {
  install((err, target) => {
    if (err) {
      // intentionally quiet-ish: the launcher retries on first run
      console.log(`[goatcode] binary download skipped (${err.message}) — will retry on first run`);
      process.exit(0);
    }
    console.log(`[goatcode] installed ${path.basename(target)}`);
  });
}

module.exports = { install, assetName, assetNameFallback, ideArchiveName, targetPath };
