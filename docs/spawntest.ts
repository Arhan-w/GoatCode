import { spawn } from "node:child_process";
const py = "python";
const script = "D:/GoatCode-ts/docs/.flashprobe-home/vendor/gemini-web2api/gemini_web2api.py";
const proc = spawn(py, ["-u", script, "--port", "8767"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
proc.stdout?.on("data", (d) => console.log("OUT:", d.toString().slice(0, 150)));
proc.stderr?.on("data", (d) => console.log("ERR:", d.toString().slice(0, 250)));
proc.on("exit", (c) => console.log("EXIT CODE:", c));
const t0 = Date.now();
for (let i = 0; i < 40; i++) {
  await Bun.sleep(250);
  try {
    const r = await fetch("http://127.0.0.1:8767/v1/models", { signal: AbortSignal.timeout(1500) });
    console.log("HEALTHY after", Date.now() - t0, "ms", r.status);
    break;
  } catch (e: any) { if (i === 39) console.log("NEVER HEALTHY", e?.message); }
}
proc.kill();
process.exit(0);
