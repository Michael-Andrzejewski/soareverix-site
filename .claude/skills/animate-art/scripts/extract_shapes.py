#!/usr/bin/env python3
"""First look at a new picture: which repeated shapes can be set free, and what is left.

    python3 extract_shapes.py --src picture.png --out /tmp/look [--kind diamond|circle|square]
                              [--ink-lum 42] [--rel 0.55] [--mass-kernel 9] [--mass-area 15000]
                              [--keep-mask keep.png]

Writes to --out:
  debug_shapes.png  detected shapes outlined in yellow, static mass tinted orange,
                    rejected (not shape-like) components boxed in red
  plate.png         the picture with the detected shapes removed and refilled
  mass_mask.png     the static mass (big dark bodies left in the plate)
  shapes.json       {width, height, shapes: [{x, y, r, color}]}

Tune the thresholds here until debug_shapes.png looks right, then copy them into
the artwork's build_scene.py. "Dark shapes on a lighter field" is the default;
for light shapes on dark, pass --invert.
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artkit as ak  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--kind", default="diamond", choices=sorted(ak.SHAPE_DIST))
    ap.add_argument("--ink-lum", type=float, default=42)
    ap.add_argument("--rel", type=float, default=0.55)
    ap.add_argument("--bg-kernel", type=int, default=81)
    ap.add_argument("--mass-kernel", type=int, default=9)
    ap.add_argument("--mass-area", type=int, default=15000)
    ap.add_argument("--min-r", type=float, default=2.0)
    ap.add_argument("--max-r", type=float, default=60.0)
    ap.add_argument("--min-cover", type=float, default=0.72)
    ap.add_argument("--keep-mask", help="png: white = never extract here")
    ap.add_argument("--invert", action="store_true", help="look for light shapes instead of dark")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    img = ak.load_rgb(a.src)
    work = 255 - img if a.invert else img
    H, W = img.shape[:2]
    ink_abs, ink = ak.ink_masks(work, a.ink_lum, a.rel, a.bg_kernel)
    mass = ak.big_components(ink_abs, a.mass_kernel, a.mass_area)
    cand = ink & ~mass
    if a.keep_mask:
        cand &= ~(np.asarray(Image.open(a.keep_mask).convert("L")) > 127)
    shapes, erase, rejected = ak.extract_shapes(img, cand, a.kind, a.min_r, a.max_r, a.min_cover)
    plate = ak.guided_fill(img, erase)

    Image.fromarray(plate).save(os.path.join(a.out, "plate.png"))
    Image.fromarray((mass * 255).astype(np.uint8)).save(os.path.join(a.out, "mass_mask.png"))
    dbg = (img * 0.55).astype(np.uint8)
    dbg[mass] = (dbg[mass] * 0.5 + np.array([120, 30, 0])).clip(0, 255).astype(np.uint8)
    for s in shapes:
        cx, cy, r = s["x"], s["y"], s["r"]
        if a.kind == "circle":
            cv2.circle(dbg, (int(round(cx)), int(round(cy))), int(round(r)), (255, 210, 0), 1, cv2.LINE_AA)
        else:
            pts = ([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]] if a.kind == "diamond"
                   else [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]])
            cv2.polylines(dbg, [np.array(pts, np.int32)], True, (255, 210, 0), 1, cv2.LINE_AA)
    for x, y, w, h in rejected:
        cv2.rectangle(dbg, (x, y), (x + w, y + h), (255, 60, 60), 1)
    Image.fromarray(dbg).save(os.path.join(a.out, "debug_shapes.png"))
    with open(os.path.join(a.out, "shapes.json"), "w") as f:
        json.dump({"width": W, "height": H, "kind": a.kind, "shapes": shapes}, f)
    print(f"{len(shapes)} {a.kind}s extracted, {len(rejected)} components left in the plate, "
          f"static mass covers {mass.mean():.1%}")


if __name__ == "__main__":
    main()
