/**
 * Dev-time generator: renders a pixel-art goat head to half-block strings.
 * Run with: bun run scripts/gen-goat.ts
 */

const W = 18, H = 18;

type Grid = boolean[][];
const make = (): Grid => Array.from({ length: H }, () => Array(W).fill(false));

function set(g: Grid, x: number, y: number) {
  x = Math.round(x); y = Math.round(y);
  if (x >= 0 && x < W && y >= 0 && y < H) g[y][x] = true;
}
function stamp(g: Grid, cx: number, cy: number, r: number) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
      if ((x + .5 - (cx + .5)) ** 2 + (y + .5 - (cy + .5)) ** 2 <= (r + .5) ** 2) set(g, x, y);
}
function ellipse(g: Grid, cx: number, cy: number, rx: number, ry: number, fill: boolean) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = ((x + .5 - cx) / rx) ** 2 + ((y + .5 - cy) / ry) ** 2;
    if (fill ? d <= 1 : d <= 1 && d >= 0.42) set(g, x, y);
  }
}
function bezier(g: Grid, p0: [number, number], p1: [number, number], p2: [number, number], r: number) {
  for (let i = 0; i <= 60; i++) {
    const t = i / 60, m = 1 - t;
    const x = m * m * p0[0] + 2 * m * t * p1[0] + t * t * p2[0];
    const y = m * m * p0[1] + 2 * m * t * p1[1] + t * t * p2[1];
    stamp(g, x - .5, y - .5, r);
  }
}

function goatFrame(opts: { blink?: boolean; chew?: boolean } = {}): Grid {
  const g = make();
  // head outline
  ellipse(g, 9, 10.5, 6.2, 5.8, false);
  // horns: sweep out and back up from the temples
  bezier(g, [5.4, 7.4], [1.4, 5.0], [1.0, 0.6], 1.1);
  bezier(g, [12.6, 7.4], [16.6, 5.0], [17.0, 0.6], 1.1);
  // ears: small filled ellipses at the cheeks
  ellipse(g, 2.4, 9.6, 1.7, 0.9, true);
  ellipse(g, 15.6, 9.6, 1.7, 0.9, true);
  // rectangular goat pupils
  if (!opts.blink) {
    for (const cx of [6.2, 10.8]) for (let y = 9; y <= 10; y++) for (let x = cx - 1; x <= cx + 1; x++) set(g, x, y);
  } else {
    for (const cx of [6.2, 10.8]) for (let x = cx - 1; x <= cx + 1; x++) set(g, x, 10);
  }
  // muzzle + mouth
  for (let x = 8; x <= 9; x++) set(g, x, 12.4);           // nose
  for (let x = 7; x <= 11; x++) set(g, x, 13.6);          // mouth line
  if (opts.chew) { for (let x = 8; x <= 10; x++) set(g, x, 14.4); } // open
  // beard from the chin
  for (let i = 0; i < 4; i++) { set(g, 9 - (i >> 1), 15 + i); set(g, 9 + (i >> 1), 15 + i); }
  return g;
}

function render(g: Grid): string {
  const rows: string[] = [];
  for (let y = 0; y < H; y += 2) {
    let s = "";
    for (let x = 0; x < W; x++) {
      const top = g[y][x], bot = y + 1 < H ? g[y + 1][x] : false;
      s += top && bot ? "█" : top ? "▀" : bot ? "▄" : " ";
    }
    rows.push(s.replace(/\s+$/, ""));
  }
  return rows.join("\n");
}

console.log("=== idle ===");
console.log(render(goatFrame()));
console.log("\n=== blink ===");
console.log(render(goatFrame({ blink: true })));
console.log("\n=== chew ===");
console.log(render(goatFrame({ chew: true })));
