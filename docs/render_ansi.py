"""Render an ANSI capture to a terminal-style PNG and a typing-animated GIF.

Parses SGR colors from the capture, draws each line with a monospace font on a
dark terminal background, adds a title bar. The GIF reveals characters
progressively to read like a recording.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SGR = re.compile(r"\x1b\[([0-9;]*)m")
PALETTE = {
    0: (13, 17, 23), 1: (224, 226, 240), 2: (110, 118, 129),
    30: (13, 17, 23), 31: (248, 81, 73), 32: (63, 185, 80), 33: (219, 171, 9),
    34: (84, 151, 241), 35: (200, 120, 230), 36: (56, 199, 211), 37: (201, 209, 217),
    90: (110, 118, 129), 91: (255, 123, 114), 92: (94, 225, 129), 93: (229, 192, 123),
    94: (121, 192, 255), 95: (221, 130, 237), 96: (140, 227, 237), 97: (240, 246, 252),
}
BG = (13, 17, 23)
CELL_W, CELL_H = 9, 20   # Consolas 17pt: 9px advance, 18px line + 2 leading
PAD_X, PAD_Y, TITLE_H = 24, 20, 40


def find_font() -> str:
    candidates = [
        "C:/Windows/Fonts/CascadiaCode.ttf", "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/courbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    return ""


def find_symbol_font() -> str:
    """Fallback with wide unicode coverage (✓, …) for glyphs monospace lacks."""
    for c in ("C:/Windows/Fonts/seguisym.ttf", "C:/Windows/Fonts/arial.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(c).exists():
            return c
    return ""


def parse_ansi(text: str) -> list[list[tuple[str, tuple]]]:
    """Split into lines of (run_text, fg_rgb) using SGR codes."""
    text = (text.replace("\x1b[?25l", "").replace("\x1b[?25h", "")
            .replace("\r\n", "\n").replace("\r", "").replace("\x00", ""))
    lines_out = []
    for raw in text.split("\n"):
        runs, pos, fg = [], 0, None
        for m in SGR.finditer(raw):
            if m.start() > pos:
                runs.append((raw[pos:m.start()], fg))
            codes = [int(c) if c else 0 for c in m.group(1).split(";")]
            for code in codes:
                if code == 0:
                    fg = None
                elif code == 39:
                    fg = None
                elif code in PALETTE:
                    fg = PALETTE[code]
            pos = m.end()
        if pos < len(raw):
            runs.append((raw[pos:], fg))
        lines_out.append(runs)
    return lines_out


def render_frame(runs_lines, upto: int, font, symbol_font=None, cover=None) -> Image.Image:
    width = PAD_X * 2 + CELL_W * 88
    height = TITLE_H + PAD_Y * 2 + CELL_H * len(runs_lines)
    img = Image.new("RGB", (width, height), (8, 10, 14))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, width, height], radius=12, fill=BG)
    d.rectangle([0, 0, width, TITLE_H], fill=(22, 27, 34))
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = 20 + i * 22
        d.ellipse([cx, 14, cx + 13, 27], fill=color)
    d.text((width // 2 - 60, 12), "goat — demo-project", font=font, fill=(139, 148, 158))
    count = 0
    y = TITLE_H + PAD_Y
    for runs in runs_lines:
        x = PAD_X
        for text, fg in runs:
            for ch in text:
                if count >= upto:
                    return img
                use = font if (cover is None or ord(ch) in cover) else symbol_font
                d.text((x, y), ch, font=use, fill=fg or PALETTE[1])
                x += CELL_W
                count += 1
        y += CELL_H
    return img


def main() -> None:
    src = Path(sys.argv[1])
    png_out = Path(sys.argv[2])
    gif_out = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    text = src.read_text(encoding="utf-8")
    lines = [l for l in parse_ansi(text)]
    while lines and not any(t.strip() for t, _ in lines[-1]):
        lines.pop()
    font_path = find_font()
    font = ImageFont.truetype(font_path, 17) if font_path else ImageFont.load_default()
    # Per-glyph fallback: Consolas lacks ❯ ⎿ ✓ — draw those with a symbol font.
    cover, symbol_font = None, None
    try:
        from fontTools.ttLib import TTFont
        sym_path = find_symbol_font()
        if font_path and sym_path:
            cover = set(TTFont(font_path, fontNumber=0, lazy=True).getBestCmap().keys())
            symbol_font = ImageFont.truetype(sym_path, 17)
    except Exception:  # noqa: BLE001 — fallback is cosmetic; never fail the render
        cover, symbol_font = None, None
    total = sum(len(t) for runs in lines for t, _ in runs)
    render_frame(lines, total, font, symbol_font, cover).save(png_out)
    print(f"png: {png_out} ({total} chars, {len(lines)} lines)")
    if gif_out:
        frames = []
        step = max(1, total // 60)
        for upto in range(step, total + step, step):
            frames.append(render_frame(lines, upto, font, symbol_font, cover).convert("P", palette=Image.ADAPTIVE))
        frames[-1] = render_frame(lines, total, font, symbol_font, cover).convert("P", palette=Image.ADAPTIVE)
        frames[0].save(gif_out, save_all=True, append_images=frames[1:], duration=60, loop=0)
        print(f"gif: {gif_out} ({len(frames)} frames)")


if __name__ == "__main__":
    main()
