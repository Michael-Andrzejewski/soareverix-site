#!/usr/bin/env python3
"""Measure how much an animation moves, so intensity can be compared, not guessed.

    python3 motion.py <framesdir> [<framesdir> ...] [--fps 60] [--step 6]

Optical flow (Farneback) between sampled consecutive frames, all resized to 512 px
tall so different resolutions compare fairly. Speeds are in frame heights per second.
  mean speed   average motion over the whole frame
  p90          speed of the fastest-moving 10% of the frame
  moving       share of the frame moving faster than 5% of its height per second
  change       mean luminance change per frame step

Reference points (60 fps):
  ascension v3 (rising storm, accepted as intense)   mean 0.078  p90 0.17  moving 54%
  maelstrom (swirl + 2.8x zoom)                      mean 0.53   p90 0.90  moving 95%
  ascension v1 (rejected as "far too mild")          most of the frame static; aim well above it
"""
import argparse
import glob
import os

import cv2
import numpy as np


def measure(d, fps=60, step=6, height=512):
    fs = sorted(glob.glob(os.path.join(d, "*.png")))
    rows = []
    for i in range(0, len(fs) - 1, step):
        a = cv2.imread(fs[i], cv2.IMREAD_GRAYSCALE)
        b = cv2.imread(fs[i + 1], cv2.IMREAD_GRAYSCALE)
        w = int(a.shape[1] * height / a.shape[0])
        a = cv2.resize(a, (w, height), interpolation=cv2.INTER_AREA)
        b = cv2.resize(b, (w, height), interpolation=cv2.INTER_AREA)
        f = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 4, 21, 5, 7, 1.5, 0)
        m = np.hypot(f[..., 0], f[..., 1]) * fps / height
        rows.append((m.mean(), np.percentile(m, 90), (m > 0.05).mean(), np.abs(a.astype(float) - b).mean()))
    return np.array(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--fps", type=float, default=60)
    ap.add_argument("--step", type=int, default=6)
    a = ap.parse_args()
    for d in a.dirs:
        r = measure(d, a.fps, a.step)
        print(f"{d}: mean {r[:, 0].mean():.3f} H/s (peak {r[:, 0].max():.3f}) | p90 {r[:, 1].mean():.3f} "
              f"(peak {r[:, 1].max():.3f}) | moving {r[:, 2].mean():.0%} | change {r[:, 3].mean():.2f}")


if __name__ == "__main__":
    main()
