# Extend endcard scene_09 to ~4.6s and rebuild clips/final.
import shutil
from pathlib import Path
d = Path("scene_09")
fs = sorted(d.glob("f*.png"))
n = len(fs)
want = int(4.6 * 24)
for k in range(n, want):
    shutil.copy(fs[-1], d / f"f{k:05d}.png")
print("endcard frames:", len(sorted(d.glob('f*.png'))))
