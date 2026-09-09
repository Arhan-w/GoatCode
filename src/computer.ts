/**
 * Desktop control ("computer use") — GoatCode can see the screen and drive
 * real apps: open things, click, type, read windows, use the clipboard.
 *
 * Two backends, auto-detected:
 *  1. cua-driver (preferred) — the open-source accessibility driver daemon.
 *     Background input: clicks/types go to target windows WITHOUT stealing
 *     focus or moving the user's cursor.
 *  2. Native fallbacks — PowerShell SendInput + GDI (Windows),
 *     osascript + screencapture (macOS), xdotool + ImageMagick (Linux).
 *     Foreground input; works on any stock OS with zero installs.
 *
 * Every mutating action flows through the ToolKit permission system and
 * deny rules; a few hard-forbidden keys (lock, sign-out) are refused outright.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.ts";

const DRIVER_TIMEOUT_MS = 30_000;
const OS_TIMEOUT_MS = 20_000;

/** Key combos that must never be sent, whatever the model asks for. */
const FORBIDDEN_KEYS = [
  /^win\+l$/i, /^super\+l$/i, // lock workstation
  /^ctrl\+alt\+delete$/i,
  /^cmd\+option\+esc$/i, // force-quit panel
];

export interface Shot {
  png: Buffer;
  width: number;
  height: number;
}

