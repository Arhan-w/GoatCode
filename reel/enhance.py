# AI Video Editor - Enhanced GoatCode reel
# Uses ffmpeg drawtext for captions (reliable), color grade, SFX mix
import json, subprocess, numpy as np, wave, re
from pathlib import Path

HERE = Path(__file__).parent
REEL = HERE / "reel_final.mp4"
OUT = HERE / "reel_enhanced.mp4"
ASSETS = HERE / "assets"
for d in [ASSETS/x for x in ["sfx","overlays"]]: d.mkdir(exist_ok=True)
PROJECT = HERE / "project"
PROJECT.mkdir(exist_ok=True)

# ── Transcript (word-level timestamps) ─────────────────────────────────────
script = json.load(open(HERE / "script.json"))
segments = []
t = 0.0
for seg_text in script:
    words = seg_text.split()
    dur = 2.0
    w_t = t
    for w in words:
        w_dur = dur / len(words)
        segments.append({"word": w.lower().strip(".,;:!?'\""), "start": round(w_t, 3), "end": round(w_t+w_dur, 3)})
        w_t += w_dur
    segments.append({"word": "|", "start": round(t, 3), "end": round(t+dur, 3), "gap": True})
    t += dur + 0.5

# Build drawtext filter for each segment
drawtexts = []
for i, seg in enumerate(segments):
    if seg.get("gap"): continue
    start = seg["start"]
    duration = seg["end"] - seg["start"]
    # Escape special chars for ffmpeg
    word = seg["word"].upper().replace("'", "'").replace('"', '"')
    # Pulse animation via text_color keyframes
    kf = f"keyframe({int(start*1000)}):white@0:keyframe({int((start+0.1)*1000)}):yellow@0:keyframe({int((start+0.2)*1000)}):white@0"
    drawtexts.append(f"drawtext=text='{word}':x=(w-text_w)/2:y=h-220:fontsize=56:fontcolor=white:borderw=3:bordercolor=black@0.8:enable='between(t,{start},{seg['end']})'")
drawtext_filter = ",".join(drawtexts)

print(f"drawtext: {len(drawtexts)} captions")

# ── SFX ────────────────────────────────────────────────────────────────────
print("Generating SFX...")
SR = 44100
DUR = 52
t_arr = np.linspace(0, DUR, int(SR*DUR), endpoint=False)
SCENE_DURS = [2.64, 1.87, 2.14, 1.87, 2.62, 3.50, 1.87, 4.30, 3.58, 3.58, 2.00, 4.25, 3.58, 3.14, 2.26, 1.97]
SCENES = []
t = 0.0
for d in SCENE_DURS:
    SCENES.append({"start": round(t, 3), "end": round(t+d, 3), "dur": round(d, 3)})
    t += d

def whoosh(tt, dur=0.15):
    return np.exp(-((tt - dur/2)**2) / (2*(dur/6)**2)) * np.sin(2*np.pi*400*tt) * 0.3
def pop(tt):
    env = np.exp(-tt*40) * (tt > 0)
    return np.sin(2*np.pi*800*tt) * env * 0.2
def impact(tt):
    env = np.exp(-tt*20) * (tt > 0)
    return np.sin(2*np.pi*60*tt) * env * 0.5
sfx = np.zeros_like(t_arr)
for i in range(0, len(SCENES), 2):
    ts = SCENES[i]["start"]
    sfx += whoosh(t_arr - ts, 0.12) * 0.3
    sfx += pop(t_arr - ts - 0.05) * 0.2
for i in range(0, len(SCENES), 6):
    ts = SCENES[i]["start"] + SCENES[i]["dur"]/2
    sfx += impact(t_arr - ts) * 0.4
sfx = np.clip(sfx, -0.8, 0.8)
pcm_sfx = (sfx*32767).astype(np.int16)
subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", "44100",
               "-ac", "2", "-i", "-", "-c:a", "mp3",
               str(ASSETS/"sfx/sfx.mp3")], input=pcm_sfx.tobytes(), check=True)
print("sfx ok")

# ── Assembly ───────────────────────────────────────────────────────────────
print("Assembling...")
cmd = [
    "ffmpeg", "-y", "-v", "error",
    "-i", str(REEL),
    "-i", str(PROJECT / "captions.mp4"),
    "-i", str(ASSETS / "sfx/sfx.mp3"),
    "-i", str(ASSETS / "bed.wav"),
    "-filter_complex",
    """
    [0:v]scale=1080:1920,format=yuv420p[base];
    [1:v]scale=1080:1920[cap];
    [base][cap]overlay=0:0[vout];
    [3:a]volume=0.55,apad=whole_dur=52[bed];
    [2:a]volume=0.35,apad=whole_dur=52[sfx];
    [bed][sfx]amix=inputs=2:duration=first[aout]
    """,
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    str(OUT)
]
subprocess.run(cmd, check=True)
print(f"RENDERED: {OUT}")

# QC
r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration,size",
                   "-of", "csv=p=0", str(OUT)], capture_output=True, text=True)
print(r.stdout.strip())
