#!/usr/bin/env python3
"""Build the animated scene for "Constellation" from source.webp.

    python3 art/constellation/build_scene.py            (--fresh to redo the cached decomposition)
    SCALE=1.5 .claude/skills/animate-art/scripts/pipeline.sh art/constellation

The constellation grows out of the planet. Each loop starts close on the figure at the
platform's edge with the sky empty of its golden network. Points of light rise from the
planet's horizon and the network draws itself outward and upward, line by line, node by
node, while the camera pulls back and the figure shrinks against it. At mid-loop the
camera rests on the full painting. Then the network withdraws into the planet the
same way it came, and the camera closes back in on the figure.

How: every network pixel gets an activation level, its geodesic distance from the
horizon along the lines (cheap along a line, dear across empty sky). A growth value
G(t) sweeps 0 -> 1 -> 0 once per loop, and a pixel shows once G passes its level. So
lines extend from node to node and comets of light run down them at the front.
Layers, back to front:
  sky       the painting with the network and the figure painted out (2x master)
  stars     twinkle on the white background stars
  motes     points of light rising off the horizon while the network grows
  dawn      the horizon glowing where the network touches it, brightest before it grows
  network   lines + golden nodes, revealed by activation (a WebGL shader)
  flares    each node flashes as the front reaches it
  sparks    comets running along the lines at the front
  figure    the figure and the platform, cut out and nearer the lens (parallax)
  bokeh     a few soft out-of-focus motes right in front of the lens
  vignette  darkens the corners while the camera is close
"""
import argparse
import os
import sys
import time

import cv2
import numpy as np
from PIL import Image
from skimage.filters import apply_hysteresis_threshold, sato
from skimage.graph import MCP_Geometric
from skimage.morphology import skeletonize

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.join(HERE, "..", "..", ".claude", "skills", "animate-art")
sys.path.insert(0, os.path.join(KIT, "scripts"))
import artkit as ak  # noqa: E402

LOOP = 30.0                  # 15 s growing out, 15 s drawing back in
SEED = 7
UP = 2                       # master resolution: 2x the source, so the close-up stays sharp
SKY_P = 0.85                 # parallax of the sky + network (the figure is 1.0): the figure is nearer
GROW = {"hold": [0.04, 0.08], "ease": 3}   # G rests at 0 for 0.6 s, at 1 for 1.2 s (each side)
CAMERA = {"drive": "grow", "cx": 300, "cy": 600, "zmax": 1.9, "log": True, "hold": [0.0, 0.06],
          "ease": 3, "roll": 0.03}
HORIZON = [(300, 645), (550, 662), (700, 675), (800, 685), (1095, 715)]   # rough planet limb, refined
ACT_RANGE = (0.03, 0.9)      # activation levels used, leaving G room to finish every flash before 1
KEEP_STARS = [(653, 218)]    # big stars that belong to the sky, not the network (the blue one)


def ell(n):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (n, n))


def components(mask):
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    ext = np.hypot(st[:, 2], st[:, 3])
    ext[0] = 0
    return n, lab, st, ext


def fit_horizon(src):
    """Planet limb as a quadratic y(x): strongest dark-to-bright step down each column near a guess."""
    L = cv2.GaussianBlur(ak.luma(src).astype(np.float32), (0, 0), 2.5)
    gy = np.diff(L, axis=0)
    gx, gyy = np.array(HORIZON, float).T
    guess = np.polyfit(gx, gyy, 2)
    xs = np.arange(370, src.shape[1], 5)
    ys = []
    for x in xs:
        g = np.polyval(guess, x)
        lo, hi = int(g - 30), min(int(g + 30), src.shape[0] - 2)
        ys.append(lo + np.argmax(gy[lo:hi, x]))
    ys = np.array(ys, float)
    c = np.polyfit(xs, ys, 2)
    keep = np.abs(ys - np.polyval(c, xs)) < 2.5 * (ys - np.polyval(c, xs)).std()
    return np.polyfit(xs[keep], ys[keep], 2)