function run(cmd: string, args: string[], timeoutMs: number, stdinData?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        done({ code: err ? ((err as any).killed ? -1 : 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
    if (stdinData !== undefined) child.stdin?.end(stdinData);
    else child.stdin?.end();
  });
}

// ---------- backend: cua-driver ----------

/** Normalize a cua-driver window row (new `bounds` shape or legacy flat x/y/w/h). */
function normWin(v: any): { pid: number; title: string; x: number; y: number; width: number; height: number; onScreen: boolean; minimized: boolean; z: number } {
  const b = v.bounds ?? v;
  return {
    pid: Number(v.pid ?? 0), title: String(v.title ?? ""),
    x: Number(b.x ?? 0), y: Number(b.y ?? 0),
    width: Number(b.width ?? 0), height: Number(b.height ?? 0),
    onScreen: v.is_on_screen !== false, minimized: v.minimized === true,
    z: Number(v.z_index ?? 0),
  };
}

class CuaDriver {
  constructor(private exe: string) {}

  async call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await run(this.exe, ["call", tool, JSON.stringify(args)], DRIVER_TIMEOUT_MS);
    if (r.code !== 0 || !r.stdout.trim())
      throw new Error(`cua-driver ${tool}: ${(r.stderr || r.stdout).slice(0, 300) || "no output"}`);
    try { return JSON.parse(r.stdout); } catch { return { text: r.stdout.slice(0, 4000) }; }
  }

  async available(): Promise<boolean> {
    try {
      const r = await this.call("get_screen_size");
      return Number(r.width ?? r.screen_width) > 0;
    } catch {
      return false;
    }
  }

  /** On-screen, unminimized, non-driver windows, front-most first. */
  private async realWindows(): Promise<ReturnType<typeof normWin>[]> {
    const w = await this.call("list_windows");
    const rows: any[] = w.windows ?? w._legacy_windows ?? [];
    return rows.map(normWin)
      .filter((v) => v.onScreen && !v.minimized && v.pid > 0 && !/cua\.agentcursor/i.test(v.title) && v.width < 10000)
      .sort((a, b) => b.z - a.z);
  }

  async shot(): Promise<Shot> {
    const d = await this.call("get_desktop_state");
    if (!d.screenshot_png_b64) throw new Error("cua-driver returned no pixels");
    return {
      png: Buffer.from(d.screenshot_png_b64, "base64"),
      width: Number(d.screen_width ?? d.screenshot_width ?? 0),
      height: Number(d.screen_height ?? d.screenshot_height ?? 0),
    };
  }

  async click(x: number, y: number, button: string, double: boolean, pid?: number): Promise<string> {
    const extra: Record<string, unknown> = pid ? { pid } : { scope: "desktop" };
    let kind: string;
    if (button === "right") kind = "right_click";
    else if (double) kind = "double_click";
    else kind = "click";
    if (kind === "click" && button !== "left") extra.button = button;
    const r = await this.call(kind, { x, y, ...extra });
    return `${kind} at (${x},${y}) → ${r.effect ?? "sent"}`;
  }

  /** Resolve a target pid (and window_id when the title pins one window) from args. */
  async targetPid(a: Record<string, any>): Promise<number> {
    return (await this.target(a)).pid;
  }

  /** pid + optional window_id chosen from `pid` and/or a window-title substring. */
  async target(a: Record<string, any>): Promise<{ pid: number; window_id?: number }> {
    const rows = await this.windowRows();
    if (a.pid) {
      const p = Number(a.pid);
      // an app with several windows is ambiguous for the driver — pin the
      // front-most visible one by window_id so input lands where it should
      const mine = rows.filter((v) => v.pid === p && v.onScreen && !v.minimized && v.window_id);
      if (mine.length === 1) return { pid: p, window_id: Number(mine[0].window_id) };
      if (mine.length > 1) {
        mine.sort((x, y) => y.z - x.z);
        return { pid: p, window_id: Number(mine[0].window_id) };
      }
      return { pid: p }; // let the driver route/ask
    }
    const title = String(a.window_title ?? a.title ?? "");
    if (title) {
      const hits = rows.filter((v) => v.title.toLowerCase().includes(title.toLowerCase()));
      if (hits.length === 1) return { pid: Number(hits[0].pid), window_id: Number(hits[0].window_id ?? undefined) };
      if (hits.length > 1)
        throw new Error(`${hits.length} visible windows match "${title}" — narrow the title or pass pid`);
      throw new Error(`no visible window matching "${title}" — check the windows action`);
    }
    throw new Error("type/key need a target: pass pid or window_title (see the windows action)");
  }

  private async windowRows(): Promise<any[]> {
    const w = await this.call("list_windows");
    return (w.windows ?? w._legacy_windows ?? []).map((v: any) => ({ ...normWin(v), window_id: v.window_id }));
  }

  async typeText(text: string, target: { pid: number; window_id?: number }): Promise<string> {
    const r = await this.call("type_text", { ...target, text });
    return `pid ${target.pid}: typed ${text.length} chars → ${r.effect ?? "sent"}`;
  }

  async key(combo: string, target: { pid?: number; window_id?: number } | null): Promise<string> {
    const parts = combo.toLowerCase().split(/[+\-]/).map((s) => s.trim()).filter(Boolean);
    const key = parts[parts.length - 1];
    const mods = new Set(parts.slice(0, -1).map((m) => (m === "cmd" || m === "super" || m === "win" ? "meta" : m)));
    const arg: Record<string, unknown> = { key, ctrl: mods.has("ctrl"), alt: mods.has("alt"), shift: mods.has("shift"), meta: mods.has("meta") };
    if (target?.pid) Object.assign(arg, target); else arg.scope = "desktop"; // desktop = current foreground app
    const r = await this.call("press_key", arg);
    return `${target?.pid ? `pid ${target.pid}: ` : ""}${combo} → ${r.effect ?? "sent"}`;
  }

  async scroll(x: number, y: number, dir: string, amount: number, target?: { pid?: number; window_id?: number } | null): Promise<string> {
    await this.call("scroll", { ...(target ?? {}), direction: dir, amount });
    return `scrolled ${dir} ${amount} at (${x},${y})`;
  }

  async launch(app: string): Promise<string> {
    const looksPath = /[\\/]/.test(app) || /\.(exe|app|msi)$/i.test(app);
    const r = await this.call("launch_app", looksPath ? { path: app } : { name: app });
    return r.pid ? `launched ${app} (pid ${r.pid})` : `launched ${app}`;
  }

  async windows(): Promise<string> {
    const w = await this.call("list_windows");
    const rows: any[] = w.windows ?? w._legacy_windows ?? [];
    return rows.map(normWin)
      .filter((v) => v.onScreen && v.pid > 0)
      .map((v) => `pid ${String(v.pid).padEnd(7)} ${String(v.x).padStart(5)},${String(v.y).padStart(5)} ${String(v.width).padStart(5)}x${String(v.height).padStart(5)}${v.minimized ? " [min]" : ""}  ${v.title.slice(0, 70)}`)
      .join("\n") || "(no visible windows)";
  }

  async clipboard(write?: string): Promise<string> {
    if (write === undefined) {
      const r = await this.call("clipboard_read", { include_text: true });
      return String(r.text ?? r.plain_text ?? "(empty)");
    }
    await this.call("clipboard_write", { text: write });
    return `clipboard set (${write.length} chars)`;
  }
}

