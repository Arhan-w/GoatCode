/**
 * GoatCode build — bundles to a single JS file, then compiles
 * to a standalone binary via bun build (like Claude Code).
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outdir = "dist";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir,
  target: "bun",
  splitting: true,
  minify: false,
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`build: ${outdir}/`);

// Generate the standalone CLI runner
const runner = `#!/usr/bin/env bun
import "./${outdir}/cli.js";
`;
writeFileSync(join(outdir, "cli.js"), runner);
