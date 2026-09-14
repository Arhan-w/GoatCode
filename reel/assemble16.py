# Assemble 16 scenes -> clips w/ xfade -> mux VO+bed -> final reel.mp4 (1080x1920, 24fps)
import subprocess
from pathlib import Path

HERE = Path(__file__).parent
FPS = 24
XF = 0.35  # xfade seconds

def dur(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True)
    return float(r.stdout.strip())

SEG = [dur(HERE / f"vo_{i:02d}.mp3") for i in range(16)]
GAP = 0.5
SCENE = [s + GAP for s in SEG]
N = 16

# 1) encode each scene dir to a clip mp4 (use exactly the rendered frames)
clips = []
for i in range(N):
    d = HERE / f"scene_{i:02d}"
    n = len(list(d.glob("f*.png")))
    out = HERE / f"clip_{i:02d}.mp4"
    end = f"{n / FPS:.4f}"
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-framerate", str(FPS), "-start_number", "0",
        "-i", str(d / "f%05d.png"), "-t", end,
        "-vf", f"fps={FPS},format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", str(out)], check=True)
    clips.append(float(end))
    print("clip", i, end, "s", flush=True)

# 2) xfade chain
inputs = []
for c in clips: inputs += ["-i", str(HERE / f"clip_{N-1-len(clips)+len([x for x in clips if x==c])-1:02d}.mp4")] if False else []
inputs = []
for i in range(N): inputs += ["-i", str(HERE / f"clip_{i:02d}.mp4")]
parts = []
chain = "[0:v]"
acc = clips[0]
for i in range(1, N):
    off = acc - XF
    outl = f"[v{i}]" if i < N - 1 else "[vout]"
    parts.append(f"{chain}[{i}:v]xfade=transition=fade:duration={XF}:offset={off:.4f}{outl}")
    chain = outl
    acc = off + clips[i]
fc = ";".join(parts)
vmid = HERE / "video_xfaded.mp4"
subprocess.run(["ffmpeg", "-y", "-v", "error"] + inputs + ["-filter_complex", fc, "-map", "[vout]",
                "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-r", str(FPS), str(vmid)], check=True)
print("video:", dur(vmid), "s")

# 3) audio: VO segments adelayed at the on-screen scene starts + bed under, loudnorm
# with xfade, scene i visible start = sum(clips[:i]) - i*XF
offsets = [int(max(0.0, sum(clips[:i]) - i * XF) * 1000) for i in range(N)]
print("vo offsets:", offsets)

cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(vmid), "-i", str(HERE / "bed.wav")]
for i in range(N):
    cmd += ["-i", str(HERE / f"vo_{i:02d}.mp3")]
fcx = ["[1:a]aresample=44100,volume=0.5[bed]"]
for i in range(N):
    fcx.append(f"[{2+i}:a]aresample=44100,adelay={offsets[i]}|{offsets[i]},volume=1.9[v{i}]")
fcx.append("[bed]" + "".join(f"[v{i}]" for i in range(N)) + f"amix=inputs={N+1}:duration=longest:normalize=0,aformat=sample_fmts=fltp:channel_layouts=stereo,loudnorm=I=-14:TP=-1.2[aout]")
cmd += ["-filter_complex", ";".join(fcx), "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", str(HERE / "reel_final.mp4")]
subprocess.run(cmd, check=True)
print("FINAL:", dur(HERE / "reel_final.mp4"), "s")
