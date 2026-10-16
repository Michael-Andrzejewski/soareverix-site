#!/usr/bin/env python3
"""Build the animated scene for "Constellation" from source.webp.

    python3 art/constellation/build_scene.py            (--fresh to redo the cached detection)
    SCALE=1.7534 .claude/skills/animate-art/scripts/pipeline.sh art/constellation   (1920x1280)

An intro: it plays once and holds the finished painting. Every star is already in
the sky. The camera starts close on the figure at the platform's edge, light gathers
around the figure, and the golden lines draw themselves from star to star in a wave
that spreads out from the figure, bottom left to top right, while the camera pulls
back and the figure grows distant. The last line to connect runs into the blue star,
which flares. The finished frame is
the painting itself, in high definition. The page plays it in 15 s; ?duration=3
plays the same intro in 3 s.

How:
- HD master: the source upscaled 4x with Real-ESRGAN (scripts/superres.py), its
  detail blended over a Lanczos upscale so glows keep their softness (source_x4.webp).
- The constellation is extracted as a graph: stars (a blob response that ignores
  lines) and the straight painted lines between them (every star pair whose
  segment is covered by line pixels, minus segments through a third star).
  graph.json carries it for the website (hover a star, light up its links).
- Order: a wave from the figure that closes on the blue star (see wave_order). The
  one line into the blue star is held back and drawn last. Each line pixel's
  activation is its point's arrival time along its line, so lines grow star to star.
- Only line pixels are revealed (a WebGL shader); stars stay in the sky plate.
Layers, back to front:
  sky       the HD painting with the lines painted out (stars kept), in tiles <= 4096 px
  stars     twinkle on the white background stars
  motes     points of light streaming out from the figure while the lines grow
  aura      the figure's backlight, brightest before the wave leaves it
  network   the painted lines, revealed by activation
  flares    each star lights up as a line reaches it
  beacon    the blue star's flare when the last line connects
  sparks    comets running along the lines at the front
  links     hover a star (once the intro is done): it lights up with its lines and neighbours
  figure    the figure and the platform, cut out and nearer the lens (parallax)
  vignette  darkens the corners while the camera is close
"""
import argparse
import json
import os
import sys
import time

import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
from skimage.filters import apply_hysteresis_threshold, sato

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.join(HERE, "..", "..", ".claude", "skills", "animate-art")
sys.path.insert(0, os.path.join(KIT, "scripts"))
import artkit as ak  # noqa: E402

INTRO = 15.0                 # the intro's length; the page's ?duration=3 plays it 5x faster
LOOP = 2 * INTRO             # the engine's period (particles loop on it; the drivers play once)
SEED = 7
DET = 2                      # detection runs on a 2x Lanczos master
UP = 4                       # rendering uses the 4x HD master
TILE = 4096                  # the largest texture side that every GPU takes
SKY_P = 0.85                 # parallax of the sky + lines (the figure is 1.0): the figure is nearer
GROW = {"hold": [0.07, 0.02], "ease": 3}   # 1 s of light gathering, then the lines
CAMERA = {"drive": "grow", "cx": 300, "cy": 600, "zmax": 1.8, "log": True, "hold": [0.0, 0.02],
          "ease": 3, "roll": 0.03}
HORIZON = [(300, 645), (550, 662), (700, 675), (800, 685), (1095, 715)]   # rough planet limb, refined
BLUE = (653.6, 217.6)        # the blue star: connected last
FIGURE = (268, 400)          # the wave starts here (the figure's chest)
MAIN = (0.02, 0.80)          # activation range of the network
FINALE = (0.84, 0.95)        # the last line, into the blue star
STAR_MIN = 14.0             # blob response a node needs (lower picks up bright points along lines)
LINE_SPEED = 0.0009          # G per px: the fastest a line grows (a 100 px line takes at least 0.09)


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


# ---------------------------------------------------------------------------- HD master
def hd_master(src):
    """source_x4.webp: Real-ESRGAN 4x detail over a Lanczos 4x base (glows keep their softness)."""
    path = os.path.join(HERE, "source_x4.webp")
    if os.path.exists(path):
        return ak.load_rgb(path)
    import superres
    weights = os.environ.get("ESRGAN_WEIGHTS", "RealESRGAN_x4plus.pth")
    if not os.path.exists(weights):
        raise SystemExit(f"need {path}, or Real-ESRGAN weights at $ESRGAN_WEIGHTS to make it (see scripts/superres.py)")
    e = superres.upscale4(src, weights).astype(np.float32)
    lz = np.asarray(Image.fromarray(src).resize((e.shape[1], e.shape[0]), Image.LANCZOS)).astype(np.float32)
    out = np.clip(np.round(e - cv2.GaussianBlur(e, (0, 0), 3.0) + cv2.GaussianBlur(lz, (0, 0), 3.0)), 0, 255)
    out = out.astype(np.uint8)
    Image.fromarray(out).save(path, quality=95, method=6)
    return out


