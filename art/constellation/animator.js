/* animator.js: plays a layered scene (window.SCENE) on a canvas. WebGL2 with a Canvas2D fallback.
 *
 * Everything is a pure function of time t (seconds), so any frame can be
 * rendered on demand (render(t)) and the loop is seamless when every particle
 * life and every wave frequency divides scene.loop.
 *
 * Scene format (built by artkit.py):
 *   { width, height, loop, wind?, layers: [ ... ] }
 * wind  { T, G: [n samples of gust strength over one loop], F: [running integral of G], FT,
 *         gmin, gmax, dir: [dx, dy], front: px/s, sweep: 'right'|'up', ground }
 *       Gust fronts travel at `front` px/s, left to right (sweep 'right') or rising from y =
 *       ground (sweep 'up', an updraft). A particle with susceptibility wd is pushed by
 *       wd * (F(now) - F(birth)) along dir, so gusts bend paths and the loop stays exact.
 * Layer types:
 *   image      { src, blend?, alpha?: Anim, x?, y?, w?, h? }
 *   particles  { shape: 'diamond'|'square'|'circle'|'glow', blend?, alpha?: Anim, grow?: bool, items: [P] }
 *              grow: born by growing from a point, die by shrinking (sh), short alpha fades at the ends.
 *              bend: { amp, yBot, H, cup } sways the whole layer with the gusts like a plume rooted
 *              at yBot: offset amp * h^1.6 * (G - gmin) along wind.dir.x, h = height above yBot / H,
 *              the gust reaching height h after (yBot - y) / cup seconds.
 *              waver: { amp, k, wl, yBot, H } ripples rising up the layer like a flame or smoke
 *              column: x offset amp * h * sin(2pi (k t/loop + y/wl)), k waves per loop.
 *              stretch: draw each particle stretch times taller than wide (motion streaks).
 *   path       { points: [[x,y]...], shape, blend?, alpha?: Anim, fade: [fi, fo], items: [{k, p, r, c, a}] }
 *   vortex     { src: canvas image, texC: [x, y] canvas px of the swirl centre, up: canvas px per scene px,
 *                vignette?, ca?, gain? (exposure lift at full zoom) }   the whole frame, swirled and zoomed by scene.camera (WebGL shader with
 *                rotational + zoom motion blur; Canvas2D fallback rotates rigidly)
 *   orbit      { shape, blend?, camera?, parallax?, core: [r0, r1], items: [O] }  particles spiralling
 *                around the camera centre with the swirl; drawn as streaks along their motion
 *   reveal     { src: RGBA image, act: RGB image, x, y, w, h, soft, front?: { c: [r,g,b], w, gain }, camera?, parallax? }
 *                an image that appears pixel by pixel as the growth G(t) passes each pixel's activation
 *                level (16 bit, R = high byte, G = low byte, sampled NEAREST): visible once G >= act,
 *                fully after act + soft. The front (G ~ act) glows with front.c, decaying over front.w
 *                (only where the image is nearly opaque, so line cores glow and their noisy fringes do not).
 *                Canvas2D fallback: the whole image fades with G.
 *   nodes      { shape, blend?, camera?, parallax?, pulse: [w0, w1], decay?: 'gauss'|'exp', base?, soft?,
 *                swell?, items: [N] }  sprites that flash as G passes their activation g:
 *                alpha a * (pulse((G - g)) + base * smooth(0, soft, G - g)), pulse rising over w0 and
 *                falling over w1. Sparks along a line with spaced g give a comet running down the line.
 * Any image / particles / orbit layer with camera: true is zoomed and rolled with the camera;
 * parallax p uses zoom^p (p > 1 feels closer to the lens).
 * grow   { hold: [h0, h1], ease?: 3|5 }  the growth driver G(t): a triangle wave over the loop (0 at the loop
 *        point, 1 at mid-loop) through smoothstep (ease 3) or smootherstep (5, default), held at 0 for h0
 *        and at 1 for h1 (fractions of half a loop). Smootherstep lingers longer near 0 and 1.
 * camera { drive: 'grow', cx, cy, zmax, log?, hold?: [h0, h1], ease?, roll? }  pull-back camera: zoom I(t) = 1 - P(t),
 *        P a growth curve with the camera's own holds; Z = zmax^I (log: true, even speed) or 1 + (zmax-1) I,
 *        about the fixed point (cx, cy); roll * I(t) radians of tilt while close.
 * camera { cx, cy, zmax, revs, omega0, twist, r0, roll, shutter }  (one zoom in + out per loop)
 *        zoom Z = 1 + (zmax-1) I(t), I = 0.5 - 0.5 cos(2 pi t / loop): 1 at the loop point, zmax mid-loop.
 *        swirl angle A(t) = integral of omega0 + omega1 I, omega1 chosen so A(loop) = 2 pi revs, so the
 *        vortex turns `revs` whole times per loop and spins fastest while zoomed in. Inner rings get an
 *        extra twist * I(t) * exp(-r / r0): the vortex tightens on the way in and relaxes on the way out.
 * O     { r, th, l, p, c, a, m: swirl multiplier, w: extra rad/s, k: inward rate 1/s, sz, st: streak, fi, fo }
 * Anim  { base, amp, k, p, wave: 'sin01'|'beat'|'sin'|'wind'|'rest'|'zoom'|'grow'|'growrate' }   value = base + amp * wave(k*t/loop + p)
 *       'zoom' is the camera's zoom progress I(t), 0 at the loop point and 1 at full zoom (for the
 *       swirl camera; for drive 'grow' it is 1 at the loop point and 0 when fully pulled back).
 *       'grow' is G(t); 'growrate' is |dG/dt| scaled to peak at 1 (busy while the network grows).
 *       'wind' is the normalised gust strength at time t (ignores k and p).
 *       'rest' is 1 within `hold` s of the loop point, easing to 0 over the next `fade` s, on
 *       both sides. Put the untouched source on top with it and every loop passes exactly
 *       through the original picture: the scene wakes from the still and settles back into it.
 * P     { x, y, r, c:[r,g,b], a, l: life, p: phase, vx, vy, ay, fi, fo, sh, gr, sw, swc, swp,
 *         tw, twk, twp, wd, wt, spin, wr, ang }
 * N     { x, y, r, c:[r,g,b], a, g: activation, tw?, twk?, twp? }
 */
