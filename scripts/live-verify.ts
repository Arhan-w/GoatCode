import { ToolKit } from "../src/tools.ts";
import { desktop } from "../src/computer.ts";

const tk = new ToolKit(process.cwd(), { autoApprove: true });

// 1. desktop backend + real screenshot
const backend = await desktop.detect();
console.log("backend:", backend);
const shot = await tk.dispatch("screenshot", { path: ".goat/verify-shot.png" });
console.log("screenshot:", shot.ok, shot.output.slice(0, 120));
if (shot.content) console.log("attached image part:", shot.content[1]?.type, shot.content[1]?.mediaType, "b64 len", (shot.content[1] as any)?.data?.length);

// 2. windows listing
const wins = await tk.dispatch("computer", { action: "windows" });
console.log("windows:", wins.ok, wins.output.split("\n").slice(0, 3).join(" | ").slice(0, 200));

// 3. clipboard round-trip
const cb = await tk.dispatch("computer", { action: "clipboard", text: "goat-verify-" + Date.now() });
const cb2 = await tk.dispatch("computer", { action: "clipboard" });
console.log("clipboard write:", cb.ok, "| read back:", cb2.output.slice(0, 40));

// 4. forbidden key refused
const lock = await tk.dispatch("computer", { action: "key", combo: "win+l" });
console.log("win+l refused:", !lock.ok, "|", lock.output.slice(0, 80));

// 5. live websearch
const s = await tk.dispatch("websearch", { query: "bun javascript runtime", max_results: 3 });
console.log("websearch:", s.ok, s.output.slice(0, 220).replace(/\n/g, " ⏎ "));
