#!/usr/bin/env python3
"""Starter build script for animating a new picture. Copy next to source.<ext>:

    mkdir -p art/<name> && cp picture.webp art/<name>/source.webp
    cp .claude/skills/animate-art/templates/build_scene_starter.py art/<name>/build_scene.py
    .claude/skills/animate-art/scripts/pipeline.sh art/<name>

It runs with no edits and gives a reasonable first animation:
  - repeated small shapes (KIND) are cut out and drift, each starting at t = 0
    exactly where the artist put it
  - the static mass (big dark bodies) twinkles with specks sampled from itself
  - the brightest regions get a breathing glow
  - the open field gets faint mosaic shimmer
Then make it the piece's own: hand-measure geometry (keep masks for strokes that
must not move, emitters, paths), and add the motion the picture implies. See
art/ascension/build_scene.py for a full worked example.
"""
import glob
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.join(HERE, "..", "..", ".claude", "skills", "animate-art")
sys.path.insert(0, os.path.join(KIT, "scripts"))
import artkit as ak  # noqa: E402

TITLE = os.path.basename(HERE).replace("-", " ").title()
LOOP = 12.0            # seconds. Every particle life and wave frequency must divide it.
SEED = 1
KIND = "diamond"       # diamond | circle | square: the repeated shape in the picture
INK_LUM, REL = 42, 0.55
MASS_KERNEL, MASS_AREA = 9, 15000
GLOW_LUM = 225         # luminance above which a region counts as a light source
GLOW_COLOR = None      # None = taken from the picture around the light
# Wind: (strength, peak time s, width s) per gust; keep ~2 s of calm around t = 0
# so frame 0 stays the original. [] = no wind.
GUSTS = [(0.7, 3.0, 0.7), (1.0, 7.5, 0.8)]


def main():
    rng = np.random.default_rng(SEED)
    wind = ak.Wind(LOOP, GUSTS) if GUSTS else None
    W_ = dict(wind=wind)
    src = sorted(glob.glob(os.path.join(HERE, "source.*")))[0]
    img = ak.load_rgb(src)
    H, W = img.shape[:2]
    L = ak.luma(img)

    ink_abs, ink = ak.ink_masks(img, INK_LUM, REL)
    mass = ak.big_components(ink_abs, MASS_KERNEL, MASS_AREA)
    keep = np.zeros((H, W), bool)  # e.g. ak.poly_mask((H, W), polylines=[(points, width)])
    shapes, erase, rejected = ak.extract_shapes(img, ink & ~mass & ~keep, KIND)
    plate = ak.guided_fill(img, erase)
    print(f"{len(shapes)} {KIND}s set free, {len(rejected)} components kept in the plate")

    layers = [{"id": "plate", "type": "image", "src": ak.to_data_uri(plate, "WEBP", lossless=True, quality=100)}]

    # faint mosaic shimmer in the open field
    field = ~mass & (L > INK_LUM) & (L < GLOW_LUM - 40)
    pts = ak.sample_points(field, 60, rng)
    cols = ak.sample_colors(img, pts, 3)
    items = [ak.particle(x, y, rng.uniform(10, 45), c * (0.6 if rng.random() < 0.6 else 1.35), alpha=rng.uniform(0.06, 0.14),
                         life=LOOP, tw=1.0, tw_k=int(rng.integers(1, 3)), tw_phase=rng.random())
             for (x, y), c in zip(pts, cols)]
    layers.append({"id": "field-shimmer", "type": "particles", "shape": KIND, "items": items})

    # breathing glow around the light sources
    light = (L > GLOW_LUM)
    light = cv2.morphologyEx(light.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
    if light.sum() > 200:
        if GLOW_COLOR is None:  # the halo just outside the light, as the picture has it
            halo = ak.edge_band(~light, 12) & ~mass
            color = tuple(int(v) for v in np.median(img[halo], axis=0))
        else:
            color = GLOW_COLOR
        glow = ak.glow_rgba(light, color, sigmas=(6, 20, 50), weights=(0.3, 0.4, 0.4), gain=1.3)
        front = cv2.GaussianBlur(mass.astype(np.float32), (0, 0), 2)
        glow[..., 3] = (glow[..., 3] * (1 - front)).astype(np.uint8)
        surge = {"base": 0.05, "amp": 0.5, "wave": "wind"} if wind else {"base": 0, "amp": 0.3, "k": 2, "wave": "sin01"}
        layers.append(ak.image_layer("glow", glow, blend="lighter", alpha=surge))

    # the static mass twinkles with its own colours
    if mass.any():
        pts = ak.sample_points(mass, 500, rng)
        cols = ak.sample_colors(img, pts, 1).astype(np.float32)
        items = [ak.particle(x, y, rng.uniform(0.7, 2.0), c * (1.6 if rng.random() < 0.6 else 0.4) + 10, alpha=rng.uniform(0.4, 0.8),
                             life=LOOP, tw=1.0, tw_k=int(rng.integers(1, 4)), tw_phase=rng.random())
                 for (x, y), c in zip(pts, cols)]
        layers.append({"id": "mass-twinkle", "type": "particles", "shape": KIND, "items": items})

    # gusts tear fragments off the mass's edges
    if wind and mass.any():
        pts = ak.sample_points(ak.edge_band(mass, 6), 600, rng)
        cols = ak.sample_colors(img, pts, 1)
        births = wind.gust_times(rng, len(pts), power=2.0, floor=0.15)
        items = [ak.particle(x, y, 1.0 + 3.5 * rng.random() ** 2, c * 0.85, vy=-rng.uniform(20, 55), ay=-rng.uniform(5, 20),
                             life=float(rng.choice([3.0, 4.0])), born_at=tb, fade_in=0.08, fade_out=0.45, shrink=1.0,
                             wd=rng.uniform(50, 110), spin=rng.uniform(-2.5, 2.5), wr=0.004, **W_)
                 for (x, y), c, tb in zip(pts, cols, births)]
        layers.append({"id": "fragments", "type": "particles", "shape": KIND, "grow": True, "items": items})

    # the artist's own shapes drift up and out, grow in / shrink away
    cx = W / 2
    items = []
    for s in shapes:
        slow = 0.55 if s["r"] >= 9 else 1.0
        fast = 3.0 if wind else 1.0
        items.append(ak.particle(s["x"], s["y"], s["r"], s["color"], vx=np.sign(s["x"] - cx) * rng.uniform(0.4, 2.5) * slow,
                                 vy=-rng.uniform(3, 9) * slow * fast, life=LOOP, fade_in=0.16, fade_out=0.22, shrink=1.0,
                                 sway=rng.uniform(1, 3) * slow, sway_cycles=1, sway_phase=rng.random(),
                                 wd=rng.uniform(25, 55) * slow if wind else 0.0, spin=rng.uniform(-0.4, 0.4) if wind else 0.0,
                                 at_phase=rng.uniform(0.3, 0.68), **W_))
    layers.append({"id": "drift", "type": "particles", "shape": KIND, "grow": True, "items": items})

    img_uri = ak.to_data_uri(img, "WEBP", quality=92)
    scene = {"title": TITLE, "width": W, "height": H, "loop": LOOP, "source": img_uri, "layers": layers}
    if wind:
        scene["wind"] = wind.to_scene()
    ak.write_scene_js(os.path.join(HERE, "scene.js"), scene)
    ak.install_page(HERE, TITLE)
    os.makedirs(os.path.join(HERE, "debug"), exist_ok=True)
    from PIL import Image
    Image.fromarray(plate).save(os.path.join(HERE, "debug", "plate.png"))


if __name__ == "__main__":
    main()
