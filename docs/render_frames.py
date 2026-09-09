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


def find_font(bold: bool = False) -> str:
    cands = (["C:/Windows/Fonts/CascadiaCode.ttf", "C:/Windows/Fonts/cascadia.ttf",
              "C:/Windows/Fonts/consolab.ttf", "C:/Windows/Fonts/consola.ttf"] if bold else
             ["C:/Windows/Fonts/CascadiaCode.ttf", "C:/Windows/Fonts/cascadia.ttf",
              "C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/consolaz.ttf"])
    for c in cands:
        if Path(c).exists():
            return c
    return ""


def find_symbol_font() -> str:
    for c in ("C:/Windows/Fonts/seguisym.ttf", "C:/Windows/Fonts/NotoSansMonoCJKsc-VF.ttf",
              "C:/Windows/Fonts/arial.ttf"):
        if Path(c).exists():
            return c
    return ""


FONT = find_font()
FONT_BOLD = find_font(bold=True)
FONT_SYM = find_symbol_font()


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
    f_reg = ImageFont.truetype(FONT, 17) if FONT else ImageFont.load_default()
    f_bold = ImageFont.truetype(FONT_BOLD, 17) if FONT_BOLD else f_reg
    f_sym = ImageFont.truetype(FONT_SYM, 17) if FONT_SYM else f_reg
    for y in range(min(rows, img_w_rows)):
        for x, cell in enumerate(grid[y]):
            ch, fg, bg, bold = cell[0], cell[1], cell[2], cell[3] if len(cell) > 3 else False
            px, py = PAD_X + x * CELL_W, PAD_TOP + y * CELL_H
            if bg and tuple(bg) != BG:
                d.rectangle([px, py, px + CELL_W, py + CELL_H], fill=tuple(bg))
            if ch in (" ", ""):
                continue
            col = tuple(fg) if fg else DEFAULT_FG
            font = f_bold if bold else f_reg
            try:
                bbox = font.getbbox(ch)
                if bbox[2] - bbox[0] > CELL_W - 1 and font is not f_sym:
                    font = f_sym
            except Exception:
                pass
            d.text((px + 1, py + 2), ch, font=font, fill=col)
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

    # --- final PNG: the most populated late frame ---
    best = max(frames[len(frames) // 2:], key=lambda f: sum(
        1 for row in f["grid"] for c in row if c[0] not in (" ", "")))
    grid = trim_rows(best["grid"])
    img = draw_frame(grid)
    img.save(FRAMES.parent / "demo.png")
    print("demo.png", img.size)

    # --- GIF: downsample frames to ~7 fps, cap the width ---
    step = max(1, len(frames) // 90)
    picked = frames[::step]
    rows = max(len(f["grid"]) for f in picked)
    gifs = []
    for f in picked:
        im = draw_frame(trim_rows(f["grid"]), img_w_rows=min(rows, 30))
        gifs.append(im.convert("P", palette=Image.ADAPTIVE, colors=128))
    if len(gifs) < 2:
        print("too few frames for a gif"); return
    gifs[0].save(FRAMES.parent / "demo.gif", save_all=True,
                 append_images=gifs[1:], duration=140, loop=0, optimize=True)
    print("demo.gif", len(gifs), "frames")


if __name__ == "__main__":
    main()
