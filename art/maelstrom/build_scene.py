#!/usr/bin/env python3
"""Build the animated scene for "Maelstrom" from source.webp.

    python3 art/maelstrom/build_scene.py
    .claude/skills/animate-art/scripts/pipeline.sh art/maelstrom

A camera dives into the glowing figure at the eye of the vortex and pulls back out,
once per 12 s loop, while the whole maelstrom swirls three times around it. The swirl
spins fastest and tightens (inner rings run ahead) at full zoom, and relaxes on the
way out. Layers, back to front:
  vortex     the painting itself (figure removed), upscaled 2x and outpainted ring by ring
             so the frame can rotate; swirled, zoomed and motion-blurred by a WebGL shader
  dust       2,200 flecks in the painting's colours spiralling inward with the swirl
  embers     glowing rust motes sucked toward the centre
  figure     the figure, cut out so it stays upright while everything turns around it
  glow       its light, swelling as the camera closes in
  sparks     light thrown off the figure
  streaks    thin bright speed lines racing around the rings
  flecks     big dark brush flecks close to the lens (parallax: they rush past)
"""
import os
import sys

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.join(HERE, "..", "..", ".claude", "skills", "animate-art")
sys.path.insert(0, os.path.join(KIT, "scripts"))
import artkit as ak  # noqa: E402

LOOP = 12.0
SEED = 11
UP = 2                       # master resolution: 2x the source, so the zoom stays sharp
CX, CY = 312, 372            # eye of the vortex = the figure (source px, whole pixels)
FIG_BOX = (292, 330, 336, 482)   # figure + its faint trail (x0, y0, x1, y1), source px
CAMERA = {"cx": CX, "cy": CY, "zmax": 2.8, "revs": 3, "omega0": 0.8, "twist": 1.6, "r0": 110,
          "roll": 0.1, "shutter": 0.025}


