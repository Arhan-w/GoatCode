"""Render docs/assets/frames/frames.json (captured by record_session.py) into
README demo assets: a polished final-frame PNG and a typing GIF, drawn with a
terminal chrome (title bar, truecolor cells) via PIL.

  python docs/render_frames.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FRAMES = HERE / "assets" / "frames"
BG = (15, 17, 23)
DEFAULT_FG = (224, 226, 240)
TITLEBAR = (28, 31, 38)
ACCENT = (168, 85, 247)

CELL_W = 10
CELL_H = 21
PAD_X = 22
PAD_TOP = 52   # title bar
PAD_BOT = 22


def find_fonts() -> list[str]:
    """Monospace first (grid-aligned), then symbol fonts as glyph fallback."""
    return [p for p in (
        "C:/Windows/Fonts/CascadiaCode.ttf", "C:/Windows/Fonts/consolab.ttf",
        "C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/seguisym.ttf",
        "C:/Windows/Fonts/arial.ttf") if Path(p).exists()]


_FONT_FILES = find_fonts()

def _cmap(path: str) -> set[int]:
    from fontTools.ttLib import TTFont
    try:
        return set(TTFont(path, fontNumber=0).getBestCmap().keys())
    except Exception:
        return set()

_CMAPS = {p: _cmap(p) for p in _FONT_FILES}
# best font per codepoint: first in list that actually has the glyph
_GLYPH_FONT = {}
def font_for(ch: str, bold: bool) -> str:
    cp = ord(ch)
    key = (cp, bold)
    if key not in _GLYPH_FONT:
        for p in _FONT_FILES:
            if cp in _CMAPS[p]:
                _GLYPH_FONT[key] = p
                break
        else:
            _GLYPH_FONT[key] = _FONT_FILES[0]
    return _GLYPH_FONT[key]

FONT = _FONT_FILES[0] if _FONT_FILES else ""
FONT_BOLD = next((p for p in _FONT_FILES if "segoe" not in p), FONT)


def draw_frame(grid, img_w_rows: int | None = None) -> Image.Image:
    rows = len(grid)
    cols = len(grid[0]) if rows else 0
    if img_w_rows is None:
        img_w_rows = rows
    w = cols * CELL_W + PAD_X * 2
    h = img_w_rows * CELL_H + PAD_TOP + PAD_BOT
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    # title bar
    d.rectangle([0, 0, w, 36], fill=TITLEBAR)
    for i, col in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([16 + i * 22, 13, 30 + i * 22, 27], fill=col)
    tf = ImageFont.truetype(FONT, 15) if FONT else ImageFont.load_default()
    d.text((w / 2, 18), "goat — GoatCode", font=tf, fill=(150, 155, 165), anchor="mm")
    # cells
    fonts: dict[tuple[str, bool], ImageFont.FreeTypeFont] = {}
    def font(ch: str, bold: bool):
        key = (ch, bold)
        if key not in fonts:
            path = font_for(ch, bold)
            fonts[key] = ImageFont.truetype(path, 17) if path else ImageFont.load_default()
        return fonts[key]
    for y in range(min(rows, img_w_rows)):
        for x, cell in enumerate(grid[y]):
            ch, fg, bg, bold = cell[0], cell[1], cell[2], cell[3] if len(cell) > 3 else False
            px, py = PAD_X + x * CELL_W, PAD_TOP + y * CELL_H
            if bg and tuple(bg) != BG:
                d.rectangle([px, py, px + CELL_W, py + CELL_H], fill=tuple(bg))
            if ch in (" ", ""):
                continue
            col = tuple(fg) if fg else DEFAULT_FG
            d.text((px + 1, py + 2), ch, font=font(ch, bold), fill=col)
    # bottom accent line
    d.line([0, h - 2, w, h - 2], fill=ACCENT, width=2)
    return img


def trim_rows(grid):
    """Drop fully-empty leading/trailing rows to tighten the frame."""
    def empty(row):
        return all((c[0] in (" ", "")) for c in row)
    top, bot = 0, len(grid)
    while top < bot and empty(grid[top]):
        top += 1
    while bot > top and empty(grid[bot - 1]):
        bot -= 1
    return grid[top:max(bot, top + 6)]


def main() -> None:
    frames = json.loads((FRAMES / "frames.json").read_text(encoding="utf-8"))
    if not frames:
        print("no frames captured"); sys.exit(1)
    print(f"{len(frames)} frames loaded")

    # --- final PNG: the settled last frame (answer complete, box empty) ---
    best = frames[-1]
    grid = trim_rows(best["grid"])
    img = draw_frame(grid)
    img.save(FRAMES.parent / "demo.png")
    print("demo.png", img.size)

    # --- GIF: downsample frames to ~7 fps ---
    # PIL sizes the GIF from frame 0 and crops the rest to it, so EVERY frame
    # must share one canvas: one global trim height, no per-frame trimming.
    step = max(1, len(frames) // 90)
    picked = frames[::step]

    def content_bottom(grid) -> int:
        for y in range(len(grid) - 1, -1, -1):
            if any(c[0] not in (" ", "") for c in grid[y]):
                return y + 1
        return 1

    bottom = max(content_bottom(f["grid"]) for f in picked)
    gifs = []
    for f in picked:
        grid = f["grid"][:bottom]
        im = draw_frame(grid)
        gifs.append(im.convert("P", palette=Image.ADAPTIVE, colors=128))
    if len(gifs) < 2:
        print("too few frames for a gif"); return
    assert len({g.size for g in gifs}) == 1, "gif frames must share one canvas"
    gifs[0].save(FRAMES.parent / "demo.gif", save_all=True,
                 append_images=gifs[1:], duration=140, loop=0, optimize=True)
    print("demo.gif", len(gifs), "frames", gifs[0].size)


if __name__ == "__main__":
    main()
