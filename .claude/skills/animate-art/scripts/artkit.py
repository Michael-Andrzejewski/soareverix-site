"""artkit: turn a still picture into layered, animatable scene data.

The idea: never redraw what the artist drew. Keep the original pixels as a
"plate", cut out only the elements that need to move (so they can be redrawn as
sprites), and add effects as overlays whose rest state is "no change". Every
frame then stays very close to the source, and frame 0 is close to identical.

Import this from a per-artwork build script (see art/ascension/build_scene.py
in the soareverix-site repo for a full example). Everything here is
deterministic given a seed.
"""
import base64
import io
import json
import math
import os

import cv2
import numpy as np
from PIL import Image

LUMA = np.array([0.299, 0.587, 0.114], np.float32)


# ---------------------------------------------------------------- basics
def load_rgb(path):
    return np.asarray(Image.open(path).convert("RGB"))


def luma(img):
    return img.astype(np.float32) @ LUMA


# Shape kinds the extractor understands. Each is the unit ball of a metric, so a
# distance transform in that metric finds the largest one that fits a blob:
#   diamond = L1 ball (45-degree square), circle = L2 ball, square = L-infinity ball.
SHAPE_DIST = {"diamond": cv2.DIST_L1, "circle": cv2.DIST_L2, "square": cv2.DIST_C}


def shape_mask(shape, cx, cy, r, kind="diamond"):
    h, w = shape
    x0, x1 = max(0, int(cx - r - 1)), min(w, int(cx + r + 2))
    y0, y1 = max(0, int(cy - r - 1)), min(h, int(cy + r + 2))
    m = np.zeros(shape, bool)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    dx, dy = np.abs(xx - cx), np.abs(yy - cy)
    if kind == "circle":
        d = np.sqrt(dx * dx + dy * dy)
    elif kind == "square":
        d = np.maximum(dx, dy)
    else:
        d = dx + dy
    m[y0:y1, x0:x1] = d <= r
    return m


def diamond_mask(shape, cx, cy, r):
    return shape_mask(shape, cx, cy, r, "diamond")


def poly_mask(shape, polygons=(), polylines=(), close=True):
    """Rasterise polygons [[(x,y),...], ...] and polylines [([(x,y)...], width), ...]."""
    m = np.zeros(shape, np.uint8)
    for poly in polygons:
        cv2.fillPoly(m, [np.round(np.array(poly) * 16).astype(np.int32)], 255, cv2.LINE_AA, shift=4)
    for pts, width in polylines:
        cv2.polylines(m, [np.round(np.array(pts) * 16).astype(np.int32)], False, 255,
                      int(width), cv2.LINE_AA, shift=4)
    return m > 127


# ---------------------------------------------------------------- masks
def ink_masks(img, ink_lum=42, rel=0.55, bg_kernel=81):
    """Absolute-dark mask and relative-dark mask (dark vs a grey-closing background)."""
    L = luma(img)
    ink_abs = L < ink_lum
    kb = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (bg_kernel, bg_kernel))
    bg = cv2.morphologyEx(L, cv2.MORPH_CLOSE, kb)
    return ink_abs, ink_abs | (L < rel * bg)


