"""GoatCode launch reel — 9:16 vertical, built from real pty-captured frames.

Pro polish:
  • edge-tts neural VO (+12% rate), scene lengths derived from actual audio
  • entry scale-punch + Ken-Burns push on every scene, GIFs played start→end
  • animated lower-third title cards (rise → hold → fade), synced to VO
  • word-by-word karaoke captions in brand palette, burned via libass
  • synthesized sound design: whooshes at cuts, riser + impact into end card,
    minimal sub-drone bed under the voice
  • broadcast loudness (−14 LUFS) master

Run:  python build_reel.py  →  goatcode-reel.mp4 + reel-thumb.jpg
"""
from __future__ import annotations

import asyncio
import glob
import subprocess
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---------------------------------------------------------------- config
HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
SCENE_DIR = WORK / "scenes"
AUDIO_DIR = WORK / "audio"
ASSETS = HERE.parent / "site" / "assets"

W, H, FPS, SR = 1080, 1920, 30, 44100
BG = (10, 9, 8)          # #0A0908
PANEL = (22, 16, 15)
BORDER = (42, 27, 31)
WINE = (73, 17, 28)
WINE_HI = (138, 32, 50)
GLOW = (178, 58, 78)     # #B23A4E
TEXT = (242, 244, 243)   # #F2F4F3
DIM = (154, 145, 142)

VOICE = "en-US-AndrewNeural"
VO_RATE = "+12%"
PAD_PRE, PAD_POST = 0.18, 0.40
PUNCH_F, PUNCH_K = 9, 1.05
GIF_STEP = 3             # source-frame advances every N output frames (~10fps feel)
TITLE_IN, TITLE_HOLD, TITLE_OUT = 8, 34, 12
TERM_TOP = 500


def find(patterns: list[str]) -> str:
    for p in patterns:
        hits = sorted(glob.glob(p))
        if hits:
            return hits[0]
    raise SystemExit(f"missing font: {patterns}")

SANS = find(["C:/Windows/Fonts/Inter-Regular.ttf", "C:/Windows/Fonts/segoeui.ttf",
              "C:/Windows/Fonts/arial.ttf"])
SANS_B = find(["C:/Windows/Fonts/Inter-SemiBold.ttf", "C:/Windows/Fonts/Inter-Bold.ttf",
               "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf"])
HEAD = find(["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/Inter-ExtraBold.ttf",
              "C:/Windows/Fonts/arialbd.ttf"])
MONO = find(["C:/Windows/Fonts/JetBrainsMono*.ttf", "C:/Windows/Fonts/CascadiaCode.ttf",
              "C:/Windows/Fonts/consolab.ttf", "C:/Windows/Fonts/consola.ttf"])

# ---------------------------------------------------------------- scenes
SCENES = [
    dict(id="hero", type="still", src="demo-read.gif", fr=-1, push=0.05,
         label="GOATCODE", title="Every provider.\nOne terminal.",
         vo="Your terminal just became every AI provider on earth — and it never stops coding.",
         sub="Every provider. One terminal. Never stop coding."),
    dict(id="failover", type="gif", src="demo-failover.gif", push=0.05,
         label="MID-TURN FAILOVER", title="Quota dies?\nIt doesn't.",
         vo="Quota dies at two A M? GoatCode walks the fallback chain mid-turn, switches providers, and still finishes the answer.",
         sub="429 → fallback chain → answer finished"),
    dict(id="flash", type="gif", src="demo-flash.gif", push=0.06,
         label="GOATED-FLASH-FREE", title="$0 to start.\nZero config.",
         vo="No key, no signup. Install it, run one command, and the embedded Goated-Flash model answers instantly. Free, out of the box.",
         sub="$0 to start · zero config"),
    dict(id="code", type="gif", src="demo-code.gif", push=0.05,
         label="CODE INTELLIGENCE", title="A real\ncode graph.",
         vo="Multi-repo workspaces with a real code graph. Index your repos, then find any symbol across all of them.",
         sub="/index · /find — tree-sitter ranked"),
    dict(id="collab", type="gif", src="demo-collab.gif", push=0.05,
         label="LIVE COLLAB", title="Pair-program,\nlive.",
         vo="Pair-program live. Encrypted relay, with invite codes, turn tokens, and real-time sync between terminals.",
         sub="/share · /peers · /handoff"),
    dict(id="ultra", type="gif", src="demo-ultra.gif", push=0.04,
         label="/ULTRAPLAN", title="One goal.\nParallel scouts.",
         vo="Ultra-plan fans a goal out to parallel scouts, and merges one prioritized plan in a single command.",
         sub="parallel scout subagents"),
    dict(id="goat", type="gif", src="demo-goatmode.gif", push=0.05, flash=True,
         label="GOAT MODE", title="Unchained.",
         vo="Shift-tab to Goat Mode: every tool auto-approves, mid-turn. Unchained, when you need velocity.",
         sub="bypass that actually bypasses"),
    dict(id="cta", type="card", flash=True,
         vo="One eighty-five megabyte binary. MIT forever. Install GoatCode today.",
         sub=""),
]

