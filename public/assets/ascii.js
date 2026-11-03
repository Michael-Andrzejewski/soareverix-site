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
  const CHARS = [...new Set((RAMP + GLITCH + EDGE.join('') + '_').split(''))];
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
  function drawEye(g, x0, y0, ew, o, side, gx, gy, think, t, cw, open01) {
    const half = ew / 2;
    const xo = x0 + side * half;
    const xi = x0 - side * half;
    const yo = y0 - ew * 0.07;
    const yi = y0 + ew * 0.05;
    const up = ew * 0.36 * o;
    const lo = ew * 0.22 * o;
    const upper = () => {
      g.moveTo(xi, yi);
      g.bezierCurveTo(lerp(xi, xo, 0.26), y0 - up, lerp(xi, xo, 0.7), y0 - up * 0.98, xo, yo);
    };
    const lower = () => {
      g.moveTo(xo, yo);
      g.bezierCurveTo(lerp(xi, xo, 0.72), y0 + lo, lerp(xi, xo, 0.28), y0 + lo * 1.04, xi, yi);
    };
    g.globalCompositeOperation = 'lighter';
    // Wings: long tapered strokes streaming out from the outer corner.
    for (let k = 0; k < 5; k++) {
      const len = ew * (0.55 + k * 0.16);
      const dy = (k - 2) * ew * 0.03;
      fadeLine(g, xo - side * ew * 0.03, yo + dy * 0.35, xo + side * len, yo + dy * 1.4 + ew * 0.01, 0.42 - Math.abs(k - 2) * 0.07, 0, cw * 0.42);
    }
    // A shorter pair from the inner corner.
    fadeLine(g, xi + side * ew * 0.01, yi, xi - side * ew * 0.16, yi + ew * 0.02, 0.4, 0, cw * 0.4);
    // Brow arc.
    g.strokeStyle = grey(0.14);
    g.lineWidth = cw * 0.45;
    g.beginPath();
    g.moveTo(lerp(xi, xo, 0.04), y0 - ew * 0.2 - up * 0.65);
    g.quadraticCurveTo(lerp(xi, xo, 0.45), y0 - ew * 0.34 - up * 0.95, xo + side * ew * 0.12, yo - ew * 0.16 - up * 0.3);
    g.stroke();

    if (o > 0.03) {
      g.save();
      g.beginPath();
      upper();
      g.bezierCurveTo(lerp(xi, xo, 0.72), y0 + lo, lerp(xi, xo, 0.28), y0 + lo * 1.04, xi, yi);
      g.closePath();
      g.clip();
      g.globalCompositeOperation = 'source-over';
      const ix = x0 - side * ew * 0.04 + gx * ew * 0.15;
      const iy = y0 + ew * 0.02 + gy * ew * 0.05;
      const ri = ew * 0.16;
      // Sclera, darker toward the corners.
      const sc = g.createRadialGradient(ix, iy, ri * 0.8, ix, iy, half * 1.05);
      sc.addColorStop(0, grey(0.46));
      sc.addColorStop(1, grey(0.2));
      g.fillStyle = sc;
      g.fillRect(x0 - half - 4, y0 - up - 4, ew + 8, up + lo + 8);
      // Iris.
      const ir = g.createRadialGradient(ix, iy, ri * 0.25, ix, iy, ri);
      ir.addColorStop(0, grey(1));
      ir.addColorStop(0.45, grey(0.86 + think * 0.14));
      ir.addColorStop(0.8, grey(0.62));
      ir.addColorStop(1, grey(0.34));
      disc(g, ix, iy, ri, ir);
      // Striations.
      g.strokeStyle = 'rgba(0,0,0,0.42)';
      g.lineWidth = cw * 0.32;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * TAU + t * 0.05 * (think ? 3 : 1);
        const r0 = ri * (0.5 + 0.06 * Math.sin(k * 3.1));
        g.beginPath();
        g.moveTo(ix + Math.cos(a) * r0, iy + Math.sin(a) * r0);
        g.lineTo(ix + Math.cos(a + 0.12) * ri * 0.93, iy + Math.sin(a + 0.12) * ri * 0.93);
        g.stroke();
      }
      // Limbal ring.
      g.strokeStyle = grey(0.95);
      g.lineWidth = cw * 0.65;
      g.beginPath();
      g.arc(ix, iy, ri, 0, TAU);
      g.stroke();
      // Pupil, which becomes a small turning gear while Karyon thinks.
      const rp = ri * (0.42 - 0.08 * think);
      disc(g, ix, iy, rp, '#000');
      if (think > 0.02) {
        g.strokeStyle = grey(0.9 * think);
        g.lineWidth = cw * 0.45;
        const teeth = 9;
        g.beginPath();
        for (let k = 0; k <= teeth * 2; k++) {
          const a = (k / (teeth * 2)) * TAU + t * 1.6 * side;
          const r = k % 2 ? rp * 0.62 : rp * 0.8;
          const px = ix + Math.cos(a) * r;
          const py = iy + Math.sin(a) * r;
          if (k === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.stroke();
        disc(g, ix, iy, rp * 0.22, grey(0.9 * think));
      }
      // Highlights.
      disc(g, ix - ri * 0.36, iy - ri * 0.36, ri * 0.18, grey(1));
      disc(g, ix + ri * 0.3, iy + ri * 0.28, ri * 0.07, grey(0.95));
      // Shadow under the upper lid.
      const sh = g.createLinearGradient(0, y0 - up, 0, y0 - up * 0.25);
      sh.addColorStop(0, 'rgba(0,0,0,0.75)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sh;
      g.fillRect(x0 - half - 4, y0 - up - 4, ew + 8, up);
      g.restore();
    }

    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.strokeStyle = grey(0.95);
    g.lineWidth = cw * 0.75;
    g.beginPath();
    upper();
    g.stroke();
    g.strokeStyle = grey(0.55);
    g.lineWidth = cw * 0.55;
    g.beginPath();
    lower();
    g.stroke();
    // Crease above the lid.
    g.strokeStyle = grey(0.3);
    g.lineWidth = cw * 0.45;
    g.beginPath();
    g.moveTo(lerp(xi, xo, 0.12), y0 - up * 0.9 - ew * 0.05);
    g.bezierCurveTo(lerp(xi, xo, 0.35), y0 - up * 1.2 - ew * 0.07, lerp(xi, xo, 0.7), y0 - up * 1.15 - ew * 0.07, lerp(xi, xo, 0.92), yo - up * 0.5 - ew * 0.04);
    g.stroke();
    // Lashes along the upper lid.
    if (open01 > 0.15) {
      g.strokeStyle = grey(0.42);
      g.lineWidth = cw * 0.38;
      for (let k = 0; k < 8; k++) {
        const u = 0.45 + k * 0.075;
        const px = lerp(xi, xo, u);
        const py = y0 - up * (1 - Math.pow(u * 2 - 1, 2)) * 0.74 - (yi - yo) * 0;
        const len = ew * 0.06 * open01 * (0.6 + u * 0.6);
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + side * len * 0.7, py - len);
        g.stroke();
      }
    }
    g.lineCap = 'butt';
  }

  SCENES.eyes = {
    init: (opts, L, r) => ({ open: 0, blinkAt: 2 + r() * 3, blinkStart: -9, gx: 0, gy: 0, r }),
    draw(g, L, s, t, P) {
      const S = L.size;
      const ew = S * 0.4;
      const target = P.eyeOpen ?? 1;
      s.open += (target - s.open) * (P.eyeSnap ? 1 : 0.16);
      if (t > s.blinkAt && target > 0.9) {
        s.blinkStart = t;
        s.blinkAt = t + 3 + s.r() * 5;
      }
      const bt = (t - s.blinkStart) / 0.2;
      const blink = bt >= 0 && bt < 1 ? Math.sin(bt * Math.PI) : 0;
      const o = clamp(s.open * (1 - blink * 0.96), 0, 1.08);
      s.gx += ((P.gazeX || 0) - s.gx) * 0.07;
      s.gy += ((P.gazeY || 0) - s.gy) * 0.07;
      const think = P.thinking || 0;
      g.globalAlpha = P.eyeFade ?? 1;
      drawEye(g, L.cx - S * 0.265, L.cy, ew, o, -1, s.gx, s.gy, think, t, L.cw, s.open);
      drawEye(g, L.cx + S * 0.265, L.cy, ew, o, 1, s.gx, s.gy, think, t, L.cw, s.open);
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
        if (s.failed) SCENES.eyes.draw(g, L, (s.fallback ||= SCENES.eyes.init({}, L, rng(1))), t, { eyeOpen: 1 });
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
      this.params = { eyeOpen: 1, gazeX: 0, gazeY: 0, thinking: 0 };
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
      const W = window.innerWidth;
      const H = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const probe = this.ctx;
      probe.font = '100px "JetBrains Mono", "IBM Plex Mono", Menlo, Consolas, monospace';
      const ratio = probe.measureText('M').width / 100 || 0.6;
      const cols = clamp(Math.round(W / (W < 700 ? 5.6 : 8.6)), 60, 240);
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

    layoutFor(mode) {
      const { W, H, cw, ch } = this;
      const narrow = W < 700;
      // In chat mode the art lives above the transcript, which starts near
      // 45% of the height (36% on phones).
      if (mode === 'chat') {
        return narrow
          ? { W, H, cw, ch, cx: W / 2, cy: H * 0.18, size: Math.min(W * 1.0, H * 0.42) }
          : { W, H, cw, ch, cx: W / 2, cy: H * 0.24, size: Math.min(W * 0.8, H * 0.72) };
      }
      // Hero: the eyes sit exactly where they are in the Era of Intelligence
      // video as it is letterboxed on this screen (eye centers at 28% and 72%
      // of the frame width, lids centered 46% down), so the cut back to them
      // lines up. y0 sits a little lower because the upper lid arcs higher.
      const vw = Math.min(W, (H * 16) / 9);
      const vh = (vw * 9) / 16;
      return { W, H, cw, ch, cx: W / 2, cy: (H - vh) / 2 + vh * 0.49, size: vw * 0.815 };
    }

    setMode(mode, instant = false) {
      this.mode = mode;
      if (instant) this.layout = this.layoutFor(mode);
    }

    setScene(name, opts = {}, { instant = false, duration = 1.5 } = {}) {
      const def = SCENES[name] ? name : 'eyes';
      const entry = { name: def, opts, t0: this.time, state: null };
      entry.state = SCENES[def].init ? SCENES[def].init(opts, this.layout, rng(this.seed++)) : {};
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
      const cx = this.layout.cx / this.cw;
      const cy = this.layout.cy / this.ch;
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
        SCENES[entry.name].draw(ctx, this.layout, entry.state, this.time - entry.t0, this.params);
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
      if (b.O[c] !== 255 && E > 0.16 && b.M[c] > 0.14) {
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
      this.renderScene(this.current, this.sA, this.xA, this.A);
      let p = -1;
      if (this.morph) {
        this.renderScene(this.next, this.sB, this.xB, this.B);
        p = ((this.time - this.morph.t0) / this.morph.dur) * 1.3;
        if (p >= 1.3) {
          this.current = this.next;
          this.next = null;
          this.morph = null;
          p = -1;
        }
      }
      const band = 0.22;
      const dim = this.dim;
      const n = cols * rows;
      for (let c = 0; c < n; c++) {
        if (p < 0) this.glyph(this.A, c);
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
        const lv = clamp(Math.round(this.gv * dim * (LEVELS - 1)), 1, LEVELS - 1);
        const x = c % cols;
        const y = (c / cols) | 0;
        ctx.drawImage(atlas, g * gw, lv * gh, gw, gh, Math.round(x * cw * dpr), Math.round(y * ch * dpr), gw, gh);
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
      for (const key of ['cx', 'cy', 'size']) this.layout[key] = lerp(this.layout[key], target[key], k);
      Object.assign(this.layout, { W: this.W, H: this.H, cw: this.cw, ch: this.ch });
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