// ---------- backend: native OS fallbacks ----------

/** PowerShell one-shot: SendInput mouse/keyboard + GDI screenshots. */
const PS_PRELUDE = `
$sig = @"
using System; using System.Runtime.InteropServices;
public static class Goat {
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P o);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);
  [StructLayout(LayoutKind.Sequential)] public struct M { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct K { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr info; }
  [StructLayout(LayoutKind.Explicit)] public struct I { [FieldOffset(0)] public uint type; [FieldOffset(8)] public M mi; [FieldOffset(8)] public K ki; }
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
}
"@; Add-Type -AssemblyName System.Windows.Forms,System.Drawing -ErrorAction SilentlyContinue; Add-Type $sig
function SI($inputs) { [Goat]::SendInput($inputs.Length, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][Goat+I])) | Out-Null }
function MI($f, $x=0, $y=0, $d=0) { $i=[Goat+I]::new(); $i.type=0; $i.mi.dx=$x; $i.mi.dy=$y; $i.mi.dwFlags=$f; $i.mi.mouseData=$d; ,$i }
function KI($vk, $up=$false) { $i=[Goat+I]::new(); $i.type=1; $i.ki.vk=$vk; if($up){$i.ki.flags=2}; $i }
function ClickAt($x,$y) { [Goat]::SetCursorPos($x,$y)|Out-Null; SI (MI 0x0002); SI (MI 0x0004) }
`;

function psVk(token: string): number | null {
  const t = token.toLowerCase();
  const named: Record<string, number> = {
    enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
    backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
    pageup: 0x21, prior: 0x21, pagedown: 0x22, next: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
    f5: 0x74, f11: 0x7a, f12: 0x7b, win: 0x5b, super: 0x5b, cmd: 0x5b,
  };
  if (named[t] !== undefined) return named[t];
  if (/^[a-z0-9]$/.test(t)) return t.toUpperCase().charCodeAt(0);
  return null;
}

