# GoatCode launch reel v3: 1080x1920 @24fps — 16 VO segments, scene-per-VO, PIL render -> ffmpeg xfade
import json, math, subprocess, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = Path(__file__).parent
W, H, FPS = 1080, 1920, 24
BG      = (11, 13, 18)
PANEL   = (18, 21, 28)
CHROME  = (28, 31, 38)
TEXT    = (224, 226, 240)
MUTED   = (124, 131, 144)
ACCENT  = (168, 85, 247)
TRACK   = (40, 38, 54)

def F(name, size):
    return ImageFont.truetype(str(HERE / "fonts" / "extras" / "ttf" / name), size)
INTER_BLACK = lambda s: F("Inter-Black.ttf", s)
INTER_BOLD  = lambda s: F("Inter-Bold.ttf", s)
INTER_MED   = lambda s: F("Inter-Medium.ttf", s)
MONO        = lambda s: ImageFont.truetype("C:/Windows/Fonts/consola.ttf", s)

LOGO = [
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

def base():
    img = Image.new("RGB", (W, H), BG)
    return img

def center_text(d, y, text, font, fill, tracking=0):
    if tracking:
        widths = [d.textlength(ch, font=font) for ch in text]
        total = sum(widths) + tracking * (len(text) - 1)
        x = (W - total) / 2
        for ch, w_ in zip(text, widths):
            d.text((x, y), ch, font=font, fill=fill)
            x += w_ + tracking
    else:
        d.text((W / 2, y), text, font=font, fill=fill, anchor="ma")

def wrap(d, text, font, maxw):
    words, lines, cur = text.split(), [], ""
    for wd in words:
        t = (cur + " " + wd).strip()
        if d.textlength(t, font=font) <= maxw: cur = t
        else: lines.append(cur); cur = wd
    if cur: lines.append(cur)
    return lines

def clean_still(p):
    im = Image.open(p).convert("RGB")
    im = im.crop((0, 52, im.width, im.height - 22))
    return im

def clean_gif(p):
    out = HERE / "_gif"
    out.mkdir(exist_ok=True)
    stem = Path(p).stem
    files = sorted(out.glob(f"{stem}-*.png"))
    if not files:
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(p), str(out / f"{stem}-%04d.png")], check=True)
        files = sorted(out.glob(f"{stem}-*.png"))
    ims = [Image.open(f).convert("RGB").crop((0, 52, Image.open(f).width, Image.open(f).height - 22)) for f in files]
    return ims

def chrome(img, shot, cx, top, bottom, title="goat"):
    # give captured content breathing room from the window frame (bottom was tight)
    cap_bg = (15, 17, 23)
    pad_b, pad_t = 18, 6
    canvas = Image.new("RGB", (shot.width, shot.height + pad_b + pad_t), cap_bg)
    canvas.paste(shot, (0, pad_t))
    shot = canvas
    box_w, box_h = W - 120, bottom - top
    sw, sh = shot.size
    s = min((box_w - 60) / sw, (box_h - 60 - 46) / sh)
    tw, th = int(sw * s), int(sh * s)
    shot = shot.resize((tw, th), Image.LANCZOS)
    pad = 30; bar = 46
    Wd, Hd = tw + pad * 2, th + bar + pad
    x = cx - Wd // 2
    y = top + (box_h - Hd) // 2
    sh_img = Image.new("RGBA", (Wd + 64, Hd + 64), (0, 0, 0, 0))
    ImageDraw.Draw(sh_img).rounded_rectangle([32, 32, 32 + Wd, 32 + Hd], 24, fill=(0, 0, 0, 150))
    sh_img = sh_img.filter(ImageFilter.GaussianBlur(20))
    img.paste(sh_img, (x - 32, y - 26), sh_img)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([x, y, x + Wd, y + Hd], 24, fill=PANEL, outline=(42, 46, 58), width=2)
    d.rectangle([x, y + 2, x + Wd, y + bar], fill=CHROME)
    d.line([x, y + bar, x + Wd, y + bar], fill=(42, 46, 58), width=2)
    for i, col in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([x + 22 + i * 26, y + 15, x + 38 + i * 26, y + 31], fill=col)
    d.text((x + Wd / 2, y + bar / 2), f"{title} — GoatCode", font=MONO(18), fill=MUTED, anchor="ma")
    img.paste(shot, (x + pad, y + bar + pad // 2))
    return img

def frame_chrome(img, kicker, caption, scene_i, prog):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 6, W, 10], fill=TRACK)
    d.rectangle([0, 6, int(W * prog), 10], fill=ACCENT)
    for i in range(16):
        y = 220 + i * 22
        d.rectangle([W - 46, y, W - 40, y + 6], fill=ACCENT if i == scene_i else (46, 48, 60))
    if kicker:
        center_text(d, 84, kicker.upper(), INTER_BOLD(26), ACCENT, tracking=7)
    cf = INTER_BLACK(54)
    lines = wrap(d, caption, cf, 900)
    lh = 68
    y0 = 1470
    if len(lines) == 3: y0 = 1440
    for i, ln in enumerate(lines):
        center_text(d, y0 + i * lh, ln, cf, TEXT)
    d.text((W / 2, 1846), "GOATCODE", font=INTER_BOLD(24), fill=(58, 63, 78), anchor="ma")
    return img

def ease_out(t): return 1 - (1 - t) ** 3