GOAT_ASCII = [
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

# ---------------------------------------------------------------- overlays
_VIG = None
def vig() -> np.ndarray:
    global _VIG
    if _VIG is None:
        yy = np.linspace(-1, 1, H)[:, None]
        xx = np.linspace(-1, 1, W)[None, :]
        r = np.sqrt((xx * 1.15) ** 2 + (yy * 0.62) ** 2)
        _VIG = (np.clip((r - 0.78) / 0.55, 0, 1) ** 1.6 * 0.42)[..., None].astype(np.float32)
    return _VIG


GRAIN = (((np.random.default_rng(7).integers(0, 36, (H, W)).astype(np.float32) - 18)
          / 255.0) * 14)[..., None].astype(np.float32)

_FC: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}
def F(path: str, size: int):
    k = (path, size)
    if k not in _FC:
        _FC[k] = ImageFont.truetype(path, size)
    return _FC[k]


def decorate(base: Image.Image) -> Image.Image:
    """Film treatment on the finished 1080x1920 composite: vignette + fine grain."""
    arr = np.asarray(base.convert("RGB"), dtype=np.float32)
    bg = np.asarray(BG, dtype=np.float32)
    out = arr * (1 - vig()) + bg * vig()
    out = np.clip(out + GRAIN, 0, 255).astype(np.uint8)
    return Image.fromarray(out)


def blank() -> Image.Image:
    return Image.new("RGB", (W, H), BG)


def chrome(img: Image.Image, label: str):
    d = ImageDraw.Draw(img)
    if label:
        f = F(MONO, 30)
        tw = d.textlength(label, font=f)
        d.rounded_rectangle([26, 26, 26 + int(tw) + 36, 86], radius=10, fill=WINE)
        d.text((44, 44), label, font=f, fill=TEXT)
    ver = "v3.0.4 · MIT"
    f2 = F(MONO, 26)
    d.text((W - d.textlength(ver, font=f2) - 30, 46), ver, font=f2, fill=DIM)
    d.line([0, H - 6, W, H - 6], fill=WINE_HI, width=6)


def paste_terminal(canvas: Image.Image, term: Image.Image, top: int, scale: float):
    w, h = term.size
    s = (980 / w) * scale
    img = term.resize((max(2, int(w * s)), max(2, int(h * s))), Image.LANCZOS)
    canvas.paste(img, ((W - img.width) // 2, top))


def draw_title(img: Image.Image, title: str, i: int):
    """Lower-third animated title: rise+fade in, hold, fade out (RGBA overlay)."""
    total = TITLE_IN + TITLE_HOLD + TITLE_OUT
    if i >= total:
        return
    if i < TITLE_IN:
        k = i / TITLE_IN
        k = 1 - (1 - k) ** 3                     # ease-out cubic
    elif i < TITLE_IN + TITLE_HOLD:
        k = 1.0
    else:
        k = 1 - (i - TITLE_IN - TITLE_HOLD) / TITLE_OUT
    alpha = max(0.0, min(1.0, k))
    rise = int((1 - alpha) * 36)
    f = F(HEAD, 68)
    lines = title.split("\n")
    lh = 84
    block = len(lines) * lh
    y0 = H - 300 - block                          # clears caption band (MV=300)
    ov = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    tw = max(d.textlength(l, font=f) for l in lines)
    x0 = (W - tw) / 2
    d.rectangle([x0 - 10, y0 + rise, x0 + tw + 10, y0 + block + rise],
                fill=(10, 9, 8, int(130 * alpha)))
    for n, ln in enumerate(lines):
        d.text((W // 2, y0 + n * lh + lh // 2 + rise), ln, font=f,
               fill=TEXT + (int(255 * alpha),), anchor="mm")
    d.rectangle([W / 2 - 44, y0 + block + rise, W / 2 + 44, y0 + block + 5 + rise],
                fill=(178, 58, 78, int(255 * alpha)))
    img.paste(ov, (0, 0), ov)

# ---------------------------------------------------------------- 1. voiceover
def synth_voiceover() -> list[Path]:
    import edge_tts
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    wavs: list[Path] = []

    async def allv():
        for i, sc in enumerate(SCENES):
            mp3 = AUDIO_DIR / f"seg{i:02d}.mp3"
            wav = AUDIO_DIR / f"seg{i:02d}.wav"
            await edge_tts.Communicate(sc["vo"], VOICE, rate=VO_RATE).save(str(mp3))
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3),
                            "-ar", str(SR), "-ac", "1", str(wav)], check=True)
            wavs.append(wav)
            print(f"   vo {sc['id']:9s} {wav_dur(wav):.1f}s")
    asyncio.run(allv())
    return wavs


