// Karyon's ASCII engine.
//
// Every scene is drawn with ordinary canvas calls in greyscale onto a small
// offscreen canvas (2 x 4 samples per character cell). Each frame that image
// is read back and turned into glyphs: flat areas become letters from a
// brightness ramp, and edges become / | \ - chosen from the local gradient
// orientation. Glyphs come from a pre-tinted gold atlas, and a blurred copy of
// the frame adds the glow. Changing scene "decodes" from the old picture to
// the new one along a noisy wavefront.
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const hash = (n) => {
    let h = Math.imul(n | 0, 2654435761) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const grey = (v, a = 1) => {
    const c = Math.round(clamp(v, 0, 1) * 255);
    return `rgba(${c},${c},${c},${a})`;
  };
  // Smooth 1-D value noise, for ridgelines and flicker.
  const noise1 = (x, seed = 0) => {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return lerp(hash(i * 7919 + seed * 104729), hash((i + 1) * 7919 + seed * 104729), u);
  };

  const RAMP = ' .:-=+;ilcueadLCUEAD#@';
  const GLITCH = '01<>/\\|{}[]#%&*+=:;?';
  const EDGE = ['|', '/', '-', '\\'];
  const CHARS = [...new Set((RAMP + GLITCH + EDGE.join('') + '_emt').split(''))];
  const CI = Object.fromEntries(CHARS.map((c, i) => [c, i]));
  const RAMP_I = RAMP.split('').map((c) => CI[c]);
  const GLITCH_I = GLITCH.split('').map((c) => CI[c]);
  const EDGE_I = EDGE.map((c) => CI[c]);
  const LEVELS = 14;
  const GOLD = [
    [0, [52, 32, 9]],
    [0.3, [140, 88, 24]],
    [0.62, [232, 164, 58]],
    [0.85, [255, 206, 112]],
    [1, [255, 242, 210]],
  ];
  function gold(t) {
    for (let i = 1; i < GOLD.length; i++) {
      if (t <= GOLD[i][0]) {
        const [t0, a] = GOLD[i - 1];
        const [t1, b] = GOLD[i];
        const k = (t - t0) / (t1 - t0);
        return `rgb(${a.map((v, j) => Math.round(lerp(v, b[j], k))).join(',')})`;
      }
    }
    return 'rgb(255,242,210)';
  }

  // ---------------------------------------------------------------------------
  // Drawing helpers shared by scenes. All take CSS-pixel coordinates.
  function glow(g, x, y, r, v, a = 1) {
    if (r <= 0) return;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, grey(v, a));
    gr.addColorStop(1, grey(v, 0));
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }
  function disc(g, x, y, r, style) {
    g.fillStyle = style;
    g.beginPath();
    g.arc(x, y, Math.max(0.01, r), 0, TAU);
    g.fill();
  }
  function line(g, x1, y1, x2, y2, style, w) {
    g.strokeStyle = style;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  }
  function fadeLine(g, x1, y1, x2, y2, v0, v1, w) {
    const gr = g.createLinearGradient(x1, y1, x2, y2);
    gr.addColorStop(0, grey(v0));
    gr.addColorStop(1, grey(v1));
    line(g, x1, y1, x2, y2, gr, w);
  }
  function star4(g, x, y, r, v) {
    g.fillStyle = grey(v);
    g.beginPath();
    g.moveTo(x, y - r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.quadraticCurveTo(x, y, x, y + r);
    g.quadraticCurveTo(x, y, x - r, y);
    g.quadraticCurveTo(x, y, x, y - r);
    g.fill();
  }
  function starfield(g, L, s, t, n, maxV = 0.6) {
    if (!s.stars) {
      const r = rng(4242);
      s.stars = Array.from({ length: n }, () => ({ x: r(), y: r(), v: 0.15 + r() * maxV, p: r() * TAU, sp: 0.5 + r() * 2 }));
    }
    for (const st of s.stars) {
      const v = st.v * (0.6 + 0.4 * Math.sin(t * st.sp + st.p));
      g.fillStyle = grey(v);
      g.fillRect(st.x * L.W, st.y * L.H, L.cw * 0.6, L.ch * 0.3);
    }
  }
  // A seated or standing silhouette, filled black with a faint rim.
  function figure(g, x, y, h, pose, rim = 0.45, cw = 4) {
    const u = h / 10;
    g.beginPath();
    if (pose === 'sit') {
      // seen from behind, sitting on a ledge, knees up
      g.moveTo(x - 2.6 * u, y);
      g.quadraticCurveTo(x - 3.1 * u, y - 4 * u, x - 2.2 * u, y - 6.2 * u);
      g.quadraticCurveTo(x - 1.2 * u, y - 7.2 * u, x, y - 7.2 * u);
      g.quadraticCurveTo(x + 1.2 * u, y - 7.2 * u, x + 2.2 * u, y - 6.2 * u);
      g.quadraticCurveTo(x + 3.1 * u, y - 4 * u, x + 2.6 * u, y);
      g.closePath();
      g.moveTo(x + 1.75 * u, y - 8.3 * u);
      g.arc(x, y - 8.3 * u, 1.75 * u, 0, TAU);
    } else {
      // standing, simple robe
      g.moveTo(x - 1.8 * u, y);
      g.lineTo(x - 1.3 * u, y - 6.5 * u);
      g.quadraticCurveTo(x, y - 7.6 * u, x + 1.3 * u, y - 6.5 * u);
      g.lineTo(x + 1.8 * u, y);
      g.closePath();
      g.moveTo(x + 1.2 * u, y - 8.4 * u);
      g.arc(x, y - 8.4 * u, 1.2 * u, 0, TAU);
    }
    g.save();
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.fill();
    if (rim > 0) {
      g.strokeStyle = grey(rim);
      g.lineWidth = cw * 0.45;
      g.stroke();
    }
    g.restore();
  }

  // ---------------------------------------------------------------------------
  // Scenes. Each has optional init(opts, L, r) -> state and draw(g, L, s, t, P),
  // where L is the layout (W, H, cx, cy, size, cw, ch), t is seconds since the
  // scene started, and P holds live parameters (eye openness, gaze, thinking).
  const SCENES = {};

  // --- Karyon's eyes ---------------------------------------------------------
  // The determined mechanical eyes from Era of Intelligence, ported from the
  // film's renderer (draw_det_eye in render_eiirp2.py): straight-sided lids, a
  // toothed gear for an iris with rings and spokes, a dark core with a white-hot
  // center, an angular brow, and circuit traces running off the outer corner.
  // The two eyes counter-rotate at 30 degrees a second, as in the film.
  // Eye space: x runs from the inner corner (-1) to the outer one (+1) in half
  // eye widths, y points up in units of hh, the film's ratio of 230 to 440.
  const EYE_HH = 230 / 440;
  // Each expression sets the upper lid (u), the lower lid (l), and how far the
  // brow drops toward the nose (b). A pair is [left eye, right eye]. Lowering the
  // upper lid reads as focus or suspicion. Raising the lower lid reads as a smile.
  const EXPRESSIONS = {
    wide: { u: 1, l: 1, b: 0 },
    focused: { u: 0.58, l: 0.8, b: 0.8 },
    suspicious: { u: [0.4, 0.74], l: [0.72, 0.88], b: [1, 0.1] },
    warm: { u: 0.88, l: 0.42, b: -0.35 },
    surprised: { u: 1.16, l: 1.08, b: -0.7 },
  };
  const eyeRng = (seed) => {
    const r = rng(seed);
    return Array.from({ length: 7 }, () => {
      const start = [0.9 + 0.2 * r(), -0.6 + 1.2 * r()];
      const steps = Array.from({ length: 3 }, () => [(60 + 140 * r()) / 440, ((r() < 0.5 ? -1 : 1) * (30 + 90 * r())) / 230]);
      return { start, steps };
    });
  };
  const EYE_TRACES = { [-1]: eyeRng(917), 1: eyeRng(1977) };

  function drawEye(g, x0, y0, ew, o, awake, lid, side, gazeX, gazeY, think, spin, sweep, cw, wing = 1) {
    const hw = ew / 2;
    const hh = hw * EYE_HH;
    const O = Math.max(o, 0.04);
    const P = (x, y) => [x0 + side * x * hw, y0 - y * hh];
    const U = O * lid.u;
    const Lo = O * lid.l;
    const corner = 0.34 * Math.min(U, 1);
    const up = [P(-1, -0.06), P(-0.3, 0.72 * U), P(0.45, 0.98 * U), P(1, corner)];
    const lo = [P(1, corner), P(0.5, -0.58 * Lo), P(-0.4, -0.52 * Lo), P(-1, -0.06)];
    const path = (pts) => pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    const stroke = (pts, v, w) => {
      g.strokeStyle = grey(v);
      g.lineWidth = w;
      g.beginPath();
      path(pts);
      g.stroke();
    };
    g.lineJoin = 'miter';
    const unit = ew / 880; // one unit of line width in the film
    // Line widths have a floor so they survive the turn into letters. Small eyes
    // get a lower floor, or their lids turn into solid bars.
    const fine = (u, min) => Math.max(u * unit, cw * min * Math.min(1, 0.5 + ew / 900));

    if (o > 0.03) {
      // The almond.
      g.save();
      g.beginPath();
      path([...up, ...lo.slice(1)]);
      g.closePath();
      g.fillStyle = grey(0.2);
      g.fill();
      g.clip();

      const ix = x0 + side * 0.06 * hw + gazeX * hw * 0.16;
      const iy = y0 - 0.04 * hh + gazeY * hh * 0.1;
      const ir = hh * 1.08;
      const rot = (side * spin * Math.PI) / 180;
      // The iris: a sixteen-toothed gear, big enough for the lids to cut it off.
      g.fillStyle = grey(0.5 + think * 0.14);
      g.beginPath();
      for (let k = 0; k < 64; k++) {
        const a = (k / 64) * TAU + rot;
        const rr = ir * (k % 4 < 2 ? 1 : 0.9);
        const px = ix + Math.cos(a) * rr;
        const py = iy + Math.sin(a) * rr;
        if (k) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.closePath();
      g.fill();
      // Three rings.
      const ringW = fine(6, 0.35);
      for (const [rr, v] of [[0.86, 0.95], [0.62, 0.85]]) {
        g.strokeStyle = grey(v);
        g.lineWidth = ringW;
        g.beginPath();
        g.arc(ix, iy, ir * rr, 0, TAU);
        g.stroke();
      }
      // Spokes between the outer rings, turning against the gear at half speed.
      g.strokeStyle = grey(0.62);
      g.lineWidth = fine(2.4, 0.2);
      g.beginPath();
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * TAU - rot * 0.5;
        g.moveTo(ix + Math.cos(a) * ir * 0.64, iy + Math.sin(a) * ir * 0.64);
        g.lineTo(ix + Math.cos(a) * ir * 0.84, iy + Math.sin(a) * ir * 0.84);
      }
      g.stroke();
      // The little gear around the pupil, turning the other way.
      g.fillStyle = grey(0.92);
      g.beginPath();
      for (let k = 0; k < 40; k++) {
        const a = (k / 40) * TAU - rot * 1.6;
        const rr = ir * 0.46 * (k % 4 < 2 ? 1 : 0.8);
        const px = ix + Math.cos(a) * rr;
        const py = iy + Math.sin(a) * rr;
        if (k) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.closePath();
      g.fill();
      // The dark core with its white-hot center.
      disc(g, ix, iy, ir * 0.3, grey(0.1));
      disc(g, ix, iy, ir * 0.165, grey(1));
      // Now and then a glint sweeps across the eye.
      if (sweep >= 0 && sweep <= 1) {
        const gx = ix + side * (-0.6 + 1.2 * sweep) * ir;
        stroke([[gx, iy - ir], [gx + 0.25 * ir, iy + ir]], 1, fine(5, 0.4));
      }
      g.restore();
    }

    // The lids, the brow, and the traces go on top of everything. The film blooms
    // its lines before turning them into letters, which is what makes them read
    // as thick letter-filled bands, so each one gets a wide dim stroke under it.
    g.globalCompositeOperation = 'lighter';
    if (o > 0.03) {
      const brow = [P(-0.9, 0.42 - lid.b * 0.3), P(-0.2, 1.05 * U + 0.1 - lid.b * 0.08), P(0.9, 0.7 * U + 0.1 + lid.b * 0.1)];
      stroke(brow, 0.38, fine(40, 3.2));
      stroke(brow, 0.3, fine(6, 0.5));
      stroke(up, 0.52, fine(40, 2.6));
      stroke(lo, 0.32, fine(26, 1.8));
      stroke(lo, 0.7, fine(5, 0.45));
    }
    stroke(up, 0.98, fine(14, 2.7));
    // The circuit traces stay lit through a blink. They only go out when the eyes
    // really close.
    if (wing > 0.01 && awake > 0.25) {
      const fade = Math.min(1, (awake - 0.25) * 3);
      for (const tr of EYE_TRACES[side]) {
        let [x, y] = tr.start;
        const pts = [P(x, y)];
        for (const [dx, dy] of tr.steps) {
          x += dx * wing;
          pts.push(P(x, y));
          y += dy * wing;
          pts.push(P(x, y));
        }
        stroke(pts, 0.42 * fade, fine(3, 0.3));
        const [ex, ey] = P(x, y);
        disc(g, ex, ey, Math.max(hw * (7 / 440), cw * 0.3), grey(0.8 * fade));
      }
    }
    g.globalCompositeOperation = 'source-over';
    g.lineJoin = 'round';
  }

  // The engine keeps one eye state for the session, so an eye left on screen
  // doesn't restart when a painting arrives.
  SCENES.eyes = {
    init: (opts, L, r) => ({
      open: 0,
      blinkAt: 2 + r() * 3,
      blinkStart: -9,
      gx: 0,
      gy: 0,
      spin: 0,
      last: 0,
      glintAt: 2.4,
      r,
      lids: { [-1]: { u: 1, l: 1, b: 0 }, 1: { u: 1, l: 1, b: 0 } },
    }),
    update(s, t, P) {
      // A scene change renders two pictures per frame. The eyes only move once.
      if (t === s.updatedAt) return;
      s.updatedAt = t;
      const target = P.eyeOpen ?? 1;
      s.open += (target - s.open) * (P.eyeSnap ? 1 : 0.16);
      if (P.blinkNow) {
        P.blinkNow = false;
        s.blinkStart = t;
      } else if (t > s.blinkAt && target > 0.9) {
        s.blinkStart = t;
        s.blinkAt = t + 3 + s.r() * 5;
      }
      const bt = (t - s.blinkStart) / 0.2;
      const blink = bt >= 0 && bt < 1 ? Math.sin(bt * Math.PI) : 0;
      s.o = clamp(s.open * (1 - blink * 0.96), 0, 1);
      const want = EXPRESSIONS[P.expression] || EXPRESSIONS.wide;
      const ease = P.eyeSnap ? 1 : 0.12;
      for (const side of [-1, 1]) {
        const lid = s.lids[side];
        for (const key of ['u', 'l', 'b']) {
          const v = want[key];
          lid[key] += ((Array.isArray(v) ? v[side < 0 ? 0 : 1] : v) - lid[key]) * ease;
        }
      }
      s.gx += ((P.gazeX || 0) - s.gx) * 0.07;
      s.gy += ((P.gazeY || 0) - s.gy) * 0.07;
      // The gears run at the film's 30 degrees a second, four times that while
      // Karyon thinks, and twice that while it speaks.
      s.spin += Math.max(0, t - s.last) * 30 * (1 + (P.thinking || 0) * 3 + (P.speaking || 0));
      s.last = t;
      if (t > s.glintAt + 0.5) s.glintAt = t + 5 + s.r() * 6;
    },
    drawOne(g, L, s, t, P, side) {
      const look = L.lookX || 0; // both eyes lean toward the conversation
      const gx = clamp(s.gx * (1 - Math.abs(look) * 0.5) + look, -1, 1);
      const sweep = (t - s.glintAt) / 0.35;
      drawEye(g, L.cx + side * L.eyeDX, L.cy, L.eyeW, s.o, s.open, s.lids[side], side, gx, s.gy, P.thinking || 0, s.spin, sweep, L.cw, L.wing ?? 1);
    },
    draw(g, L, s, t, P) {
      this.update(s, t, P);
      g.globalAlpha = P.eyeFade ?? 1;
      this.drawOne(g, L, s, t, P, -1);
      this.drawOne(g, L, s, t, P, 1);
      g.globalAlpha = 1;
    },
  };

  // --- Eclipse -----------------------------------------------------------------
  SCENES.eclipse = {
    init: (opts) => ({ intro: opts.phase === 'intro' }),
    draw(g, L, s, t) {
      const cover01 = s.intro ? smooth(0, 1.3, t) : 1;
      const R = L.size * 0.15 * (1 + 0.6 * (1 - cover01));
      const x = L.cx;
      const y = L.cy;
      starfield(g, L, s, t, 90, 0.35);
      const off = R * 2.4 * (1 - cover01);
      const cover = 1 - clamp(off / (2 * R), 0, 1);
      const corona = smooth(0.82, 1, cover);
      const flare = s.intro ? Math.exp(-Math.pow((t - 1.2) / 0.1, 2)) : 0;
      g.globalCompositeOperation = 'lighter';
      glow(g, x, y, R * 2.5, 0.13 * corona + 0.02, 1);
      glow(g, x, y, R * 1.45, 0.42 * corona, 1);
      if (cover < 0.999) glow(g, x, y, R * 1.9, 0.4 * (1 - corona));
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * TAU + 0.05 * Math.sin(t * 0.25 + i);
        const len = R * (1.2 + 1.7 * Math.pow(hash(i + 7), 2.2)) * (0.88 + 0.12 * Math.sin(t * 0.7 + i * 1.7));
        const v = (0.32 + 0.4 * hash(i + 99)) * corona;
        fadeLine(g, x + Math.cos(a) * R * 1.02, y + Math.sin(a) * R * 1.02, x + Math.cos(a) * len, y + Math.sin(a) * len, v, 0, L.cw * (0.35 + 0.4 * hash(i)));
      }
      // The dotted outer band, slowly turning.
      for (let i = 0; i < 160; i++) {
        const a = (i / 160) * TAU + t * 0.03;
        const r = R * (1.38 + 0.16 * hash(i * 3 + 1));
        g.fillStyle = grey((0.3 + 0.35 * hash(i)) * (0.3 + 0.7 * corona));
        g.fillRect(x + Math.cos(a) * r, y + Math.sin(a) * r, L.cw * 0.9, L.ch * 0.35);
      }
      g.globalCompositeOperation = 'source-over';
      if (cover < 0.999) disc(g, x, y, R, grey(1));
      disc(g, x - off, y, R * 1.015, '#000');
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = grey(0.85 * corona);
      g.lineWidth = L.cw * 0.6;
      g.beginPath();
      g.arc(x, y, R * 1.03, 0, TAU);
      g.stroke();
      if (flare > 0.01) {
        glow(g, x + R * 0.97, y - R * 0.18, R * 1.1 * flare, flare);
        star4(g, x + R * 0.97, y - R * 0.18, R * 0.9 * flare, flare);
      }
      // A few prominences on the limb.
      for (let i = 0; i < 4; i++) {
        const a = 0.6 + i * 1.7 + Math.sin(t * 0.2 + i) * 0.05;
        const px = x + Math.cos(a) * R * 1.02;
        const py = y + Math.sin(a) * R * 1.02;
        glow(g, px, py, R * 0.12, 0.8 * corona);
      }
      g.globalCompositeOperation = 'source-over';
    },
  };

  // --- Horizon: a small figure on a cliff watching the sun come up ------------
  SCENES.horizon = {
    init: (opts, L, r) => ({
      clouds: Array.from({ length: 9 }, () => ({ x: r(), y: 0.25 + r() * 0.55, w: 0.12 + r() * 0.22, h: 0.012 + r() * 0.02, v: 0.004 + r() * 0.008 })),
      birds: Array.from({ length: 3 }, () => ({ x: r(), y: 0.2 + r() * 0.25, p: r() * TAU })),
    }),
    draw(g, L, s, t) {
      const { W, H, size: S, cw } = L;
      const hy = L.cy + S * 0.12;
      const sunX = L.cx + S * 0.14;
      const sky = g.createLinearGradient(0, 0, 0, hy);
      sky.addColorStop(0, grey(0.0));
      sky.addColorStop(0.5, grey(0.12));
      sky.addColorStop(1, grey(0.55));
      g.fillStyle = sky;
      g.fillRect(0, 0, W, hy + 2);
      g.globalCompositeOperation = 'lighter';
      glow(g, sunX, hy, S * 0.55, 0.32);
      glow(g, sunX, hy, S * 0.13, 0.75);
      for (let i = 0; i < 10; i++) {
        const a = Math.PI + (i / 9) * Math.PI + Math.sin(t * 0.1) * 0.03;
        g.fillStyle = grey(0.05);
        g.beginPath();
        g.moveTo(sunX, hy);
        g.arc(sunX, hy, S * 0.9, a - 0.035, a + 0.035);
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
      disc(g, sunX, hy, S * 0.05, grey(1));
      // Clouds drifting left, lit from below.
      for (const c of s.clouds) {
        const cx = ((((c.x - t * c.v) % 1) + 1) % 1) * (W + S * 0.6) - S * 0.3;
        const cy = c.y * hy;
        const cl = g.createLinearGradient(0, cy - c.h * S, 0, cy + c.h * S);
        cl.addColorStop(0, grey(0.18));
        cl.addColorStop(1, grey(0.5 * (cy / hy) + 0.1));
        g.fillStyle = cl;
        g.beginPath();
        g.ellipse(cx, cy, c.w * S, c.h * S, 0, 0, TAU);
        g.fill();
      }
      // Ridges, lighter with distance.
      const ridge = (base, amp, freq, seed, v) => {
        g.fillStyle = grey(v);
        g.beginPath();
        g.moveTo(0, H);
        for (let x = 0; x <= W + 8; x += 8) {
          const n = noise1((x / S) * freq + seed, seed) * 0.7 + noise1((x / S) * freq * 3.1 + seed, seed + 1) * 0.3;
          g.lineTo(x, base - n * amp);
        }
        g.lineTo(W, H);
        g.closePath();
        g.fill();
      };
      ridge(hy + S * 0.012, S * 0.06, 3, 1, 0.42);
      ridge(hy + S * 0.06, S * 0.07, 2.2, 5, 0.27);
      ridge(hy + S * 0.13, S * 0.08, 1.6, 9, 0.14);
      g.globalCompositeOperation = 'lighter';
      const mist = g.createLinearGradient(0, hy, 0, hy + S * 0.12);
      mist.addColorStop(0, grey(0.14));
      mist.addColorStop(1, grey(0));
      g.fillStyle = mist;
      g.fillRect(0, hy, W, S * 0.12);
      g.globalCompositeOperation = 'source-over';
      // The cliff, and the figure sitting on its edge.
      const ledgeY = hy + S * 0.05;
      const lx = L.cx - S * 0.12;
      g.fillStyle = grey(0.02);
      g.beginPath();
      g.moveTo(-10, H + 10);
      g.lineTo(-10, ledgeY + S * 0.02);
      g.lineTo(lx - S * 0.25, ledgeY + S * 0.005);
      g.lineTo(lx + S * 0.05, ledgeY);
      g.lineTo(lx + S * 0.09, ledgeY + S * 0.05);
      g.lineTo(lx + S * 0.13, ledgeY + S * 0.2);
      g.lineTo(lx + S * 0.1, H + 10);
      g.closePath();
      g.fill();
      g.strokeStyle = grey(0.45);
      g.lineWidth = cw * 0.5;
      g.beginPath();
      g.moveTo(-10, ledgeY + S * 0.02);
      g.lineTo(lx - S * 0.25, ledgeY + S * 0.005);
      g.lineTo(lx + S * 0.05, ledgeY);
      g.lineTo(lx + S * 0.09, ledgeY + S * 0.05);
      g.stroke();
      figure(g, lx, ledgeY + 1, S * 0.1, 'sit', 0.5, cw);
      g.globalCompositeOperation = 'lighter';
      const tw = 0.6 + 0.4 * Math.sin(t * 1.3);
      star4(g, sunX - S * 0.33, hy - S * 0.26, S * 0.03 * tw, 0.9);
      for (const b of s.birds) {
        const bx = ((b.x + t * 0.01) % 1) * W;
        const by = b.y * hy + Math.sin(t + b.p) * 4;
        const f = Math.sin(t * 6 + b.p) * S * 0.006;
        g.strokeStyle = grey(0.06);
        g.lineWidth = cw * 0.4;
        g.beginPath();
        g.moveTo(bx - S * 0.012, by - f);
        g.lineTo(bx, by);
        g.lineTo(bx + S * 0.012, by - f);
        g.stroke();
      }
      g.globalCompositeOperation = 'source-over';
    },
  };

  // --- Planet with rings, satellites, and habitats -----------------------------
  SCENES.planet = {
    init: (opts, L, r) => ({
      sats: Array.from({ length: 9 }, (_, i) => ({
        rx: 1.5 + r() * 1.3,
        ry: 0.25 + r() * 0.55,
        tilt: -0.5 + r() * 1,
        sp: (0.12 + r() * 0.25) * (r() < 0.2 ? -1 : 1),
        p: r() * TAU,
        hab: i % 3 === 0,
      })),
      lights: Array.from({ length: 40 }, () => ({ a: r() * TAU, d: Math.sqrt(r()), p: r() * TAU })),
    }),
    draw(g, L, s, t) {
      const R = L.size * 0.15;
      const x = L.cx;
      const y = L.cy;
      const cw = L.cw;
      starfield(g, L, s, t, 140, 0.55);
      const tilt = -0.28;
      const ring = (front) => {
        for (let k = 0; k < 4; k++) {
          const rx = R * (1.55 + k * 0.17);
          const ry = rx * 0.24;
          g.strokeStyle = grey((front ? 0.75 : 0.4) - k * 0.1);
          g.lineWidth = cw * (k === 1 ? 1.1 : 0.6);
          g.beginPath();
          g.ellipse(x, y, rx, ry, tilt, front ? 0 : Math.PI, front ? Math.PI : TAU);
          g.stroke();
        }
      };
      const satPos = (st) => {
        const a = st.p + t * st.sp;
        const ex = Math.cos(a) * st.rx * R;
        const ey = Math.sin(a) * st.ry * R;
        return { x: x + ex * Math.cos(st.tilt) - ey * Math.sin(st.tilt), y: y + ex * Math.sin(st.tilt) + ey * Math.cos(st.tilt), back: Math.sin(a) < 0 };
      };
      const drawSat = (st) => {
        const p = satPos(st);
        const hidden = p.back && Math.hypot(p.x - x, p.y - y) < R;
        if (hidden) return;
        g.globalCompositeOperation = 'lighter';
        // trail
        for (let k = 1; k <= 6; k++) {
          const q = satPos({ ...st, p: st.p - k * 0.05 * Math.sign(st.sp) });
          disc(g, q.x, q.y, cw * 0.3, grey(0.4 * (1 - k / 7)));
        }
        if (st.hab) {
          g.save();
          g.translate(p.x, p.y);
          g.rotate(t * 0.6 + st.p);
          g.fillStyle = grey(0.85);
          g.fillRect(-cw * 1.6, -cw * 0.45, cw * 3.2, cw * 0.9);
          g.fillStyle = grey(0.5);
          g.fillRect(-cw * 0.25, -cw * 1.4, cw * 0.5, cw * 2.8);
          g.restore();
        } else {
          disc(g, p.x, p.y, cw * 0.55, grey(1));
          glow(g, p.x, p.y, cw * 2.2, 0.35 + 0.3 * Math.sin(t * 4 + st.p));
        }
        g.globalCompositeOperation = 'source-over';
      };
      for (const st of s.sats) if (satPos(st).back) drawSat(st);
      ring(false);
      // Planet body.
      g.save();
      g.beginPath();
      g.arc(x, y, R, 0, TAU);
      g.clip();
      const body = g.createRadialGradient(x - R * 0.4, y - R * 0.45, R * 0.1, x, y, R * 1.05);
      body.addColorStop(0, grey(0.95));
      body.addColorStop(0.5, grey(0.55));
      body.addColorStop(1, grey(0.08));
      g.fillStyle = body;
      g.fillRect(x - R, y - R, R * 2, R * 2);
      // Cloud bands drifting with rotation.
      g.globalCompositeOperation = 'source-over';
      for (let k = 0; k < 9; k++) {
        const by = y - R + (k + 0.5) * ((2 * R) / 9);
        g.strokeStyle = k % 2 ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.12)';
        g.lineWidth = R * 0.07;
        g.beginPath();
        for (let xx = -R; xx <= R; xx += R / 12) {
          const yy = by + Math.sin(xx / R * 3 + t * 0.4 + k) * R * 0.03;
          if (xx === -R) g.moveTo(x + xx, yy);
          else g.lineTo(x + xx, yy);
        }
        g.stroke();
      }
      // Night side: the shadow, and the lights of utopias on it.
      const night = g.createLinearGradient(x - R * 0.6, y - R * 0.6, x + R, y + R);
      night.addColorStop(0, 'rgba(0,0,0,0)');
      night.addColorStop(0.62, 'rgba(0,0,0,0.55)');
      night.addColorStop(1, 'rgba(0,0,0,0.92)');
      g.fillStyle = night;
      g.fillRect(x - R, y - R, R * 2, R * 2);
      g.globalCompositeOperation = 'lighter';
      for (const l of s.lights) {
        const lx = x + Math.cos(l.a) * l.d * R;
        const ly = y + Math.sin(l.a) * l.d * R;
        if ((lx - x) + (ly - y) > R * 0.35) disc(g, lx, ly, cw * 0.28, grey(0.55 + 0.4 * Math.sin(t * 2 + l.p)));
      }
      g.restore();
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = grey(0.55);
      g.lineWidth = cw * 0.5;
      g.beginPath();
      g.arc(x, y, R * 1.01, Math.PI * 0.75, Math.PI * 1.75);
      g.stroke();
      glow(g, x - R * 0.2, y - R * 0.2, R * 1.6, 0.1);
      g.globalCompositeOperation = 'source-over';
      ring(true);
      for (const st of s.sats) if (!satPos(st).back) drawSat(st);
      // A small moon.
      const mx = x + R * 2.55;
      const my = y - R * 0.95;
      disc(g, mx, my, R * 0.16, grey(0.7));
      disc(g, mx + R * 0.06, my + R * 0.03, R * 0.15, grey(0.08));
    },
  };

  // --- Golden-ratio galaxy with the seven steps of Convergence ------------------
  SCENES.galaxy = {
    init: (opts, L, r) => {
      const pts = [];
      const N = L.W < 700 ? 900 : 1500;
      const b = Math.log(1.618) / (Math.PI / 2);
      for (let i = 0; i < N; i++) {
        const arm = i % 2;
        const th = Math.pow(r(), 0.8) * 3.6 * Math.PI;
        const rr = Math.exp(b * th) / Math.exp(b * 3.6 * Math.PI);
        const j = (r() + r() + r() - 1.5) * 0.16 * (0.3 + rr);
        pts.push({ th: th + arm * Math.PI, r: rr + j * 0.4, j: (r() - 0.5) * 0.3, v: 0.3 + r() * 0.7 });
      }
      return { pts, b };
    },
    draw(g, L, s, t) {
      const Rm = L.size * 0.5;
      const x = L.cx;
      const y = L.cy;
      const cw = L.cw;
      starfield(g, L, s, t, 80, 0.3);
      const rot = -0.35;
      const squash = 0.5;
      const proj = (th, rr) => {
        const px = Math.cos(th) * rr * Rm;
        const py = Math.sin(th) * rr * Rm * squash;
        return [x + px * Math.cos(rot) - py * Math.sin(rot), y + px * Math.sin(rot) + py * Math.cos(rot)];
      };
      g.globalCompositeOperation = 'lighter';
      glow(g, x, y, Rm * 0.55, 0.3);
      glow(g, x, y, Rm * 0.2, 0.95);
      for (const p of s.pts) {
        const th = p.th + p.j + t * 0.05 * (1.4 - p.r);
        const [px, py] = proj(th, Math.max(0.02, p.r));
        const v = p.v * (0.45 + 0.55 * (1 - p.r));
        g.fillStyle = grey(v);
        g.fillRect(px, py, cw * 0.85, cw * 0.85);
      }
      // Seven bright stars along one arm, joined like a constellation.
      const steps = [];
      for (let i = 0; i < 7; i++) {
        const th = 0.9 + i * 1.12;
        const rr = Math.exp(s.b * th) / Math.exp(s.b * 3.6 * Math.PI) + 0.06;
        steps.push(proj(th + t * 0.05 * (1.4 - rr), rr));
      }
      g.strokeStyle = grey(0.35);
      g.lineWidth = cw * 0.35;
      g.beginPath();
      steps.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
      g.stroke();
      const lit = Math.floor(t / 0.9) % 8;
      steps.forEach(([px, py], i) => {
        const on = i === lit ? 1 : 0.65;
        star4(g, px, py, cw * (i === lit ? 2.4 : 1.6), on);
        glow(g, px, py, cw * 3, 0.3 * on);
      });
      g.globalCompositeOperation = 'source-over';
    },
  };

  // --- Staravorix: rune circle and fire ----------------------------------------
  SCENES.fire = {
    init: (opts, L, r) => ({
      parts: Array.from({ length: 140 }, () => ({ life: r(), sp: 0.5 + r() * 0.7, x: (r() - 0.5), w: r() * TAU, s: 0.6 + r() * 0.8 })),
      embers: Array.from({ length: 50 }, () => ({ life: r(), sp: 0.15 + r() * 0.2, x: (r() - 0.5) * 1.6, w: r() * TAU })),
      runes: Array.from({ length: 20 }, () => Array.from({ length: 3 }, () => [r() * 2 - 1, r() * 2 - 1])),
    }),
    draw(g, L, s, t) {
      const S = L.size;
      const cw = L.cw;
      const x = L.cx;
      const base = L.cy + S * 0.2;
      const rx = S * 0.27;
      const ry = rx * 0.28;
      // Rune circle on the ground.
      g.globalCompositeOperation = 'lighter';
      glow(g, x, base, rx * 0.95, 0.12);
      g.strokeStyle = grey(0.7);
      g.lineWidth = cw * 0.6;
      for (const k of [1, 0.8]) {
        g.beginPath();
        g.ellipse(x, base, rx * k, ry * k, 0, 0, TAU);
        g.stroke();
      }
      g.strokeStyle = grey(0.55);
      g.lineWidth = cw * 0.45;
      s.runes.forEach((rn, i) => {
        const a = (i / s.runes.length) * TAU + t * 0.15;
        const cx = x + Math.cos(a) * rx * 0.9;
        const cy = base + Math.sin(a) * ry * 0.9;
        const sz = rx * 0.045;
        g.beginPath();
        g.moveTo(cx + rn[0][0] * sz, cy + rn[0][1] * sz * 0.6);
        g.lineTo(cx + rn[1][0] * sz, cy + rn[1][1] * sz * 0.6);
        g.lineTo(cx + rn[2][0] * sz, cy + rn[2][1] * sz * 0.6);
        g.stroke();
      });
      // A hexagram inside the circle.
      g.strokeStyle = grey(0.42);
      g.lineWidth = cw * 0.4;
      for (let k = 0; k < 2; k++) {
        g.beginPath();
        for (let i = 0; i <= 3; i++) {
          const a = (i / 3) * TAU + k * Math.PI + t * -0.1;
          const px = x + Math.cos(a) * rx * 0.78;
          const py = base + Math.sin(a) * ry * 0.78;
          if (i === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.stroke();
      }
      // The flame: overlapping flickering tongues, brightest where they meet.
      const fh = S * 0.5;
      const fw = S * 0.06;
      const tongue = (ox, wm, hm, k, v) => {
        const fl = (j) => noise1(t * (2.6 + k * 0.3) + j * 1.7, k * 11 + j) - 0.5;
        const w = fw * wm;
        const h = fh * hm * (0.9 + 0.2 * noise1(t * 2 + k, k + 40));
        const bx = x + ox;
        const gr = g.createLinearGradient(0, base, 0, base - h);
        gr.addColorStop(0, grey(v));
        gr.addColorStop(0.55, grey(v * 0.55));
        gr.addColorStop(1, grey(0));
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(bx - w, base);
        g.bezierCurveTo(bx - w * 1.5, base - h * 0.3, bx - w * 0.5 + fl(1) * w * 2.2, base - h * 0.65, bx + fl(2) * w * 1.8, base - h);
        g.bezierCurveTo(bx + w * 0.5 + fl(3) * w * 2.2, base - h * 0.65, bx + w * 1.5, base - h * 0.3, bx + w, base);
        g.closePath();
        g.fill();
      };
      tongue(0, 1, 1, 1, 0.3);
      tongue(-fw * 0.7, 0.55, 0.66, 2, 0.24);
      tongue(fw * 0.75, 0.5, 0.74, 3, 0.24);
      tongue(-fw * 0.1, 0.35, 0.45, 4, 0.3);
      tongue(fw * 0.25, 0.28, 0.95, 5, 0.18);
      const dt = 1 / 30;
      for (const p of s.parts) {
        p.life += dt * p.sp * 0.8;
        if (p.life > 1) {
          p.life -= 1;
          p.x = (Math.random() - 0.5);
        }
        const py = base - p.life * fh * 1.05;
        const px = x + p.x * fw * 2 * (1 - p.life * 0.7) + Math.sin(t * 3 + p.w + p.life * 4) * fw * 0.5 * p.life;
        const v = Math.pow(1 - p.life, 1.3);
        glow(g, px, py, fw * 0.45 * p.s * (1 - p.life * 0.5), v * 0.32);
      }
      for (const e of s.embers) {
        e.life += dt * e.sp * 0.5;
        if (e.life > 1) e.life -= 1;
        const py = base - e.life * S * 0.7;
        const px = x + e.x * S * 0.18 + Math.sin(t * 1.5 + e.w) * S * 0.03;
        disc(g, px, py, cw * 0.35, grey((1 - e.life) * 0.95));
      }
      g.globalCompositeOperation = 'source-over';
    },
  };

  // --- Gear tree: a trunk whose canopy is turning gears -------------------------
  function gear(g, x, y, r, teeth, angle, v, cw) {
    const depth = r * 0.16;
    g.beginPath();
    for (let i = 0; i < teeth; i++) {
      const a0 = angle + (i / teeth) * TAU;
      const step = TAU / teeth;
      g.lineTo(x + Math.cos(a0) * (r - depth), y + Math.sin(a0) * (r - depth));
      g.lineTo(x + Math.cos(a0 + step * 0.12) * r, y + Math.sin(a0 + step * 0.12) * r);
      g.lineTo(x + Math.cos(a0 + step * 0.45) * r, y + Math.sin(a0 + step * 0.45) * r);
      g.lineTo(x + Math.cos(a0 + step * 0.57) * (r - depth), y + Math.sin(a0 + step * 0.57) * (r - depth));
    }
    g.closePath();
    const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    gr.addColorStop(0, grey(v));
    gr.addColorStop(1, grey(v * 0.45));
    g.fillStyle = gr;
    g.fill();
    g.strokeStyle = grey(Math.min(1, v + 0.3));
    g.lineWidth = cw * 0.5;
    g.stroke();
    // spokes cut out of the web
    g.save();
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    const spokes = r > 60 ? 5 : 4;
    for (let i = 0; i < spokes; i++) {
      const a = angle + (i / spokes) * TAU + Math.PI / spokes;
      g.beginPath();
      g.moveTo(x + Math.cos(a - 0.42) * r * 0.32, y + Math.sin(a - 0.42) * r * 0.32);
      g.arc(x, y, r * 0.66, a - 0.42, a + 0.42);
      g.lineTo(x + Math.cos(a + 0.42) * r * 0.32, y + Math.sin(a + 0.42) * r * 0.32);
      g.closePath();
      g.fill();
    }
    disc(g, x, y, r * 0.12, '#000');
    g.restore();
    disc(g, x, y, r * 0.2, grey(0));
    g.strokeStyle = grey(Math.min(1, v + 0.2));
    g.lineWidth = cw * 0.45;
    g.beginPath();
    g.arc(x, y, r * 0.2, 0, TAU);
    g.stroke();
  }
  SCENES.gears = {
    init: (opts, L, r) => ({ leaves: Array.from({ length: 36 }, () => ({ x: r(), y: r(), sp: 0.03 + r() * 0.05, w: r() * TAU })) }),
    draw(g, L, s, t) {
      const S = L.size;
      const cw = L.cw;
      const x = L.cx;
      const y = L.cy - S * 0.02;
      const ground = L.cy + S * 0.3;
      // Trunk and roots.
      const tr = g.createLinearGradient(x - S * 0.05, 0, x + S * 0.05, 0);
      tr.addColorStop(0, grey(0.1));
      tr.addColorStop(0.5, grey(0.32));
      tr.addColorStop(1, grey(0.08));
      g.fillStyle = tr;
      g.beginPath();
      g.moveTo(x - S * 0.075, ground);
      g.bezierCurveTo(x - S * 0.03, ground - S * 0.1, x - S * 0.035, y + S * 0.1, x - S * 0.02, y);
      g.lineTo(x + S * 0.02, y);
      g.bezierCurveTo(x + S * 0.035, y + S * 0.1, x + S * 0.03, ground - S * 0.1, x + S * 0.075, ground);
      g.closePath();
      g.fill();
      g.strokeStyle = grey(0.22);
      g.lineWidth = cw * 0.5;
      for (const k of [-1, 1]) {
        g.beginPath();
        g.moveTo(x + k * S * 0.05, ground);
        g.quadraticCurveTo(x + k * S * 0.12, ground + S * 0.01, x + k * S * 0.2, ground + S * 0.05);
        g.stroke();
      }
      g.fillStyle = grey(0.06);
      g.fillRect(0, ground, L.W, L.H - ground);
      g.strokeStyle = grey(0.3);
      g.beginPath();
      g.moveTo(0, ground);
      g.lineTo(L.W, ground);
      g.stroke();
      // Gears meshing: each child's speed is the parent's times -teeth ratio.
      const w = t * 0.35;
      const G = [
        { dx: 0, dy: -0.06, r: 0.13, n: 20, sp: 1, v: 0.7 },
        { dx: 0.19, dy: -0.12, r: 0.085, n: 13, sp: -20 / 13, v: 0.6 },
        { dx: -0.2, dy: -0.1, r: 0.095, n: 14, sp: -20 / 14, v: 0.62 },
        { dx: 0.07, dy: -0.255, r: 0.07, n: 11, sp: 20 / 11, v: 0.55 },
        { dx: -0.1, dy: -0.27, r: 0.055, n: 9, sp: 20 / 9, v: 0.5 },
        { dx: 0.3, dy: -0.02, r: 0.05, n: 8, sp: 20 / 8, v: 0.5 },
        { dx: -0.31, dy: 0.0, r: 0.05, n: 8, sp: 20 / 8, v: 0.5 },
      ];
      for (const q of G) gear(g, x + q.dx * S, y + q.dy * S, q.r * S, q.n, w * q.sp + q.n, q.v, cw);
      // Leaves drifting down.
      g.globalCompositeOperation = 'lighter';
      for (const l of s.leaves) {
        const ly = ((l.y + t * l.sp) % 1) * (ground - (y - S * 0.35)) + (y - S * 0.35);
        const lx = x + (l.x - 0.5) * S * 0.8 + Math.sin(t + l.w) * S * 0.02;
        disc(g, lx, ly, cw * 0.4, grey(0.75));
      }
      g.globalCompositeOperation = 'source-over';
    },
  };

  // --- Neural network under a lens ----------------------------------------------
  SCENES.network = {
    init: (opts, L, r) => {
      const layers = [4, 6, 7, 7, 6, 3];
      const nodes = [];
      layers.forEach((n, li) => {
        for (let i = 0; i < n; i++) nodes.push({ li, u: li / (layers.length - 1), v: (i + 0.5) / n, act: 0 });
      });
      const edges = [];
      nodes.forEach((a, ai) => {
        const next = nodes.map((b, bi) => [b, bi]).filter(([b]) => b.li === a.li + 1);
        const picks = next.sort(() => r() - 0.5).slice(0, 3);
        for (const [, bi] of picks) edges.push([ai, bi]);
      });
      const pulses = Array.from({ length: 34 }, () => ({ e: Math.floor(r() * edges.length), p: r(), sp: 0.5 + r() * 0.6 }));
      return { nodes, edges, pulses, r };
    },
    draw(g, L, s, t) {
      const S = L.size;
      const cw = L.cw;
      const w = S * 0.82;
      const h = S * 0.42;
      const ox = L.cx - w / 2;
      const oy = L.cy - h / 2;
      const pos = (n) => [ox + n.u * w, oy + (n.v - 0.5) * h * (0.6 + 0.4 * Math.sin(n.u * Math.PI)) + h / 2];
      const lensX = L.cx + Math.cos(t * 0.23) * w * 0.28;
      const lensY = L.cy + Math.sin(t * 0.31) * h * 0.22;
      const lensR = S * 0.11;
      g.strokeStyle = grey(0.16);
      g.lineWidth = cw * 0.3;
      for (const [a, b] of s.edges) {
        const [x1, y1] = pos(s.nodes[a]);
        const [x2, y2] = pos(s.nodes[b]);
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
      }
      g.globalCompositeOperation = 'lighter';
      const dt = 1 / 30;
      for (const p of s.pulses) {
        p.p += dt * p.sp;
        const [a, b] = s.edges[p.e];
        if (p.p >= 1) {
          s.nodes[b].act = 1;
          const out = s.edges.map((e, i) => [e, i]).filter(([e]) => e[0] === b);
          p.e = out.length ? out[Math.floor(s.r() * out.length)][1] : Math.floor(s.r() * s.edges.length);
          p.p = 0;
          continue;
        }
        const [x1, y1] = pos(s.nodes[a]);
        const [x2, y2] = pos(s.nodes[b]);
        const px = lerp(x1, x2, p.p);
        const py = lerp(y1, y2, p.p);
        disc(g, px, py, cw * 0.45, grey(1));
        glow(g, px, py, cw * 2, 0.3);
      }
      for (const n of s.nodes) {
        const [nx, ny] = pos(n);
        n.act *= 0.94;
        disc(g, nx, ny, S * 0.016, grey(0.3 + 0.6 * n.act));
        glow(g, nx, ny, S * 0.04, 0.35 * n.act);
      }
      // Inside the lens, the network is drawn brighter and larger.
      g.globalCompositeOperation = 'source-over';
      g.save();
      g.beginPath();
      g.arc(lensX, lensY, lensR, 0, TAU);
      g.clip();
      g.fillStyle = grey(0.06);
      g.fillRect(lensX - lensR, lensY - lensR, lensR * 2, lensR * 2);
      g.translate(lensX, lensY);
      g.scale(1.7, 1.7);
      g.translate(-lensX, -lensY);
      g.strokeStyle = grey(0.45);
      g.lineWidth = cw * 0.3;
      for (const [a, b] of s.edges) {
        const [x1, y1] = pos(s.nodes[a]);
        const [x2, y2] = pos(s.nodes[b]);
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
      }
      for (const n of s.nodes) {
        const [nx, ny] = pos(n);
        disc(g, nx, ny, S * 0.016, grey(0.6 + 0.4 * n.act));
      }
      g.restore();
      g.strokeStyle = grey(0.95);
      g.lineWidth = cw * 0.9;
      g.beginPath();
      g.arc(lensX, lensY, lensR, 0, TAU);
      g.stroke();
      line(g, lensX + lensR * 0.72, lensY + lensR * 0.72, lensX + lensR * 1.6, lensY + lensR * 1.6, grey(0.7), cw * 1.8);
    },
  };

  // --- Fireworks over a child in a dark field -----------------------------------
  SCENES.fireworks = {
    init: () => ({ bursts: [], next: -1.6 }),
    draw(g, L, s, t) {
      const S = L.size;
      const cw = L.cw;
      const ground = L.cy + S * 0.3;
      const r = Math.random;
      while (t > s.next) {
        const t0 = s.next;
        s.next += 0.45 + r() * 0.55;
        const n = 60 + Math.floor(r() * 40);
        const bx = L.cx + (r() - 0.5) * S * 1.0;
        const by = L.cy - S * 0.1 + (r() - 0.5) * S * 0.3;
        const sp = S * (0.2 + r() * 0.16);
        s.bursts.push({
          t0,
          x: bx,
          y: by,
          life: 1.8 + r() * 0.8,
          ring: r() < 0.3,
          parts: Array.from({ length: n }, (_, i) => {
            const a = (i / n) * TAU + r() * 0.2;
            const v = sp * (0.6 + r() * 0.4);
            return { vx: Math.cos(a) * v, vy: Math.sin(a) * v };
          }),
        });
      }
      s.bursts = s.bursts.filter((b) => t - b.t0 < b.life);
      // Horizon glow and the field.
      const hz = g.createLinearGradient(0, ground - S * 0.25, 0, ground);
      hz.addColorStop(0, grey(0));
      hz.addColorStop(1, grey(0.16));
      g.fillStyle = hz;
      g.fillRect(0, ground - S * 0.25, L.W, S * 0.25);
      let flash = 0;
      g.globalCompositeOperation = 'lighter';
      for (const b of s.bursts) {
        const a = t - b.t0;
        const k = 1 - a / b.life;
        flash = Math.max(flash, Math.pow(k, 3));
        if (a < 0.12) glow(g, b.x, b.y, S * 0.12, 0.8 * (1 - a / 0.12));
        const drag = (1 - Math.exp(-a * 1.6)) * 0.95;
        for (const p of b.parts) {
          const px = b.x + p.vx * drag;
          const py = b.y + p.vy * drag + 0.5 * S * 0.06 * a * a;
          const px2 = b.x + p.vx * drag * 0.86;
          const py2 = b.y + p.vy * drag * 0.86 + 0.5 * S * 0.06 * a * a * 0.9;
          line(g, px2, py2, px, py, grey(Math.pow(k, 1.2)), cw * 0.6);
          if (b.ring && Math.sin(a * 20 + p.vx) > 0.6) disc(g, px, py, cw * 0.5, grey(k));
        }
      }
      g.globalCompositeOperation = 'source-over';
      const field = g.createLinearGradient(0, ground, 0, L.H);
      field.addColorStop(0, grey(0.14 + flash * 0.1));
      field.addColorStop(1, grey(0.04));
      g.fillStyle = field;
      g.fillRect(0, ground, L.W, L.H - ground);
      // Grass tufts on the ridge, then the child sitting and looking up.
      g.strokeStyle = grey(0.2 + flash * 0.1);
      g.lineWidth = cw * 0.35;
      for (let i = 0; i < 70; i++) {
        const gx = (i / 70) * L.W + hash(i) * 10;
        g.beginPath();
        g.moveTo(gx, ground + 2);
        g.lineTo(gx + Math.sin(t + i) * 3, ground - S * 0.015 * (0.5 + hash(i + 5)));
        g.stroke();
      }
      figure(g, L.cx - S * 0.06, ground + S * 0.01, S * 0.09, 'sit', 0.25 + flash * 0.5, cw);
    },
  };

  // --- Meadow at dusk: two figures on a winding path ----------------------------
  SCENES.meadow = {
    init: (opts, L, r) => ({ flies: Array.from({ length: 34 }, () => ({ x: r(), y: r(), p: r() * TAU, sp: 0.3 + r() })) }),
    draw(g, L, s, t) {
      const { W, H, size: S, cw } = L;
      const hy = L.cy + S * 0.05;
      const sky = g.createLinearGradient(0, 0, 0, hy);
      sky.addColorStop(0, grey(0.02));
      sky.addColorStop(0.7, grey(0.16));
      sky.addColorStop(1, grey(0.42));
      g.fillStyle = sky;
      g.fillRect(0, 0, W, hy + 1);
      g.globalCompositeOperation = 'lighter';
      const sunX = L.cx - S * 0.3;
      glow(g, sunX, hy, S * 0.4, 0.3);
      glow(g, sunX, hy, S * 0.07, 0.8);
      starfield(g, L, s, t, 40, 0.3);
      g.globalCompositeOperation = 'source-over';
      const hill = (base, amp, freq, ph, v) => {
        g.fillStyle = grey(v);
        g.beginPath();
        g.moveTo(0, H);
        for (let x = 0; x <= W + 10; x += 10) g.lineTo(x, base - Math.sin((x / S) * freq + ph) * amp - Math.sin((x / S) * freq * 2.3 + ph * 2) * amp * 0.3);
        g.lineTo(W, H);
        g.closePath();
        g.fill();
      };
      hill(hy + S * 0.01, S * 0.025, 4, 1, 0.3);
      hill(hy + S * 0.06, S * 0.04, 2.6, 2, 0.2);
      hill(hy + S * 0.13, S * 0.05, 1.8, 4, 0.11);
      // The path: wide at the bottom, narrowing as it winds to the horizon.
      g.fillStyle = grey(0.38);
      g.beginPath();
      const N = 30;
      const px = (k) => L.cx + Math.sin(k * 4.2 + 0.4) * S * 0.12 * k + S * 0.05;
      const py = (k) => lerp(H + 10, hy + S * 0.025, 1 - k);
      for (let i = 0; i <= N; i++) {
        const k = 1 - i / N;
        g.lineTo(px(k) - S * 0.2 * Math.pow(k, 1.6) - 2, py(k));
      }
      for (let i = N; i >= 0; i--) {
        const k = 1 - i / N;
        g.lineTo(px(k) + S * 0.2 * Math.pow(k, 1.6) + 2, py(k));
      }
      g.closePath();
      g.fill();
      // Two figures holding hands, walking away from us.
      const k = 0.42;
      const fx = px(k);
      const fy = py(k);
      const bob = Math.sin(t * 3) * S * 0.002;
      figure(g, fx - S * 0.018, fy + bob, S * 0.085, 'stand', 0.35, cw);
      figure(g, fx + S * 0.018, fy - bob, S * 0.078, 'stand', 0.35, cw);
      line(g, fx - S * 0.01, fy - S * 0.04, fx + S * 0.01, fy - S * 0.038, '#000', cw * 0.6);
      // Fireflies and swaying grass.
      g.globalCompositeOperation = 'lighter';
      for (const f of s.flies) {
        const fxp = (f.x + Math.sin(t * 0.2 * f.sp + f.p) * 0.03) * W;
        const fyp = hy + (f.y * 0.9 + 0.05) * (H - hy) + Math.cos(t * 0.3 * f.sp + f.p) * 10;
        const on = Math.max(0, Math.sin(t * f.sp * 2 + f.p));
        if (on > 0.1) {
          disc(g, fxp, fyp, cw * 0.4, grey(on));
          glow(g, fxp, fyp, cw * 2, 0.25 * on);
        }
      }
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = grey(0.24);
      g.lineWidth = cw * 0.4;
      for (let i = 0; i < 90; i++) {
        const gx = (i / 90) * W + hash(i * 3) * 12;
        const gh = S * (0.03 + hash(i) * 0.05);
        const sway = Math.sin(t * 1.4 + i * 0.4) * gh * 0.25;
        g.beginPath();
        g.moveTo(gx, H + 2);
        g.quadraticCurveTo(gx, H - gh * 0.5, gx + sway, H - gh);
        g.stroke();
      }
    },
  };

  // --- Seed: sprouting into a branching tree -----------------------------------
  SCENES.seed = {
    init: (opts, L, r) => ({ r, pollen: Array.from({ length: 30 }, () => ({ x: r(), y: r(), p: r() * TAU })) }),
    draw(g, L, s, t) {
      const S = L.size;
      const cw = L.cw;
      const x = L.cx;
      const ground = L.cy + S * 0.24;
      const grow = smooth(0.2, 7, t);
      g.globalCompositeOperation = 'lighter';
      glow(g, x + S * 0.25, L.cy - S * 0.25, S * 0.35, 0.22);
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = grey(0.07);
      g.fillRect(0, ground, L.W, L.H - ground);
      line(g, 0, ground, L.W, ground, grey(0.35), cw * 0.5);
      // Roots: dim lines branching down into the soil.
      const roots = (x0, y0, a, len, d) => {
        if (d > 5 || len < 4) return;
        const k = clamp(grow * 1.4 - d * 0.12, 0, 1);
        if (k <= 0) return;
        const x1 = x0 + Math.cos(a) * len * k;
        const y1 = y0 + Math.sin(a) * len * k;
        line(g, x0, y0, x1, y1, grey(0.38 - d * 0.05), cw * (0.55 - d * 0.07));
        roots(x1, y1, a - 0.45 + hash(d * 13 + len) * 0.2, len * 0.7, d + 1);
        roots(x1, y1, a + 0.45 - hash(d * 7 + len) * 0.2, len * 0.66, d + 1);
      };
      roots(x, ground + 2, Math.PI / 2, S * 0.08, 0);
      // The seed itself, half buried.
      g.fillStyle = grey(0.85);
      g.beginPath();
      g.ellipse(x, ground + S * 0.004, S * 0.022, S * 0.013, -0.3, 0, TAU);
      g.fill();
      // The tree.
      const maxD = 8;
      const tips = [];
      const branch = (x0, y0, a, len, d) => {
        const k = clamp(grow * maxD - d, 0, 1);
        if (k <= 0) return;
        const sway = Math.sin(t * 0.8 + d * 0.7) * 0.018 * d;
        const aa = a + sway;
        const x1 = x0 + Math.cos(aa) * len * k;
        const y1 = y0 + Math.sin(aa) * len * k;
        line(g, x0, y0, x1, y1, grey(0.85 - d * 0.05), Math.max(cw * 0.3, cw * (1.6 - d * 0.18)));
        if (d === maxD - 1 || k < 1) {
          tips.push([x1, y1, k]);
          return;
        }
        const spread = 0.38 + hash(d * 31 + Math.round(x0)) * 0.12;
        branch(x1, y1, aa - spread, len * 0.76, d + 1);
        branch(x1, y1, aa + spread * 0.9, len * 0.72, d + 1);
      };
      g.lineCap = 'round';
      branch(x, ground - 1, -Math.PI / 2, S * 0.1, 0);
      g.lineCap = 'butt';
      g.globalCompositeOperation = 'lighter';
      for (const [tx, ty, k] of tips) {
        disc(g, tx, ty, cw * 0.55 * k, grey(0.95));
        glow(g, tx, ty, cw * 2.2, 0.18 * k);
      }
      for (const p of s.pollen) {
        const py = ground - ((p.y + t * 0.02) % 1) * S * 0.5;
        const px = x + (p.x - 0.5) * S * 0.7 + Math.sin(t * 0.7 + p.p) * S * 0.02;
        disc(g, px, py, cw * 0.25, grey(0.6));
      }
      g.globalCompositeOperation = 'source-over';
    },
  };

  // --- City: a skyline being built by a swarm ------------------------------------
  SCENES.city = {
    init: (opts, L, r) => {
      const blds = [];
      let x = -0.6;
      while (x < 0.6) {
        const w = 0.03 + r() * 0.05;
        blds.push({ x, w, h: 0.06 + Math.pow(r(), 1.6) * 0.32, build: r() < 0.14, seed: Math.floor(r() * 1e6) });
        x += w + 0.004;
      }
      const drones = Array.from({ length: 28 }, () => ({ a: r() * TAU, rx: 0.1 + r() * 0.5, ry: 0.05 + r() * 0.16, sp: 0.2 + r() * 0.5, y: r() }));
      return { blds, drones };
    },
    draw(g, L, s, t) {
      const S = L.size;
      const cw = L.cw;
      const ground = L.cy + S * 0.2;
      starfield(g, L, s, t, 60, 0.3);
      g.globalCompositeOperation = 'lighter';
      glow(g, L.cx, ground, S * 0.7, 0.18);
      g.globalCompositeOperation = 'source-over';
      disc(g, L.cx + S * 0.38, L.cy - S * 0.22, S * 0.035, grey(0.8));
      const drawCity = (mirror) => {
        for (const b of s.blds) {
          const bx = L.cx + b.x * S * 1.2;
          const bw = b.w * S * 1.2;
          let bh = b.h * S;
          if (b.build) bh *= 0.35 + 0.65 * ((Math.sin(t * 0.25 + b.seed) + 1) / 2);
          const top = mirror ? ground + 2 : ground - bh;
          const hgt = mirror ? bh * 0.5 : bh;
          if (b.build && !mirror) {
            g.strokeStyle = grey(0.75);
            g.lineWidth = cw * 0.4;
            g.strokeRect(bx, top, bw, bh);
            for (let k = 0; k < bh; k += bw) {
              line(g, bx, top + k, bx + bw, Math.min(top + bh, top + k + bw), grey(0.45), cw * 0.3);
            }
            line(g, bx + bw / 2, top, bx + bw / 2, top - S * 0.05, grey(0.6), cw * 0.35);
            line(g, bx + bw / 2 - S * 0.06, top - S * 0.05, bx + bw / 2 + S * 0.03, top - S * 0.05, grey(0.6), cw * 0.35);
            continue;
          }
          const fill = g.createLinearGradient(0, top, 0, top + hgt);
          fill.addColorStop(0, grey(mirror ? 0.08 : 0.34));
          fill.addColorStop(1, grey(mirror ? 0 : 0.16));
          g.fillStyle = fill;
          g.fillRect(bx, top, bw, hgt);
          if (mirror) continue;
          line(g, bx, top, bx + bw, top, grey(0.55), cw * 0.4);
          // windows
          const cols = Math.max(1, Math.floor(bw / (cw * 1.6)));
          const rows = Math.floor(bh / (L.ch * 0.9));
          for (let i = 0; i < cols; i++) {
            for (let j = 1; j < rows; j++) {
              const hsh = hash(b.seed + i * 131 + j * 977);
              const on = hsh < 0.42 + 0.1 * Math.sin(t * 0.3 + hsh * 20);
              if (!on) continue;
              g.fillStyle = grey(0.75 + 0.25 * hsh);
              g.fillRect(bx + (i + 0.5) * (bw / cols) - cw * 0.4, top + j * L.ch * 0.9, cw * 0.8, L.ch * 0.5);
            }
          }
        }
      };
      drawCity(false);
      g.fillStyle = grey(0.03);
      g.fillRect(0, ground, L.W, L.H - ground);
      drawCity(true);
      g.globalCompositeOperation = 'lighter';
      for (const d of s.drones) {
        const a = d.a + t * d.sp;
        const dx = L.cx + Math.cos(a) * d.rx * S;
        const dy = ground - S * (0.1 + d.y * 0.35) + Math.sin(a * 2) * d.ry * S * 0.3;
        disc(g, dx, dy, cw * 0.45, grey(1));
        glow(g, dx, dy, cw * 1.8, 0.3);
      }
      g.globalCompositeOperation = 'source-over';
    },
  };

  // --- Library: towering shelves toward a light -----------------------------------
  SCENES.library = {
    draw(g, L, s, t) {
      const S = L.size;
      const cw = L.cw;
      const vx = L.cx;
      const vy = L.cy - S * 0.02;
      const F = S * 0.32;
      const dolly = (t * 0.25) % 0.6;
      g.globalCompositeOperation = 'lighter';
      glow(g, vx, vy, S * 0.35, 0.5);
      glow(g, vx, vy, S * 0.08, 1);
      g.globalCompositeOperation = 'source-over';
      const P = (X, Y, Z) => [vx + (X / Z) * F, vy + (Y / Z) * F];
      // Floor runner of light.
      const [fx1, fy1] = P(-0.35, 1.1, 0.7);
      const [fx2, fy2] = P(0.35, 1.1, 0.7);
      const [fx3, fy3] = P(0.35, 1.1, 14);
      const [fx4, fy4] = P(-0.35, 1.1, 14);
      const fl = g.createLinearGradient(0, fy1, 0, fy3);
      fl.addColorStop(0, grey(0.12));
      fl.addColorStop(1, grey(0.45));
      g.fillStyle = fl;
      g.beginPath();
      g.moveTo(fx1, fy1);
      g.lineTo(fx2, fy2);
      g.lineTo(fx3, fy3);
      g.lineTo(fx4, fy4);
      g.closePath();
      g.fill();
      const shelfYs = [-2.6, -2.05, -1.5, -0.95, -0.4, 0.15, 0.7];
      for (const side of [-1, 1]) {
        for (let k = 0; k < 90; k++) {
          const z0 = 0.7 + k * 0.15 - dolly;
          const z1 = z0 + 0.15;
          if (z0 < 0.4) continue;
          const fog = Math.exp(-z0 * 0.08);
          for (let r = 0; r < shelfYs.length - 1; r++) {
            const hsh = hash(k * 31 + r * 7 + (side > 0 ? 1000 : 0) + Math.floor((t * 0.25) / 0.6) * 0);
            const top = shelfYs[r] + 0.06 + (1 - hsh) * 0.12;
            const bot = shelfYs[r + 1] - 0.02;
            const [ax, ay] = P(side, top, z0);
            const [bx, by] = P(side, top, z1);
            const [cx, cy] = P(side, bot, z1);
            const [dx, dy] = P(side, bot, z0);
            g.fillStyle = grey((0.1 + hsh * 0.5) * fog + (1 - fog) * 0.3);
            g.beginPath();
            g.moveTo(ax, ay);
            g.lineTo(bx, by);
            g.lineTo(cx, cy);
            g.lineTo(dx, dy);
            g.closePath();
            g.fill();
          }
        }
        // Shelf boards.
        for (const Y of shelfYs) {
          const [ax, ay] = P(side, Y, 0.5);
          const [bx, by] = P(side, Y, 14);
          line(g, ax, ay, bx, by, grey(0.6), cw * 0.5);
        }
      }
      // A small reader walking toward the light.
      const [mx, my] = P(0.05, 1.1, 3.2);
      figure(g, mx, my, (F / 3.2) * 0.9, 'stand', 0.5, cw);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 26; i++) {
        const px = vx + (hash(i) - 0.5) * S * 0.4 + Math.sin(t * 0.3 + i) * 10;
        const py = vy + (hash(i + 50) - 0.5) * S * 0.3 + Math.cos(t * 0.25 + i) * 8;
        disc(g, px, py, cw * 0.25, grey(0.55));
      }
      g.globalCompositeOperation = 'source-over';
    },
  };

  // --- Lanterns rising over water ---------------------------------------------------
  SCENES.lanterns = {
    init: (opts, L, r) => ({ ls: Array.from({ length: 46 }, () => ({ x: r(), y: r(), z: 0.35 + r() * 0.65, sp: 0.02 + r() * 0.03, p: r() * TAU })) }),
    draw(g, L, s, t) {
      const { W, H, size: S, cw } = L;
      const water = L.cy + S * 0.2;
      starfield(g, L, s, t, 70, 0.25);
      const hz = g.createLinearGradient(0, water - S * 0.2, 0, water);
      hz.addColorStop(0, grey(0));
      hz.addColorStop(1, grey(0.12));
      g.fillStyle = hz;
      g.fillRect(0, water - S * 0.2, W, S * 0.2);
      const order = [...s.ls].sort((a, b) => a.z - b.z);
      const pos = (l) => {
        const y = water - (((l.y + t * l.sp) % 1) * (water + S * 0.1)) + S * 0.02;
        const x = (l.x + Math.sin(t * 0.3 + l.p) * 0.01) * W;
        return [x, y];
      };
      g.globalCompositeOperation = 'lighter';
      for (const l of order) {
        const [x, y] = pos(l);
        const h = S * 0.035 * l.z;
        const w = h * 0.75;
        glow(g, x, y, h * 2.2, 0.28 * l.z);
        const lg = g.createLinearGradient(0, y - h / 2, 0, y + h / 2);
        lg.addColorStop(0, grey(0.55 * l.z + 0.2));
        lg.addColorStop(1, grey(0.95 * l.z + 0.05));
        g.fillStyle = lg;
        g.beginPath();
        g.moveTo(x - w * 0.5, y - h * 0.5);
        g.lineTo(x + w * 0.5, y - h * 0.5);
        g.lineTo(x + w * 0.36, y + h * 0.5);
        g.lineTo(x - w * 0.36, y + h * 0.5);
        g.closePath();
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = grey(0.04);
      g.fillRect(0, water, W, H - water);
      g.globalCompositeOperation = 'lighter';
      for (const l of order) {
        const [x, y] = pos(l);
        const d = water - y;
        if (d < 0) continue;
        const ry = water + d * 0.35;
        if (ry > H) continue;
        for (let k = 0; k < 3; k++) {
          const wob = Math.sin(t * 2 + k + l.p) * cw * 0.8;
          line(g, x - cw * 0.8 + wob, ry + k * L.ch * 0.5, x + cw * 0.8 + wob, ry + k * L.ch * 0.5, grey(0.35 * l.z * (1 - k / 3)), cw * 0.35);
        }
      }
      g.globalCompositeOperation = 'source-over';
      // The crowd on the shore, heads and shoulders against the reflections.
      g.fillStyle = '#000';
      for (let i = 0; i < 26; i++) {
        const cx = (i / 25) * W + (hash(i) - 0.5) * 20;
        const hh = S * (0.045 + hash(i + 9) * 0.03);
        const by = H + 4;
        g.beginPath();
        g.moveTo(cx - hh * 0.5, by);
        g.quadraticCurveTo(cx - hh * 0.5, by - hh * 0.7, cx, by - hh * 0.75);
        g.quadraticCurveTo(cx + hh * 0.5, by - hh * 0.7, cx + hh * 0.5, by);
        g.fill();
        disc(g, cx, by - hh * 0.95, hh * 0.2, '#000');
      }
    },
  };

  // --- Custom: an SVG Karyon drew, turned into brightness ---------------------------
  SCENES.custom = {
    init(opts) {
      const s = { img: null, ready: false };
      if (opts.svg) {
        const img = new Image();
        img.onload = () => {
          // Rasterize once to greyscale so every frame is a cheap drawImage.
          const c = document.createElement('canvas');
          c.width = 640;
          c.height = 360;
          const x = c.getContext('2d', { willReadFrequently: true });
          x.fillStyle = '#000';
          x.fillRect(0, 0, c.width, c.height);
          x.drawImage(img, 0, 0, c.width, c.height);
          const d = x.getImageData(0, 0, c.width, c.height);
          for (let i = 0; i < d.data.length; i += 4) {
            const v = 0.3 * d.data[i] + 0.59 * d.data[i + 1] + 0.11 * d.data[i + 2];
            d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
          }
          x.putImageData(d, 0, 0);
          s.img = c;
          s.ready = true;
        };
        img.onerror = () => (s.failed = true);
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(opts.svg)}`;
      }
      return s;
    },
    draw(g, L, s, t) {
      if (!s.ready) {
        if (s.failed) return;
        return;
      }
      const w = Math.min(L.W * 0.96, L.size * 1.1);
      const h = w * (9 / 16);
      const k = 1 + 0.012 * Math.sin(t * 0.6);
      g.drawImage(s.img, L.cx - (w * k) / 2, L.cy - (h * k) / 2, w * k, h * k);
      // A slow sheen across the picture.
      g.globalCompositeOperation = 'lighter';
      const sx = L.cx - w / 2 + (((t * 0.12) % 1.4) - 0.2) * w;
      const sh = g.createLinearGradient(sx - w * 0.1, 0, sx + w * 0.1, 0);
      sh.addColorStop(0, grey(0, 0));
      sh.addColorStop(0.5, grey(0.12));
      sh.addColorStop(1, grey(0, 0));
      g.fillStyle = sh;
      g.fillRect(L.cx - w / 2, L.cy - h / 2, w, h);
      g.globalCompositeOperation = 'source-over';
    },
  };

  // ---------------------------------------------------------------------------
  // At this width and up, the eyes and the art share a stage on the left and the
  // conversation takes the right. Below it, the eyes sit in a band at the top and
  // the art stays dim behind the text.
  const SIDE_MIN_W = 1080;

  class Engine {
    constructor(canvas, glowCanvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.glowCanvas = glowCanvas;
      this.gctx = glowCanvas ? glowCanvas.getContext('2d') : null;
      this.sA = document.createElement('canvas');
      this.sB = document.createElement('canvas');
      this.xA = this.sA.getContext('2d', { willReadFrequently: true });
      this.xB = this.sB.getContext('2d', { willReadFrequently: true });
      this.params = { eyeOpen: 1, gazeX: 0, gazeY: 0, thinking: 0, expression: 'wide' };
      this.bolts = [];
      this.hover = null;
      this.hoverL = 0;
      this.hoverR = 0;
      this.eyeT0 = 0;
      this.mode = 'hero';
      this.time = 0;
      this.frame = 0;
      this.fps = 30;
      this.paused = false;
      this.dim = 1;
      this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.current = null;
      this.next = null;
      this.morph = null;
      this.seed = 1;
      this.resize();
      this.layout = this.layoutFor(this.mode);
      window.addEventListener('resize', () => {
        clearTimeout(this._rz);
        this._rz = setTimeout(() => this.resize(), 120);
      });
    }

    resize() {
      // A hidden tab can report a zero-size window, and the grid can't be zero.
      const W = window.innerWidth || 1024;
      const H = window.innerHeight || 768;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const probe = this.ctx;
      probe.font = '100px "JetBrains Mono", "IBM Plex Mono", Menlo, Consolas, monospace';
      const ratio = probe.measureText('M').width / 100 || 0.6;
      const cols = clamp(Math.round(W / (W < 700 ? 4.6 : 6.4)), 70, 340);
      const cw = W / cols;
      const font = cw / ratio;
      const ch = font * 1.14;
      const rows = Math.ceil(H / ch);
      Object.assign(this, { W, H, dpr, cols, rows, cw, ch, font });
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      if (this.glowCanvas) {
        this.glowCanvas.width = Math.max(1, Math.round(W / 4));
        this.glowCanvas.height = Math.max(1, Math.round(H / 4));
      }
      this.sw = cols * 2;
      this.sh = rows * 4;
      for (const c of [this.sA, this.sB]) {
        c.width = this.sw;
        c.height = this.sh;
      }
      const n = cols * rows;
      this.gray = new Float32Array(this.sw * this.sh);
      this.A = this.cellBuffers(n);
      this.B = this.cellBuffers(n);
      this.order = new Float32Array(n);
      this.buildAtlas();
      if (this.layout) this.layout = this.layoutFor(this.mode);
    }

    cellBuffers(n) {
      return {
        L: new Float32Array(n),
        E: new Float32Array(n),
        M: new Float32Array(n),
        O: new Uint8Array(n),
        jxx: new Float32Array(n),
        jyy: new Float32Array(n),
        jxy: new Float32Array(n),
      };
    }

    buildAtlas() {
      const gw = Math.ceil(this.cw * this.dpr) + 1;
      const gh = Math.ceil(this.ch * this.dpr) + 1;
      const atlas = document.createElement('canvas');
      atlas.width = gw * CHARS.length;
      atlas.height = gh * LEVELS;
      const a = atlas.getContext('2d');
      a.textAlign = 'center';
      a.textBaseline = 'middle';
      a.font = `${this.font * this.dpr}px "JetBrains Mono", "IBM Plex Mono", Menlo, Consolas, monospace`;
      for (let k = 0; k < LEVELS; k++) {
        a.fillStyle = gold(k / (LEVELS - 1));
        for (let i = 0; i < CHARS.length; i++) a.fillText(CHARS[i], i * gw + gw / 2, k * gh + gh / 2 + this.dpr * 0.5);
      }
      Object.assign(this, { atlas, gw, gh });
    }

    // The width of the left stage. The rest of the window is the conversation.
    get stageW() {
      return this.W - clamp(this.W * 0.42, 440, 660);
    }

    get sideMode() {
      return this.mode === 'chat' && this.W >= SIDE_MIN_W;
    }

    // Height of the band that holds the eyes above the text on narrow screens.
    get bandH() {
      return Math.round(Math.min(this.H * 0.22, this.W * 0.4));
    }

    get hasArt() {
      return this.mode === 'chat' && this.sceneName && this.sceneName !== 'eyes';
    }

    layoutFor(mode) {
      const { W, H, cw, ch } = this;
      if (mode === 'chat') {
        if (W >= SIDE_MIN_W) {
          // Both eyes on the stage. With a painting they rise to make room for it.
          const S = this.stageW;
          const eyeW = this.hasArt ? Math.min(S * 0.27, H * 0.36) : Math.min(S * 0.36, H * 0.6);
          return { W, H, cw, ch, cx: S / 2, cy: this.hasArt ? H * 0.17 : H * 0.46, size: Math.min(S, H), eyeDX: eyeW * 0.62, eyeW, wing: this.hasArt ? 0.3 : 0.38, lookX: 0.45 };
        }
        const band = this.bandH;
        const eyeW = Math.min(W * 0.36, band * 1.15);
        return { W, H, cw, ch, cx: W / 2, cy: band * 0.5, size: Math.min(W, H * 0.5), eyeDX: eyeW * 0.62, eyeW, wing: 0.15, lookX: 0 };
      }
      if (W < SIDE_MIN_W && W < H) {
        // Portrait phones: the eyes fill the width.
        return { W, H, cw, ch, cx: W / 2, cy: H * 0.24, size: W, eyeDX: W * 0.25, eyeW: W * 0.46, wing: 0.25, lookX: 0 };
      }
      // Hero: the eyes at the proportions they have in Era of Intelligence (eye
      // centers 22.5% of a 16:9 frame off center, each eye 35.3% wide), above the
      // middle of the window so they clear the greeting.
      const vw = Math.min(W, (H * 16) / 9);
      return { W, H, cw, ch, cx: W / 2, cy: H * 0.34, size: vw * 0.815, eyeDX: vw * 0.2247, eyeW: vw * 0.3531, wing: 1, lookX: 0 };
    }

    // Where a painting lives: under the eyes on the stage, or behind the text.
    get artRect() {
      const { W, H } = this;
      if (W >= SIDE_MIN_W) {
        const y = Math.round(H * 0.32);
        return { x: 0, y, W: this.stageW, H: H - y };
      }
      const y = this.bandH;
      return { x: 0, y, W, H: H - y };
    }

    // The eyes' box on screen, at their current place in the layout.
    get eyeRect() {
      const L = this.layout;
      const hw = L.eyeDX + L.eyeW / 2;
      return { x: L.cx - hw, y: L.cy - L.eyeW * 0.36, W: hw * 2, H: L.eyeW * 0.72 };
    }

    // The frame a painting gets. Scenes see it as their whole world, so anything
    // sized to L.W and L.H stays inside it.
    panelLayout() {
      const { cw, ch } = this;
      const r = this.artRect;
      return { W: r.W, H: r.H, cw, ch, cx: r.W / 2, cy: r.H * 0.5, size: Math.min(r.W * 1.3, r.H * 1.6), x: r.x, y: r.y };
    }

    drawPanel(ctx, entry) {
      const L = this.panelLayout();
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.x, L.y, L.W, L.H);
      ctx.clip();
      ctx.translate(L.x, L.y);
      SCENES[entry.name].draw(ctx, L, entry.state, this.time - entry.t0, this.params);
      ctx.restore();
      // Fade the painting into an oval, so full-bleed scenes float on the stage
      // instead of ending in the edges of a rectangle.
      const rx = L.W * 0.52;
      const ry = L.H * 0.52;
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.x, L.y, L.W, L.H);
      ctx.clip();
      ctx.translate(L.x + L.cx, L.y + L.cy);
      ctx.scale(rx, ry);
      const gr = ctx.createRadialGradient(0, 0, 0.6, 0, 0, 1);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = gr;
      ctx.fillRect(-(L.W / rx) * 2, -(L.H / ry) * 2, (L.W / rx) * 4, (L.H / ry) * 4);
      ctx.restore();
    }

    // A lightning strike between two points on screen. The bolt is drawn into the
    // scene, so it turns into letters and picks up the glow like everything else.
    strike(x0, y0, x1, y1) {
      const jag = (ax, ay, bx, by, n, spread) => {
        const pts = [[ax, ay]];
        for (let i = 1; i < n; i++) {
          const k = i / n;
          pts.push([ax + (bx - ax) * k + (Math.random() - 0.5) * spread, ay + (by - ay) * k]);
        }
        pts.push([bx, by]);
        return pts;
      };
      const main = jag(x0, y0, x1, y1, 16, Math.abs(y1 - y0) * 0.09);
      const branches = [];
      for (let i = 3; i < main.length - 3; i += 3) {
        const [bx, by] = main[i];
        const dir = Math.random() < 0.5 ? -1 : 1;
        const len = 60 + Math.random() * 170;
        branches.push(jag(bx, by, bx + dir * len, by + len * 0.8, 6, 34));
      }
      this.bolts.push({ t0: this.time, main, branches });
    }

    drawBolts(ctx) {
      this.bolts = this.bolts.filter((b) => this.time - b.t0 < 0.55);
      for (const b of this.bolts) {
        const age = this.time - b.t0;
        // Bright, a quick dip, a second flare, then gone.
        const v = age < 0.08 ? 1 : age < 0.14 ? 0.35 : age < 0.24 ? 0.95 : Math.max(0, 0.6 * (1 - (age - 0.24) / 0.31));
        const trace = (pts, w, a) => {
          ctx.strokeStyle = grey(a);
          ctx.lineWidth = w;
          ctx.beginPath();
          pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
        };
        ctx.lineJoin = 'miter';
        ctx.globalCompositeOperation = 'lighter';
        trace(b.main, this.cw * 5, v * 0.3);
        trace(b.main, this.cw * 1.9, v);
        for (const br of b.branches) trace(br, this.cw * 1.1, v * 0.7);
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    setMode(mode, instant = false) {
      this.mode = mode;
      if (instant) {
        this.layout = this.layoutFor(mode);
        this.dim = this.dimTarget;
      }
    }

    get dimTarget() {
      return 1;
    }

    setScene(name, opts = {}, { instant = false, duration = 1.5 } = {}) {
      const def = SCENES[name] ? name : 'eyes';
      const entry = { name: def, opts, t0: this.time, state: null };
      if (def === 'eyes') {
        // One eye state for the whole session, so an eye that stays on screen
        // doesn't restart when the scene around it changes.
        if (instant || !this.eyeState) {
          this.eyeState = SCENES.eyes.init(opts, this.layout, rng(this.seed++));
          this.eyeT0 = this.time;
        }
        entry.state = this.eyeState;
      } else {
        const L = this.mode === 'chat' ? this.panelLayout() : this.layout;
        entry.state = SCENES[def].init ? SCENES[def].init(opts, L, rng(this.seed++)) : {};
      }
      if (!this.eyeState) {
        this.eyeState = SCENES.eyes.init({}, this.layout, rng(this.seed++));
        this.eyeT0 = this.time;
      }
      if (instant || !this.current) {
        this.current = entry;
        this.next = null;
        this.morph = null;
        return;
      }
      if (this.next) this.current = this.next;
      this.next = entry;
      this.morph = { t0: this.time, dur: this.reduced ? 0.4 : duration };
      // Decode order: mostly noise, partly a ripple out from the art's center.
      const { cols, rows } = this;
      const origin = this.mode === 'chat' ? this.panelLayout() : { ...this.layout, x: 0, y: 0 };
      const cx = (origin.x + origin.cx) / this.cw;
      const cy = (origin.y + origin.cy) / this.ch;
      const md = Math.hypot(Math.max(cx, cols - cx), Math.max(cy, rows - cy) * 2);
      const salt = Math.floor(Math.random() * 1e6);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          this.order[i] = 0.5 * hash(i + salt) + 0.5 * (Math.hypot(x - cx, (y - cy) * 2) / md);
        }
      }
    }

    get sceneName() {
      return (this.next || this.current)?.name;
    }

    renderScene(entry, canvas, ctx, buf) {
      const { sw, sh, W, H } = this;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, sw, sh);
      ctx.setTransform(sw / W, 0, 0, sh / H, 0, 0);
      try {
        const eyeT = this.time - this.eyeT0;
        if (entry.name === 'eyes') {
          SCENES.eyes.draw(ctx, this.layout, entry.state, eyeT, this.params);
        } else if (this.mode === 'chat') {
          // The painting has its own frame and the eyes stay above it.
          this.drawPanel(ctx, entry);
          SCENES.eyes.draw(ctx, this.layout, this.eyeState, eyeT, this.params);
        } else {
          SCENES[entry.name].draw(ctx, this.layout, entry.state, this.time - entry.t0, this.params);
        }
        if (this.bolts.length) this.drawBolts(ctx);
      } catch (err) {
        console.error('scene', entry.name, err);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.analyze(ctx.getImageData(0, 0, sw, sh).data, buf);
    }

    analyze(data, b) {
      const { sw, sh, cols, gray } = this;
      const n = b.L.length;
      b.L.fill(0);
      b.M.fill(0);
      b.jxx.fill(0);
      b.jyy.fill(0);
      b.jxy.fill(0);
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = data[p] * 0.00392157;
      for (let y = 0; y < sh; y++) {
        const row = (y >> 2) * cols;
        const yi = y * sw;
        const inY = y > 0 && y < sh - 1;
        for (let x = 0; x < sw; x++) {
          const c = row + (x >> 1);
          const i = yi + x;
          const v = gray[i];
          b.L[c] += v;
          if (v > b.M[c]) b.M[c] = v;
          if (inY && x > 0 && x < sw - 1) {
            const gx = gray[i + 1] - gray[i - 1];
            const gy = gray[i + sw] - gray[i - sw];
            b.jxx[c] += gx * gx;
            b.jyy[c] += gy * gy;
            b.jxy[c] += gx * gy;
          }
        }
      }
      for (let c = 0; c < n; c++) {
        b.L[c] *= 0.125;
        const a = b.jxx[c];
        const d = b.jyy[c];
        const e = b.jxy[c];
        const sum = a + d;
        b.E[c] = Math.sqrt(sum * 0.125);
        if (sum < 1e-6) {
          b.O[c] = 255;
          continue;
        }
        const coh = Math.sqrt((a - d) * (a - d) + 4 * e * e) / sum;
        if (coh < 0.5) {
          b.O[c] = 255;
          continue;
        }
        // Dominant gradient orientation; the edge runs perpendicular to it.
        const th = 0.5 * Math.atan2(2 * e, a - d);
        const deg = ((th * 180) / Math.PI + 180) % 180;
        b.O[c] = deg < 22.5 || deg >= 157.5 ? 0 : deg < 67.5 ? 1 : deg < 112.5 ? 2 : 3;
      }
    }

    // Glyph and brightness for one cell of an analyzed buffer, written to
    // this.gi / this.gv (no per-cell allocation in the hot loop).
    glyph(b, c) {
      const L = b.L[c];
      const E = b.E[c];
      if (b.O[c] !== 255 && E > 0.27 && b.M[c] > 0.14) {
        this.gi = EDGE_I[b.O[c]];
        this.gv = clamp(Math.max(L * 1.15, 0.3 + E * 0.75), 0, 1);
        return;
      }
      if (L < 0.028) {
        this.gi = -1;
        return;
      }
      let idx = Math.round(Math.pow(L, 0.85) * (RAMP_I.length - 1));
      if (idx < 1) idx = 1;
      // A little shimmer so still scenes breathe.
      if (hash(c * 977 + (this.frame >> 3)) < 0.02) idx = clamp(idx + (hash(c + this.frame) < 0.5 ? -1 : 1), 1, RAMP_I.length - 1);
      this.gi = RAMP_I[idx];
      this.gv = L;
    }

    draw() {
      const { ctx, cols, rows, cw, ch, dpr, gw, gh, atlas } = this;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#040302';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.current) return;
      // Finish a scene change before rendering, so its last frame already shows
      // the new scene instead of one more frame of the old one.
      let p = -1;
      if (this.morph) {
        p = ((this.time - this.morph.t0) / this.morph.dur) * 1.3;
        if (p >= 1.3) {
          this.current = this.next;
          this.next = null;
          this.morph = null;
          p = -1;
        }
      }
      this.renderScene(this.current, this.sA, this.xA, this.A);
      if (this.morph) this.renderScene(this.next, this.sB, this.xB, this.B);
      const band = 0.22;
      const n = cols * rows;
      // Only the painting decodes when a scene changes. The eyes are the same in
      // both scenes, so they skip the glitch.
      const chat = this.mode === 'chat';
      const art = this.artRect;
      const ax0 = chat ? Math.floor(art.x / cw) : 0;
      const ax1 = chat ? Math.ceil((art.x + art.W) / cw) : cols;
      const ay0 = chat ? Math.floor(art.y / ch) : 0;
      // Behind the text on narrow screens, the painting stays dim.
      const artDim = chat && !this.sideMode ? 0.3 : 1.12;
      const eye = this.eyeRect;
      const ex0 = eye.x / cw;
      const ex1 = (eye.x + eye.W) / cw;
      const ey0 = eye.y / ch;
      const ey1 = (eye.y + eye.H) / ch;
      this.hoverL += ((this.hover === 'left' ? 1 : 0) - this.hoverL) * 0.2;
      this.hoverR += ((this.hover === 'right' ? 1 : 0) - this.hoverR) * 0.2;
      for (let c = 0; c < n; c++) {
        const x = c % cols;
        const y = (c / cols) | 0;
        const inArt = x >= ax0 && x < ax1 && y >= ay0;
        if (p < 0 || !inArt) this.glyph(this.A, c);
        else {
          const o = this.order[c];
          if (p < o) this.glyph(this.A, c);
          else if (p > o + band) this.glyph(this.B, c);
          else {
            const m = Math.max(this.A.L[c], this.B.L[c]);
            const r = hash(c * 31 + this.frame);
            if (m < 0.03 && r > 0.12) continue;
            this.gi = GLITCH_I[Math.floor(r * GLITCH_I.length)];
            this.gv = 0.5 + 0.5 * Math.min(1, m * 1.5);
          }
        }
        const g = this.gi;
        if (g < 0) continue;
        const inEyes = x >= ex0 && x < ex1 && y >= ey0 && y < ey1;
        // Hovering the art or the eyes lifts them.
        const lift = inEyes ? 1 + 0.4 * this.hoverR : chat && inArt ? artDim * (1 + 0.4 * this.hoverL) : 1;
        const lv = clamp(Math.round(this.gv * this.dim * lift * (LEVELS - 1)), 1, LEVELS - 1);
        ctx.drawImage(atlas, g * gw, lv * gh, gw, gh, Math.round(x * cw * dpr), Math.round(y * ch * dpr), gw, gh);
      }
      // A golem wakes with the word for truth on its forehead. Karyon's is here,
      // between the eyes, faint enough that almost nobody will find it.
      if ((this.params.eyeFade ?? 1) > 0.5 && this.eyeState?.open > 0.5) {
        const r = Math.round((this.layout.cy - this.layout.eyeW * 0.16) / ch);
        const c0 = Math.round(this.layout.cx / cw) - 2;
        [...'emet'].forEach((letter, k) => {
          ctx.drawImage(atlas, CI[letter] * gw, 1 * gh, gw, gh, Math.round((c0 + k) * cw * dpr), Math.round(r * ch * dpr), gw, gh);
        });
      }
      if (this.gctx) {
        this.gctx.clearRect(0, 0, this.glowCanvas.width, this.glowCanvas.height);
        this.gctx.drawImage(this.canvas, 0, 0, this.glowCanvas.width, this.glowCanvas.height);
      }
    }

    step(dt) {
      this.time += dt;
      this.frame++;
      const target = this.layoutFor(this.mode);
      const k = this.reduced ? 1 : 1 - Math.exp(-dt * 3);
      for (const key of ['cx', 'cy', 'size', 'eyeDX', 'eyeW', 'wing', 'lookX']) this.layout[key] = lerp(this.layout[key], target[key], k);
      Object.assign(this.layout, { W: this.W, H: this.H, cw: this.cw, ch: this.ch });
      this.dim = lerp(this.dim, this.dimTarget, k);
      if (this.onStep) this.onStep(this.time, dt);
      this.draw();
    }

    start() {
      let last = performance.now();
      const loop = (now) => {
        requestAnimationFrame(loop);
        if (this.paused) {
          last = now;
          return;
        }
        const minGap = 1000 / this.fps - 2;
        if (now - last < minGap) return;
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        this.step(this.reduced ? dt * 0.35 : dt);
      };
      requestAnimationFrame(loop);
    }
  }

  window.KaryonASCII = { Engine, SCENES: Object.keys(SCENES) };
})();
