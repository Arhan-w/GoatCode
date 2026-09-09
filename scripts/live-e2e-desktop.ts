import { ToolKit } from "../src/tools.ts";
import { spawnSync } from "node:child_process";

const tk = new ToolKit(process.cwd(), { autoApprove: true });

const launch = await tk.dispatch("computer", { action: "launch", app: "notepad" });
console.log("launch:", launch.ok, launch.output);
await Bun.sleep(3000);

const wins = await tk.dispatch("computer", { action: "windows" });
console.log("windows has notepad:", /notepad/i.test(wins.output));
const pid = Number((wins.output.match(/pid (\d+)[^\n]*Notepad/i)?.[1] ?? 0));
console.log("notepad pid:", pid);

const typed = await tk.dispatch("computer", { action: "type", text: "Grazie!", pid: pid || undefined });
console.log("type:", typed.ok, typed.output.slice(0, 120));

const winShot = spawnSync("powershell", ["-NoProfile", "-Command",
  `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size)
$bmp.Save("$env:TEMP\goat-e2e-after.png",[System.Drawing.Imaging.ImageFormat]::Png)`]);
const png = readFileSyncSafe("C:/Users/Arhan/AppData/Local/Temp/goat-e2e-after.png");
console.log("post-type screenshot bytes:", png ?? "n/a");

if (pid) {
  const close = await tk.dispatch("computer", { action: "key", combo: "alt+F4", pid });
  console.log("close:", close.ok, close.output.slice(0, 100));
}
function readFileSyncSafe(p: string): string | number {
  try { return require("node:fs").readFileSync(p).length; } catch { return -1; }
}
