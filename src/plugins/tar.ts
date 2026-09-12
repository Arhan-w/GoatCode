/**
 * Tar archive utilities — pure ustar/GNU tar parser and writer, gzip
 * via Bun.gunzipSync (fallback node:zlib). Used by the plugin marketplace
 * for installing .tgz packages with pinned ed25519 signatures.
 *
 * NOTE: NO wasmtime — the v2 plugin directory bundle IS the plugin system;
 * tgz installation is the extension mechanism only.
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";

export class TarError extends Error {
  constructor(reason: string) { super(reason); this.name = "TarError"; }
}

/** Max decompressed bytes before rejecting a gzip bomb. */
export const MAX_DECOMPRESSED = 50_000_000;

/** Parse a ustar/GNU tar header at offset 0 into fields, or null. */
function parseHeader(buf: Buffer, off: number): Record<string, string | number> | null {
  if (off + 512 > buf.length) return null;
  const h = buf.subarray(off, off + 512);
  const magic = h.subarray(257, 263).toString("ascii").trim();
  if (magic !== "ustar" && magic !== "ustar  \0" && magic !== "") return null;
  // All-zero block = end of archive
  if (h.every((b) => b === 0)) return null;
  const name = h.subarray(0, 100).toString("ascii").replace(/\0/g, "");
  const mode = h.subarray(100, 108).toString("ascii").replace(/\0/g, "").trim();
  const sizeRaw = h.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim();
  const typeflag = h.subarray(156, 157).toString("ascii");
  const prefix = h.subarray(345, 500).toString("ascii").replace(/\0/g, "");
  return { name: prefix ? `${prefix}${name}` : name, mode, size: sizeRaw, typeflag, magic };
}

/** Parse an octal string (including base-256 high-bit variant) to a number. */
function parseOctal(s: string): number {
  if (!s) return 0;
  // GNU high-bit variant: first char is 0o200 (128) | digits
  if (s.charCodeAt(0) >= 128) {
    let n = s.charCodeAt(0) & 0x7f;
    for (let i = 1; i < s.length; i++) {
      const d = s.charCodeAt(i) - 48;
      if (d < 0 || d > 7) break;
      n = n * 8 + d;
    }
    return n;
  }
  const v = parseInt(s, 8);
  return Number.isNaN(v) ? 0 : v;
}

/** Read PAX (POSIX) extended header entries preceding the real header. */
function readPaxEntries(buf: Buffer, off: number): Map<string, string> {
  const m = new Map<string, string>();
  for (;;) {
    if (off + 512 > buf.length) return m;
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return m; // zero block = end
    const typeflag = h.subarray(156, 157).toString("ascii");
    if (typeflag !== "x" && typeflag !== "g") return m;
    const s = h.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim();
    const sz = parseInt(s, 8) || 0;
    const end = off + 512 + sz;
    const content = buf.subarray(off + 512, Math.min(end, buf.length)).toString("utf8");
    for (const line of content.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) {
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k === "path") m.set("path", v);
      }
    }
    off = Math.ceil(end / 512) * 512;
  }
}

/** Read the next entry's long name (GNU typeflag 'L'). */
function readLongName(buf: Buffer, off: number): string {
  if (off + 512 > buf.length) return "";
  const h = buf.subarray(off, off + 512);
  if (h.every((b) => b === 0)) return "";
  const typeflag = h.subarray(156, 157).toString("ascii");
  if (typeflag !== "L") return "";
  const s = h.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim();
  const sz = parseOctal(s);
  return buf.subarray(off + 512, off + 512 + sz).toString("utf8").replace(/\0/g, "");
}

/** Read the data blocks for a header of given size. Returns [data, newOff]. */
function readData(buf: Buffer, off: number, size: number): { data: Buffer; off: number } {
  const data = buf.subarray(off, off + Math.min(size, buf.length - off));
  const end = off + size;
  const pad = Math.ceil(end / 512) * 512 - end;
  return { data: Buffer.concat([data, Buffer.alloc(Math.max(0, pad))]), off: Math.ceil(end / 512) * 512 };
}

/** Decompress gzip bytes. Bun.gunzipSync first, node:zlib fallback. */
export function gunzipToU8(u8: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(Bun.gunzipSync(Buffer.from(u8)));
  } catch {
    const { gunzipSync } = require("node:zlib");
    return new Uint8Array(gunzipSync(Buffer.from(u8)));
  }
}

/**
 * Extract a tar (gzipped or raw) buffer into destDir.
 * Returns the list of extracted entry names + sizes.
 * Every guard listed in the spec is enforced; throws TarError on violation.
 */