def fill_holes(mask):
    """Fill enclosed holes (e.g. a bright emblem inside a dark body)."""
    m = mask.astype(np.uint8)
    pad = cv2.copyMakeBorder(m, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    ff = pad.copy()
    cv2.floodFill(ff, np.zeros((ff.shape[0] + 2, ff.shape[1] + 2), np.uint8), (0, 0), 1)
    return (m > 0) | (ff[1:-1, 1:-1] == 0)


def big_components(mask, kernel=21, min_area=15000, holes=True):
    """Close `mask` and keep components above `min_area` (the static mass)."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel, kernel))
    closed = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, k)
    n, lab, st, _ = cv2.connectedComponentsWithStats(closed, 8)
    ids = [i for i in range(1, n) if st[i, 4] > min_area]
    out = np.isin(lab, ids)
    return fill_holes(out) if holes else out


# ---------------------------------------------------------------- shape extraction
def _decompose(comp, min_r, kind="diamond", max_count=12):
    """Greedy cover of a binary component by metric balls (diamonds, circles or squares)."""
    out, m = [], comp.copy()
    total = m.sum()
    for _ in range(max_count):
        if m.sum() < max(6, 0.08 * total):
            break
        pad = cv2.copyMakeBorder(m, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
        mask_size = cv2.DIST_MASK_PRECISE if kind == "circle" else 3
        dt = cv2.distanceTransform(pad, SHAPE_DIST[kind], mask_size)[1:-1, 1:-1]
        cy, cx = np.unravel_index(np.argmax(dt), dt.shape)
        r = float(dt[cy, cx])
        if r < min_r:
            break
        r -= 0.5  # DT reaches the first outside pixel; the edge is half a pixel in
        out.append((float(cx), float(cy), r))
        m[shape_mask(m.shape, cx, cy, r + 1.5, kind)] = 0
    return out


def extract_shapes(img, candidates, kind="diamond", min_r=2.0, max_r=60.0, min_cover=0.72, margin=3.5):
    """Find shapes of `kind` in `candidates` (bool mask). Returns (shapes, erase_mask, rejected_boxes).

    A component is only extracted if its shapes explain >= min_cover of it,
    so strokes and blobs that merely happen to be dark are left in the plate.
    `margin` px around each shape is erased too, to take the antialiased rim.
    """
    H, W = img.shape[:2]
    imf = img.astype(np.float32)
    n, lab, st, _ = cv2.connectedComponentsWithStats(candidates.astype(np.uint8), 8)
    shapes, rejected = [], []
    erase = np.zeros((H, W), bool)
    for i in range(1, n):
        x, y, w, h, area = st[i]
        if area < 4:
            continue
        comp = (lab[y:y + h, x:x + w] == i).astype(np.uint8)
        found = [d for d in _decompose(comp, min_r, kind) if d[2] <= max_r]
        if not found:
            continue
        cover = np.zeros_like(comp, bool)
        for cx, cy, r in found:
            cover |= shape_mask(comp.shape, cx, cy, r + 1.0, kind)
        if (cover & (comp > 0)).sum() < min_cover * comp.sum():
            rejected.append((int(x), int(y), int(w), int(h)))
            continue
        for cx, cy, r in found:
            gx, gy = cx + x, cy + y
            core = shape_mask((H, W), gx, gy, max(0.8, r - 1.5), kind)
            col = np.median(imf[core], axis=0)
            shapes.append({"x": round(gx, 2), "y": round(gy, 2), "r": round(r, 2),
                           "color": [int(c) for c in col]})
            erase |= shape_mask((H, W), gx, gy, r + margin, kind)
        # anything of the component the diamonds did not explain goes too
        sub = erase[y:y + h, x:x + w]
        sub |= (comp > 0) & (cv2.dilate(sub.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0)
    erase = cv2.dilate(erase.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    return shapes, erase, rejected


def extract_diamonds(img, candidates, **kw):
    return extract_shapes(img, candidates, kind="diamond", **kw)


# ---------------------------------------------------------------- plate fill
def _line_kernel(length, angle_deg):
    k = np.zeros((length, length), np.float32)
    c = (length - 1) / 2
    a = math.radians(angle_deg)
    for t in np.linspace(-c, c, length * 3):
        k[int(round(c + t * math.sin(a))), int(round(c + t * math.cos(a)))] = 1
    return k / k.sum()


def convex_polygon_sdf(shape, verts):
    """Signed distance (px, negative inside) from every pixel centre to a convex polygon."""
    H, W = shape
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    v = np.asarray(verts, np.float32)
    d = np.full(shape, np.inf, np.float32)
    inside = np.ones(shape, bool)
    area = 0.0
    for i in range(len(v)):
        a, b = v[i], v[(i + 1) % len(v)]
        area += a[0] * b[1] - b[0] * a[1]
    orient = 1.0 if area > 0 else -1.0
    for i in range(len(v)):
        a, b = v[i], v[(i + 1) % len(v)]
        ab = b - a
        t = np.clip(((xx - a[0]) * ab[0] + (yy - a[1]) * ab[1]) / (ab @ ab), 0, 1)
        dx, dy = xx - (a[0] + t * ab[0]), yy - (a[1] + t * ab[1])
        d = np.minimum(d, np.sqrt(dx * dx + dy * dy))
        cross = ab[0] * (yy - a[1]) - ab[1] * (xx - a[0])
        inside &= cross * orient >= 0
    return np.where(inside, -d, d)


def ring_coordinate(shape, outer, inner):
    """1-D coordinate across a polygon ring (a stroked outline): 0 at the outer
    edge, -width at the inner edge, positive outside, below -width inside the hole."""
    so = convex_polygon_sdf(shape, outer)
    si = convex_polygon_sdf(shape, inner)
    width = float(np.median(-so[np.abs(si) < 0.5])) if (np.abs(si) < 0.5).any() else 0.0
    return np.where(si >= 0, so, -width + si), width


def profile_guide(img, coord, valid, lo, hi, step=0.25):
    """Median colour as a function of a 1-D coordinate (e.g. distance from a glowing edge).

    Returns (guide HxWx3 float32, mask of pixels where the guide applies). Use as
    guided_fill(..., guide=..., guide_mask=...) so holes over a glow get the exact
    falloff rebuilt instead of a smear.
    """
    bins = np.arange(lo, hi + step, step, dtype=np.float32)
    idx = np.clip(np.round((coord - lo) / step).astype(np.int64), 0, len(bins) - 1)
    inr = (coord >= lo) & (coord <= hi)
    sel = inr & valid
    prof = np.full((len(bins), 3), np.nan, np.float32)
    ii = idx[sel]
    cols = img[sel].astype(np.float32)
    order = np.argsort(ii, kind="stable")
    ii, cols = ii[order], cols[order]
    starts = np.searchsorted(ii, np.arange(len(bins)))
    ends = np.searchsorted(ii, np.arange(len(bins)), side="right")
    for b in range(len(bins)):
        if ends[b] - starts[b] >= 3:
            prof[b] = np.median(cols[starts[b]:ends[b]], axis=0)
    good = ~np.isnan(prof[:, 0])
    for c in range(3):
        prof[:, c] = np.interp(np.arange(len(bins)), np.nonzero(good)[0], prof[good, c])
    # interpolate between bins for sub-pixel accuracy
    f = np.clip((coord - lo) / step, 0, len(bins) - 1)
    i0 = np.floor(f).astype(np.int64)
    i1 = np.minimum(i0 + 1, len(bins) - 1)
    w = (f - i0)[..., None]
    guide = prof[i0] * (1 - w) + prof[i1] * w
    return guide.astype(np.float32), inr


def guided_fill(img, hole, lengths=(41, 81, 161, 321), angles=range(0, 180, 15), exclude=None,
                min_support=0.45, resid_gain=0.6, guide=None, guide_mask=None):
    """Structure-aware hole fill.

    For each of several directions, average the valid pixels along a line
    through every pixel (normalised convolution). Per pixel, keep the direction
    along which the surroundings are most uniform: next to a straight glowing
    edge that is the edge direction, so the edge continues straight through the
    hole instead of smearing like a plain Telea inpaint. A direction only counts
    if at least `min_support` of its line is valid on BOTH halves, so a line that
    barely clips one bright region cannot win. Lines get longer (`lengths`) for
    pixels that the shorter ones could not resolve (big holes). The remaining
    residual is Telea-inpainted and added back at `resid_gain` so texture carries in.
    """
    imf = img.astype(np.float32)
    valid = (~hole).astype(np.float32)
    if exclude is not None:
        valid *= (~exclude).astype(np.float32)
    H, W = hole.shape
    best = np.zeros_like(imf)
    bestvar = np.full((H, W), np.inf, np.float32)
    # the guide is also needed on a ring around each hole: the residual
    # (image - guide) is inpainted from there
    ring = cv2.dilate(hole.astype(np.uint8), np.ones((15, 15), np.uint8)) > 0
    todo = ring.copy()
    for length in lengths:
        for ang in angles:
            k = _line_kernel(length, ang)
            half_a, half_b = k.copy(), k.copy()
            c = (length - 1) // 2
            # split the line into its two halves (each side of the pixel)
            yy, xx = np.mgrid[0:length, 0:length]
            a = math.radians(ang)
            side = (xx - c) * math.cos(a) + (yy - c) * math.sin(a)
            half_a[side < 0] = 0
            half_b[side > 0] = 0
            wa = cv2.filter2D(valid, -1, half_a / max(half_a.sum(), 1e-6), borderType=cv2.BORDER_REFLECT)
            wb = cv2.filter2D(valid, -1, half_b / max(half_b.sum(), 1e-6), borderType=cv2.BORDER_REFLECT)
            w = cv2.filter2D(valid, -1, k, borderType=cv2.BORDER_REFLECT)
            wd = np.maximum(w, 1e-3)[..., None]
            m = cv2.filter2D(imf * valid[..., None], -1, k, borderType=cv2.BORDER_REFLECT) / wd
            m2 = cv2.filter2D(imf ** 2 * valid[..., None], -1, k, borderType=cv2.BORDER_REFLECT) / wd
            var = (m2 - m ** 2).sum(-1)
            ok = todo & (np.minimum(wa, wb) >= min_support * 0.5) & (var < bestvar)
            best[ok], bestvar[ok] = m[ok], var[ok]
        todo &= ~np.isfinite(bestvar)
        if not todo.any():
            break
    if guide is not None:  # a model of the structure beats any directional guess
        gm = ring & guide_mask
        best[gm] = guide[gm]
        todo &= ~gm
    if todo.any():  # nothing qualified anywhere: plain inpaint for those pixels
        tel = cv2.inpaint(img, todo.astype(np.uint8) * 255, 7, cv2.INPAINT_TELEA).astype(np.float32)
        best[todo] = tel[todo]
    resid = np.clip(imf - best + 128, 0, 255).astype(np.uint8)
    resid[~ring] = 128
    rf = cv2.inpaint(resid, hole.astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA).astype(np.float32) - 128
    out = imf.copy()
    out[hole] = (best + rf * resid_gain)[hole]
    return np.clip(out, 0, 255).astype(np.uint8)


def upscale(img, factor=2, sharpen=0.35, sigma=1.2):
    """Lanczos upscale with a mild unsharp mask, for scenes the camera zooms into."""
    H, W = img.shape[:2]
    up = cv2.resize(img, (int(W * factor), int(H * factor)), interpolation=cv2.INTER_LANCZOS4).astype(np.float32)
    if sharpen:
        blur = cv2.GaussianBlur(up, (0, 0), sigma)
        up = up + sharpen * (up - blur)
    return np.clip(up, 0, 255).astype(np.uint8)


def polar_outpaint(img, center, radius, n_theta=4096, smooth_rows=3):
    """Square canvas of side 2*radius centred on `center`, original pixels kept inside
    the source rectangle, the rest continued around each ring.

    For rotating a picture of concentric structure (a vortex, a tunnel, a flower): along
    every circle around the centre, the arcs the source covers are reflected (ping-pong)
    across the gaps, blending from both ends, so the rings carry on with their own
    texture. `center` should be whole pixels. Returns (canvas uint8, canvas centre (x, y),
    (x0, y0) where the source's top-left corner sits on the canvas).
    """
    H, W = img.shape[:2]
    cx, cy = center
    R = int(np.ceil(radius))
    nr = R + 2
    th = np.arange(n_theta) * 2 * np.pi / n_theta
    rr = np.arange(nr, dtype=np.float32)
    mapx = (cx + rr[:, None] * np.cos(th)[None, :]).astype(np.float32)
    mapy = (cy + rr[:, None] * np.sin(th)[None, :]).astype(np.float32)
    P = cv2.remap(img.astype(np.float32), mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    valid = (mapx >= 0) & (mapx <= W - 1) & (mapy >= 0) & (mapy <= H - 1)
    filled = P.copy()

    def pingpong(j, n):
        if n <= 1:
            return np.zeros_like(j)
        m = j % (2 * (n - 1))
        return np.where(m < n, m, 2 * (n - 1) - m)

    for ri in range(nr):
        v = valid[ri]
        if v.all():
            continue
        if not v.any():  # past every corner: carry the last ring outward
            filled[ri] = filled[ri - 1]
            continue
        start = int(np.argmax(v))  # rotate the ring so it begins on a covered sample
        vv = np.roll(v, -start)
        row = np.roll(P[ri], -start, axis=0)
        out = row.copy()
        n = len(vv)
        runs, i = [], 0
        while i < n:
            j = i
            while j < n and vv[j] == vv[i]:
                j += 1
            runs.append((bool(vv[i]), i, j))
            i = j
        for k, (isv, a0, b0) in enumerate(runs):
            if isv:
                continue
            g = b0 - a0
            left, right = runs[k - 1], runs[(k + 1) % len(runs)]
            lidx = left[2] - 1 - pingpong(np.arange(g), left[2] - left[1])
            ridx = right[1] + pingpong(np.arange(g)[::-1], right[2] - right[1])
            w = ((np.arange(g) + 0.5) / g)[:, None]
            out[a0:b0] = row[lidx % n] * (1 - w) + row[ridx % n] * w
        filled[ri] = np.roll(out, start, axis=0)
    if smooth_rows > 1:  # soften row-to-row jumps in the synthesised part only
        sm = cv2.blur(filled, (1, smooth_rows))
        filled = np.where(valid[..., None], filled, sm)
    # back to cartesian
    S = 2 * R
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    dx, dy = xx - R, yy - R
    pr = np.sqrt(dx * dx + dy * dy)
    pt = (np.arctan2(dy, dx) % (2 * np.pi)) * n_theta / (2 * np.pi)
    Fp = np.concatenate([filled, filled[:, :1]], axis=1)  # wrap theta
    synth = cv2.remap(Fp, pt, pr, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    # paste the untouched source back where it exists (centre must be whole pixels)
    x0, y0 = int(round(R - cx)), int(round(R - cy))
    canvas = synth.copy()
    canvas[y0:y0 + H, x0:x0 + W] = img.astype(np.float32)
    return np.clip(canvas, 0, 255).astype(np.uint8), (float(R), float(R)), (x0, y0)


# ---------------------------------------------------------------- overlays
def glow_rgba(mask, color, sigmas=(6, 24), weights=(0.6, 0.4), gain=1.0):
    """Soft glow from a binary emission mask -> RGBA uint8 (colour fixed, alpha = glow)."""
    m = mask.astype(np.float32)
    g = np.zeros_like(m)
    for s, w in zip(sigmas, weights):
        g += w * cv2.GaussianBlur(m, (0, 0), s)
    g = np.clip(g * gain, 0, 1)
    rgba = np.zeros(mask.shape + (4,), np.uint8)
    rgba[..., :3] = np.array(color, np.uint8)
    rgba[..., 3] = (g * 255).astype(np.uint8)
    return rgba


def crop_rgba(rgba, pad=2, min_alpha=2):
    """Trim an RGBA overlay to where it is visible. Returns (rgba, x, y)."""
    ys, xs = np.nonzero(rgba[..., 3] >= min_alpha)
    if len(xs) == 0:
        return rgba[:1, :1], 0, 0
    H, W = rgba.shape[:2]
    x0, x1 = max(0, xs.min() - pad), min(W, xs.max() + pad + 1)
    y0, y1 = max(0, ys.min() - pad), min(H, ys.max() + pad + 1)
    return rgba[y0:y1, x0:x1], int(x0), int(y0)


def image_layer(layer_id, rgba, **kw):
    """Scene 'image' layer for an RGBA overlay, cropped to its visible box."""
    crop, x, y = crop_rgba(rgba)
    d = {"id": layer_id, "type": "image", "src": to_data_uri(crop), "x": x, "y": y}
    d.update(kw)
    return d


def sample_points(mask, n, rng, weight=None):
    """n random (x, y) pixel-centre points inside mask, optionally weighted."""
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return np.zeros((0, 2))
    p = None
    if weight is not None:
        p = weight[ys, xs].astype(np.float64)
        p = p / p.sum()
    idx = rng.choice(len(xs), size=n, replace=True, p=p)
    return np.c_[xs[idx] + rng.random(n), ys[idx] + rng.random(n)]


def sample_colors(img, pts, radius=1):
    """Median colour in a small window around each point."""
    H, W = img.shape[:2]
    out = []
    for x, y in pts:
        x0, x1 = int(max(0, x - radius)), int(min(W, x + radius + 1))
        y0, y1 = int(max(0, y - radius)), int(min(H, y + radius + 1))
        out.append(np.median(img[y0:y1, x0:x1].reshape(-1, 3), axis=0))
    return np.array(out)


def edge_band(mask, width=6):
    """Pixels of `mask` within `width` px of its boundary."""
    m = mask.astype(np.uint8)
    er = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * width + 1,) * 2))
    return (m > 0) & (er == 0)


# ---------------------------------------------------------------- wind
class Wind:
    """Periodic gust field, mirrored exactly by engine/animator.js (same tables, same lerp).

    G(t): gust strength. F(t): its running integral. A particle with susceptibility wd
    born at age s ago is displaced wd * (F(t - wt) - F(t - wt - s)) along `dir`, where
    wt = delay(x, y) is when the gust front reaches it:
      sweep='right'  fronts cross the frame left to right (wt = x / front)
      sweep='up'     an updraft: fronts rise from y = ground (wt = (ground - y) / front)
    base sets the floor: small for gusts out of calm air, high for a storm that never
    drops. steady_flutter adds buffeting to the floor too, not only inside gusts.
    """

    def __init__(self, loop, gusts, base=0.12, flutter=((0.22, 17, 0.4), (0.12, 29, 0.0)),
                 dir=(1.0, -0.28), front=520.0, n=2400, sweep="right", ground=0.0, steady_flutter=0.0):
        self.T, self.n = float(loop), int(n)
        t = np.arange(n) * self.T / n
        env = np.zeros(n)
        for amp, mu, sig in gusts:  # periodic gaussian bumps
            for m in (-1, 0, 1):
                env += amp * np.exp(-0.5 * ((t - mu - m * self.T) / sig) ** 2)
        g = base + env
        for amp, k, ph in flutter:  # gustiness while a gust blows (+ on the floor if steady)
            g += amp * (env + steady_flutter * base) * np.sin(2 * np.pi * (k * t / self.T + ph))
        self.Gt = np.maximum(g, 0.03)
        dt = self.T / n
        F = np.zeros(n)
        F[1:] = np.cumsum(dt * (self.Gt[:-1] + self.Gt[1:]) / 2)
        self.Ft = F
        self.FT = float(F[-1] + dt * (self.Gt[-1] + self.Gt[0]) / 2)
        self.dir, self.front = [float(dir[0]), float(dir[1])], float(front)
        self.sweep, self.ground = sweep, float(ground)
        self.gmin, self.gmax = float(self.Gt.min()), float(self.Gt.max())

    def delay(self, x, y):
        return (self.ground - y) / self.front if self.sweep == "up" else x / self.front

    def G(self, t):
        x = (np.asarray(t, float) / self.T % 1.0) * self.n
        i = np.floor(x).astype(int)
        f = x - i
        return self.Gt[i % self.n] * (1 - f) + self.Gt[(i + 1) % self.n] * f

    def F(self, t):
        t = np.asarray(t, float)
        k = np.floor(t / self.T)
        x = (t - k * self.T) / (self.T / self.n)
        i = np.floor(x).astype(int)
        f = x - i
        Fx = np.append(self.Ft, self.FT)
        a = Fx[np.minimum(i, self.n)]
        b = Fx[np.minimum(i + 1, self.n)]
        return k * self.FT + a * (1 - f) + b * f

    def gust_times(self, rng, n, power=2.0, floor=0.15):
        """Birth times concentrated in gusts (density ~ G^power + floor)."""
        w = (self.Gt - self.gmin) ** power + floor * (self.gmax - self.gmin) ** power
        idx = rng.choice(self.n, size=n, p=w / w.sum())
        return (idx + rng.random(n)) * self.T / self.n

    def to_scene(self):
        r = lambda a: [round(float(v), 5) for v in a]
        return {"T": self.T, "G": r(self.Gt), "F": r(self.Ft), "FT": round(self.FT, 5),
                "gmin": round(self.gmin, 5), "gmax": round(self.gmax, 5), "dir": self.dir, "front": self.front,
                "sweep": self.sweep, "ground": self.ground}


# ---------------------------------------------------------------- particles
def particle(x, y, r, color, alpha=1.0, vx=0.0, vy=0.0, ay=0.0, life=12.0, phase=0.0,
             fade_in=0.0, fade_out=0.0, shrink=0.0, grow=0.0, sway=0.0, sway_cycles=0.0, sway_phase=0.0,
             tw=0.0, tw_k=1, tw_phase=0.0, wind=None, wd=0.0, spin=0.0, wr=0.0, ang=0.0,
             at_phase=None, born_at=None):
    """One particle record for the engine (compact keys).

    Placement, pick one:
      at_phase=p  (x, y) is where the particle must be at t = 0; its birth point is
                  solved for (motion, sway, wind and spin all undone), phase = p.
      born_at=t   the particle is born at (x, y) at time t (e.g. during a gust).
      phase=p     the particle is born at (x, y); p is its phase at t = 0.
    Mirrors the motion model in engine/animator.js.
    """
    wt = 0.0
    if wind is not None and wd:
        wt = wind.delay(x, y)
    if born_at is not None:
        phase = (-born_at / life) % 1.0
    if at_phase is not None:
        s = at_phase * life
        sx = sway * math.sin(2 * math.pi * (sway_cycles * at_phase + sway_phase))
        D = wd * float(wind.F(-wt) - wind.F(-wt - s)) if (wind is not None and wd) else 0.0
        dxw, dyw = (D * wind.dir[0], D * wind.dir[1]) if D else (0.0, 0.0)
        x = x - vx * s - sx - dxw
        y = y - vy * s - 0.5 * ay * s * s - dyw
        ang = -(spin * s + wr * D)
        phase = at_phase
    rec = {"x": round(float(x), 2), "y": round(float(y), 2), "r": round(float(r), 2),
           "c": [int(np.clip(v, 0, 255)) for v in color], "a": round(float(alpha), 3),
           "l": float(life), "p": round(float(phase) % 1.0, 5)}
    opt = {"vx": vx, "vy": vy, "ay": ay, "fi": fade_in, "fo": fade_out, "sh": shrink, "gr": grow,
           "sw": sway, "swc": sway_cycles, "swp": sway_phase, "tw": tw, "twk": tw_k, "twp": tw_phase,
           "wd": wd, "wt": wt, "spin": spin, "wr": wr, "ang": ang}
    for k, v in opt.items():
        if v:
            rec[k] = round(float(v), 4) if not isinstance(v, (int, np.integer)) or isinstance(v, bool) else int(v)
    return rec


def row_span(mask, smooth_rows=9, pad=1.0):
    """Fill each row of `mask` between its leftmost and rightmost pixel (smoothed over rows).

    Turns a ragged, speckled silhouette (smoke, foliage) into the solid region that
    has to be cut from the plate when the whole thing is going to move."""
    H, W = mask.shape
    ys = np.nonzero(mask.any(1))[0]
    out = np.zeros_like(mask, bool)
    if len(ys) == 0:
        return out
    lo = np.array([np.nonzero(mask[y])[0].min() if mask[y].any() else np.nan for y in range(ys[0], ys[-1] + 1)])
    hi = np.array([np.nonzero(mask[y])[0].max() + 1 if mask[y].any() else np.nan for y in range(ys[0], ys[-1] + 1)])
    yr = np.arange(ys[0], ys[-1] + 1)
    good = ~np.isnan(lo)
    lo, hi = np.interp(yr, yr[good], lo[good]), np.interp(yr, yr[good], hi[good])
    k = np.ones(smooth_rows) / smooth_rows
    p_ = smooth_rows // 2
    lo = np.minimum(lo, np.convolve(np.pad(lo, p_, mode="edge"), k, "valid"))
    hi = np.maximum(hi, np.convolve(np.pad(hi, p_, mode="edge"), k, "valid"))
    xx = np.arange(W)
    for y, a, b in zip(yr, lo, hi):
        out[y] = (xx >= a - pad) & (xx < b + pad)
    return out


def unmix(color, bg):
    """Split an observed colour into (ink, alpha) over a known background, minimal alpha.

    ink * alpha + bg * (1 - alpha) == color exactly, with ink inside [0, 255]. Lets a
    cut-out pixel move over a new background and still match the source at rest.
    """
    c = np.asarray(color, np.float64)
    b = np.asarray(bg, np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        dark = np.where(c < b, (b - c) / np.maximum(b, 1e-6), 0.0)
        light = np.where(c > b, (c - b) / np.maximum(255.0 - b, 1e-6), 0.0)
    a = np.clip(np.maximum(dark, light).max(-1), 0, 1)
    ink = (c - (1 - a)[..., None] * b) / np.maximum(a, 1e-6)[..., None]
    return np.clip(ink, 0, 255), a


# ---------------------------------------------------------------- export
def to_data_uri(arr, fmt="PNG", **save_kw):
    im = Image.fromarray(arr)
    buf = io.BytesIO()
    im.save(buf, format=fmt, **save_kw)
    mime = {"PNG": "image/png", "WEBP": "image/webp", "JPEG": "image/jpeg"}[fmt]
    return f"data:{mime};base64," + base64.b64encode(buf.getvalue()).decode()


def install_page(art_dir, title):
    """Copy the engine and viewer page into an artwork folder, titled."""
    engine = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine")
    with open(os.path.join(engine, "animator.js")) as f:
        js = f.read()
    with open(os.path.join(art_dir, "animator.js"), "w") as f:
        f.write(js)
    with open(os.path.join(engine, "template.html")) as f:
        html = f.read().replace("{{TITLE}}", title)
    with open(os.path.join(art_dir, "index.html"), "w") as f:
        f.write(html)


def file_data_uri(path):
    """The file's own bytes as a data URI (no re-encode), e.g. the untouched source picture."""
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[ext]
    with open(path, "rb") as f:
        return f"data:{mime};base64," + base64.b64encode(f.read()).decode()


def rest_layer(source_uri, hold=0.15, fade=0.85):
    """Top layer showing the untouched source around the loop point, so the loop
    passes exactly through the original (frame 0 is the picture, bit for bit)."""
    return {"id": "rest", "type": "image", "src": source_uri,
            "alpha": {"wave": "rest", "hold": hold, "fade": fade}}


def write_scene_js(path, scene):
    """Scene data as a JS file (window.SCENE = {...}) so pages work from file:// too."""
    with open(path, "w") as f:
        f.write("window.SCENE = ")
        json.dump(scene, f, separators=(",", ":"))
        f.write(";\n")