def main():
    rng = np.random.default_rng(SEED)
    src = ak.load_rgb(os.path.join(HERE, "source.webp"))
    H, W = src.shape[:2]
    master = ak.upscale(src, UP, sharpen=0.35)
    Lm = ak.luma(master)

    # ------------------------------------------------------------ cut the figure out
    x0, y0, x1, y1 = [v * UP for v in FIG_BOX]
    pad = 40
    cx0, cy0, cx1, cy1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    crop = master[cy0:cy1, cx0:cx1]
    Lc = Lm[cy0:cy1, cx0:cx1]
    box = np.zeros(Lc.shape, bool)
    box[pad:-pad, pad:-pad] = True
    fig = box & (Lc > 38)
    fig = cv2.dilate(fig.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    filled = ak.guided_fill(crop, fig, lengths=(41, 81, 161))
    ink, alpha = ak.unmix(crop.astype(np.float32), filled.astype(np.float32))
    alpha[~fig] = 0
    figure_rgba = np.dstack([np.round(ink).astype(np.uint8), np.round(alpha * 255).astype(np.uint8)])
    plate = master.copy()
    plate[cy0:cy1, cx0:cx1] = filled

    # ------------------------------------------------------------ outpaint for rotation
    corners = [np.hypot(CX - x, CY - y) for x in (0, W) for y in (0, H)]
    R = max(corners) * 1.08 * UP
    canvas, texc, _ = ak.polar_outpaint(plate, (CX * UP, CY * UP), R)

    layers = [{"id": "vortex", "type": "vortex", "src": ak.to_data_uri(canvas, "WEBP", quality=90),
               "texC": list(texc), "up": UP, "vignette": 0.35, "ca": 0.012, "gain": 0.6}]

    # palette: the painting's own visible colours (rust, salmon, blues), brightness-weighted
    Ls = ak.luma(src)
    pal = src[(Ls > 45) & (Ls < 200)].astype(np.float32)
    pal_w = ak.luma(pal.astype(np.uint8)) ** 1.5
    pick = lambda n: pal[rng.choice(len(pal), size=n, p=pal_w / pal_w.sum())]

    def area_radius(n, r_in, r_out):
        return np.sqrt(rng.random(n) * (r_out ** 2 - r_in ** 2) + r_in ** 2)

    def orbit_items(n, r_in, r_out, cols, sz, m, w, k, lives, alpha, st=1.0, fi=0.12, fo=0.3):
        rs = area_radius(n, r_in, r_out)
        out = []
        for i in range(n):
            out.append({"r": round(float(rs[i]), 1), "th": round(float(rng.random() * 2 * np.pi), 4),
                        "l": float(rng.choice(lives)), "p": round(float(rng.random()), 4),
                        "c": [int(v) for v in np.clip(cols[i], 0, 255)], "a": round(float(rng.uniform(*alpha)), 3),
                        "m": round(float(rng.uniform(*m)), 3), "w": round(float(rng.uniform(*w)), 3),
                        "k": round(float(rng.uniform(*k)), 3), "sz": round(float(rng.uniform(*sz)), 2),
                        "st": st, "fi": fi, "fo": fo})
        return out

    # ------------------------------------------------------------ dust + embers (behind the figure)
    layers.append({"id": "dust", "type": "orbit", "shape": "square", "camera": True, "core": [10, 45],
                   "items": orbit_items(1400, 25, 560, pick(1400) * 1.15, (0.4, 1.1), (1.1, 1.6), (0.0, 0.4),
                                        (0.08, 0.3), [3.0, 4.0, 6.0], (0.35, 0.8), st=0.35)})
    layers.append({"id": "embers", "type": "orbit", "shape": "glow", "blend": "lighter", "camera": True,
                   "core": [8, 30], "items": orbit_items(160, 40, 420, np.tile([[230, 120, 90]], (160, 1)) *
                                                         rng.uniform(0.6, 1.0, (160, 1)), (2.0, 4.5), (1.2, 1.5),
                                                         (0.0, 0.3), (0.25, 0.5), [2.0, 3.0], (0.25, 0.55), st=0.0)})

    # ------------------------------------------------------------ the figure, upright, and its light
    fx, fy = cx0 / UP, cy0 / UP
    fw, fh = figure_rgba.shape[1] / UP, figure_rgba.shape[0] / UP
    layers.append({"id": "figure", "type": "image", "src": ak.to_data_uri(figure_rgba), "camera": True,
                   "x": fx, "y": fy, "w": fw, "h": fh})
    bright = (Lc > 120) & box
    glow = ak.glow_rgba(bright, (175, 215, 255), sigmas=(4, 14, 44), weights=(0.6, 0.5, 0.5), gain=1.6)
    gpad = 120
    glow_big = ak.glow_rgba(np.pad(bright, gpad), (175, 215, 255), sigmas=(4, 16, 60), weights=(0.6, 0.55, 0.6), gain=1.8)
    layers.append({"id": "glow", "type": "image", "src": ak.to_data_uri(glow_big), "camera": True, "blend": "lighter",
                   "x": (cx0 - gpad) / UP, "y": (cy0 - gpad) / UP,
                   "w": glow_big.shape[1] / UP, "h": glow_big.shape[0] / UP,
                   "alpha": {"base": 0.12, "amp": 0.4, "wave": "zoom"}})
    del glow
    layers.append({"id": "pulse", "type": "image", "src": ak.to_data_uri(glow_big), "camera": True, "blend": "lighter",
                   "x": (cx0 - gpad) / UP, "y": (cy0 - gpad) / UP,
                   "w": glow_big.shape[1] / UP, "h": glow_big.shape[0] / UP,
                   "alpha": {"base": 0.0, "amp": 0.35, "k": 6, "wave": "beat"}})

    # sparks thrown off the figure (cartesian particles in world space, carried by the camera)
    items = []
    fig_pts = np.argwhere(bright)
    for _ in range(140):
        yy, xx = fig_pts[rng.integers(len(fig_pts))]
        x, y = (cx0 + xx) / UP, (cy0 + yy) / UP
        a = rng.uniform(0, 2 * np.pi)
        sp = rng.uniform(20, 70)
        items.append(ak.particle(x, y, rng.uniform(1.0, 2.6), (190, 225, 255), alpha=rng.uniform(0.45, 0.9),
                                 vx=np.cos(a) * sp, vy=np.sin(a) * sp, life=float(rng.choice([1.5, 2.0, 3.0])),
                                 phase=rng.random(), fade_in=0.1, fade_out=0.6, shrink=0.7))
    layers.append({"id": "sparks", "type": "particles", "shape": "glow", "blend": "lighter", "camera": True, "items": items})

    # ------------------------------------------------------------ speed lines + near flecks (in front)
    layers.append({"id": "streaks", "type": "orbit", "shape": "square", "blend": "lighter", "camera": True,
                   "parallax": 1.15, "core": [30, 90],
                   "items": orbit_items(90, 60, 600, np.tile([[150, 190, 235]], (90, 1)) * rng.uniform(0.5, 1.0, (90, 1)),
                                        (0.3, 0.6), (1.6, 2.2), (0.0, 0.3), (0.05, 0.15), [1.5, 2.0], (0.12, 0.3),
                                        st=2.0, fi=0.2, fo=0.4)})
    dark = np.vstack([pick(80) * 0.35, np.tile([[12, 8, 10]], (80, 1))])
    layers.append({"id": "flecks", "type": "orbit", "shape": "square", "camera": True, "parallax": 1.35,
                   "core": [20, 70],
                   "items": orbit_items(160, 80, 640, dark, (1.2, 3.0), (1.4, 2.0), (0.0, 0.4), (0.15, 0.4),
                                        [2.0, 3.0], (0.6, 0.95), st=0.8)})

    scene = {"title": "Maelstrom", "width": W, "height": H, "loop": LOOP, "camera": CAMERA,
             "source": ak.file_data_uri(os.path.join(HERE, "source.webp")), "layers": layers}
    ak.write_scene_js(os.path.join(HERE, "scene.js"), scene)
    ak.install_page(HERE, scene["title"])

    dbg = os.path.join(HERE, "debug")
    os.makedirs(dbg, exist_ok=True)
    Image.fromarray(canvas).resize((canvas.shape[1] // 3, canvas.shape[0] // 3)).save(os.path.join(dbg, "canvas.png"))
    Image.fromarray(figure_rgba).save(os.path.join(dbg, "figure.png"))
    Image.fromarray(filled).save(os.path.join(dbg, "figure_hole_filled.png"))
    n = sum(len(l.get("items", [])) for l in layers)
    print(f"scene: {len(layers)} layers, {n} particles, canvas {canvas.shape[1]}px, "
          f"scene.js {os.path.getsize(os.path.join(HERE, 'scene.js')) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