class PowerShellBackend {
  private async ps(body: string): Promise<string> {
    const script = `$ProgressPreference='SilentlyContinue'; ${PS_PRELUDE}\n${body}`;
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], OS_TIMEOUT_MS);
    if (r.code !== 0) throw new Error(`powershell: ${(r.stderr || r.stdout).slice(0, 300)}`);
    return r.stdout.trim();
  }

  async available(): Promise<boolean> {
    try { await this.ps("Write-Output ok"); return true; } catch { return false; }
  }

  async shot(): Promise<Shot> {
    const tmp = join(tmpdir(), `goat-shot-${Date.now()}.png`);
    await this.ps(`
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
$bmp.Save('${tmp}', [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$($b.Width)x$($b.Height)"`);
    const png = readFileSync(tmp);
    try { unlinkSync(tmp); } catch { /* */ }
    const dims = await this.ps(`$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; "$($b.Width)x$($b.Height)"`);
    const [w, h] = dims.split("x").map(Number);
    return { png, width: w || 0, height: h || 0 };
  }

  async click(x: number, y: number, button: string, double: boolean): Promise<string> {
    if (button === "right")
      await this.ps(`[Goat]::SetCursorPos(${x},${y})|Out-Null; SI (MI 0x0008); SI (MI 0x0010)`);
    else {
      await this.ps(`ClickAt ${x} ${y}; if (${double ? 2 : 1} -eq 2) { Start-Sleep -Milliseconds 80; ClickAt ${x} ${y} }`);
    }
    return `${double ? "double-" : ""}${button}-click at (${x},${y})`;
  }

  async typeText(text: string): Promise<string> {
    // SendKeys meta-characters are hostile to raw text — clipboard+paste is the
    // reliable path for arbitrary content.
    return this.typeViaClipboard(text);
  }

  async key(combo: string): Promise<string> {
    const parts = combo.toLowerCase().split(/[+\-]/).map((s) => s.trim()).filter(Boolean);
    const main = psVk(parts[parts.length - 1]);
    if (main === null) throw new Error(`unknown key in combo: ${combo}`);
    const mods = new Set(parts.slice(0, -1));
    const modDefs: [string, number][] = [["ctrl", 0x11], ["alt", 0x12], ["shift", 0x10], ["win", 0x5b], ["super", 0x5b], ["cmd", 0x5b]];
    const held = modDefs.filter(([n]) => mods.has(n));
    let script = "";
    for (const [, vk] of held) script += `SI (KI ${vk}); `;
    script += `SI (KI ${main}); SI (KI ${main} $true); `;
    for (const [, vk] of held.slice().reverse()) script += `SI (KI ${vk} $true); `;
    await this.ps(script);
    return `sent ${combo}`;
  }

  async scroll(_x: number, y: number, dir: string, amount: number): Promise<string> {
    const d = dir === "down" || dir === "right" ? -1 : 1;
    await this.ps(`[Goat]::SetCursorPos(${_x},${y})|Out-Null; for($i=0;$i -lt ${amount};$i++){ [Goat]::mouse_event(0x0800,0,0,${d * 120},0); Start-Sleep -Milliseconds 30 }`);
    return `scrolled ${dir} ${amount}`;
  }

  async launch(app: string): Promise<string> {
    await this.ps(`Start-Process -FilePath '${app.replaceAll("'", "''")}'`);
    return `launched ${app}`;
  }

  async windows(): Promise<string> {
    const out = await this.ps(
      `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { "{0,-8} {1}" -f $_.Id, $_.MainWindowTitle }`);
    return out || "(no visible windows)";
  }

  async clipboard(write?: string): Promise<string> {
    if (write === undefined) return this.ps("Get-Clipboard");
    await this.ps(`Set-Clipboard -Value @'\n${write.replaceAll("'@@", "'@'@'@@")}\n'@`);
    return `clipboard set (${write.length} chars)`;
  }

  /** SendKeys meta-characters are brittle for raw text — clipboard+paste instead. */
  async typeViaClipboard(text: string): Promise<string> {
    await this.clipboard(text);
    await this.key("ctrl+v");
    return `pasted ${text.length} chars via clipboard`;
  }
}

class MacBackend {
  private async osa(script: string): Promise<string> {
    const r = await run("osascript", ["-e", script], OS_TIMEOUT_MS);
    if (r.code !== 0) throw new Error(`osascript: ${(r.stderr || r.stdout).slice(0, 300)}`);
    return r.stdout.trim();
  }
  async available(): Promise<boolean> { return process.platform === "darwin"; }
  async shot(): Promise<Shot> {
    const tmp = join(tmpdir(), `goat-shot-${Date.now()}.png`);
    await run("screencapture", ["-x", tmp], OS_TIMEOUT_MS);
    const png = readFileSync(tmp);
    return { png, width: 0, height: 0 };
  }
  async click(x: number, y: number): Promise<string> {
    const r = await run("cliclick", [`c:${x},${y}`], 5000);
    if (r.code !== 0) throw new Error("mouse clicks need `brew install cliclick` (or cua-driver) on macOS");
    return `click at (${x},${y})`;
  }
  async typeText(text: string): Promise<string> {
    // clipboard+paste: AppleScript keystroke chokes on non-ASCII and quoting
    const r = await run("pbcopy", [], 5000, text);
    if (r.code !== 0) throw new Error("pbcopy failed");
    await this.osa(`tell application "System Events" to keystroke "v" using command down`);
    return `pasted ${text.length} chars via clipboard`;
  }
  async key(combo: string): Promise<string> {
    const parts = combo.toLowerCase().split(/[+\-]/).map((s) => s.trim()).filter(Boolean);
    const main = parts.pop()!;
    const using = parts
      .map((p) => ({ ctrl: "control down", alt: "option down", shift: "shift down", cmd: "command down", super: "command down", win: "command down", meta: "command down" }[p] ?? ""))
      .filter(Boolean);
    const keyCode: Record<string, string> = {
      enter: "36", return: "36", tab: "48", esc: "53", escape: "53", space: "49",
      up: "126", down: "125", left: "123", right: "124", delete: "117", backspace: "51",
    };
    let script: string;
    if (keyCode[main])
      script = `key code ${keyCode[main]}${using.length ? ` using {${using.join(", ")}}` : ""}`;
    else if (main.length === 1)
      script = `keystroke "${main === '"' ? '\\"' : main}"${using.length ? ` using {${using.join(", ")}}` : ""}`;
    else throw new Error(`unknown key: ${main}`);
    await this.osa(`tell application "System Events" to ${script}`);
    return `sent ${combo}`;
  }
  async scroll(_x: number, _y: number, dir: string, amount: number): Promise<string> {
    const dy = dir === "down" ? amount : dir === "up" ? -amount : 0;
    const dx = dir === "right" ? amount : dir === "left" ? -amount : 0;
    if (!dx && !dy) throw new Error(`bad scroll direction: ${dir}`);
    throw new Error("macOS scrolling needs cliclick or cua-driver installed");
  }
  async launch(app: string): Promise<string> {
    await run("open", ["-a", app], 10_000);
    return `launched ${app}`;
  }
  async windows(): Promise<string> {
    return this.osa(`tell application "System Events" to get name of (processes where background only is false)`);
  }
  async clipboard(write?: string): Promise<string> {
    if (write === undefined) return (await run("pbpaste", [], 5000)).stdout;
    const r = await run("pbcopy", [], 5000, write);
    if (r.code !== 0) throw new Error("pbcopy failed");
    return `clipboard set (${write.length} chars)`;
  }
}

