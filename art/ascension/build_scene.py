#!/usr/bin/env python3
"""Build the animated scene for "Ascension" from source.webp.

    python3 art/ascension/build_scene.py      # writes scene.js, animator.js, index.html, debug/
    .claude/skills/animate-art/scripts/pipeline.sh art/ascension   # + frames, review, mp4

The piece is driven by a wind field: three gusts per 12 s loop sweep left to right
(calm at t = 0, so the first frame is the original). Layers, back to front:
  plate           source with the free diamonds and the head plume cut out and refilled
  bg-shimmer      mosaic tiles breathing in the purple field
  far-fragments   big faint diamonds drifting up in the distance (depth)
  tri-glow        the triangle's halo, surging with every gust
  tri-sweep       light running around the band
  ground-shimmer  tiles flickering in the pile at the bottom
  body-twinkle    granular specks across the figure
  heart           chest triangle heartbeat (lub-dub every 3 s) + motes
  plume-core      soft dark puffs keeping the head's middle a smooth deep navy
  plume           the head itself, rebuilt as a churning cloud of its own diamonds that
                  rise continuously, sway as one with each gust and climb off the top
  smoke           soft dark puffs torn off the plume
  trail           specks + glints racing up the zigzag into the apex
  ground-lift     tiles ripped off the pile by gusts
  shed            specks torn off shoulders and arms
  dissolve        fragments stripped off the head's edges
  drift           every diamond the artist drew loose, now carried by the wind; at
                  t = 0 each sits exactly where the artist put it
  sparks          light motes thrown up from the triangle and the heart
  debris          a few large dark fragments close to the camera, crossing in gusts
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

LOOP = 12.0          # seconds; every life / frequency below divides this
SEED = 7
CX = 415.0           # figure's vertical axis

# Hand-measured geometry (source pixels)
ZIGZAG = [(372.5, 252.5), (452.5, 181.3), (408.8, 140.0), (385.0, 165.0),
          (365.0, 145.0), (390.0, 122.5), (388.8, 102.5)]          # head -> apex
FIGURE_HULL = [(398, 135), (462, 175), (482, 300), (512, 420), (492, 520), (470, 565), (530, 615),
               (595, 700), (605, 1026), (245, 1026), (250, 700), (300, 615), (360, 565), (333, 520),
               (318, 420), (343, 300), (378, 180)]
HEART = [(384, 708), (444, 708), (413, 762)]
PLUME_TOP, PLUME_BOT = 246, 572                                     # head column, top to neck
# The big triangle is an exact equilateral vector stroke. Vertices from orthogonal
# line fits to the band's subpixel edges (median residual ~0.06 px).
TRI_OUTER = [(415.44, 41.40), (772.23, 659.51), (58.80, 659.54)]
TRI_INNER = [(415.54, 149.35), (679.12, 605.78), (151.89, 605.83)]
TRI_CENTER = [tuple((np.array(o) + np.array(i)) / 2) for o, i in zip(TRI_OUTER, TRI_INNER)]
TRI_CENTER = [(float(x), float(y)) for x, y in TRI_CENTER + TRI_CENTER[:1]]

# Wind: (strength, peak time s, width s). Calm from ~10.2 s through 0.5 s.
GUSTS = [(0.6, 2.6, 0.7), (0.85, 5.4, 0.6), (1.0, 7.8, 0.8)]
PLUME_N = 6000       # diamonds in the head cloud (calibrated so its darkness matches the source)


def main():
    rng = np.random.default_rng(SEED)
    img = ak.load_rgb(os.path.join(HERE, "source.webp"))
    H, W = img.shape[:2]
    L = ak.luma(img)
    yy, xx = np.mgrid[0:H, 0:W]
    wind = ak.Wind(LOOP, GUSTS, base=0.12, dir=(1.0, -0.3), front=520.0)

    # ------------------------------------------------------------ masks
    ink_abs, ink = ak.ink_masks(img, ink_lum=42, rel=0.55, bg_kernel=81)
    mass = ak.big_components(ink_abs, kernel=9, min_area=15000)    # figure + ground pile
    keep = ak.poly_mask((H, W), polylines=[(ZIGZAG, 16)])          # zigzag trail stays
    figure = mass & ak.poly_mask((H, W), polygons=[FIGURE_HULL])
    ground = mass & ~figure & (yy > 600)
    heart = ak.poly_mask((H, W), polygons=[HEART])
    head = figure & (yy >= PLUME_TOP) & (yy <= PLUME_BOT)
    tri_t, tri_w = ak.ring_coordinate((H, W), TRI_OUTER, TRI_INNER)  # 0 outer edge, -w inner edge
    band = (tri_t <= 0) & (tri_t >= -tri_w)

    # ------------------------------------------------------------ extract + plate
    shapes, erase, rejected = ak.extract_diamonds(img, ink & ~mass & ~keep, min_r=2.0, max_r=60)
    span = ak.row_span(head, smooth_rows=9, pad=2)                  # the head, cut out whole
    span = cv2.dilate(span.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    span &= (yy >= PLUME_TOP - 2) & (yy <= PLUME_BOT)
    hole = erase | span
    clean = ~hole & ~mass & ~keep & (L > 45)
    guide, gmask = ak.profile_guide(img, tri_t, clean, -tri_w - 400, 70)
    plate = ak.guided_fill(img, hole, guide=guide, guide_mask=gmask)
    print(f"extracted {len(shapes)} diamonds, left {len(rejected)} non-diamond components")

    # What the head is made of: ink colour + coverage of every pixel over the refilled plate
    head_ink, head_alpha = ak.unmix(img[span], plate[span])
    ink_map = np.zeros_like(img, np.float32)
    alpha_map = np.zeros((H, W), np.float32)
    ink_map[span], alpha_map[span] = head_ink, head_alpha
    BEND = {"amp": 55.0, "yBot": float(PLUME_BOT), "H": float(PLUME_BOT - PLUME_TOP), "cup": 380.0}

    front = cv2.GaussianBlur((mass | keep).astype(np.float32), (0, 0), 2.0)
    tri_glow = ak.glow_rgba(band, (190, 165, 255), sigmas=(6, 18, 50), weights=(0.25, 0.4, 0.4), gain=1.3)
    tri_glow[..., 3] = (tri_glow[..., 3] * (1 - front)).astype(np.uint8)
    heart_glow = ak.glow_rgba(heart, (205, 190, 255), sigmas=(3, 12, 36), weights=(0.6, 0.5, 0.45), gain=1.6)

    layers = [{"id": "plate", "type": "image", "src": ak.to_data_uri(plate, "WEBP", lossless=True, quality=100)}]
    W_ = dict(wind=wind)

    # ------------------------------------------------------------ background mosaic shimmer
    open_bg = ~mass & ~(cv2.dilate(band.astype(np.uint8), np.ones((41, 41), np.uint8)) > 0) & ~keep
    items = []
    for x, y in ak.sample_points(open_bg, 90, rng):
        dark = rng.random() < 0.6
        items.append(ak.particle(x, y, rng.uniform(12, 52), (34, 20, 128) if dark else (118, 96, 238),
                                 alpha=rng.uniform(0.1, 0.22) if dark else rng.uniform(0.07, 0.14),
                                 life=LOOP, tw=1.0, tw_k=int(rng.integers(1, 4)), tw_phase=rng.random()))
    layers.append({"id": "bg-shimmer", "type": "particles", "shape": "diamond", "items": items})

    # ------------------------------------------------------------ far fragments (depth)
    items = []
    for _ in range(90):
        x, y = rng.uniform(-60, W), rng.uniform(150, H + 40)
        dark = rng.random() < 0.65
        items.append(ak.particle(x, y, rng.uniform(9, 36), (38, 22, 132) if dark else (124, 102, 240),
                                 alpha=rng.uniform(0.12, 0.24) if dark else rng.uniform(0.08, 0.16),
                                 vy=-rng.uniform(8, 24), life=float(rng.choice([6.0, 12.0])), phase=rng.random(),
                                 fade_in=0.2, fade_out=0.3, shrink=1.0, wd=rng.uniform(14, 32), spin=rng.uniform(-0.2, 0.2),
                                 sway=rng.uniform(2, 6), sway_cycles=1, sway_phase=rng.random(), **W_))
    layers.append({"id": "far-fragments", "type": "particles", "shape": "diamond", "grow": True, "items": items})

    # ------------------------------------------------------------ triangle glow + sweep (surge with gusts)
    layers.append(ak.image_layer("tri-glow", tri_glow, blend="lighter",
                                 alpha={"base": 0.06, "amp": 0.62, "wave": "wind"}))
    layers.append({"id": "tri-sweep", "type": "path", "shape": "glow", "blend": "lighter", "points": TRI_CENTER,
                   "fade": [0, 0], "alpha": {"base": 0.4, "amp": 1.0, "wave": "wind"},
                   "items": [{"k": 2, "p": 0.0, "r": 75, "c": [175, 145, 255], "a": 0.2},
                             {"k": 2, "p": 0.5, "r": 75, "c": [175, 145, 255], "a": 0.2}]})

    # ------------------------------------------------------------ ground shimmer
    items = []
    for x, y in ak.sample_points(ground & (yy > 660), 100, rng):
        dark = rng.random() < 0.55
        items.append(ak.particle(x, y, rng.uniform(7, 26), (6, 3, 18) if dark else (80, 60, 200),
                                 alpha=rng.uniform(0.3, 0.55) if dark else rng.uniform(0.2, 0.35),
                                 life=LOOP, tw=1.0, tw_k=int(rng.integers(1, 5)), tw_phase=rng.random()))
    layers.append({"id": "ground-shimmer", "type": "particles", "shape": "diamond", "items": items})

    # ------------------------------------------------------------ figure twinkle
    body = figure & (yy > PLUME_BOT) & ~cv2.dilate(heart.astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool)
    pts = ak.sample_points(body, 900, rng)
    cols = ak.sample_colors(img, pts, radius=1).astype(np.float32)
    items = []
    for (x, y), c in zip(pts, cols):
        if rng.random() < 0.6:
            c2, a = c * 0.45 + np.array([96, 78, 232]) * 0.55, rng.uniform(0.4, 0.9)
        else:
            c2, a = c * 0.35, rng.uniform(0.5, 0.95)
        items.append(ak.particle(x, y, rng.uniform(0.7, 2.1), c2, alpha=a, life=LOOP,
                                 tw=1.0, tw_k=int(rng.integers(2, 6)), tw_phase=rng.random()))
    layers.append({"id": "body-twinkle", "type": "particles", "shape": "diamond", "items": items})

    # ------------------------------------------------------------ heart
    layers.append(ak.image_layer("heart", heart_glow, blend="lighter",
                                 alpha={"base": 0.0, "amp": 1.0, "k": 4, "p": 0.0, "wave": "beat"}))
    box = ak.poly_mask((H, W), polygons=[[(360, 690), (470, 690), (470, 790), (360, 790)]]) & ~heart
    items = [ak.particle(x, y, rng.uniform(0.8, 1.7), (225, 215, 255), alpha=rng.uniform(0.5, 0.95), life=LOOP,
                         tw=1.0, tw_k=int(rng.integers(2, 6)), tw_phase=rng.random()) for x, y in ak.sample_points(box, 34, rng)]
    layers.append({"id": "heart-motes", "type": "particles", "shape": "diamond", "blend": "lighter", "items": items})

    # ------------------------------------------------------------ the head plume
    # Steady-state cloud: births spread over the head by its coverage, each diamond rises
    # for 2-3 s and shrinks away, so the cloud keeps the head's shape while churning upward.
    zone = span & (alpha_map > 0.05)
    # soft dark core underneath, so the middle of the head stays a smooth, deep navy
    pts = ak.sample_points(zone, 70, rng, weight=alpha_map ** 3)
    core = []
    for x, y in pts:
        hup = np.clip((PLUME_BOT - y) / (PLUME_BOT - PLUME_TOP), 0, 1)
        core.append(ak.particle(x, y + 10, rng.uniform(18, 34), (9, 6, 28), alpha=rng.uniform(0.35, 0.55),
                                vy=-rng.uniform(12, 26) * (1 + 0.5 * hup), life=float(rng.choice([3.0, 4.0])),
                                phase=rng.random(), fade_in=0.25, fade_out=0.45, wd=rng.uniform(8, 20),
                                sway=rng.uniform(2, 5), sway_cycles=1, sway_phase=rng.random(), **W_))
    layers.append({"id": "plume-core", "type": "particles", "shape": "glow", "bend": BEND, "items": core})
    pts = ak.sample_points(zone, PLUME_N, rng, weight=alpha_map ** 1.6)
    items = []
    for x, y in pts:
        xi, yi = int(x), int(y)
        hup = np.clip((PLUME_BOT - y) / (PLUME_BOT - PLUME_TOP), 0, 1)
        big = rng.random() < 0.04
        r = rng.uniform(4.0, 7.0) if big else 1.1 + 3.6 * rng.random() ** 1.6
        col = img[max(0, yi - 1):yi + 2, max(0, xi - 1):xi + 2].reshape(-1, 3).mean(0) * 0.92
        a = float(np.clip(0.5 + 0.45 * alpha_map[yi, xi], 0.5, 0.95))
        out = np.sign(x - CX + rng.normal(0, 10))
        items.append(ak.particle(x, y + rng.uniform(0, 22), r, col, alpha=a,
                                 vx=out * rng.uniform(0, 6), vy=-rng.uniform(14, 38) * (1 + 0.8 * hup),
                                 ay=-rng.uniform(8, 28), life=float(rng.choice([2.0, 3.0])), phase=rng.random(),
                                 fade_in=0.12, fade_out=0.45, shrink=1.0, wd=rng.uniform(10, 28) * (1 + 2 * hup),
                                 spin=rng.uniform(-0.8, 0.8), sway=rng.uniform(1, 3), sway_cycles=1,
                                 sway_phase=rng.random(), **W_))
    layers.append({"id": "plume", "type": "particles", "shape": "diamond", "grow": True, "bend": BEND, "items": items})

    # ------------------------------------------------------------ smoke puffs torn off the plume
    edge = ak.edge_band(head, 10)
    wgt = 1.0 + 3.0 * np.clip((420 - yy) / 170.0, 0, 1)
    pts = ak.sample_points(edge, 150, rng, weight=wgt)
    births = wind.gust_times(rng, len(pts), power=1.5, floor=0.25)
    items = []
    for (x, y), tb in zip(pts, births):
        items.append(ak.particle(x, y, rng.uniform(9, 22), (16, 10, 50), alpha=rng.uniform(0.16, 0.32),
                                 vy=-rng.uniform(25, 55), ay=-rng.uniform(5, 20), life=float(rng.choice([3.0, 4.0])),
                                 born_at=tb, fade_in=0.15, fade_out=0.55, grow=1.3,
                                 wd=rng.uniform(60, 110), sway=rng.uniform(3, 8), sway_cycles=1, sway_phase=rng.random(), **W_))
    layers.append({"id": "smoke", "type": "particles", "shape": "glow", "bend": BEND, "items": items})

    # ------------------------------------------------------------ zigzag trail flow
    trail_items = [{"k": int(rng.choice([2, 3])), "p": float(i / 40 + rng.random() * 0.02), "r": float(rng.uniform(1.4, 3.2)),
                    "c": [22, 15, 62], "a": float(rng.uniform(0.75, 1.0))} for i in range(40)]
    layers.append({"id": "trail", "type": "path", "shape": "diamond", "points": ZIGZAG, "fade": [0.08, 0.25], "items": trail_items})
    glint_items = [{"k": 3, "p": float(i / 4 + 0.1), "r": float(rng.uniform(5, 8)), "c": [215, 200, 255], "a": 0.65} for i in range(4)]
    layers.append({"id": "trail-glint", "type": "path", "shape": "glow", "blend": "lighter", "points": ZIGZAG,
                   "fade": [0.15, 0.3], "items": glint_items})

    def fragments(layer_id, zone, n, rmin, rmax, vy, ay, wd, lives, power, floor, darken=0.85, weight=None,
                  big_frac=0.0, big=(4, 8), spin=2.5, fo=0.45):
        pts = ak.sample_points(zone, n, rng, weight=weight)
        cols = ak.sample_colors(img, pts, radius=1)
        births = wind.gust_times(rng, n, power=power, floor=floor)
        out = []
        for (x, y), c, tb in zip(pts, cols, births):
            r = rng.uniform(*big) if rng.random() < big_frac else rmin + (rmax - rmin) * rng.random() ** 2
            out.append(ak.particle(x, y, r, np.minimum(c, 90) * darken, alpha=rng.uniform(0.85, 1.0),
                                   vx=np.sign(x - CX + rng.normal(0, 8)) * rng.uniform(2, 14), vy=-rng.uniform(*vy),
                                   ay=-rng.uniform(*ay), life=float(rng.choice(lives)), born_at=tb,
                                   fade_in=0.08, fade_out=fo, shrink=1.0, wd=rng.uniform(*wd),
                                   spin=rng.uniform(-spin, spin), wr=0.004,
                                   sway=rng.uniform(2, 6), sway_cycles=1, sway_phase=rng.random(), **W_))
        return {"id": layer_id, "type": "particles", "shape": "diamond", "grow": True, "items": out}

    # ------------------------------------------------------------ ground lift / shoulder shed / head dissolve
    layers.append(fragments("ground-lift", ground & (yy > 630) & (yy < 900), 420, 2.0, 9.0, (25, 60), (5, 20),
                            (50, 110), [4.0, 6.0], 2.0, 0.12, darken=0.9))
    shed_zone = ak.edge_band(figure, 6) & (yy > PLUME_BOT) & (yy < 900)
    layers.append(fragments("shed", shed_zone, 500, 1.0, 4.0, (20, 50), (8, 20), (60, 120), [3.0, 4.0], 2.0, 0.15))
    head_edge = ak.edge_band(head, 8)
    wgt = 1.0 + 2.0 * np.clip((430 - yy) / 180.0, 0, 1)
    dissolve = fragments("dissolve", head_edge, 900, 1.0, 4.5, (30, 70), (10, 30), (50, 110), [3.0, 4.0, 6.0],
                         1.5, 0.3, weight=wgt, big_frac=0.07, big=(4.5, 8.0), spin=3.0)
    dissolve["bend"] = BEND
    layers.append(dissolve)

    # ------------------------------------------------------------ drift: the artist's own diamonds, in the wind
    items = []
    for s in shapes:
        x, y, r = s["x"], s["y"], s["r"]
        slow = 0.55 if r >= 9 else 1.0
        items.append(ak.particle(x, y, r, s["color"], alpha=1.0, vx=np.sign(x - CX) * rng.uniform(1, 6) * slow,
                                 vy=-rng.uniform(16, 36) * slow, life=6.0 if r < 9 else LOOP,
                                 fade_in=0.12, fade_out=0.25, shrink=1.0, wd=rng.uniform(25, 55) * slow,
                                 spin=rng.uniform(-0.5, 0.5), wr=0.003,
                                 sway=rng.uniform(2, 5) * slow, sway_cycles=1, sway_phase=rng.random(),
                                 at_phase=rng.uniform(0.3, 0.6), **W_))
    layers.append({"id": "drift", "type": "particles", "shape": "diamond", "grow": True, "items": items})

    # ------------------------------------------------------------ sparks from the triangle and the heart
    spark_zone = (band & ~(front > 0.5)) | cv2.dilate(heart.astype(np.uint8), np.ones((31, 31), np.uint8)).astype(bool)
    pts = ak.sample_points(spark_zone, 240, rng)
    births = wind.gust_times(rng, len(pts), power=1.5, floor=0.3)
    items = []
    for (x, y), tb in zip(pts, births):
        col = (235, 225, 255) if rng.random() < 0.6 else (200, 180, 255)
        items.append(ak.particle(x, y, rng.uniform(1.6, 4.0), col, alpha=rng.uniform(0.45, 0.9), vy=-rng.uniform(25, 65),
                                 ay=-rng.uniform(0, 15), life=float(rng.choice([3.0, 4.0])), born_at=tb,
                                 fade_in=0.1, fade_out=0.5, shrink=0.8, wd=rng.uniform(60, 120),
                                 sway=rng.uniform(2, 6), sway_cycles=2, sway_phase=rng.random(), **W_))
    layers.append({"id": "sparks", "type": "particles", "shape": "glow", "blend": "lighter", "items": items})

    # ------------------------------------------------------------ near-camera debris
    items = []
    births = wind.gust_times(rng, 36, power=3.0, floor=0.02)
    for tb in births:
        x, y = rng.uniform(-80, 420), rng.uniform(520, H + 60)
        items.append(ak.particle(x, y, rng.uniform(6, 17), (12, 8, 32), alpha=0.96, vx=rng.uniform(50, 120),
                                 vy=-rng.uniform(50, 110), ay=-rng.uniform(0, 20), life=float(rng.choice([3.0, 4.0])),
                                 born_at=tb, fade_in=0.06, fade_out=0.3, shrink=1.0, wd=rng.uniform(100, 180),
                                 spin=rng.uniform(-3, 3), wr=0.003, **W_))
    layers.append({"id": "debris", "type": "particles", "shape": "diamond", "grow": True, "items": items})

    scene = {"title": "Ascension", "width": W, "height": H, "loop": LOOP, "wind": wind.to_scene(),
             "source": ak.to_data_uri(img, "WEBP", quality=92), "layers": layers}
    ak.write_scene_js(os.path.join(HERE, "scene.js"), scene)
    ak.install_page(HERE, scene["title"])

    # ------------------------------------------------------------ debug views
    dbg = os.path.join(HERE, "debug")
    os.makedirs(dbg, exist_ok=True)
    Image.fromarray(plate).save(os.path.join(dbg, "plate.png"))
    vis = (img * 0.5).astype(np.uint8)
    vis[figure] = (vis[figure] * 0.5 + np.array([128, 40, 0])).astype(np.uint8)
    vis[ground] = (vis[ground] * 0.5 + np.array([0, 90, 60])).astype(np.uint8)
    vis[span] = (vis[span] * 0.5 + np.array([128, 128, 0])).astype(np.uint8)
    vis[keep] = (vis[keep] * 0.5 + np.array([0, 0, 128])).astype(np.uint8)
    for s in shapes:
        cx, cy, r = s["x"], s["y"], s["r"]
        p = np.array([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]], np.int32)
        cv2.polylines(vis, [p], True, (255, 210, 0), 1, cv2.LINE_AA)
    Image.fromarray(vis).save(os.path.join(dbg, "layers.png"))
    n_items = sum(len(l.get("items", [])) for l in layers)
    print(f"scene: {len(layers)} layers, {n_items} particles, "
          f"scene.js {os.path.getsize(os.path.join(HERE, 'scene.js')) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
