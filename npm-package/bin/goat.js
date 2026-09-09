#!/usr/bin/env node
/*
 * `goat` launcher. Runs the platform binary installed by postinstall; if the
 * binary is missing (offline install, skipped scripts), it downloads once,
 * then proceeds. Transparent stdin/stdout — full interactive TUI works.
 */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { install, targetPath } = require("../scripts/install-binary.js");

function runBinary() {
  const bin = targetPath();
  if (!fs.existsSync(bin)) return null;
  const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit", windowsHide: true });
  if (r.error) {
    console.error(`[goatcode-cli] failed to run ${bin}: ${r.error.message}`);
    process.exit(1);
  }
  return r.status === null ? 1 : r.status;
}

function main(retryDownload) {
  const code = runBinary();
  if (code !== null) process.exit(code);

  if (!retryDownload) {
    console.error("[goatcode-cli] binary missing and no download allowed — reinstall: npm i -g goatcode-cli");
    process.exit(1);
  }
  process.stderr.write("[goatcode-cli] first run: fetching the GoatCode binary...\n");
  install((err) => {
    if (err) {
      console.error(`[goatcode-cli] download failed: ${err.message}`);
      console.error("[goatcode-cli] manual install: see https://github.com/Arhan-w/GoatCode#install");
      process.exit(1);
    }
    const code = runBinary();
    process.exit(code === null ? 1 : code);
  });
}

// GOATCODE_NO_DOWNLOAD=1 makes a missing binary a hard error (CI/hermetic use)
main(!process.env.GOATCODE_NO_DOWNLOAD);