class XdotoolBackend {
  async available(): Promise<boolean> { return (await run("which", ["xdotool"], 5000)).code === 0; }
  private async x(args: string[]): Promise<string> {
    const r = await run("xdotool", args, OS_TIMEOUT_MS);
    if (r.code !== 0) throw new Error(`xdotool: ${(r.stderr || r.stdout).slice(0, 300)}`);
    return r.stdout.trim();
  }
  async shot(): Promise<Shot> {
    const tmp = join(tmpdir(), `goat-shot-${Date.now()}.png`);
    let r = await run("gnome-screenshot", ["-f", tmp], OS_TIMEOUT_MS);
    if (r.code !== 0) r = await run("import", ["-window", "root", tmp], OS_TIMEOUT_MS);
    if (r.code !== 0) r = await run("scrot", [tmp], OS_TIMEOUT_MS);
    if (r.code !== 0) throw new Error("no screenshot tool found (gnome-screenshot/import/scrot)");
    return { png: readFileSync(tmp), width: 0, height: 0 };
  }
  async click(x: number, y: number, button: string): Promise<string> {
    const b = button === "right" ? "3" : button === "middle" ? "2" : "1";
    await this.x(["mousemove", String(x), String(y), "click", b]);
    return `${button}-click at (${x},${y})`;
  }
  async typeText(text: string): Promise<string> {
    await this.x(["type", "--clearmodifiers", text]);
    return `typed ${text.length} chars`;
  }
  async key(combo: string): Promise<string> {
    await this.x(["key", combo.toLowerCase().replace(/[+\-]/g, "+")]);
    return `sent ${combo}`;
  }
  async scroll(_x: number, y: number, dir: string, amount: number): Promise<string> {
    const btn = { up: "4", down: "5", left: "6", right: "7" }[dir] ?? "4";
    await this.x(["mousemove", String(_x), String(y), "click", "--repeat", String(amount), "--delay", "40", btn]);
    return `scrolled ${dir} ${amount}`;
  }
  async launch(app: string): Promise<string> {
    await run(app, [], 3000).catch(() => { /* detached-ish */ });
    return `launched ${app}`;
  }
  async windows(): Promise<string> {
    const ids = await this.x(["search", "--onlyvisible", "--name", ""]);
    return ids || "(no visible windows)";
  }
  async clipboard(write?: string): Promise<string> {
    if (write === undefined) return (await run("xclip", ["-selection", "clipboard", "-o"], 5000)).stdout;
    const r = await run("xclip", ["-selection", "clipboard"], 5000, write);
    if (r.code !== 0) throw new Error("xclip not available");
    return `clipboard set (${write.length} chars)`;
  }
}