def shot_zoom(shot, z):
    if z <= 1.0: return shot
    w, h = shot.size
    cw, ch = int(w / z), int(h / z)
    x = (w - cw) // 2; y = (h - ch) // 2
    return shot.crop((x, y, x + cw, y + ch)).resize((w, h), Image.LANCZOS)

def dur(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True)
    return float(r.stdout.strip())

SEG = [dur(HERE / f"vo_{i:02d}.mp3") for i in range(16)]
GAP = 0.5
SCENE_D = [s + GAP for s in SEG]
KICKS = ["", "INSTALL", "FREE", "GOATED-FLASH-FREE", "CODE INTEL", "ULTRAPLAN", "LIVE RELAY", "FAILOVER", "UPGRADE", "", "PLUG IN", "FAILOVER", "YOUR RULES", "OR DON'T", "IT'S GOATED", ""]
CAPS = [
    "Every coding agent wants a key.",
    "This one does not even need one.",
    "Install it, type one word: goat.",
    "That is the whole setup.",
    "It boots straight into Goated Flash Free.",
    "A real coding model, built in, zero cost.",
    "Ask it anything.",
    "It reads your codebase, writes files, runs commands, for free.",
    "Index your repos, find any symbol, ranked.",
    "Run ultraplan, fans out a squad of subagents.",
    "Then merges one battle plan.",
    "Share a code, your teammate is inside your session, live.",
    "Provider rate limits? It fails over before you notice.",
    "Plug in a key later, it upgrades instantly.",
    "Or do not. It is already goated.",
    "Goat Code. Link in bio.",
]

def render_scene(i, out_dir):
    out_dir.mkdir(exist_ok=True)
    total = int(round(SCENE_D[i] * FPS))
    fade_in = int(0.2 * FPS); fade_out = int(0.2 * FPS)
    stills = {}
    for k in range(total):
        t = k / total
        img = base()
        d = ImageDraw.Draw(img)
        if i == 0:
            lg = MONO(70)
            for r, line in enumerate(LOGO):
                d.text((W / 2, 620 + r * 66), line, font=lg, fill=ACCENT, anchor="ma")
            center_text(d, 1330, "NO API KEY.", INTER_BLACK(92), TEXT)
            center_text(d, 1436, "NO SETUP.", INTER_BLACK(92), TEXT)
            center_text(d, 1560, "just goat", INTER_BOLD(50), ACCENT)
        elif i == 15:
            lg = MONO(54)
            for r, line in enumerate(LOGO):
                d.text((W / 2, 560 + r * 54), line, font=lg, fill=ACCENT, anchor="ma")
            center_text(d, 1180, "GOATCODE", INTER_BLACK(108), TEXT)
            center_text(d, 1300, "every provider · one terminal", INTER_MED(42), (190, 193, 208))
            center_text(d, 1380, "npm install -g goatcode-cli", MONO(38), (220, 223, 235))
            center_text(d, 1450, "github.com/Arhan-w/GoatCode", MONO(38), ACCENT)
        elif i == 1:
            shot = clean_still(HERE / "img-welcome.png")
            if not stills: stills["s"] = shot
            z = lerp_z(t)
            chrome(img, shot_zoom(stills["s"], z), W // 2, 160, 1330)
        elif i == 2:
            shot = clean_still(HERE / "img-config.png")
            chrome(img, shot_zoom(shot, lerp_z(t)), W // 2, 160, 1330)
        elif i == 4:
            shot = clean_still(HERE / "img-code.png")
            chrome(img, shot_zoom(shot, lerp_z(t)), W // 2, 160, 1330)
        elif i == 6:
            shot = clean_still(HERE / "img-share.png")
            chrome(img, shot_zoom(shot, lerp_z(t)), W // 2, 160, 1330)
        elif i == 8:
            shot = clean_still(HERE / "img-read.png")
            chrome(img, shot_zoom(shot, lerp_z(t)), W // 2, 160, 1330)
        else:
            if ("g", i) not in stills:
                stills[("g", i)] = clean_gif(HERE / {3: "src-flash.gif", 5: "src-ultra.gif", 7: "src-failover.gif", 9: "src-ultra.gif", 10: "src-flash.gif", 11: "src-share.gif", 12: "src-failover.gif", 13: "src-read.gif", 14: "src-flash.gif"}[i])
            gf = stills[("g", i)]
            idx = min(len(gf) - 1, int(k / max(1, total - 4) * len(gf)))
            chrome(img, gf[idx], W // 2, 160, 1330, title="goat")
        if i not in (0, 15):
            prog = (sum(SCENE_D[:i]) + SCENE_D[i] * t) / sum(SCENE_D)
            frame_chrome(img, KICKS[i], CAPS[i], i, prog)
        else:
            d = ImageDraw.Draw(img)
            d.rectangle([0, 6, W, 10], fill=TRACK)
            d.rectangle([0, 6, int(W * ((sum(SCENE_D[:i]) + SCENE_D[i] * t) / sum(SCENE_D))), 10], fill=ACCENT)
        a = 1.0
        if k < fade_in: a = k / fade_in
        if k > total - fade_out: a = min(a, (total - k) / fade_out)
        if a < 1.0:
            img = Image.blend(Image.new("RGB", (W, H), BG), img, a)
        img.save(out_dir / f"f{k:05d}.png")
    return total

def lerp_z(t): return 1.0 + 0.05 * ease_out(min(1, t * 1.3))

if __name__ == "__main__":
    total = 0
    for i in range(16):
        n = render_scene(i, HERE / f"scene_{i:02d}")
        total += n
        print("scene", i, n, "frames", flush=True)
    print("TOTAL", total)
