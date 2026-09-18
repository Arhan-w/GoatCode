# Assemble: scene dirs -> 10 clips w/ xfade -> mux VO+bed -> final reel.mp4 (1080x1920, 24fps, h264+aac)
import subprocess, json, math
from pathlib import Path

HERE = Path(__file__).parent
FPS = 24
GAP = 0.5

def dur(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True)
    return float(r.stdout.strip())

SEG = [dur(HERE / f"vo_{i:02d}.mp3") for i in range(10)]
SCENE = [s + GAP for s in SEG]

def render(n):
    return int(round(n * FPS))

# build per-scene frame counts from dirs
counts = []
for i in range(10):
    d = HERE / f"scene_{i:02d}"
    counts.append(len(list(d.glob("f*.png"))))
    print("scene", i, counts[-1], "frames (want", render(SCENE[i]), ")")

XF = 0.35  # xfade seconds
xf_frames = int(round(XF * FPS))

# 1) encode each scene to mp4 (exact frame counts; skip extra frames so scenes align to VO offsets)
clips = []
for i, n in enumerate(counts):
    src = HERE / f"scene_{i:02d}" / "f%05d.png"
    out = HERE / f"clip_{i:02d}.mp4"
    end = f"{n / FPS:.4f}"
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-framerate", str(FPS), "-start_number", "0", "-i", str(src),
        "-t", end, "-vf", f"fps={FPS},format=yuv420p", "-c:v", "libx264", "-preset", "medium",
        "-crf", "18", str(out)], check=True)
    clips.append((out, float(end)))
    print("clip", i, end, "s")

# 2) xfade chain
inputs = []
for c, _ in clips: inputs += ["-i", str(c)]
parts = []
chain = "[0:v]"
prev = clips[0][1]
# xfade offset = accumulated duration of the chain so far minus xf
acc = clips[0][1]
for i in range(1, len(clips)):
    off = acc - XF
    outl = f"[v{i}]" if i < len(clips) - 1 else "[vout]"
    parts.append(f"{chain}[{i}:v]xfade=transition=fade:duration={XF}:offset={off:.4f}{outl}")
    chain = outl
    acc = off + clips[i][1]
fc = ";".join(parts)
vmid = HERE / "video_xfaded.mp4"
subprocess.run(["ffmpeg", "-y", "-v", "error"] + inputs + ["-filter_complex", fc, "-map", f"{chain}" if len(clips) == 1 else "[vout]",
                "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-r", str(FPS), str(vmid)], check=True)
vdur = dur(vmid)
print("video:", vdur, "s")

# 3) VO mix: concat each vo with silence padding = GAP, then adelay by cumulative offsets
offsets = []
t = 0.0
for s in SEG:
    offsets.append(int(t * 1000 * (XF * 0)))  # scenes start at 0; xfade shortens total but VO must follow the ON-SCREEN scene timing
    t += s
# with xfades, scene i starts at: sum(clip_len[:i]) - i*XF
CLIP = [c[1] for c in clips]
offsets = [int(max(0.0, sum(CLIP[:i]) - i * XF) * 1000) for i in range(10)]
print("vo offsets:", offsets)

cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(vmid), "-i", str(HERE / "bed.wav")]
for i in range(10):
    cmd += ["-i", str(HERE / f"vo_{i:02d}.mp3")]
# inputs: 0=video, 1=bed.wav, 2..11 = vo_00..vo_09
fcx = ["[1:a]aresample=44100,volume=0.55[bed]"]
for i in range(10):
    fcx.append(f"[{2+i}:a]aresample=44100,adelay={offsets[i]}|{offsets[i]},volume=1.9[v{i}]")
fcx.append("[bed]" + "".join(f"[v{i}]" for i in range(10)) + "amix=inputs=11:duration=longest:normalize=0,aformat=sample_fmts=fltp:channel_layouts=stereo,loudnorm=I=-14:TP=-1.2[aout]")
cmd += ["-filter_complex", ";".join(fcx), "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", str(HERE / "reel_final.mp4")]
subprocess.run(cmd, check=True)
print("FINAL:", dur(HERE / "reel_final.mp4"), "s")