// ---------- facade ----------

export type DesktopBackend = "cua-driver" | "powershell" | "osascript" | "xdotool" | "none";

export class Desktop {
  private driver: CuaDriver | null = null;
  private ps: PowerShellBackend | null = null;
  private mac: MacBackend | null = null;
  private x11: XdotoolBackend | null = null;
  backend: DesktopBackend = "none";
  private detecting: Promise<void> | null = null;

  /** Lazy backend detection (runs once; cheap calls only). */
  async detect(): Promise<DesktopBackend> {
    if (this.backend === "none" && !this.detecting) this.detecting = this._detect();
    await this.detecting;
    return this.backend;
  }

  private async _detect(): Promise<void> {
    if (process.platform === "win32") {
      const exe = findCuaDriver();
      if (exe) {
        const d = new CuaDriver(exe);
        if (await d.available().catch(() => false)) { this.driver = d; this.backend = "cua-driver"; log("desktop", "backend: cua-driver"); return; }
      }
      this.ps = new PowerShellBackend();
      this.backend = "powershell";
      log("desktop", "backend: powershell (SendInput)");
    } else if (process.platform === "darwin") {
      const exe = findCuaDriver();
      if (exe) {
        const d = new CuaDriver(exe);
        if (await d.available().catch(() => false)) { this.driver = d; this.backend = "cua-driver"; return; }
      }
      this.mac = new MacBackend();
      this.backend = "osascript";
    } else {
      const exe = findCuaDriver();
      if (exe) {
        const d = new CuaDriver(exe);
        if (await d.available().catch(() => false)) { this.driver = d; this.backend = "cua-driver"; return; }
      }
      this.x11 = new XdotoolBackend();
      this.backend = (await this.x11.available().catch(() => false)) ? "xdotool" : "none";
    }
  }