def wav_dur(p: Path) -> float:
    with wave.open(str(p), "rb") as w:
        return w.getnframes() / w.getframerate()


def wav_read(p: Path) -> np.ndarray:
    with wave.open(str(p), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0

# ---------------------------------------------------------------- 2. sound design
def env_exp(n: int, decay: float) -> np.ndarray:
    return np.exp(-np.arange(n) / SR * decay).astype(np.float32)


def sound_bed(total: float, cut_times: list[float], cta_start: float) -> np.ndarray:
    n = int(total * SR)
    t = np.arange(n, dtype=np.float32) / SR
    bed = np.zeros(n, np.float32)
    # minimal sub-drone + soft 100bpm pulse
    lfo = 0.75 + 0.25 * np.sin(2 * np.pi * 0.21 * t)
    bed += (0.05 * lfo * (np.sin(2 * np.pi * 55 * t) + 0.6 * np.sin(2 * np.pi * 82.4 * t))).astype(np.float32)
    ph = (t % 0.6) / 0.6
    bed += (0.045 * np.sin(2 * np.pi * 48 * t) * np.exp(-ph * 13)).astype(np.float32)
    rng = np.random.default_rng(11)
    def add(i0: int, sig: np.ndarray):
        ln = len(sig)
        i1 = min(i0 + ln, n)
        if i0 < n:
            bed[i0:i1] += sig[: i1 - i0]
    # whoosh at each scene cut
    for ct in cut_times:
        ln = int(0.32 * SR)
        i0 = int(ct * SR)
        wsn = rng.standard_normal(ln) * np.hanning(ln)
        add(i0, (0.5 * np.diff(wsn, prepend=0.0)).astype(np.float32))
    # riser into the end card + sub impact
    rlen = int(2.0 * SR)
    rn = rng.standard_normal(rlen)
    ramp = (np.linspace(0, 1, rlen) ** 2.4 * np.hanning(rlen)).astype(np.float32)
    add(max(0, int((cta_start - 2.0) * SR)), (0.12 * rn * ramp).astype(np.float32))
    ilen = int(0.6 * SR)
    it = (np.arange(ilen) / SR).astype(np.float32)
    add(int(cta_start * SR), (0.22 * np.sin(2 * np.pi * 46 * it) * np.exp(-it * 6.5)).astype(np.float32))
    return bed

# ---------------------------------------------------------------- 3. frames
def gif_frames(path: str) -> list[Image.Image]:
    im = Image.open(ASSETS / path)
    out = []
    for i in range(im.n_frames):
        im.seek(i)
        out.append(Image.fromarray(np.asarray(im.convert("RGB"))))
    return out


_CACHE: dict[str, list[Image.Image]] = {}
def raw_frames(src: str) -> list[Image.Image]:
    """Native GIF frames, undecorated — film treatment happens on the composite."""
    if src not in _CACHE:
        _CACHE[src] = gif_frames(src)
    return _CACHE[src]


def term_scale(i: int, n: int, sc: dict) -> float:
    s = 1.0
    if i < PUNCH_F:
        s *= PUNCH_K - (PUNCH_K - 1) * (i / PUNCH_F)
    push = sc.get("push", 0)
    if push:
        s *= 1 + push * (i / max(n - 1, 1))
    return s


def flash_on(img: Image.Image, sc: dict, i: int) -> Image.Image:
    if sc.get("flash") and i < 2:
        return Image.blend(img, Image.new("RGB", (W, H), (255, 255, 255)), 0.55)
    return img


def gif_scene_iter(sc: dict, n: int):
    src = raw_frames(sc["src"])
    k = len(src)
    for i in range(n):
        fr = src[min(i // GIF_STEP, k - 1)]
        img = blank()
        paste_terminal(img, fr, TERM_TOP, term_scale(i, n, sc))
        chrome(img, sc["label"])
        draw_title(img, sc["title"], i)
        img = decorate(img)
        yield flash_on(img, sc, i)


def still_scene_iter(sc: dict, n: int):
    src = raw_frames(sc["src"])
    fr0 = src[sc["fr"]]
    for i in range(n):
        img = blank()
        paste_terminal(img, fr0, TERM_TOP, term_scale(i, n, sc))
        chrome(img, sc["label"])
        draw_title(img, sc["title"], i)
        yield decorate(img)


def card_frame_base():
    base = blank()
    d = ImageDraw.Draw(base)
    fm = F(MONO, 34)
    lw = max(d.textlength(l, font=fm) for l in GOAT_ASCII)
    x0 = int((W - lw) / 2)
    y0 = 330
    for k, row in enumerate(GOAT_ASCII):
        d.text((x0, y0 + k * 42), row, font=fm, fill=GLOW)
    d.text((W // 2, y0 + len(GOAT_ASCII) * 42 + 86), "GoatCode", font=F(HEAD, 96),
           fill=TEXT, anchor="mm")
    d.text((W // 2, y0 + len(GOAT_ASCII) * 42 + 172), "Every provider. One terminal.",
           font=F(SANS, 40), fill=DIM, anchor="mm")
    cmd = "$ npm install -g goatcode-cli"
    fc = F(MONO, 42)
    tw = d.textlength(cmd, font=fc)
    bx0, bx1 = int(W / 2 - tw / 2 - 34), int(W / 2 + tw / 2 + 34)
    d.rounded_rectangle([bx0, 1190, bx1, 1284], radius=14, fill=PANEL, outline=BORDER, width=2)
    d.text((W // 2, 1237), cmd, font=fc, fill=GLOW, anchor="mm")
    d.text((W // 2, 1368), "MIT · $0 forever · 85 MB binary", font=F(SANS, 36),
           fill=DIM, anchor="mm")
    d.text((W // 2, 1442), "github.com/Arhan-w/GoatCode", font=F(MONO, 36),
           fill=WINE_HI, anchor="mm")
    chrome(base, "")
    return base, (bx0, bx1)


_CARD: tuple[Image.Image, tuple[int, int]] | None = None


def card_scene_iter(sc: dict, n: int):
    global _CARD
    if _CARD is None:
        base, box = card_frame_base()
        _CARD = (decorate(base), box)
    base, (bx0, bx1) = _CARD
    for i in range(n):
        img = base.copy()
        if int(i / FPS * 1.6) % 2 == 0:
            dd = ImageDraw.Draw(img)
            dd.rectangle([bx1 + 16, 1216, bx1 + 36, 1258], fill=GLOW)
        yield flash_on(img, sc, i)


def encode_scene(sc: dict, n: int) -> Path:
    SCENE_DIR.mkdir(parents=True, exist_ok=True)
    out = SCENE_DIR / f"{sc['id']}.mp4"
    it = (card_scene_iter if sc["type"] == "card"
          else still_scene_iter if sc["type"] == "still" else gif_scene_iter)(sc, n)
    proc = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "fast",
         "-crf", "15", "-pix_fmt", "yuv420p", str(out)],
        stdin=subprocess.PIPE)
    assert proc.stdin
    for fr in it:
        proc.stdin.write(fr.tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit(f"scene encode failed: {sc['id']}")
    return out

# ---------------------------------------------------------------- 4. captions (karaoke)
def ts(t: float) -> str:
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def karaoke_line(sc: dict, a: float, b: float) -> str | None:
    words = (sc.get("sub") or "").split()
    if not words:
        return None
    chars = sum(len(w) + 1 for w in words)
    span_cs = max(int((b - a) * 100), 20)
    per = span_cs / max(chars, 1)
    acc = 0.0
    out: list[str] = []
    line_len = 0
    for w in words:
        target = acc + (len(w) + 1) * per
        k = max(round(target) - round(acc), 1)
        acc = target
        if line_len + len(w) + 1 > 26:
            out.append("\\N")
            line_len = 0
        out.append(f"{{\\kf{k}}}{w}")
        line_len += len(w) + 1
    return "{\\fad(120,160)}" + " ".join(out).replace(" \\N", "\\N")


def build_ass(durs: list[float], starts: list[float], path: Path):
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Segoe UI Black,60,&H00F3F4F2,&H008E919A,&H000A0908,&H000A0908,1,0,0,100,100,1,0,1,6,0,2,74,74,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for sc, d, st in zip(SCENES, durs, starts):
        txt = karaoke_line(sc, st + PAD_PRE, st + d - 0.03)
        if txt:
            lines.append(f"Dialogue: 0,{ts(st + PAD_PRE)},{ts(st + d - 0.03)},Cap,,0,0,0,,{txt}")
    path.write_text(head + "\n".join(lines) + "\n", encoding="utf-8")

# ---------------------------------------------------------------- 5. assemble
def main():
    print("1/5 voiceover (edge-tts)…")
    wavs = synth_voiceover()
    durs = [wav_dur(w) + PAD_PRE + PAD_POST for w in wavs]
    total = sum(durs)
    starts, t = [], 0.0
    for d in durs:
        starts.append(t); t += d
    print(f"   total {total:.1f}s")

    print("2/5 audio (voice + sound design)…")
    pre = AUDIO_DIR / "pre.wav"; post = AUDIO_DIR / "post.wav"
    for name, sec in ((pre, PAD_PRE), (post, PAD_POST)):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                        "-i", f"anullsrc=r={SR}:cl=mono", "-t", str(sec), str(name)], check=True)
    a_in = []
    for w in wavs:
        a_in += ["-i", str(pre), "-i", str(w), "-i", str(post)]
    seg = "".join(f"[{i}:a]" for i in range(3 * len(wavs)))
    vo = AUDIO_DIR / "vo.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error"] + a_in +
                   ["-filter_complex", f"{seg}concat=n={3*len(wavs)}:v=0:a=1[a]",
                    "-map", "[a]", "-ar", str(SR), str(vo)], check=True)
    voc = wav_read(vo)
    n_tot = int(total * SR)
    voc = np.resize(voc, n_tot) if len(voc) != n_tot else voc
    voc = voc / (np.max(np.abs(voc)) or 1.0) * 0.82
    bed = sound_bed(total, starts[1:], cta_start=starts[-1])
    mix = np.clip(voc + bed[: len(voc)], -1, 1)
    mixf = AUDIO_DIR / "mix.wav"
    with wave.open(str(mixf), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((mix * 32767).astype(np.int16).tobytes())

    print("3/5 encoding scenes…")
    outs = []
    for sc, d in zip(SCENES, durs):
        n = round(d * FPS)
        outs.append(encode_scene(sc, n))
        print(f"   {sc['id']:9s} {n:4d}f")
    (WORK / "vlist.txt").write_text("\n".join(f"file '{p.as_posix()}'" for p in outs),
                                    encoding="utf-8")
    joined = WORK / "joined.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                    "-i", str(WORK / "vlist.txt"), "-c", "copy", joined], check=True)

    print("4/5 captions…")
    cap = WORK / "captions.ass"
    build_ass(durs, starts, cap)

    print("5/5 master (burn captions, loudnorm −14 LUFS)…")
    out = HERE / "goatcode-reel.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "warning", "-stats",
                    "-i", str(joined), "-i", str(mixf),
                    "-vf", "subtitles=work/captions.ass:fontsdir='C\\:/Windows/Fonts'",
                    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k",
                    "-af", "loudnorm=I=-14:TP=-1.2:LRA=9,alimiter=limit=0.95",
                    "-ar", "48000", "-shortest", "-movflags", "+faststart",
                    str(out)], check=True, cwd=str(HERE))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(out), "-ss", "1.0",
                    "-frames:v", "1", str(HERE / "reel-thumb.jpg")], check=True)
    print("done:", out, f"({out.stat().st_size/1e6:.1f} MB, {total:.1f}s)")


if __name__ == "__main__":
    main()
