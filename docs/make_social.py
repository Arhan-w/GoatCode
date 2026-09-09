"""Render the GitHub social preview (1200x630) from the goat banner.

  python docs/make_social.py   ->  docs/assets/social.png
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE / "assets" / "social.png"

GOAT = [
    "███            ███",
    "███▄          ▄███",
    "▀███▄ ▄▄▄▄▄▄ ▄███▀",
    "  ▀████▀▀▀▀████▀",
    " ▄▄████▄  ▄████▄▄",
    "   ██▀▀▀  ▀▀▀██",
    "   ▀██▄ ▀▀ ▄██▀",
    "     ▀██████▀",
    "        ▄▀▄",
]

BG = (10, 12, 18)
ACCENT = (168, 85, 247)
FG = (230, 232, 240)
DIM = (140, 148, 160)
GRID = (26, 30, 40)


def font(size: int, mono: bool = False) -> ImageFont.FreeTypeFont:
    cands = (["C:/Windows/Fonts/CascadiaCode.ttf", "C:/Windows/Fonts/consolab.ttf"] if mono else
             ["C:/Windows/Fonts/SegoeUI-Semibold.ttf", "C:/Windows/Fonts/segoeuib.ttf",
              "C:/Windows/Fonts/arialbd.ttf"])
    for c in cands:
        if Path(c).exists():
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def main() -> None:
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # subtle grid
    for x in range(0, W, 40):
        d.line([x, 0, x, H], fill=GRID, width=1)
    for y in range(0, H, 40):
        d.line([0, y, W, y], fill=GRID, width=1)

    # goat banner, left column
    cell = 22
    bx, by = 72, 96
    bf = font(cell, mono=True)
    for r, line in enumerate(GOAT):
        for c, chx in enumerate(line):
            if chx != " ":
                d.text((bx + c * int(cell * 0.62), by + r * (cell + 4)), chx, font=bf, fill=ACCENT)

    # right column copy
    title = font(64)
    tag = font(28)
    sub = font(22)
    mono_s = font(20, mono=True)
    tx = 640
    d.text((tx, 110), "GoatCode", font=title, fill=FG)
    d.text((tx, 196), "Any provider. Your subscriptions.", font=tag, fill=ACCENT)
    d.text((tx, 244), "The open-source terminal coding agent", font=sub, fill=DIM)
    d.text((tx, 282), "with built-in desktop control.", font=sub, fill=DIM)

    # install chip (must be a command that actually works today)
    chip = "npm install -g goatcode"
    cw = d.textlength(chip, font=mono_s) + 44
    d.rounded_rectangle([tx, 348, tx + cw, 348 + 54], radius=10, fill=(22, 26, 36), outline=ACCENT, width=2)
    d.text((tx + 22, 362), chip, font=mono_s, fill=FG)

    # feature line
    feats = "183 providers · MCP · skills · OAuth · MIT"
    d.text((tx, 436), feats, font=sub, fill=DIM)

    # bottom accent bar
    d.rectangle([0, H - 8, W, H], fill=ACCENT)

    OUT.parent.mkdir(exist_ok=True)
    img.save(OUT)
    print("wrote", OUT, img.size)


if __name__ == "__main__":
    main()
