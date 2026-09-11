/**
 * Minimal line diff (LCS) for the inline edit/write preview.
 * Returns lines prefixed "+", "-" or " " (context). Pure + small: files here
 * are already capped by MAX_SNAP_BYTES, and the UI only shows the first rows.
 */
export function unifiedDiff(before: string, after: string, context = 2): string[] {
  if (before === after) return [];
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];

  // LCS table (O(n*m) — snap sizes keep this bounded; 2k lines worst case)
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  // walk to produce the edit script
  const raw: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { raw.push(" " + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push("-" + a[i]); i++; }
    else { raw.push("+" + b[j]); j++; }
  }
  while (i < n) raw.push("-" + a[i++]);
  while (j < m) raw.push("+" + b[j++]);

  // collapse to hunks: keep `context` unchanged lines around each change
  const keep = new Uint8Array(raw.length);
  for (let k = 0; k < raw.length; k++) {
    if (raw[k][0] === " ") continue;
    for (let t = Math.max(0, k - context); t <= Math.min(raw.length - 1, k + context); t++) keep[t] = 1;
  }
  const out: string[] = [];
  let gap = false;
  for (let k = 0; k < raw.length; k++) {
    if (keep[k]) { out.push(raw[k]); gap = false; }
    else if (!gap && out.length) { out.push("…"); gap = true; }
  }
  return out.filter((l) => l !== "…");
}

/** "+N -M" summary for the diff header. */
export function diffStats(lines: string[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of lines) { if (l[0] === "+") added++; else if (l[0] === "-") removed++; }
  return { added, removed };
}