  async screenshot(outPath: string): Promise<Shot> {
    const b = await this.detect();
    const shot = b === "cua-driver" ? await this.driver!.shot()
      : b === "powershell" ? await this.ps!.shot()
      : b === "osascript" ? await this.mac!.shot()
      : await this.x11!.shot();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, shot.png);
    return shot;
  }

  async act(action: string, a: Record<string, any>): Promise<string> {
    const b = await this.detect();
    const d = this.driver, ps = this.ps, mac = this.mac, x11 = this.x11;
    switch (action) {
      case "click":
      case "double_click":
      case "right_click": {
        const x = Number(a.x), y = Number(a.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${action} needs numeric x,y in screenshot pixels`);
        if (b === "cua-driver") return d!.click(x, y, action === "right_click" ? "right" : "left", action === "double_click", a.pid ? Number(a.pid) : undefined);
        if (b === "powershell") return ps!.click(x, y, action === "right_click" ? "right" : "left", action === "double_click");
        if (b === "osascript") return mac!.click(x, y);
        return x11!.click(x, y, action === "right_click" ? "right" : "left");
      }
      case "type": {
        const text = String(a.text ?? "");
        if (!text) throw new Error("type needs text");
        if (b === "cua-driver") return d!.typeText(text, await d!.target(a));
        if (b === "powershell") return ps!.typeText(text);
        if (b === "osascript") return mac!.typeText(text);
        return x11!.typeText(text);
      }
      case "key": {
        const combo = String(a.combo ?? a.key ?? "");
        if (FORBIDDEN_KEYS.some((re) => re.test(combo.replace(/\s/g, "+"))))
          throw new Error(`refused: ${combo} is on the never-send list (system lock / sign-out)`);
        if (b === "cua-driver") {
          const t = a.pid || a.window_title ? await d!.target(a) : null;
          return d!.key(combo, t);
        }
        if (b === "powershell") return ps!.key(combo);
        if (b === "osascript") return mac!.key(combo);
        return x11!.key(combo);
      }
      case "scroll": {
        const x = Number(a.x ?? 0), y = Number(a.y ?? 0);
        const dir = ["up", "down", "left", "right"].includes(a.direction) ? a.direction : "down";
        const amount = Math.min(20, Math.max(1, Number(a.amount ?? 3)));
        if (b === "cua-driver")
          return d!.scroll(x, y, dir, amount, a.pid || a.window_title ? await d!.target(a) : null);
        if (b === "powershell") return ps!.scroll(x, y, dir, amount);
        if (b === "osascript") return mac!.scroll(x, y, dir, amount);
        return x11!.scroll(x, y, dir, amount);
      }
      case "launch": {
        const app = String(a.app ?? "");
        if (!app) throw new Error("launch needs app name or path");
        if (b === "cua-driver") return d!.launch(app);
        if (b === "powershell") return ps!.launch(app);
        if (b === "osascript") return mac!.launch(app);
        return x11!.launch(app);
      }
      case "windows": {
        if (b === "cua-driver") return d!.windows();
        if (b === "powershell") return ps!.windows();
        if (b === "osascript") return mac!.windows();
        return x11!.windows();
      }
      case "clipboard": {
        const write = a.text === undefined ? undefined : String(a.text);
        if (b === "cua-driver") return d!.clipboard(write);
        if (b === "powershell") return ps!.clipboard(write);
        if (b === "osascript") return mac!.clipboard(write);
        return x11!.clipboard(write);
      }
      default:
        throw new Error(`unknown desktop action: ${action}`);
    }
  }
}

/** Locate cua-driver.exe / cua-driver on PATH or the known install dir. */
export function findCuaDriver(): string | null {
  const names = process.platform === "win32" ? ["cua-driver.exe", "cua-driver"] : ["cua-driver"];
  const dirs = [
    process.env.CUA_DRIVER_PATH,
    join(homedir(), ".cua-driver", "bin"),
    join(homedir(), ".local", "bin"),
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? "", "Programs", "Cua", "cua-driver", "bin")
      : "/usr/local/bin",
  ].filter(Boolean) as string[];
  for (const n of names)
    for (const d of dirs) {
      const p = join(d, n);
      if (existsSync(p)) return p;
    }
  return null;
}

export const desktop = new Desktop();

// ---------- clipboard image (Ctrl+V in the TUI) ----------

/**
 * Grab an image from the system clipboard, save as PNG, return the path.
 * null when the clipboard holds no image. Per-OS native tools; no deps.
 */
export async function clipboardImage(): Promise<string | null> {
  const tmp = join(tmpdir(), `goat-paste-${Date.now()}.png`);
  if (process.platform === "win32") {
    const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing -ErrorAction SilentlyContinue
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) { $img.Save('${tmp.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output ok }`;
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], OS_TIMEOUT_MS);
    if (r.code === 0 && r.stdout.trim() === "ok" && existsSync(tmp)) return tmp;
    return null;
  }
  if (process.platform === "darwin") {
    // try PNG directly, else TIFF -> sips convert
    const png = await run("osascript", ["-e",
      `set f to open for access POSIX file "${tmp}" with write permission
try
  write (the clipboard as «class PNGf») to f
end try
close access f`], OS_TIMEOUT_MS);
    if (png.code === 0 && existsSync(tmp)) return tmp;
    const tiff = tmp.replace(/\.png$/, ".tiff");
    const t = await run("osascript", ["-e",
      `set f to open for access POSIX file "${tiff}" with write permission
try
  write (the clipboard as «class TIFF») to f
end try
close access f`], OS_TIMEOUT_MS);
    if (t.code === 0 && existsSync(tiff)) {
      await run("sips", ["-s", "format", "png", tiff, "--out", tmp], OS_TIMEOUT_MS);
      try { unlinkSync(tiff); } catch { /* */ }
      if (existsSync(tmp)) return tmp;
    }
    return null;
  }
  // Linux: Wayland then X11 (shell redirect keeps the bytes binary-safe)
  const sh = (cmd: string) => run("bash", ["-c", `${cmd} > ${tmp} 2>/dev/null`], 5000);
  if ((await sh("wl-paste --type image/png")).code === 0 && existsSync(tmp) && statSync(tmp).size > 0) return tmp;
  if ((await sh("xclip -t image/png -selection clipboard -o")).code === 0 && existsSync(tmp) && statSync(tmp).size > 0) return tmp;
  try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* */ }
  return null;
}
