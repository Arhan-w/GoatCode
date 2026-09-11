/**
 * User-message builders shared by the TUI and the web UI:
 * @file / @dir / @image expansion. No React — the `push` callback takes
 * plain strings now; the TUI wraps them into its own nodes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { MAX_IMAGE_BYTES, SKIP_DIRS, sniffImage } from "./tools.ts";

/**
 * Project files for @-mention completion: relative POSIX paths, SKIP_DIRS
 * honored, capped. Directories appear with a trailing "/" so Tab can descend.
 */
export function listProjectFiles(cwd: string, limit = 2000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const abs = join(dir, e.name);
      const rel = relative(cwd, abs).replaceAll("\\", "/");
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        out.push(rel + "/");
        walk(abs);
      } else out.push(rel);
    }
  };
  walk(cwd);
  return out.sort();
}

/** Completion candidates for an @token (the text after "@", may contain "/"). */
export function atCompletions(token: string, files: string[], cap = 8): string[] {
  const t = token.toLowerCase();
  const hits = files.filter((f) => f.toLowerCase().startsWith(t));
  // if the token has no slash, also match basenames (src/tui -> tui.tsx under src)
  const extra = t.includes("/") ? [] : files.filter(
    (f) => !f.toLowerCase().startsWith(t) && (f.split("/").pop() ?? "").toLowerCase().startsWith(t));
  return [...hits, ...extra].slice(0, cap);
}
import type { ContentPart } from "./llm.ts";

/** Replace @path tokens with fenced file contents (sandboxed to cwd). */
export function expandFileRefs(text: string, cwd: string, warn?: (msg: string) => void): string {
  return text.replace(/(^|\s)@([^\s@]+)/g, (_all, pre: string, ref: string) => {
    if (/\.(png|jpe?g|gif|webp)$/i.test(ref)) return `${pre}@${ref}`; // handled by buildUserContent
    try {
      const abs = resolvePath(cwd, ref);
      const rel = relative(cwd, abs);
      if (rel === "" || rel.startsWith("..")) return `${pre}@${ref}`; // outside root — leave as-is
      if (!existsSync(abs)) { warn?.(`@${ref} not found`); return `${pre}@${ref}`; }
      if (statSync(abs).isDirectory()) {
        // @dir → one-level entry listing (Claude-compatible)
        const all = readdirSync(abs);
        const names = all.slice(0, 1000);
        const more = all.length > 1000 ? `\n… and ${all.length - 1000} more entries` : "";
        return `${pre}\n\n[dir: ${ref}]\n${names.join("\n")}${more}\n`;
      }
      const body = readFileSync(abs, "utf8").slice(0, 32_000);
      return `${pre}\n\n[file: ${ref}]\n\`\`\`\n${body}\n\`\`\`\n`;
    } catch {
      return `${pre}@${ref}`;
    }
  });
}

/**
 * Build the user message: text @refs inline (fenced), image @refs become
 * base64 content parts with an [image: path] marker left in the text.
 * Returns a plain string when nothing image-shaped matched.
 */
export function buildUserContent(text: string, cwd: string, warn?: (msg: string) => void): string | ContentPart[] {
  const images: ContentPart[] = [];
  const replaced = text.replace(/(^|\s)@([^\s@]+\.(?:png|jpe?g|gif|webp))/gi, (_all, pre: string, ref: string) => {
    try {
      const abs = resolvePath(cwd, ref);
      const rel = relative(cwd, abs);
      if (rel === "" || rel.startsWith("..")) return `${pre}@${ref}`; // outside sandbox — leave
      if (!existsSync(abs)) { warn?.(`@${ref} not found`); return `${pre}@${ref}`; }
      const size = statSync(abs).size;
      if (size > MAX_IMAGE_BYTES) { warn?.(`@${ref} too large (${size} bytes)`); return `${pre}@${ref}`; }
      const buf = readFileSync(abs);
      const mediaType = sniffImage(buf); // extension is a hint; magic bytes decide
      if (!mediaType) { warn?.(`@${ref} isn't a real png/jpeg/gif/webp file`); return `${pre}@${ref}`; }
      images.push({ type: "image", data: buf.toString("base64"), mediaType });
      return `${pre}[image: ${ref}]`;
    } catch {
      return `${pre}@${ref}`;
    }
  });
  const expanded = expandFileRefs(replaced, cwd, warn);
  if (!images.length) return expanded;
  return [{ type: "text", text: expanded }, ...images];
}
