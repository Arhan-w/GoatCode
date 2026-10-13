/**
 * GoatCode build — bundles src/index.ts into dist/ (with code splitting),
 * then writes a thin `cli.js` runner that re-exports the bundle entrypoint.
 * `bun run build.ts && bun dist/cli.js --version` is the smoke test.
 */
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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

// Bun names the entry chunk after the entrypoint (index.js). A separate
// runner file can't just `import` it — import.meta.main is false for
// imported modules, so main() never runs. Compile the entry directly
// instead: `bun dist/index.js` IS the runnable CLI (import.meta.main true).
const entry = join(outdir, "index.js");
if (!existsSync(entry)) {
  console.error("build: expected dist/index.js (Bun entry chunk) — aborting");
  process.exit(1);
}
writeFileSync(join(outdir, "cli.js"), `#!/usr/bin/env bun\nimport "./index.js";\n`);
console.log("build: dist/index.js is the runnable bundle (bun dist/index.js)");