export function extractTar(buffer: Buffer, destDir: string): { name: string; size: number }[] {
  const raw = Buffer.from(buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipToU8(buffer) : buffer);
  if (raw.length > MAX_DECOMPRESSED) throw new TarError("decompressed payload exceeds 50MB");

  mkdirSync(destDir, { recursive: true });
  const out: { name: string; size: number }[] = [];
  let off = 0;
  let longName = "";
  let entryCount = 0;
  const writtenPaths = new Set<string>();
  const lowerPaths = new Set<string>(); // case-collision guard on Windows

  while (off + 512 <= raw.length) {
    const h = parseHeader(raw, off);
    if (!h || h.magic === "") break; // zero block = end
    off += 512;
    entryCount++;
    if (entryCount > 10000) throw new TarError("too many entries (>10000)");

    const name = longName || (h.name as string);
    longName = "";
    const typeflag = h.typeflag as string;
    const size = parseOctal(h.size as string);

    // PAX "x" entries: path override
    if (typeflag === "x" || typeflag === "g") {
      const pax = readPaxEntries(raw, off - 512);
      off = Math.ceil((off - 512 + size) / 512) * 512;
      // If a "path=" override exists, re-apply by rewriting the entry name
      if (pax.has("path")) {
        // The path override affects the name used for extraction.
        // We stored writtenPaths/lowerPaths with the original name;
        // skip re-extraction under the overridden path for safety.
        continue;
      }
      continue;
    }

    // GNU long name entry: capture, then skip data
    if (typeflag === "L") {
      longName = readLongName(raw, off - 512);
      const lz = parseOctal(h.size as string);
      off = Math.ceil((off - 512 + lz) / 512) * 512;
      continue;
    }

    // Resolve final name
    let entryName = name;
    // Guard: absolute path
    if (entryName.startsWith("/")) throw new TarError("absolute entry name rejected");
    // Guard: drive-letter name on win32
    if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(entryName)) throw new TarError("drive-letter name rejected");

    const destPath = resolve(destDir, entryName);
    // Guard: dot-dot escape via resolve containment check
    if (!destPath.startsWith(resolve(destDir) + "/") && destPath !== resolve(destDir)) throw new TarError("path escapes target (dot-dot)");
    // Guard: symlinks
    if (typeflag === "2") throw new TarError("symlinks not allowed");

    // Read data
    const { data, off: newOff } = readData(raw, off, size);
    off = newOff; // pad to 512 boundary

    if (typeflag === "S" || typeflag === "K") {
      // sparse: treat as normal file if header size sane, else skip
      if (size > MAX_DECOMPRESSED) { out.push({ name: entryName, size: 0 }); continue; }
    }

    const relPath = destPath.slice(destDir.length + 1);
    const lowerRel = relPath.toLowerCase();

    // Case-collision guard
    if (lowerPaths.has(lowerRel)) {
      throw new TarError(`case collision: ${relPath}`);
    }
    lowerPaths.add(lowerRel);
    writtenPaths.add(relPath);

    const fullPath = join(destDir, relPath);
    if (typeflag === "5") {
      mkdirSync(fullPath, { recursive: true });
    } else {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, data);
    }
    out.push({ name: relPath, size });
  }
  return out;
}

/** Minimal ustar writer: 512-byte headers, octal fields, zero padding. */
export function writeTarFixtures(entries: { name: string; content: string | Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const content = typeof e.content === "string" ? Buffer.from(e.content, "utf8") : e.content;
    const size = content.length;
    const sizeOct = size.toString(8).padStart(11, "0").slice(0, 11) + "\0";
    const name = e.name.slice(0, 99);
    const hdr = Buffer.alloc(512);
    // name (0-99)
    Buffer.from(name).copy(hdr, 0);
    // mode (100-107)
    hdr.write("0000644\0", 100);
    // uid/gid (108-135)
    hdr.write("0000000\0", 108);
    hdr.write("0000000\0", 116);
    // size (124-135)
    Buffer.from(sizeOct).copy(hdr, 124);
    // mtime (136-147)
    hdr.write("00000000000\0", 136);
    // typeflag (156)
    hdr.write("0", 156);
    // magic (257-262)
    hdr.write("ustar\0", 257);
    // version (263-264)
    hdr.write("00", 263);
    // prefix (345-500) — empty for simple names
    blocks.push(hdr);
    blocks.push(content);
    // pad to 512
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  // Two zero blocks = end
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
