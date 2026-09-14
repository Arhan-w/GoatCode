# Minimal dark ambient bed under the VO: slow filtered pad + soft pulse. numpy.
import numpy as np, subprocess, wave
SR = 44100
TOTAL = 52.0
t = np.linspace(0, TOTAL, int(SR * TOTAL), endpoint=False)

def pad(freq, t, amp, atk=2.5, rel=3.0):
    env = np.minimum(1.0, t / atk)
    tail = np.maximum(0.0, (t - (TOTAL - rel)) / rel)
    env = env * (1 - tail)
    x = np.sin(2 * np.pi * freq * t) + 0.5 * np.sin(2 * np.pi * freq * 2.001 * t)
    x = x + 0.35 * np.sin(2 * np.pi * freq * 0.5 * t)
    # gentle chorus wobble
    x *= 1 + 0.06 * np.sin(2 * np.pi * 0.13 * t)
    return amp * x * env

# A-minor-ish dark chord, low register: A1 E2 A2 C3-ish (use pure ratios)
chord = [55.0, 82.41, 110.0, 130.81]
bed = np.zeros_like(t)
for f in chord:
    bed += pad(f, t, 0.16)
# soft heartbeat pulse: 100 BPM, very low, filtered thump
bpm = 100.0
period = 60.0 / bpm
pulse = np.zeros_like(t)
for start in np.arange(0.3, TOTAL - 0.2, period):
    idx = (t >= start) & (t < start + 0.22)
    tt = t[idx] - start
    pulse[idx] += np.sin(2 * np.pi * 48 * tt) * np.exp(-tt * 14) * 0.5
    idx2 = (t >= start + 0.02) & (t < start + 0.3)
    tt2 = t[idx2] - start
    pulse[idx2] += np.sin(2 * np.pi * 36 * tt2) * np.exp(-tt2 * 10) * 0.35
bed = bed + pulse * 0.8
# subtle noise shimmer (highpassed by differencing)
noise = np.random.default_rng(7).normal(0, 1, len(t))
shimmer = noise - np.concatenate([[0], noise[:-1]])
bed += shimmer * 0.006
# fade in/out
fade = int(SR * 1.6)
bed[:fade] *= np.linspace(0, 1, fade)
bed[-int(SR * 2.5):] *= np.linspace(1, 0, int(SR * 2.5))
bed = np.tanh(bed * 1.4) * 0.85
pcm = (bed * 32767).astype(np.int16)
with wave.open("bed.wav", "w") as w:
    w.setnchannels(1); w.setframerate(SR); w.setsampwidth(2)
    w.writeframes(pcm.tobytes())
print("bed.wav", round(len(t) / SR, 1), "s")