def decompose(src, cache):
    """Split the 2x master into sky plate, network (RGBA + mask) and figure (RGBA)."""
    if cache and os.path.exists(cache):
        z = np.load(cache)
        return {k: z[k] for k in z.files}
    H, W = src.shape[:2]
    m = ak.upscale(src, UP, sharpen=0.35)
    mf = m.astype(np.float32)
    L = ak.luma(m).astype(np.float32)
    yy, xx = np.mgrid[0:H * UP, 0:W * UP]
    horizon = fit_horizon(src)

    # figure + platform: the one big dark silhouette; small holes (platform texture) filled,
    # but the bright gap between the legs stays background
    dark = cv2.morphologyEx(((L < 70) & (xx < 800) & (yy > 540)).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, st, _ = components(dark)
    fig = lab == (np.argmax(st[1:, 4]) + 1)
    holes = ak.fill_holes(fig) & ~fig
    nh, lh, sh, _ = components(holes)
    hmean = np.bincount(lh.ravel(), L.ravel(), nh) / np.maximum(sh[:, 4], 1)
    fig |= holes & ~((hmean > 110) & (sh[:, 4] > 200))[lh]
    fig_band = cv2.dilate(fig.astype(np.uint8), ell(9)) > 0
    sky = ~fig_band & (yy < np.polyval(horizon, xx / UP) * UP - 4 * UP)

    # the network: bright thin structure (top-hat). The web of lines is one huge component;
    # off-line dots join it if golden (warm added light), white ones are background stars
    t9 = cv2.morphologyEx(L, cv2.MORPH_TOPHAT, ell(17))
    t41 = cv2.morphologyEx(L, cv2.MORPH_TOPHAT, ell(81))
    strong = (t9 > 18) & sky
    n, lab, st, ext = components(strong)
    web = st[:, 4] > 20000
    web[0] = False
    tc = np.dstack([cv2.morphologyEx(mf[..., k], cv2.MORPH_TOPHAT, ell(17)) for k in range(3)])
    sR = np.bincount(lab.ravel(), tc[..., 0].ravel(), n)
    sB = np.bincount(lab.ravel(), tc[..., 2].ravel(), n)
    warm = (sR / np.maximum(sB, 1) > 1.1) & ~web
    for x, y in KEEP_STARS:
        near = np.unique(lab[max(0, (y - 12) * UP):(y + 12) * UP, max(0, (x - 12) * UP):(x + 12) * UP])
        warm[near[~web[near]]] = False
    warm[0] = False
    star_lab = np.where((~web & ~warm)[lab], lab, 0)
    # faint lines the top-hat misses: ridge filter with hysteresis, long thin pieces only,
    # away from the figure's edges
    r = sato(L, sigmas=[1.0, 2.0], black_ridges=False)
    away = ~(cv2.dilate(fig.astype(np.uint8), ell(31)) > 0)
    hy = apply_hysteresis_threshold(np.where(sky & away, r, 0), 3.5, 6)
    n2, lab2, st2, ext2 = components(hy)
    thin = (ext2 > 40) & (st2[:, 4] < 7 * ext2)
    thin[0] = False
    faint = thin[lab2]
    reveal = web[lab] | warm[lab] | faint
    core = reveal & (t9 > 90)
    halo = (cv2.dilate(core.astype(np.uint8), ell(61)) > 0) & (t41 > 30) & sky
    net = cv2.dilate((reveal | halo).astype(np.uint8), ell(5)) > 0
    small_holes = ak.fill_holes(net) & ~net
    nh, lh, sh, _ = components(small_holes)
    net |= (sh[:, 4] < 3000)[lh] & small_holes
    net &= ~fig_band

    t0 = time.time()
    plate = ak.smooth_fill(m, net, exclude=fig_band)
    # second pass: soft, out-of-focus lines stand out once the sharp network is gone.
    # Wider ridge filter on the cleaned sky; straight pieces only (nebula wisps curl)
    r2 = sato(ak.luma(plate).astype(np.float32), sigmas=[2.0, 3.0, 4.5], black_ridges=False)
    hy = apply_hysteresis_threshold(np.where(sky & away, r2, 0), 1.5, 3.0)
    n3, lab3, st3, ext3 = components(hy)
    soft = np.zeros(n3, bool)
    for i in np.nonzero((ext3 > 60) & (st3[:, 4] < 12 * ext3))[0]:
        x, y, w, h, _ = st3[i]
        pts = np.argwhere(lab3[y:y + h, x:x + w] == i).astype(float)
        ev = np.linalg.eigvalsh(np.cov(pts.T))
        soft[i] = np.sqrt(ev[0]) < 2.2 and np.sqrt(ev[1]) > 15
    soft_lines = cv2.dilate(soft[lab3].astype(np.uint8), ell(7)) > 0
    for i in np.nonzero(soft)[0]:
        print("  soft line at", (st3[i, :2] / UP).astype(int), "size", (st3[i, 2:4] / UP).astype(int))
    reveal |= soft_lines & sky
    net |= soft_lines & ~fig_band
    plate = ak.smooth_fill(m, net, exclude=fig_band)
    plate = ak.smooth_fill(plate, fig_band)
    print(f"  plate filled in {time.time() - t0:.0f} s")
    pf = plate.astype(np.float32)

    ink, alpha = ak.unmix(mf, pf)
    alpha[~net] = 0
    net_rgba = np.dstack([np.round(ink), np.round(alpha * 255)]).astype(np.uint8)
    fink, falpha = ak.unmix(mf, pf)
    falpha[~fig_band] = 0
    fink[fig] = mf[fig]
    falpha[fig] = 1
    fig_rgba = np.dstack([np.round(fink), np.round(falpha * 255)]).astype(np.uint8)
    out = dict(master=m, plate=plate, net=net, reveal=reveal, net_rgba=net_rgba, fig=fig, fig_band=fig_band,
               fig_rgba=fig_rgba, t9=t9, horizon=horizon, star_lab=star_lab, web=web[lab])
    if cache:
        np.savez(cache, **out)
    return out


def activation(d, src):
    """Geodesic distance from the horizon, along the network (cost 1) or across sky (cost 5)."""
    H, W = src.shape[:2]
    rev = cv2.resize(d["reveal"].astype(np.uint8), (W, H), interpolation=cv2.INTER_AREA) > 0
    fig = cv2.resize(d["fig_band"].astype(np.uint8), (W, H), interpolation=cv2.INTER_AREA) > 0
    yy, xx = np.mgrid[0:H, 0:W]
    hz = np.polyval(d["horizon"], xx)
    cost = np.where(rev, 1.0, 5.0)
    cost[fig] = 40.0
    seeds = rev & (yy > hz - 26) & (yy < hz) & (xx > 360)
    mcp = MCP_Geometric(cost)
    dist, _ = mcp.find_costs(np.argwhere(seeds))
    web = cv2.resize(d["web"].astype(np.uint8), (W, H), interpolation=cv2.INTER_AREA) > 0
    dmax = np.percentile(dist[web], 99.7)   # the web sets the pace; stray outliers just clamp
    lo, hi = ACT_RANGE
    act = np.clip(lo + (hi - lo) * dist / dmax, 0, 1)
    return act, seeds, rev


def act_image(act):
    q = np.round(act * 65535).astype(np.uint32)
    return np.dstack([q >> 8, q & 255, np.zeros_like(q)]).astype(np.uint8)


def poisson_points(mask, spacing, rng):
    """Points on a mask at least `spacing` apart (greedy, random order)."""
    pts = np.argwhere(mask)
    rng.shuffle(pts)
    taken = {}
    out = []
    s = spacing
    for y, x in pts:
        gx, gy = int(x // s), int(y // s)
        ok = True
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                q = taken.get((gx + dx, gy + dy))
                if q is not None and (q[0] - x) ** 2 + (q[1] - y) ** 2 < s * s:
                    ok = False
        if ok:
            taken[(gx, gy)] = (x, y)
            out.append((x, y))
    return np.array(out, float)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", action="store_true", help="recompute the decomposition (slow)")
    args = ap.parse_args()
    rng = np.random.default_rng(SEED)
    src = ak.load_rgb(os.path.join(HERE, "source.webp"))
    H, W = src.shape[:2]
    dbg = os.path.join(HERE, "debug")
    os.makedirs(dbg, exist_ok=True)
    cache = os.path.join(dbg, "decomposition.npz")
    if args.fresh and os.path.exists(cache):
        os.remove(cache)
    d = decompose(src, cache)
    act, seeds, rev = activation(d, src)
    sky_cam = {"camera": True, "parallax": SKY_P}
    near_cam = {"camera": True, "parallax": 1.0}
    layers = [{"id": "sky", "type": "image", "src": ak.to_data_uri(d["plate"], "WEBP", quality=92),
               "x": 0, "y": 0, "w": W, "h": H, **sky_cam}]

    # ------------------------------------------------------------ background stars twinkle
    t9, star_lab = d["t9"], d["star_lab"]
    ns = star_lab.max() + 1
    peak = np.zeros(ns)
    np.maximum.at(peak, star_lab.ravel(), t9.ravel())
    cnt = np.bincount(star_lab.ravel(), minlength=ns)
    ys, xs = np.nonzero(star_lab)
    cx = np.bincount(star_lab[ys, xs], xs, ns) / np.maximum(cnt, 1)
    cy = np.bincount(star_lab[ys, xs], ys, ns) / np.maximum(cnt, 1)
    bright = [i for i in np.argsort(-peak) if i > 0 and peak[i] > 90][:260]
    items = []
    for i in bright:
        x, y = cx[i] / UP, cy[i] / UP
        col = d["master"][int(cy[i]), int(cx[i])].astype(float)
        col = 0.5 * col + 0.5 * np.array([225, 235, 255])
        items.append(ak.particle(x, y, rng.uniform(2.0, 4.2), col, alpha=rng.uniform(0.3, 0.6), life=LOOP,
                                 tw=1.0, tw_k=int(rng.choice([2, 3, 4, 6])), tw_phase=rng.random()))
    layers.append({"id": "stars", "type": "particles", "shape": "glow", "blend": "lighter", **sky_cam, "items": items})

    # ------------------------------------------------------------ motes rising off the horizon
    hz = d["horizon"]
    items = []
    seed_x = np.argwhere(seeds)[:, 1]
    for k in range(240):
        x = rng.choice(seed_x) + rng.normal(0, 18) if rng.random() < 0.7 else rng.uniform(370, W)
        y = np.polyval(hz, x) + rng.uniform(-2, 6)
        col = (255, 226, 170) if rng.random() < 0.75 else (215, 230, 255)
        items.append(ak.particle(x, y, rng.uniform(1.2, 2.8), col, alpha=rng.uniform(0.5, 1.0),
                                 vx=rng.normal(0, 3), vy=-rng.uniform(10, 34), life=float(rng.choice([5.0, 6.0, 10.0])),
                                 phase=rng.random(), fade_in=0.15, fade_out=0.55, shrink=0.5,
                                 tw=0.5, tw_k=int(rng.choice([6, 8, 12])), tw_phase=rng.random()))
    layers.append({"id": "motes", "type": "particles", "shape": "glow", "blend": "lighter", **sky_cam,
                   "alpha": {"base": 0.55, "amp": 0.45, "wave": "growrate"}, "items": items})

    # ------------------------------------------------------------ the horizon lights up where the lines start
    seed2 = cv2.resize(seeds.astype(np.uint8), (W * UP, H * UP), interpolation=cv2.INTER_NEAREST) > 0
    dawn = ak.glow_rgba(seed2, (255, 214, 160), sigmas=(10, 36, 110), weights=(0.5, 0.7, 0.8), gain=2.2)
    dawn_rgba, dx0, dy0 = ak.crop_rgba(dawn, pad=4)
    layers.append({"id": "dawn", "type": "image", "src": ak.to_data_uri(dawn_rgba), "blend": "lighter", **sky_cam,
                   "x": dx0 / UP, "y": dy0 / UP, "w": dawn_rgba.shape[1] / UP, "h": dawn_rgba.shape[0] / UP,
                   "alpha": {"base": 1.0, "amp": -1.0, "wave": "grow"}})

    # ------------------------------------------------------------ the network, revealed by activation
    nr, nx0, ny0 = ak.crop_rgba(d["net_rgba"], pad=2)
    ax0, ay0 = nx0 // UP, ny0 // UP
    nr = d["net_rgba"][ay0 * UP:ay0 * UP + nr.shape[0] + UP, ax0 * UP:ax0 * UP + nr.shape[1] + UP]
    ah, aw = nr.shape[0] // UP, nr.shape[1] // UP
    nr = nr[:ah * UP, :aw * UP]
    layers.append({"id": "network", "type": "reveal", "src": ak.to_data_uri(nr),
                   "act": ak.to_data_uri(act_image(act[ay0:ay0 + ah, ax0:ax0 + aw])),
                   "x": ax0, "y": ay0, "w": aw, "h": ah, "soft": 0.025,
                   "front": {"c": [255, 232, 190], "w": 0.012, "gain": 1.0}, **sky_cam})

    # ------------------------------------------------------------ nodes flare as the front reaches them
    t9r = np.where(d["reveal"], t9, 0)
    pk = (t9r == cv2.dilate(t9r, ell(15))) & (t9r > 110)
    items = []
    for y, x in np.argwhere(pk):
        size = (t9[max(0, y - 10):y + 11, max(0, x - 10):x + 11] > 70).sum()
        rr = np.sqrt(size / np.pi) / UP
        g = float(act[min(H - 1, y // UP), min(W - 1, x // UP)])
        col = 0.55 * d["master"][y, x].astype(float) + 0.45 * np.array([255, 225, 170])
        items.append({"x": round(x / UP, 2), "y": round(y / UP, 2), "r": round(float(2.5 + 1.6 * rr), 2),
                      "c": [int(v) for v in np.clip(col, 0, 255)], "a": round(float(rng.uniform(0.35, 0.6)), 3),
                      "g": round(g, 5)})
    layers.append({"id": "flares", "type": "nodes", "shape": "glow", "blend": "lighter", **sky_cam,
                   "pulse": [0.006, 0.04], "swell": 0.4, "items": items})

    # ------------------------------------------------------------ comets along the lines at the front
    line_core = d["web"] & (t9 > 40)
    sk = skeletonize(cv2.resize(line_core.astype(np.uint8), (W, H), interpolation=cv2.INTER_AREA) > 0)
    pts = poisson_points(sk, 3.5, rng)
    items = []
    for x, y in pts:
        g = float(act[int(y), int(x)])
        items.append({"x": round(x + 0.5, 2), "y": round(y + 0.5, 2), "r": round(float(rng.uniform(1.2, 2.0)), 2),
                      "c": [255, 236, 200], "a": round(float(rng.uniform(0.5, 0.8)), 3), "g": round(g, 5)})
    layers.append({"id": "sparks", "type": "nodes", "shape": "glow", "blend": "lighter", **sky_cam,
                   "pulse": [0.0015, 0.008], "decay": "exp", "items": items})

    # ------------------------------------------------------------ the figure and the platform
    fr, fx0, fy0 = ak.crop_rgba(d["fig_rgba"], pad=2)
    layers.append({"id": "figure", "type": "image", "src": ak.to_data_uri(fr), **near_cam,
                   "x": fx0 / UP, "y": fy0 / UP, "w": fr.shape[1] / UP, "h": fr.shape[0] / UP})

    # ------------------------------------------------------------ soft motes right in front of the lens
    items = []
    for k in range(26):
        items.append(ak.particle(rng.uniform(0, W), rng.uniform(0, H), rng.uniform(5, 13), (255, 222, 180),
                                 alpha=rng.uniform(0.05, 0.13), vx=rng.normal(0, 2), vy=-rng.uniform(2, 7),
                                 life=float(rng.choice([10.0, 15.0])), phase=rng.random(), fade_in=0.3, fade_out=0.4))
    layers.append({"id": "bokeh", "type": "particles", "shape": "glow", "blend": "lighter", "camera": True,
                   "parallax": 1.35, "alpha": {"base": 0.0, "amp": 1.0, "wave": "zoom"}, "items": items})

    # ------------------------------------------------------------ vignette while close
    yy, xx = np.mgrid[0:H // 2, 0:W // 2]
    q = np.hypot((xx / (W / 2) - 0.5) * 2, (yy / (H / 2) - 0.5) * 2)
    va = np.clip((q - 0.55) / 0.95, 0, 1) ** 1.6
    vig = np.dstack([np.zeros((H // 2, W // 2, 3), np.uint8), np.round(va * 255).astype(np.uint8)])
    layers.append({"id": "vignette", "type": "image", "src": ak.to_data_uri(vig), "x": 0, "y": 0, "w": W, "h": H,
                   "alpha": {"base": 0.0, "amp": 0.7, "wave": "zoom"}})

    scene = {"title": "Constellation", "width": W, "height": H, "loop": LOOP, "grow": GROW, "camera": CAMERA,
             "source": ak.file_data_uri(os.path.join(HERE, "source.webp")), "layers": layers}
    ak.write_scene_js(os.path.join(HERE, "scene.js"), scene)
    ak.install_page(HERE, scene["title"])

    Image.fromarray(d["plate"]).resize((W, H), Image.LANCZOS).save(os.path.join(dbg, "sky.png"))
    Image.fromarray(d["net_rgba"]).resize((W, H), Image.LANCZOS).save(os.path.join(dbg, "network.png"))
    Image.fromarray(d["fig_rgba"]).resize((W, H), Image.LANCZOS).save(os.path.join(dbg, "figure.png"))
    av = (np.clip(act, 0, 1) * 255).astype(np.uint8)
    heat = cv2.applyColorMap(av, cv2.COLORMAP_TURBO)[..., ::-1].copy()
    heat[~rev] = (heat[~rev] * 0.25).astype(np.uint8)
    heat[seeds] = (255, 255, 255)
    Image.fromarray(heat).save(os.path.join(dbg, "activation.png"))
    n = sum(len(l.get("items", [])) for l in layers)
    print(f"scene: {len(layers)} layers, {n} sprites, scene.js {os.path.getsize(os.path.join(HERE, 'scene.js')) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
