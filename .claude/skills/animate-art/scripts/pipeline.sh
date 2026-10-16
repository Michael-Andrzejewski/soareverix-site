#!/usr/bin/env bash
# One command from build script to verified MP4.
#   pipeline.sh <artdir> [fps=60] [seconds=<scene loop>]
# Expects <artdir>/build_scene.py and <artdir>/source.* ; writes into <artdir>/out/:
#   frames/  review/ (metrics + sheets)  <name>.mp4  <name>.poster.png  <name>.html (single file)
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
dir=${1:?artdir}; fps=${2:-60}
name=$(basename "$(cd "$dir" && pwd)")
src=$(ls "$dir"/source.* | head -1)
out="$dir/out"; mkdir -p "$out"

echo "== build scene"
python3 "$dir/build_scene.py"
seconds=${3:-$(python3 -c "import json,re;s=open('$dir/scene.js').read();print(json.loads(s[s.index('{'):s.rindex('}')+1])['loop'])")}

echo "== capture ${seconds}s at ${fps} fps"
rm -rf "$out/frames"
node "$KIT/capture.mjs" "$dir/index.html" "$out/frames" --fps "$fps" --seconds "$seconds"

echo "== compare against $src"
python3 "$KIT/compare.py" --src "$src" --frames "$out/frames" --out "$out/review" --every "$fps" | tail -3

echo "== loop seam"
python3 - "$out/frames" <<'EOF'
import glob, sys
import numpy as np
from PIL import Image
fs = sorted(glob.glob(sys.argv[1] + "/*.png"))
step = lambda a, b: np.abs(np.asarray(Image.open(a), np.int16) - np.asarray(Image.open(b), np.int16)).mean()
mid = [step(fs[i], fs[i + 1]) for i in range(0, len(fs) - 1, max(1, len(fs) // 40))]
seam = step(fs[-1], fs[0])
print(f"seam step {seam:.3f} vs typical {np.median(mid):.3f} (max {max(mid):.3f})" + ("  <-- POP AT LOOP" if seam > 2 * max(mid) else "  ok"))
EOF

echo "== encode"
"$KIT/encode.sh" "$out/frames" "$out/$name.mp4" "$fps"

echo "== single-file page"
python3 "$KIT/bundle.py" "$dir/index.html" "$out/$name.html"
echo "done: $out"