(function () {
  const TAU = Math.PI * 2;
  const frac = (v) => v - Math.floor(v);
  const smooth = (e0, e1, x) => {
    if (e1 === e0) return x < e0 ? 0 : 1;
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const WAVES = {
    sin01: (x) => 0.5 - 0.5 * Math.cos(TAU * x),
    sin: (x) => Math.sin(TAU * x),
    // two-beat pulse ("lub-dub"), peak ~1, rests at 0
    beat: (x) => Math.exp(-(((x - 0.06) / 0.045) ** 2)) + 0.55 * Math.exp(-(((x - 0.24) / 0.06) ** 2)),
  };
  const SHAPES = { diamond: 0, square: 1, circle: 2, glow: 3 };

  function makeWind(w) {
    if (!w) return null;
    const n = w.G.length, T = w.T, dt = T / n, G = w.G, F = w.F, FT = w.FT;
    const gmin = w.gmin, gspan = w.gmax - w.gmin || 1;
    const wind = {
      dir: w.dir,
      front: w.front,
      gmin,
      delay(x, y) {
        return w.sweep === 'up' ? ((w.ground || 0) - y) / w.front : x / w.front;
      },
      G(t) {
        const x = frac(t / T) * n, i = Math.floor(x), f = x - i;
        return G[i % n] * (1 - f) + G[(i + 1) % n] * f;
      },
      Gn(t) {
        return (wind.G(t) - gmin) / gspan;
      },
      F(t) {
        const k = Math.floor(t / T), x = (t - k * T) / dt, i = Math.floor(x), f = x - i;
        const a = i < n ? F[i] : FT, b = i + 1 < n ? F[i + 1] : FT;
        return k * FT + a * (1 - f) + b * f;
      },
    };
    return wind;
  }

  // triangle wave over the loop through smoothstep or smootherstep, with holds at both ends
  function makeGrow(g, loop) {
    const h0 = (g && g.hold && g.hold[0]) || 0, h1 = (g && g.hold && g.hold[1]) || 0, span = 1 - h0 - h1;
    const cubic = g && g.ease === 3;  // smoothstep: more time in motion than smootherstep
    const ss = cubic ? (x) => x * x * (3 - 2 * x) : (x) => x * x * x * (x * (6 * x - 15) + 10);
    const ds = cubic ? (x) => 6 * x * (1 - x) : (x) => 30 * x * x * (1 - x) * (1 - x);
    const peak = cubic ? 1.5 : 1.875;
    const pos = (t) => {
      const u = frac(t / loop);
      return { x: (1 - Math.abs(2 * u - 1) - h0) / span, dir: u < 0.5 ? 1 : -1 };
    };
    return {
      v(t) {
        const x = pos(t).x;
        return x <= 0 ? 0 : x >= 1 ? 1 : ss(x);
      },
      d(t) {  // dG/dt
        const p = pos(t);
        return p.x <= 0 || p.x >= 1 ? 0 : (ds(p.x) * p.dir * 2) / (span * loop);
      },
      rate(t) {  // |dG/dt| / its peak
        const x = pos(t).x;
        return x <= 0 || x >= 1 ? 0 : ds(x) / peak;
      },
    };
  }

  function makeCamera(c, loop) {
    if (!c) return null;
    if (c.drive === 'grow') {
      const P = makeGrow({ hold: c.hold, ease: c.ease }, loop), zmax = c.zmax || 1, lz = Math.log(zmax);
      const I = (t) => 1 - P.v(t);
      const zoom = (t) => (c.log ? Math.exp(lz * I(t)) : 1 + (zmax - 1) * I(t));
      return {
        cx: c.cx, cy: c.cy, shutter: 0, r0: 100,
        I,
        zoom,
        zoomRate: (t) => -P.d(t) * (c.log ? zoom(t) * lz : zmax - 1),
        A: () => 0, Arate: () => 0, twist: () => 0, twistRate: () => 0,
        roll: (t) => (c.roll || 0) * I(t),
        xf(t, parallax) {
          const Z = Math.pow(this.zoom(t), parallax || 1), rl = this.roll(t);
          const a = Z * Math.cos(rl), b = -Z * Math.sin(rl), cc = Z * Math.sin(rl), d = Z * Math.cos(rl);
          return [a, b, cc, d, c.cx - (a * c.cx + b * c.cy), c.cy - (cc * c.cx + d * c.cy), Z, rl];
        },
      };
    }
    const T = loop, w = TAU / T, O0 = c.omega0 || 0;
    const O1 = ((TAU * (c.revs || 0) - O0 * T) * 2) / T;
    const I = (t) => 0.5 - 0.5 * Math.cos(w * t);
    const Ip = (t) => 0.5 * w * Math.sin(w * t);
    const zmax = c.zmax || 1;
    return {
      cx: c.cx, cy: c.cy, shutter: c.shutter || 0, r0: c.r0 || 100,
      I,
      zoom: (t) => 1 + (zmax - 1) * I(t),
      zoomRate: (t) => (zmax - 1) * Ip(t),
      A: (t) => O0 * t + O1 * (t / 2 - Math.sin(w * t) / (2 * w)),
      Arate: (t) => O0 + O1 * I(t),
      twist: (t) => (c.twist || 0) * I(t),
      twistRate: (t) => (c.twist || 0) * Ip(t),
      roll: (t) => (c.roll || 0) * Math.sin(w * t),
      // world -> screen affine for a layer: [a, b, c, d, tx, ty]
      xf(t, parallax) {
        const Z = Math.pow(this.zoom(t), parallax || 1), rl = this.roll(t);
        const a = Z * Math.cos(rl), b = -Z * Math.sin(rl), cc = Z * Math.sin(rl), d = Z * Math.cos(rl);
        return [a, b, cc, d, c.cx - (a * c.cx + b * c.cy), c.cy - (cc * c.cx + d * c.cy), Z, rl];
      },
    };
  }

  function anim(spec, t, loop, wind, cam, grow) {
    if (spec == null) return 1;
    if (typeof spec === 'number') return spec;
    if (spec.wave === 'zoom') return (spec.base || 0) + (spec.amp || 0) * (cam ? cam.I(t) : 0);
    if (spec.wave === 'grow') return (spec.base || 0) + (spec.amp || 0) * grow.v(t);
    if (spec.wave === 'growrate') return (spec.base || 0) + (spec.amp || 0) * grow.rate(t);
    if (spec.wave === 'wind') return (spec.base || 0) + (spec.amp || 0) * (wind ? wind.Gn(t) : 0);
    if (spec.wave === 'rest') {
      const d = Math.min(t, loop - t), h = spec.hold || 0;
      return 1 - smooth(h, h + (spec.fade || 1), d);
    }
    const w = WAVES[spec.wave || 'sin01'];
    return (spec.base || 0) + (spec.amp || 0) * w(frac(((spec.k || 1) * t) / loop + (spec.p || 0)));
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = src;
    });
  }

  function pathTable(points) {
    const seg = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      const len = Math.hypot(x1 - x0, y1 - y0);
      seg.push({ x0, y0, x1, y1, s0: total, len });
      total += len;
    }
    return { seg, total };
  }
  function pointAt(tab, u) {
    const d = u * tab.total;
    for (const s of tab.seg) {
      if (d <= s.s0 + s.len) {
        const f = s.len ? (d - s.s0) / s.len : 0;
        return [s.x0 + (s.x1 - s.x0) * f, s.y0 + (s.y1 - s.y0) * f];
      }
    }
    const last = tab.seg[tab.seg.length - 1];
    return [last.x1, last.y1];
  }

  // ------------------------------------------------------------------ renderers
  function glRenderer(canvas, scene, scale, preserve) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: !!preserve });
    if (!gl) return null;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    };
    const pP = program(`#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aGeom;
layout(location=2) in vec2 aAng;
layout(location=3) in vec4 aCol;
uniform vec2 uScene; uniform float uPx;
out vec2 vLocal; out vec2 vR; out vec4 vCol; flat out int vShape;
void main(){
  int shape = int(aAng.y + 0.5);
  vec2 ext = aGeom.zw + (shape == 3 ? 0.0 : 1.0 / uPx);
  vec2 lp = aCorner * ext;
  float c = cos(aAng.x), s = sin(aAng.x);
  vec2 wp = aGeom.xy + vec2(c * lp.x - s * lp.y, s * lp.x + c * lp.y);
  vLocal = lp; vR = aGeom.zw; vCol = aCol; vShape = shape;
  gl_Position = vec4(wp.x / uScene.x * 2.0 - 1.0, 1.0 - wp.y / uScene.y * 2.0, 0.0, 1.0);
}`, `#version 300 es
precision highp float;
in vec2 vLocal; in vec2 vR; in vec4 vCol; flat in int vShape;
uniform float uPx;
out vec4 o;
float boxcov(float p, float r){ return clamp(min(r, p + 0.5) - max(-r, p - 0.5), 0.0, 1.0); }
void main(){
  float cov;
  vec2 P = vLocal * uPx, R = vR * uPx;
  if (vShape == 3) {
    float q = length(vLocal / vR);
    cov = q < 0.35 ? mix(1.0, 0.45, q / 0.35) : mix(0.45, 0.0, clamp((q - 0.35) / 0.65, 0.0, 1.0));
  } else if (vShape == 1) {
    cov = boxcov(P.x, R.x) * boxcov(P.y, R.y);
  } else if (vShape == 0) {
    float d = (abs(P.x) + abs(P.y) - R.x) * 0.70710678;
    cov = clamp(0.5 - d, 0.0, 1.0) * min(1.0, 4.0 * R.x * R.x);
  } else {
    float d = length(P) - R.x;
    cov = clamp(0.5 - d, 0.0, 1.0) * min(1.0, 4.0 * R.x * R.x);
  }
  float a = vCol.a * cov;
  if (a <= 0.0) discard;
  o = vec4(vCol.rgb * a, a);
}`);
    const pI = program(`#version 300 es
layout(location=0) in vec2 aCorner;
uniform vec4 uRect; uniform vec2 uScene; uniform vec4 uXf; uniform vec2 uXt;
out vec2 vUV;
void main(){
  vec2 wp = uRect.xy + aCorner * uRect.zw;
  wp = vec2(uXf.x * wp.x + uXf.y * wp.y, uXf.z * wp.x + uXf.w * wp.y) + uXt;
  vUV = aCorner;
  gl_Position = vec4(wp.x / uScene.x * 2.0 - 1.0, 1.0 - wp.y / uScene.y * 2.0, 0.0, 1.0);
}`, `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uTex; uniform float uAlpha; out vec4 o;
void main(){ o = texture(uTex, vUV) * uAlpha; }`);
    const pR = program(`#version 300 es
layout(location=0) in vec2 aCorner;
uniform vec4 uRect; uniform vec2 uScene; uniform vec4 uXf; uniform vec2 uXt;
out vec2 vUV;
void main(){
  vec2 wp = uRect.xy + aCorner * uRect.zw;
  wp = vec2(uXf.x * wp.x + uXf.y * wp.y, uXf.z * wp.x + uXf.w * wp.y) + uXt;
  vUV = aCorner;
  gl_Position = vec4(wp.x / uScene.x * 2.0 - 1.0, 1.0 - wp.y / uScene.y * 2.0, 0.0, 1.0);
}`, `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uTex, uAct; uniform float uAlpha, uG, uSoft, uFw, uFg; uniform vec3 uFc;
out vec4 o;
void main(){
  vec4 c = texture(uTex, vUV);
  vec3 q = texture(uAct, vUV).rgb;
  float x = uG - (q.r * 65280.0 + q.g * 255.0) / 65535.0;
  float vis = smoothstep(0.0, uSoft, x);
  float e = x >= 0.0 ? exp(-x / uFw) : exp(-x * x / (uFw * uFw * 0.04));
  // the glow follows the line cores only: faint fringe alpha is noisy, and the glow would amplify it
  o = (c * vis + vec4(uFc * (smoothstep(0.55, 0.95, c.a) * e * uFg), 0.0)) * uAlpha;
}`);
    const pV = program(`#version 300 es
layout(location=0) in vec2 aCorner;
uniform vec2 uScene;
out vec2 vP;
void main(){ vP = aCorner * uScene; gl_Position = vec4(aCorner.x * 2.0 - 1.0, 1.0 - aCorner.y * 2.0, 0.0, 1.0); }`, `#version 300 es
precision highp float;
in vec2 vP; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexSize, uTexC, uC, uScene; uniform float uUp;
uniform float uZoom, uRoll, uRot, uTwist, uR0, uArc, uArcTw, uZb, uCa, uVig, uExp;
vec3 samp(float r, float a){ return texture(uTex, (uTexC + uUp * r * vec2(cos(a), sin(a))) / uTexSize).rgb; }
void main(){
  vec2 d = (vP - uC) / uZoom;
  float cr = cos(uRoll), sr = sin(uRoll);
  d = vec2(cr * d.x + sr * d.y, -sr * d.x + cr * d.y);
  float r = length(d), th = atan(d.y, d.x);
  float tw = exp(-r / uR0);
  float base = th - (uRot + uTwist * tw);
  float arc = uArc + uArcTw * tw;
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = 0; i < 16; i++) {
    float f = float(i) / 15.0, w = 1.0 - 0.6 * f;
    acc += samp(r * (1.0 + uZb * f), base + arc * f) * w; ws += w;
  }
  vec3 col = acc / ws;
  float ca = uCa * length(vP - uC) / uScene.y;
  col.r = mix(col.r, samp(r * (1.0 + ca), base).r, 0.6);
  col.b = mix(col.b, samp(r * (1.0 - ca), base).b, 0.6);
  vec2 q = (vP / uScene - 0.5) * 2.0;
  col *= uExp * (1.0 - uVig * smoothstep(0.45, 1.5, length(q)));
  o = vec4(col, 1.0);
}`);

    const quad = (pts) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
      return b;
    };
    const unitQuad = quad([0, 0, 1, 0, 0, 1, 1, 1]);
    const centeredQuad = quad([-1, -1, 1, -1, -1, 1, 1, 1]);
    const vaoI = gl.createVertexArray();
    gl.bindVertexArray(vaoI);
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const vaoP = gl.createVertexArray();
    gl.bindVertexArray(vaoP);
    gl.bindBuffer(gl.ARRAY_BUFFER, centeredQuad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    const STRIDE = 40;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE, 24);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    let instCap = 0;

    const uP = { scene: gl.getUniformLocation(pP, 'uScene'), px: gl.getUniformLocation(pP, 'uPx') };
    const uI = { rect: gl.getUniformLocation(pI, 'uRect'), scene: gl.getUniformLocation(pI, 'uScene'), tex: gl.getUniformLocation(pI, 'uTex'), alpha: gl.getUniformLocation(pI, 'uAlpha'),
      xf: gl.getUniformLocation(pI, 'uXf'), xt: gl.getUniformLocation(pI, 'uXt') };
    const uR = {};
    for (const n of ['uRect', 'uScene', 'uXf', 'uXt', 'uTex', 'uAct', 'uAlpha', 'uG', 'uSoft', 'uFw', 'uFg', 'uFc']) uR[n] = gl.getUniformLocation(pR, n);
    const uV = {};
    for (const n of ['uTex', 'uTexSize', 'uTexC', 'uC', 'uScene', 'uUp', 'uZoom', 'uRoll', 'uRot', 'uTwist', 'uR0', 'uArc', 'uArcTw', 'uZb', 'uCa', 'uVig', 'uExp']) uV[n] = gl.getUniformLocation(pV, n);

    const blend = (mode) => {
      if (mode === 'lighter') gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    };
    return {
      kind: 'webgl2',
      texture(img, nearest) {
        const t = gl.createTexture();
        const f = nearest ? gl.NEAREST : gl.LINEAR;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !nearest);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      },
      begin() {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
      },
      image(layer, alpha, xf) {
        gl.useProgram(pI);
        gl.bindVertexArray(vaoI);
        blend(layer.blend);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, layer._tex);
        gl.uniform1i(uI.tex, 0);
        gl.uniform1f(uI.alpha, alpha);
        gl.uniform2f(uI.scene, scene.width, scene.height);
        gl.uniform4f(uI.rect, layer.x || 0, layer.y || 0, layer.w || layer._img.width, layer.h || layer._img.height);
        const m = xf || [1, 0, 0, 1, 0, 0];
        gl.uniform4f(uI.xf, m[0], m[1], m[2], m[3]);
        gl.uniform2f(uI.xt, m[4], m[5]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      reveal(layer, alpha, xf, G) {
        gl.useProgram(pR);
        gl.bindVertexArray(vaoI);
        blend(layer.blend);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, layer._tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, layer._act);
        gl.uniform1i(uR.uTex, 0);
        gl.uniform1i(uR.uAct, 1);
        gl.uniform1f(uR.uAlpha, alpha);
        gl.uniform1f(uR.uG, G);
        gl.uniform1f(uR.uSoft, layer.soft || 0.02);
        const f = layer.front || {};
        const fc = f.c || [255, 240, 210];
        gl.uniform1f(uR.uFw, f.w || 0.01);
        gl.uniform1f(uR.uFg, f.gain || 0);
        gl.uniform3f(uR.uFc, fc[0] / 255, fc[1] / 255, fc[2] / 255);
        gl.uniform2f(uR.uScene, scene.width, scene.height);
        gl.uniform4f(uR.uRect, layer.x || 0, layer.y || 0, layer.w || layer._img.width, layer.h || layer._img.height);
        const m = xf || [1, 0, 0, 1, 0, 0];
        gl.uniform4f(uR.uXf, m[0], m[1], m[2], m[3]);
        gl.uniform2f(uR.uXt, m[4], m[5]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.activeTexture(gl.TEXTURE0);
      },
      vortex(layer, v) {
        gl.useProgram(pV);
        gl.bindVertexArray(vaoI);
        gl.blendFunc(gl.ONE, gl.ZERO);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, layer._tex);
        gl.uniform1i(uV.uTex, 0);
        gl.uniform2f(uV.uTexSize, layer._img.width, layer._img.height);
        gl.uniform2f(uV.uTexC, layer.texC[0], layer.texC[1]);
        gl.uniform2f(uV.uC, v.cx, v.cy);
        gl.uniform2f(uV.uScene, scene.width, scene.height);
        gl.uniform1f(uV.uUp, layer.up || 1);
        for (const k of ['uZoom', 'uRoll', 'uRot', 'uTwist', 'uR0', 'uArc', 'uArcTw', 'uZb', 'uCa', 'uVig', 'uExp']) gl.uniform1f(uV[k], v[k]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      instances(buf, count, mode) {
        if (!count) return;
        gl.useProgram(pP);
        gl.bindVertexArray(vaoP);
        blend(mode);
        gl.bindBuffer(gl.ARRAY_BUFFER, inst);
        if (buf.length > instCap) {
          instCap = buf.length;
          gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf, 0, count * 10);
        gl.uniform2f(uP.scene, scene.width, scene.height);
        gl.uniform1f(uP.px, scale);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      },
      end() {
        gl.bindVertexArray(null);
      },
    };
  }

  function canvasRenderer(canvas, scene, scale) {
    const ctx = canvas.getContext('2d');
    const glowCache = new Map();
    const glowSprite = (r, g, b) => {
      const key = `${r},${g},${b}`;
      if (glowCache.has(key)) return glowCache.get(key);
      const s = 64, cv = document.createElement('canvas');
      cv.width = cv.height = s;
      const c = cv.getContext('2d');
      const gr = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, `rgba(${key},1)`);
      gr.addColorStop(0.35, `rgba(${key},0.45)`);
      gr.addColorStop(1, `rgba(${key},0)`);
      c.fillStyle = gr;
      c.fillRect(0, 0, s, s);
      glowCache.set(key, cv);
      return cv;
    };
    return {
      kind: 'canvas2d',
      texture(img) {
        return img;
      },
      begin() {
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, scene.width, scene.height);
      },
      image(layer, alpha, xf) {
        ctx.globalCompositeOperation = layer.blend || 'source-over';
        ctx.globalAlpha = Math.min(1, alpha);
        if (xf) ctx.setTransform(scale * xf[0], scale * xf[2], scale * xf[1], scale * xf[3], scale * xf[4], scale * xf[5]);
        ctx.drawImage(layer._img, layer.x || 0, layer.y || 0, layer.w || layer._img.width, layer.h || layer._img.height);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
      },
      reveal(layer, alpha, xf, G) {  // fallback: the whole image fades in with the growth
        this.image(layer, alpha * Math.min(1, Math.max(0, G)), xf);
      },
      vortex(layer, v) {  // fallback: rigid swirl + zoom, no twist or blur
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.translate(v.cx, v.cy);
        ctx.scale(v.uZoom, v.uZoom);
        ctx.rotate(v.uRoll + v.uRot);
        const up = layer.up || 1;
        ctx.drawImage(layer._img, -layer.texC[0] / up, -layer.texC[1] / up, layer._img.width / up, layer._img.height / up);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
      },
      instances(buf, count, mode) {
        ctx.globalCompositeOperation = mode || 'source-over';
        for (let n = 0; n < count; n++) {
          const o = n * 10;
          const x = buf[o], y = buf[o + 1], rx = buf[o + 2], ry = buf[o + 3], ang = buf[o + 4], shape = buf[o + 5];
          const r = Math.round(buf[o + 6] * 255), g = Math.round(buf[o + 7] * 255), b = Math.round(buf[o + 8] * 255);
          ctx.globalAlpha = Math.min(1, buf[o + 9]);
          if (shape === 3) {
            ctx.setTransform(scale, 0, 0, scale, 0, 0);
            ctx.drawImage(glowSprite(r, g, b), x - rx, y - ry, 2 * rx, 2 * ry);
            continue;
          }
          const c = Math.cos(ang) * scale, s = Math.sin(ang) * scale;
          ctx.setTransform(c, s, -s, c, x * scale, y * scale);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.beginPath();
          if (shape === 1) ctx.rect(-rx, -ry, 2 * rx, 2 * ry);
          else if (shape === 2) ctx.arc(0, 0, rx, 0, TAU);
          else {
            ctx.moveTo(0, -rx);
            ctx.lineTo(rx, 0);
            ctx.lineTo(0, rx);
            ctx.lineTo(-rx, 0);
            ctx.closePath();
          }
          ctx.fill();
        }
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
      },
      end() {
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      },
    };
  }

  // ------------------------------------------------------------------ simulation
  async function create(canvas, scene, opts = {}) {
    const scale = opts.scale || 1;
    canvas.width = Math.round(scene.width * scale);
    canvas.height = Math.round(scene.height * scale);
    const loop = scene.loop;
    const wind = makeWind(scene.wind);
    const cam = makeCamera(scene.camera, loop);
    const grow = makeGrow(scene.grow, loop);
    let R = null;
    if (opts.renderer !== 'canvas2d') {
      try {
        R = glRenderer(canvas, scene, scale, opts.preserve);
      } catch (e) {
        console.warn('WebGL2 renderer unavailable, using Canvas2D', e);
        R = null;
      }
    }
    if (!R) R = canvasRenderer(canvas, scene, scale);

    let maxInst = 0;
    for (const layer of scene.layers) {
      if (layer.type === 'image' || layer.type === 'vortex' || layer.type === 'reveal') {
        layer._img = await loadImage(layer.src);
        layer._tex = R.texture(layer._img);
      }
      if (layer.type === 'reveal') layer._act = R.texture(await loadImage(layer.act), true);
      if (layer.type === 'path') layer._tab = pathTable(layer.points);
      for (const it of layer.items || []) {
        it._r = it.c[0] / 255;
        it._g = it.c[1] / 255;
        it._b = it.c[2] / 255;
      }
      maxInst = Math.max(maxInst, (layer.items || []).length);
    }
    const buf = new Float32Array(Math.max(1, maxInst) * 10);
    let count = 0;
    const push = (x, y, rx, ry, ang, shape, r, g, b, a) => {
      const o = count * 10;
      buf[o] = x; buf[o + 1] = y; buf[o + 2] = rx; buf[o + 3] = ry; buf[o + 4] = ang; buf[o + 5] = shape;
      buf[o + 6] = r; buf[o + 7] = g; buf[o + 8] = b; buf[o + 9] = a;
      count++;
    };

    function particles(layer, tt, la) {
      const shape = SHAPES[layer.shape || 'diamond'];
      const grow = !!layer.grow;
      const k = grow ? 0.3 : 1;
      const bend = wind && layer.bend;
      const wav = layer.waver;
      const stretch = layer.stretch || 1;
      for (const it of layer.items) {
        const ph = frac(tt / it.l + it.p);
        const s = ph * it.l;
        let a = it.a * la;
        if (it.fi) a *= smooth(0, it.fi * k, ph);
        if (it.fo) a *= 1 - smooth(1 - it.fo * k, 1, ph);
        if (it.tw) a *= 1 - it.tw * WAVES.sin01(((it.twk || 1) * tt) / loop + (it.twp || 0));
        if (a <= 0.004) continue;
        let x = it.x + (it.vx || 0) * s;
        let y = it.y + (it.vy || 0) * s + 0.5 * (it.ay || 0) * s * s;
        if (it.sw) x += it.sw * Math.sin(TAU * ((it.swc || 0) * ph + (it.swp || 0)));
        let ang = it.ang || 0;
        if (it.wd && wind) {
          const tl = tt - (it.wt || 0);
          const D = it.wd * (wind.F(tl) - wind.F(tl - s));
          x += D * wind.dir[0];
          y += D * wind.dir[1];
          if (it.wr) ang += it.wr * D;
        }
        if (bend) {
          const h = Math.min(1.6, Math.max(0, (bend.yBot - y) / bend.H));
          const g = wind.G(tt - wind.delay(x, y) - (bend.yBot - y) / (bend.cup || 400)) - wind.gmin;
          x += bend.amp * Math.pow(h, 1.6) * g * wind.dir[0];
        }
        if (wav) {
          const h = Math.min(1.6, Math.max(0, (wav.yBot - y) / wav.H));
          x += wav.amp * h * Math.sin(TAU * (((wav.k || 1) * tt) / loop + y / (wav.wl || 200)));
        }
        if (it.spin) ang += it.spin * s;
        let r = it.r;
        if (it.gr) r *= 1 + it.gr * ph;
        if (it.sh && it.fo) r *= 1 - it.sh * smooth(1 - it.fo, 1, ph);
        if (grow && it.fi) r *= smooth(0, it.fi, ph);
        if (r < 0.12) continue;
        push(x, y, r, r * stretch, ang, shape, it._r, it._g, it._b, Math.min(1, a));
      }
    }

    function orbit(layer, tt, la) {
      const shape = SHAPES[layer.shape || 'square'];
      const sh = cam.shutter, Ar = cam.Arate(tt), A0 = cam.A(tt);
      const [c0, c1] = layer.core || [0, 0];
      for (const it of layer.items) {
        const ph = frac(tt / it.l + it.p);
        const s = ph * it.l;
        let a = it.a * la;
        if (it.fi) a *= smooth(0, it.fi, ph);
        if (it.fo) a *= 1 - smooth(1 - it.fo, 1, ph);
        const m = it.m == null ? 1 : it.m;
        const rad = it.r * Math.exp(-(it.k || 0) * s);
        if (c1 > c0) a *= smooth(c0, c1, rad);
        if (a <= 0.004) continue;
        const ang = it.th + m * (A0 - cam.A(tt - s)) + (it.w || 0) * s;
        const vt = rad * (m * Ar + (it.w || 0)), vr = rad * (it.k || 0);
        const st = it.st == null ? 1 : it.st;
        push(cam.cx + rad * Math.cos(ang), cam.cy + rad * Math.sin(ang),
             it.sz + vr * sh * st * 0.5, it.sz + vt * sh * st * 0.5, ang, shape, it._r, it._g, it._b, Math.min(1, a));
      }
    }

    function nodes(layer, tt, la) {
      const shape = SHAPES[layer.shape || 'glow'];
      const G = grow.v(tt);
      const [w0, w1] = layer.pulse || [0.004, 0.03];
      const expo = layer.decay === 'exp', base = layer.base || 0, soft = layer.soft || 0.02, swell = layer.swell || 0;
      for (const it of layer.items) {
        const x = G - it.g;
        let p = x < 0 ? Math.exp(-((x / w0) ** 2)) : expo ? Math.exp(-x / w1) : Math.exp(-((x / w1) ** 2));
        let a = it.a * la * (p + (base ? base * smooth(0, soft, x) : 0));
        if (it.tw) a *= 1 - it.tw * WAVES.sin01(((it.twk || 1) * tt) / loop + (it.twp || 0));
        if (a <= 0.004) continue;
        const r = it.r * (1 + swell * p);
        push(it.x, it.y, r, r, 0, shape, it._r, it._g, it._b, Math.min(1, a));
      }
    }

    function applyCamera(layer, tt) {
      const [a, b, c, d, tx, ty, Z, rl] = cam.xf(tt, layer.parallax);
      for (let n = 0; n < count; n++) {
        const o = n * 10, x = buf[o], y = buf[o + 1];
        buf[o] = a * x + b * y + tx;
        buf[o + 1] = c * x + d * y + ty;
        buf[o + 2] *= Z;
        buf[o + 3] *= Z;
        buf[o + 4] += rl;
      }
    }

    function render(t) {
      const tt = frac(t / loop) * loop;
      R.begin();
      for (const layer of scene.layers) {
        if (layer.off) continue;
        const la = anim(layer.alpha, tt, loop, wind, cam, grow);
        if (la <= 0.001) continue;
        if (layer.type === 'reveal') {
          R.reveal(layer, Math.min(1, la), layer.camera && cam ? cam.xf(tt, layer.parallax) : null, grow.v(tt));
          continue;
        }
        if (layer.type === 'image') {
          R.image(layer, Math.min(1, la), layer.camera && cam ? cam.xf(tt, layer.parallax) : null);
          continue;
        }
        if (layer.type === 'vortex') {
          const Z = cam.zoom(tt), sh = cam.shutter;
          R.vortex(layer, {
            cx: cam.cx, cy: cam.cy, uZoom: Z, uRoll: cam.roll(tt), uRot: cam.A(tt), uTwist: cam.twist(tt),
            uR0: cam.r0, uArc: cam.Arate(tt) * sh, uArcTw: cam.twistRate(tt) * sh,
            uZb: (cam.zoomRate(tt) / Z) * sh, uCa: layer.ca || 0, uVig: layer.vignette || 0,
            uExp: 1 + (layer.gain || 0) * cam.I(tt),
          });
          continue;
        }
        count = 0;
        if (layer.type === 'particles') particles(layer, tt, la);
        else if (layer.type === 'orbit') orbit(layer, tt, la);
        else if (layer.type === 'nodes') nodes(layer, tt, la);
        else if (layer.type === 'path') {
          const [fi, fo] = layer.fade || [0.1, 0.2];
          const shape = SHAPES[layer.shape || 'glow'];
          for (const it of layer.items) {
            const u = frac(((it.k || 1) * tt) / loop + it.p);
            const a = (it.a == null ? 1 : it.a) * la * smooth(0, fi, u) * (1 - smooth(1 - fo, 1, u));
            if (a <= 0.004) continue;
            const [x, y] = pointAt(layer._tab, u);
            push(x, y, it.r, it.r, 0, shape, it._r, it._g, it._b, Math.min(1, a));
          }
        }
        if (layer.camera && cam) applyCamera(layer, tt);
        R.instances(buf, count, layer.blend);
      }
      R.end();
    }

    return { render, loop, renderer: R.kind, layers: scene.layers, wind, camera: cam, grow };
  }

  window.ArtAnimator = { create };
})();
