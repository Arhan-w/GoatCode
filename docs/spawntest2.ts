import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
const py = "python";
const script = "D:/GoatCode-ts/docs/.flashprobe-home/vendor/gemini-web2api/gemini_web2api.py";
// replicate gflash.ts exactly: stdio ignore, cwd tmpdir, windowsHide
const proc = spawn(py, ["-u", script, "--port", "8768"], {
  cwd: tmpdir(), stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
});
proc.on("exit", (c) => console.log("EXIT CODE:", c));
const t0 = Date.now();
for (let i = 0; i < 40; i++) {
  await Bun.sleep(250);
  try {
    const r = await fetch("http://127.0.0.1:8768/v1/models", { signal: AbortSignal.timeout(1500) });
    console.log("HEALTHY after", Date.now() - t0, "ms", r.status); break;
  } catch (e: any) { if (i === 39) console.log("NEVER HEALTHY after", Date.now() - t0, "ms"); }
}
proc.kill();
process.exit(0);