# ---------------------------------------------------------------------------- detection (2x)
def detect(src):
    """Masks at 2x: figure, sky, the line network (web + faint + soft lines), golden dots, white stars."""
    H, W = src.shape[:2]
    m = ak.upscale(src, DET, sharpen=0.35)
    mf = m.astype(np.float32)
    L = ak.luma(m).astype(np.float32)
    yy, xx = np.mgrid[0:H * DET, 0:W * DET]
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
    sky = ~fig_band & (yy < np.polyval(horizon, xx / DET) * DET - 4 * DET)

    # the web: bright thin structure (top-hat), one huge component. Off-line dots are
    # stars: golden ones (warm added light) and white ones
    t9 = cv2.morphologyEx(L, cv2.MORPH_TOPHAT, ell(17))
    n, lab, st, ext = components((t9 > 18) & sky)
    web = st[:, 4] > 20000
    web[0] = False
    tc = np.dstack([cv2.morphologyEx(mf[..., k], cv2.MORPH_TOPHAT, ell(17)) for k in range(3)])
    sR = np.bincount(lab.ravel(), tc[..., 0].ravel(), n)
    sB = np.bincount(lab.ravel(), tc[..., 2].ravel(), n)
    # golden dots are compact; an elongated warm piece is a stray bit of line
    warm = (sR / np.maximum(sB, 1) > 1.1) & ~web & (ext < 16)
    warm[0] = False
    star_lab = np.where((~web & ~warm)[lab], lab, 0)
    # faint lines the top-hat misses: ridge filter with hysteresis, long thin pieces only
    ridge = sato(L, sigmas=[1.0, 2.0], black_ridges=False)
    away = ~(cv2.dilate(fig.astype(np.uint8), ell(31)) > 0)
    hy = apply_hysteresis_threshold(np.where(sky & away, ridge, 0), 3.5, 6)
    n2, lab2, st2, ext2 = components(hy)
    thin = (ext2 > 40) & (st2[:, 4] < 7 * ext2)
    thin[0] = False
    lines = web[lab] | thin[lab2]
    # soft, out-of-focus lines stand out once the sharp ones are gone: wider ridge filter
    # on a quick plate, straight pieces only (nebula wisps curl)
    quick = ak.smooth_fill(m, cv2.dilate((lines | warm[lab]).astype(np.uint8), ell(5)) > 0, exclude=fig_band)
    r2 = sato(ak.luma(quick).astype(np.float32), sigmas=[2.0, 3.0, 4.5], black_ridges=False)
    hy = apply_hysteresis_threshold(np.where(sky & away, r2, 0), 1.5, 3.0)
    n3, lab3, st3, ext3 = components(hy)
    soft = np.zeros(n3, bool)
    for i in np.nonzero((ext3 > 60) & (st3[:, 4] < 12 * ext3))[0]:
        x, y, w, h, _ = st3[i]
        pts = np.argwhere(lab3[y:y + h, x:x + w] == i).astype(float)
        ev = np.linalg.eigvalsh(np.cov(pts.T))
        soft[i] = np.sqrt(ev[0]) < 2.2 and np.sqrt(ev[1]) > 15
    lines |= (cv2.dilate(soft[lab3].astype(np.uint8), ell(7)) > 0) & sky
    return dict(m=m, L=L, t9=t9, ridge=ridge, horizon=horizon, fig=fig, fig_band=fig_band, sky=sky,
                web=web[lab], lines=lines, warm=warm[lab], star_lab=star_lab)


