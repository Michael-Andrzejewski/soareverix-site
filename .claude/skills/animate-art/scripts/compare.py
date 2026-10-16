#!/usr/bin/env python3
"""Score rendered frames against the source still and make review sheets.

    python3 compare.py --src source.webp --frames framesdir [--out reviewdir] [--every 15]

Prints PSNR / SSIM / mean abs error per sampled frame and overall, and writes:
  side_by_side.png  original | frame 0 | middle frame | abs-diff heat map
  contact.png       grid of sampled frames (motion at a glance)
  metrics.json
Reading the numbers: frame 0 should be near-identical (PSNR > 30 dB, SSIM > 0.9);
later frames drop a little because things have moved, which is the point. A
sudden drop at one frame usually means a pop (a particle respawning visibly).
"""
import argparse
import glob
import json
import os

import numpy as np
from PIL import Image, ImageDraw
from skimage.metrics import peak_signal_noise_ratio as psnr
from skimage.metrics import structural_similarity as ssim


def load(p, size=None):
    im = Image.open(p).convert("RGB")
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im)


def label(im, text):
    im = im.copy()
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 8 + 7 * len(text), 18], fill=(0, 0, 0))
    d.text((4, 3), text, fill=(255, 255, 255))
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--frames", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--every", type=int, default=15)
    a = ap.parse_args()
    out = a.out or a.frames.rstrip("/") + "_review"
    os.makedirs(out, exist_ok=True)

    files = sorted(glob.glob(os.path.join(a.frames, "*.png")))
    if not files:
        raise SystemExit("no frames found")
    first = Image.open(files[0])
    src = load(a.src, first.size)
    picks = files[:: a.every]
    rows = []
    for f in picks:
        fr = load(f)
        rows.append({
            "frame": os.path.basename(f),
            "psnr": float(psnr(src, fr, data_range=255)),
            "ssim": float(ssim(src, fr, channel_axis=2, data_range=255)),
            "mae": float(np.abs(src.astype(np.float32) - fr).mean()),
        })
        print(f"{rows[-1]['frame']}  PSNR {rows[-1]['psnr']:.2f} dB  SSIM {rows[-1]['ssim']:.4f}  MAE {rows[-1]['mae']:.2f}")
    summ = {k: float(np.mean([r[k] for r in rows])) for k in ("psnr", "ssim", "mae")}
    summ["min_ssim"] = float(min(r["ssim"] for r in rows))
    print("mean  PSNR {psnr:.2f} dB  SSIM {ssim:.4f}  MAE {mae:.2f}  (min SSIM {min_ssim:.4f})".format(**summ))
    json.dump({"summary": summ, "frames": rows}, open(os.path.join(out, "metrics.json"), "w"), indent=1)

    f0, fm = load(files[0]), load(files[len(files) // 2])
    diff = np.abs(src.astype(np.int16) - fm.astype(np.int16)).sum(-1)
    heat = np.clip(diff * 2, 0, 255).astype(np.uint8)
    heat = np.stack([heat, (heat * 0.4).astype(np.uint8), 255 - heat], -1)
    tiles = [label(Image.fromarray(src), "original"), label(Image.fromarray(f0), os.path.basename(files[0])),
             label(Image.fromarray(fm), os.path.basename(files[len(files) // 2])), label(Image.fromarray(heat), "diff (mid)")]
    w, h = tiles[0].size
    sheet = Image.new("RGB", (w * 4, h))
    for i, t in enumerate(tiles):
        sheet.paste(t, (i * w, 0))
    sheet.resize((w * 2, h // 2)).save(os.path.join(out, "side_by_side.png"))

    n = min(12, len(files))
    idx = np.linspace(0, len(files) - 1, n).astype(int)
    th = [label(Image.open(files[i]).convert("RGB").resize((w // 3, h // 3)), os.path.basename(files[i])) for i in idx]
    cols = 6
    contact = Image.new("RGB", (cols * (w // 3), ((n + cols - 1) // cols) * (h // 3)))
    for k, t in enumerate(th):
        contact.paste(t, ((k % cols) * (w // 3), (k // cols) * (h // 3)))
    contact.save(os.path.join(out, "contact.png"))
    print(f"review sheets in {out}")


if __name__ == "__main__":
    main()