# ---------------------------------------------------------------------------- the graph
def extract_graph(d):
    """Stars on the web and the straight painted lines between them (all in 2x px)."""
    L, t9, fig_band, web = d["L"], d["t9"], d["fig_band"], d["web"]
    H2, W2 = t9.shape
    # stars: difference of gaussians minus its best average along any line direction, so a
    # line (which keeps its response along itself) scores low and a star high
    dog = cv2.GaussianBlur(L, (0, 0), 2.0) - cv2.GaussianBlur(L, (0, 0), 6.0)
    along = []
    for a in np.linspace(0, np.pi, 12, endpoint=False):
        k = np.zeros((15, 15), np.float32)
        for t in np.linspace(-7, 7, 60):
            k[int(round(7 + t * np.sin(a))), int(round(7 + t * np.cos(a)))] = 1
        along.append(cv2.filter2D(dog, -1, k / k.sum()))
    star = dog - np.max(along, axis=0)
    webd = cv2.dilate(web.astype(np.uint8), ell(11)) > 0
    pk = (star == cv2.dilate(star, ell(9))) & (star > STAR_MIN) & ~fig_band & webd
    ys, xs = np.nonzero(pk)
    cand = np.column_stack([xs, ys]).astype(float)
    strength = star[ys, xs]
    cand = np.vstack([cand, [[BLUE[0] * DET, BLUE[1] * DET]]])     # its spikes hide it from the blob test
    strength = np.r_[strength, 1e9]
    kept = []
    for k in np.argsort(-strength):          # one star, one node; a weak point near a star is that star
        near = 18 if strength[k] < 30 else 8
        if all(np.hypot(*(cand[k] - cand[q])) > near for q in kept):
            kept.append(k)
    nodes = cand[sorted(kept)]
    strength = np.minimum(strength[sorted(kept)], 200)
    # lines: a star pair whose segment (minus the star discs) is covered by line pixels
    E = ((d["ridge"] > 3) | (t9 > 18)) & ~fig_band
    E = cv2.dilate(E.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    N = len(nodes)
    ii, jj = np.triu_indices(N, 1)
    dist = np.hypot(*(nodes[jj] - nodes[ii]).T)
    sel = (dist > 12) & (dist < 900)
    ii, jj, dist = ii[sel], jj[sel], dist[sel]
    R0 = 6.0

    def sample(i, j, dd, k):
        a, b = R0 / dd, 1 - R0 / dd
        tt = a[:, None] + (b - a)[:, None] * np.linspace(0, 1, k)[None]
        x = nodes[i, 0][:, None] + (nodes[j, 0] - nodes[i, 0])[:, None] * tt
        y = nodes[i, 1][:, None] + (nodes[j, 1] - nodes[i, 1])[:, None] * tt
        xi = np.clip(np.round(x).astype(int), 0, W2 - 1)
        yi = np.clip(np.round(y).astype(int), 0, H2 - 1)
        return E[yi, xi], fig_band[yi, xi]

    cov = np.zeros(len(ii))
    for s in range(0, len(ii), 20000):
        e, f = sample(ii[s:s + 20000], jj[s:s + 20000], dist[s:s + 20000], 48)
        cov[s:s + 20000] = (e & ~f).sum(1) / np.maximum((~f).sum(1), 1) * ((~f).mean(1) > 0.4)
    edges = []
    for i, j, dd in zip(ii[cov >= 0.85], jj[cov >= 0.85], dist[cov >= 0.85]):
        e, f = sample(np.array([i]), np.array([j]), np.array([dd]), int(dd * 1.5))
        e, valid = e[0], ~f[0]
        if valid.mean() < 0.4 or (e & valid).sum() / valid.sum() < 0.93:
            continue
        gap = best = 0
        for v in valid & ~e:
            gap = gap + 1 if v else 0
            best = max(best, gap)
        if best / 1.5 <= 4:
            edges.append((i, j, dd))
    # a segment through a third star is two lines, not one
    keep = []
    for i, j, dd in edges:
        p, v = nodes[i], (nodes[j] - nodes[i]) / dd
        w = nodes - p
        t = w @ v
        inner = (t > 8) & (t < dd - 8) & (np.abs(w[:, 0] * v[1] - w[:, 1] * v[0]) < 5.0)
        inner[[i, j]] = False
        keep.append(not inner.any())
    edges = [e for e, k in zip(edges, keep) if k]
    # a weak star that a straight line merely passes (two lines, straight through) is not a
    # node: join its two lines into one
    adj = {}
    for i, j, _ in edges:
        adj.setdefault(int(i), set()).add(int(j))
        adj.setdefault(int(j), set()).add(int(i))
    blue_i = len(nodes) - 1
    changed = True
    while changed:
        changed = False
        for w in list(adj):
            nb = adj.get(w, set())
            if len(nb) != 2 or strength[w] >= 30 or w == blue_i:
                continue
            a_, b_ = nb
            va, vb = nodes[a_] - nodes[w], nodes[b_] - nodes[w]
            cosang = (va @ vb) / (np.linalg.norm(va) * np.linalg.norm(vb) + 1e-9)
            if cosang > -0.985 or b_ in adj[a_]:      # bends by more than ~10 degrees, or already joined
                continue
            adj[a_].discard(w); adj[b_].discard(w)
            adj[a_].add(b_); adj[b_].add(a_)
            del adj[w]
            changed = True
    edges = [(i, j, np.hypot(*(nodes[j] - nodes[i]))) for i in adj for j in adj[i] if i < j]
    used = sorted({int(e[0]) for e in edges} | {int(e[1]) for e in edges})
    remap = {o: n for n, o in enumerate(used)}
    edges = np.array([(remap[int(i)], remap[int(j)]) for i, j, _ in edges], int)
    return nodes[used] / DET, edges, strength[used]


def wave_order(nodes, edges):
    """When each star connects (in G). A wave leaves the figure and closes on the blue star:
    the field a / (a + b) (a, b: distances to the figure and to the blue star) is 0 at the
    figure and 1 only at the blue star; rank-equalised over the lines so the drawing keeps
    an even pace. Every star connects at its wave time; the lines bridge between them."""
    N = len(nodes)
    blue = int(np.argmin(np.hypot(*(nodes - np.array(BLUE)).T)))
    length = np.hypot(*(nodes[edges[:, 1]] - nodes[edges[:, 0]]).T)
    normal = (edges[:, 0] != blue) & (edges[:, 1] != blue)

    def field(p):
        a = np.hypot(*(p - np.array(FIGURE)).T)
        b = np.hypot(*(p - np.array(BLUE)).T)
        return a / (a + b)

    # the lines' own field values (1 px samples) set the pace
    samples = np.concatenate([field(nodes[u] + (nodes[v] - nodes[u]) * np.linspace(0, 1, max(2, int(ln)))[:, None])
                              for (u, v), ln, ok in zip(edges, length, normal) if ok])
    samples.sort()
    lo, hi = MAIN
    arr = lo + (hi - lo) * np.searchsorted(samples, field(nodes)) / len(samples)
    arr[blue] = FINALE[1]
    return arr, blue, length


def activation(nodes, edges, arr, blue, length, lines1, shape):
    """Per line pixel (1x): the G at which it shows. A line leaves its earlier star when that
    star connects and arrives as the later one does; if they connect almost together, it
    grows from both ends at LINE_SPEED and meets in the middle. The blue star's line runs
    last, alone."""
    H, W = shape

    def act_at(e, s):
        u, v = edges[e]
        if u == blue or v == blue:  # the finale: from the other star into the blue one
            s_from = s if v == blue else length[e] - s
            return FINALE[0] + (FINALE[1] - FINALE[0]) * s_from / length[e]
        k = max(LINE_SPEED, abs(arr[v] - arr[u]) / length[e])
        return np.minimum(arr[u] + k * s, arr[v] + k * (length[e] - s))

    # rasterise the lines (index + 1) and give each line pixel its nearest line's timing
    idx = np.zeros((H, W), np.float32)
    for e, (u, v) in enumerate(edges):
        cv2.line(idx, tuple(np.round(nodes[u]).astype(int)), tuple(np.round(nodes[v]).astype(int)), float(e + 1), 1)
    dist, (iy, ix) = distance_transform_edt(idx == 0, return_indices=True)
    eid = idx[iy, ix].astype(int) - 1
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    p0, p1 = nodes[edges[eid, 0]], nodes[edges[eid, 1]]
    dv = p1 - p0
    s = np.clip(((xx - p0[..., 0]) * dv[..., 0] + (yy - p0[..., 1]) * dv[..., 1]) / length[eid], 0, length[eid])
    act = np.full((H, W), np.nan, np.float32)
    near = dist <= 3
    for e in range(len(edges)):
        m = near & (eid == e)
        if m.any():
            act[m] = act_at(e, s[m])
    # line pixels the graph misses (lines off the frame, behind the figure...): continue
    # from the nearest timed line pixel
    timed = np.isfinite(act) & lines1
    dd, (jy, jx) = distance_transform_edt(~timed, return_indices=True)
    miss = lines1 & ~timed
    act[miss] = np.minimum(act[jy[miss], jx[miss]] + LINE_SPEED * dd[miss], MAIN[1])
    # every other pixel takes its nearest line pixel's value (clean NEAREST edges)
    has = np.isfinite(act)
    _, (jy, jx) = distance_transform_edt(~has, return_indices=True)
    return act[jy, jx], act_at


def star_glows(master, centres, rmax=56, fade=6):
    """Each star's radial glow: the median of every ring around it (lines cover only a few
    of a ring's angles), above its own background. Returns (x, y, R, glow[r, rgb])."""
    th = np.linspace(0, 2 * np.pi, 72, endpoint=False)
    rs = np.arange(rmax + 1, dtype=np.float32)
    out = []
    for x, y in centres:
        mx = (x + rs[:, None] * np.cos(th)[None]).astype(np.float32)
        my = (y + rs[:, None] * np.sin(th)[None]).astype(np.float32)
        ring = cv2.remap(master, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT).astype(np.float32)
        prof = np.median(ring, axis=1)
        lum = prof @ np.array([0.299, 0.587, 0.114], np.float32)
        bg = lum[-8:].mean()
        if lum[:3].max() - bg < 10:
            continue
        above = np.nonzero(lum - bg < 0.06 * (lum[:3].max() - bg))[0]
        R = int(min(max(4, above[0] if len(above) else rmax), rmax - fade))
        out.append((x, y, R, np.maximum(prof - prof[-8:].mean(0), 0)))
    return out


def paint_glows(plate, glows, fade=6):
    """Add the radial glows onto a plate whose star discs were filled from outside."""
    H, W = plate.shape[:2]
    for x, y, R, glow in glows:
        x0, x1 = max(0, int(x) - R - fade), min(W, int(x) + R + fade + 1)
        y0, y1 = max(0, int(y) - R - fade), min(H, int(y) + R + fade + 1)
        yy, xx = np.mgrid[y0:y1, x0:x1]
        rr = np.hypot(xx - x, yy - y)
        sel = rr <= R + fade
        rs = np.arange(len(glow), dtype=np.float32)
        val = np.stack([np.interp(rr[sel], rs, glow[:, c]) for c in range(3)], -1)
        w = np.clip((R + fade - rr[sel]) / fade, 0, 1)[:, None]
        sub = plate[y0:y1, x0:x1]
        sub[sel] = np.clip(sub[sel] + w * val, 0, 255).astype(np.uint8)


def act_image(act):
    q = np.round(np.clip(act, 0, 1) * 65535).astype(np.uint32)
    return np.dstack([q >> 8, q & 255, np.zeros_like(q)]).astype(np.uint8)


def column_tiles(width_1x):
    """Split [0, width) into columns no wider than TILE at UP (boundaries on whole 1x px)."""
    n = int(np.ceil(width_1x * UP / TILE))
    edges = np.round(np.linspace(0, width_1x, n + 1)).astype(int)
    return [(int(a), int(b)) for a, b in zip(edges[:-1], edges[1:])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", action="store_true", help="recompute the cached detection (slow)")
    args = ap.parse_args()
    rng = np.random.default_rng(SEED)
    src = ak.load_rgb(os.path.join(HERE, "source.webp"))
    H, W = src.shape[:2]
    dbg = os.path.join(HERE, "debug")
    os.makedirs(dbg, exist_ok=True)
    cache = os.path.join(dbg, "detect_v2.npz")
    t0 = time.time()
    if os.path.exists(cache) and not args.fresh:
        z = np.load(cache)
        d = {k: z[k] for k in z.files}
    else:
        d = detect(src)
        d["nodes"], d["edges"], d["strength"] = extract_graph(d)
        np.savez(cache, **d)
    nodes, edges = d["nodes"], d["edges"]
    print(f"  detection: {len(nodes)} stars, {len(edges)} lines ({time.time() - t0:.0f} s)")

    arr, blue, length = wave_order(nodes, edges)
    blue_edges = np.nonzero((edges[:, 0] == blue) | (edges[:, 1] == blue))[0]
    first = np.argsort(arr)[:3]
    print(f"  blue star #{blue} at {nodes[blue].round(1)}, lines into it: {len(blue_edges)}; "
          f"first stars {nodes[first].round(0).tolist()}; last before it {nodes[np.argsort(arr)[-2]].round(0)}")

    # ------------------------------------------------------------ HD layers
    t0 = time.time()
    m4 = hd_master(src)
    lines2 = d["lines"].copy()
    lines2 &= ~d["warm"]
    # every graph line belongs to the reveal, wherever the image shows it
    em = np.zeros_like(lines2, np.uint8)
    for u, v in edges:
        cv2.line(em, tuple(np.round(nodes[u] * DET).astype(int)), tuple(np.round(nodes[v] * DET).astype(int)), 1, 5)
    lines2 |= (em > 0) & (d["t9"] > 5) & d["sky"]
    lines1 = cv2.resize(lines2.astype(np.uint8), (W, H), interpolation=cv2.INTER_AREA) > 0
    net4 = cv2.resize(lines2.astype(np.uint8), (W * UP, H * UP), interpolation=cv2.INTER_NEAREST)
    net4 = cv2.dilate(net4, ell(5)) > 0
    fig4 = cv2.resize(d["fig"].astype(np.uint8), (W * UP, H * UP), interpolation=cv2.INTER_NEAREST) > 0
    band4 = cv2.dilate(fig4.astype(np.uint8), ell(19)) > 0
    net4 &= ~band4
    # stars on the lines: the sky shows a radial model of each (glow without lines); the
    # star's own pixels come back with its lines, so it lights up as it connects
    glows = star_glows(m4, nodes * UP)
    discs = np.zeros(net4.shape, np.uint8)
    for x, y, R, _ in glows:
        cv2.circle(discs, (int(round(x)), int(round(y))), R + 6, 1, -1)
    net4 |= (discs > 0) & ~band4
    plate4 = ak.smooth_fill(m4, net4, exclude=band4)
    plate4 = ak.smooth_fill(plate4, band4)
    paint_glows(plate4, glows)
    # the lines as light over the plate (unmixed): exact when complete, and alpha measures
    # line strength, so the front's glow follows the line cores
    ink, alpha = ak.unmix(m4.astype(np.float32), plate4.astype(np.float32))
    net_a = np.where(net4, alpha, 0)
    net_rgb = np.where(net4[..., None], np.round(ink), 0).astype(np.uint8)
    ink, alpha = ak.unmix(m4.astype(np.float32), plate4.astype(np.float32))
    core4 = cv2.erode(fig4.astype(np.uint8), ell(3)) > 0
    alpha[~band4] = 0
    ink[core4] = m4[core4]
    alpha[core4] = 1
    fig_rgba = np.dstack([np.round(ink), np.round(alpha * 255)]).astype(np.uint8)
    print(f"  HD layers in {time.time() - t0:.0f} s")

    act, act_at = activation(nodes, edges, arr, blue, length, lines1, (H, W))

    sky_cam = {"camera": True, "parallax": SKY_P, "mip": True}
    layers = []
    for x0, x1 in column_tiles(W):
        layers.append({"id": "sky" if x0 == 0 else f"sky{x0}", "type": "image",
                       "src": ak.to_data_uri(plate4[:, x0 * UP:x1 * UP], "WEBP", quality=92, method=6),
                       "x": x0, "y": 0, "w": x1 - x0, "h": H, **sky_cam})

    # ------------------------------------------------------------ background stars twinkle
    t9, star_lab = d["t9"], d["star_lab"]
    ns = star_lab.max() + 1
    peak = np.zeros(ns)
    np.maximum.at(peak, star_lab.ravel(), t9.ravel())
    cnt = np.bincount(star_lab.ravel(), minlength=ns)
    ys, xs = np.nonzero(star_lab)
    cx = np.bincount(star_lab[ys, xs], xs, ns) / np.maximum(cnt, 1)
    cy = np.bincount(star_lab[ys, xs], ys, ns) / np.maximum(cnt, 1)
    items = []
    for i in [i for i in np.argsort(-peak) if i > 0 and peak[i] > 90][:260]:
        col = 0.5 * d["m"][int(cy[i]), int(cx[i])].astype(float) + 0.5 * np.array([225, 235, 255])
        items.append(ak.particle(cx[i] / DET, cy[i] / DET, rng.uniform(1.6, 3.4), col, alpha=rng.uniform(0.25, 0.5),
                                 life=LOOP, tw=1.0, tw_k=int(rng.choice([2, 3, 4, 6])), tw_phase=rng.random()))
    layers.append({"id": "stars", "type": "particles", "shape": "glow", "blend": "lighter", **sky_cam, "items": items})

    # ------------------------------------------------------------ light leaving the figure
    # the person (not the platform): the silhouette above the platform's top
    person2 = d["fig"].copy()
    person2[int(560 * DET):, :] = False
    person2[:, int(330 * DET):] = False
    rim = cv2.dilate(person2.astype(np.uint8), ell(9)) > 0
    ry, rx = np.nonzero(rim & ~person2)
    fx, fy = FIGURE
    items = []
    for k in range(200):
        j = rng.integers(len(rx))
        x, y = rx[j] / DET, ry[j] / DET
        ang = np.arctan2(y - fy, x - fx) + rng.normal(0, 0.35)
        sp = rng.uniform(14, 40)
        col = (255, 226, 170) if rng.random() < 0.8 else (215, 230, 255)
        items.append(ak.particle(x, y, rng.uniform(1.0, 2.3), col, alpha=rng.uniform(0.5, 1.0),
                                 vx=np.cos(ang) * sp, vy=np.sin(ang) * sp - 6, life=float(rng.choice([5.0, 6.0, 10.0])),
                                 phase=rng.random(), fade_in=0.12, fade_out=0.6, shrink=0.5,
                                 tw=0.5, tw_k=int(rng.choice([6, 10, 12])), tw_phase=rng.random()))
    layers.append({"id": "motes", "type": "particles", "shape": "glow", "blend": "lighter",
                   "camera": True, "parallax": 0.92, "alpha": {"base": 0.3, "amp": 0.7, "wave": "growrate"},
                   "items": items})

    # ------------------------------------------------------------ the figure's backlight: brightest before the wave
    aura = ak.glow_rgba(np.pad(person2, 120), (255, 214, 160), sigmas=(40, 110), weights=(0.5, 0.6), gain=1.1)
    aura_rgba, ax0, ay0 = ak.crop_rgba(aura, pad=4)
    layers.append({"id": "aura", "type": "image", "src": ak.to_data_uri(aura_rgba), "blend": "lighter",
                   "camera": True, "parallax": 1.0,
                   "x": (ax0 - 120) / DET, "y": (ay0 - 120) / DET, "w": aura_rgba.shape[1] / DET,
                   "h": aura_rgba.shape[0] / DET, "alpha": {"base": 0.45, "amp": -0.45, "wave": "grow"}})

    # ------------------------------------------------------------ the painted lines, revealed by activation
    ys1, xs1 = np.nonzero(lines1)
    by0, by1 = int(max(0, ys1.min() - 2)), int(min(H, ys1.max() + 3))
    for x0, x1 in column_tiles(W):
        sl = (slice(by0 * UP, by1 * UP), slice(x0 * UP, x1 * UP))
        rgba = np.dstack([net_rgb[sl], np.round(net_a[sl] * 255).astype(np.uint8)])
        layers.append({"id": "network" if x0 == 0 else f"network{x0}", "type": "reveal",
                       "src": ak.to_data_uri(rgba, "WEBP", quality=92, alpha_quality=100, method=6),
                       "act": ak.to_data_uri(act_image(act[by0:by1, x0:x1])),
                       "x": x0, "y": by0, "w": x1 - x0, "h": by1 - by0, "soft": 0.02,
                       "front": {"c": [255, 232, 190], "w": 0.012, "gain": 1.0}, **sky_cam})

    # ------------------------------------------------------------ stars light up as a line reaches them
    g_node = arr
    items = []
    for k, (x, y) in enumerate(nodes):
        if k == blue:
            continue
        win = t9[max(0, int(y * DET) - 8):int(y * DET) + 9, max(0, int(x * DET) - 8):int(x * DET) + 9]
        rr = np.sqrt((win > 0.5 * win.max()).sum() / np.pi) / DET if win.size else 1.0
        col = 0.5 * d["m"][int(y * DET), int(x * DET)].astype(float) + 0.5 * np.array([255, 226, 175])
        items.append({"x": round(float(x), 2), "y": round(float(y), 2), "r": round(float(3.0 + 2.2 * rr), 2),
                      "c": [int(v) for v in np.clip(col, 0, 255)], "a": round(float(rng.uniform(0.45, 0.7)), 3),
                      "g": round(float(g_node[k]), 5)})
    layers.append({"id": "flares", "type": "nodes", "shape": "glow", "blend": "lighter", **sky_cam,
                   "pulse": [0.004, 0.035], "swell": 0.5, "items": items})
    bx, by = nodes[blue]
    layers.append({"id": "beacon", "type": "nodes", "shape": "glow", "blend": "lighter", **sky_cam,
                   "pulse": [0.003, 0.022], "swell": 0.8,
                   "items": [{"x": round(float(bx), 2), "y": round(float(by), 2), "r": 16.0, "c": [190, 225, 255],
                              "a": 1.0, "g": FINALE[1]},
                             {"x": round(float(bx), 2), "y": round(float(by), 2), "r": 42.0, "c": [120, 175, 255],
                              "a": 0.55, "g": FINALE[1]}]})

    # ------------------------------------------------------------ comets along the lines at the front
    items = []
    for e, (u, v) in enumerate(edges):
        p, q = nodes[u], nodes[v]
        for s in np.arange(3.0, length[e] - 3.0, 1.25):
            x, y = p + (q - p) * s / length[e]
            if not (0 <= x < W and 0 <= y < H) or d["fig_band"][int(y * DET), int(x * DET)]:
                continue
            fin = e in blue_edges
            items.append({"x": round(float(x), 2), "y": round(float(y), 2),
                          "r": round(float(rng.uniform(1.4, 2.0) * (1.4 if fin else 1)), 2),
                          "c": [205, 230, 255] if fin else [255, 236, 200],
                          "a": round(float(rng.uniform(0.3, 0.45)), 3), "g": round(float(act_at(e, s)), 5)})
    layers.append({"id": "sparks", "type": "nodes", "shape": "glow", "blend": "lighter", **sky_cam,
                   "pulse": [0.0015, 0.008], "decay": "exp", "items": items})

    # ------------------------------------------------------------ hover a star: it lights up with its lines
    layers.append({"id": "links", "type": "links", "blend": "lighter", "camera": True, "parallax": SKY_P,
                   "c": [255, 228, 180], "stars": [[round(float(x), 2), round(float(y), 2)] for x, y in nodes],
                   "lines": [[int(u), int(v)] for u, v in edges]})

    # ------------------------------------------------------------ the figure and the platform
    fr, fx0, fy0 = ak.crop_rgba(fig_rgba, pad=4)
    layers.append({"id": "figure", "type": "image", "src": ak.to_data_uri(fr, "WEBP", quality=94, alpha_quality=100, method=6),
                   "camera": True, "parallax": 1.0, "mip": True,
                   "x": fx0 / UP, "y": fy0 / UP, "w": fr.shape[1] / UP, "h": fr.shape[0] / UP})

    # ------------------------------------------------------------ vignette while close
    yy, xx = np.mgrid[0:H // 2, 0:W // 2]
    q = np.hypot((xx / (W / 2) - 0.5) * 2, (yy / (H / 2) - 0.5) * 2)
    va = np.clip((q - 0.55) / 0.95, 0, 1) ** 1.6
    vig = np.dstack([np.zeros((H // 2, W // 2, 3), np.uint8), np.round(va * 255).astype(np.uint8)])
    layers.append({"id": "vignette", "type": "image", "src": ak.to_data_uri(vig), "x": 0, "y": 0, "w": W, "h": H,
                   "alpha": {"base": 0.0, "amp": 0.6, "wave": "zoom"}})

    scene = {"title": "Constellation", "width": W, "height": H, "loop": LOOP, "intro": INTRO, "durations": [15, 3],
             "grow": GROW,
             "camera": CAMERA, "source": ak.file_data_uri(os.path.join(HERE, "source.webp")), "layers": layers}
    ak.write_scene_js(os.path.join(HERE, "scene.js"), scene)
    ak.install_page(HERE, scene["title"])

    # ------------------------------------------------------------ the graph, for the website
    graph = {
        "about": "Stars and the lines between them in Constellation, in source pixels (1095x730). "
                 "'order' is when each star connects in the intro (0..1 of the growth); the blue star is last.",
        "size": [W, H],
        "stars": [{"id": k, "x": round(float(x), 2), "y": round(float(y), 2),
                   "order": round(float(g_node[k]), 4)} for k, (x, y) in enumerate(nodes)],
        "lines": [[int(u), int(v)] for u, v in edges],
        "blue": int(blue),
    }
    with open(os.path.join(HERE, "graph.json"), "w") as f:
        json.dump(graph, f, separators=(",", ":"))

    Image.fromarray(plate4).resize((W * 2, H * 2), Image.LANCZOS).save(os.path.join(dbg, "sky.png"))
    Image.fromarray(fig_rgba).resize((W, H), Image.LANCZOS).save(os.path.join(dbg, "figure.png"))
    av = (np.clip(act, 0, 1) * 255).astype(np.uint8)
    heat = cv2.applyColorMap(av, cv2.COLORMAP_TURBO)[..., ::-1].copy()
    heat[~lines1] = (heat[~lines1] * 0.2).astype(np.uint8)
    Image.fromarray(heat).save(os.path.join(dbg, "activation.png"))
    n = sum(len(l.get("items", [])) for l in layers)
    print(f"scene: {len(layers)} layers, {n} sprites, scene.js {os.path.getsize(os.path.join(HERE, 'scene.js')) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
