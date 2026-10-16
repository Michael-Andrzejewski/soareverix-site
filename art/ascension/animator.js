/* animator.js: plays a layered scene (window.SCENE) on a canvas. WebGL2 with a Canvas2D fallback.
 *
 * Everything is a pure function of time t (seconds), so any frame can be
 * rendered on demand (render(t)) and the loop is seamless when every particle
 * life and every wave frequency divides scene.loop.
 *
 * Scene format (built by artkit.py):
 *   { width, height, loop, wind?, layers: [ ... ] }
 * wind  { T, G: [n samples of gust strength over one loop], F: [running integral of G], FT,
 *         gmin, gmax, dir: [dx, dy], front: px/s }
 *       Gusts sweep left to right at `front` px/s. A particle with susceptibility wd is pushed
 *       by wd * (F(now) - F(birth)) along dir, so gusts bend paths and the loop stays exact.
 * Layer types:
 *   image      { src, blend?, alpha?: Anim, x?, y?, w?, h? }
 *   particles  { shape: 'diamond'|'square'|'circle'|'glow', blend?, alpha?: Anim, grow?: bool, items: [P] }
 *              grow: born by growing from a point, die by shrinking (sh), short alpha fades at the ends.
 *              bend: { amp, yBot, H, cup } sways the whole layer with the gusts like a plume rooted
 *              at yBot: offset amp * h^1.6 * (G - gmin), h = height above yBot / H, the gust
 *              reaching height h after (yBot - y) / cup seconds.
 *   path       { points: [[x,y]...], shape, blend?, alpha?: Anim, fade: [fi, fo], items: [{k, p, r, c, a}] }
 * Anim  { base, amp, k, p, wave: 'sin01'|'beat'|'sin'|'wind'|'rest' }   value = base + amp * wave(k*t/loop + p)
 *       'wind' is the normalised gust strength at time t (ignores k and p).
 *       'rest' is 1 within `hold` s of the loop point, easing to 0 over the next `fade` s, on
 *       both sides. Put the untouched source on top with it and every loop passes exactly
 *       through the original picture: the scene wakes from the still and settles back into it.
 * P     { x, y, r, c:[r,g,b], a, l: life, p: phase, vx, vy, ay, fi, fo, sh, gr, sw, swc, swp,
 *         tw, twk, twp, wd, wt, spin, wr, ang }
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

  function anim(spec, t, loop, wind) {
    if (spec == null) return 1;
    if (typeof spec === 'number') return spec;
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
uniform vec4 uRect; uniform vec2 uScene;
out vec2 vUV;
void main(){
  vec2 wp = uRect.xy + aCorner * uRect.zw;
  vUV = aCorner;
  gl_Position = vec4(wp.x / uScene.x * 2.0 - 1.0, 1.0 - wp.y / uScene.y * 2.0, 0.0, 1.0);
}`, `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uTex; uniform float uAlpha; out vec4 o;
void main(){ o = texture(uTex, vUV) * uAlpha; }`);

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
    const uI = { rect: gl.getUniformLocation(pI, 'uRect'), scene: gl.getUniformLocation(pI, 'uScene'), tex: gl.getUniformLocation(pI, 'uTex'), alpha: gl.getUniformLocation(pI, 'uAlpha') };

    const blend = (mode) => {
      if (mode === 'lighter') gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    };
    return {
      kind: 'webgl2',
      texture(img) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
      image(layer, alpha) {
        gl.useProgram(pI);
        gl.bindVertexArray(vaoI);
        blend(layer.blend);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, layer._tex);
        gl.uniform1i(uI.tex, 0);
        gl.uniform1f(uI.alpha, alpha);
        gl.uniform2f(uI.scene, scene.width, scene.height);
        gl.uniform4f(uI.rect, layer.x || 0, layer.y || 0, layer.w || layer._img.width, layer.h || layer._img.height);
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
      image(layer, alpha) {
        ctx.globalCompositeOperation = layer.blend || 'source-over';
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.drawImage(layer._img, layer.x || 0, layer.y || 0, layer.w || layer._img.width, layer.h || layer._img.height);
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
      if (layer.type === 'image') {
        layer._img = await loadImage(layer.src);
        layer._tex = R.texture(layer._img);
      }
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
          const g = wind.G(tt - x / wind.front - (bend.yBot - y) / (bend.cup || 400)) - wind.gmin;
          x += bend.amp * Math.pow(h, 1.6) * g * wind.dir[0];
        }
        if (it.spin) ang += it.spin * s;
        let r = it.r;
        if (it.gr) r *= 1 + it.gr * ph;
        if (it.sh && it.fo) r *= 1 - it.sh * smooth(1 - it.fo, 1, ph);
        if (grow && it.fi) r *= smooth(0, it.fi, ph);
        if (r < 0.12) continue;
        push(x, y, r, r, ang, shape, it._r, it._g, it._b, Math.min(1, a));
      }
    }

    function render(t) {
      const tt = frac(t / loop) * loop;
      R.begin();
      for (const layer of scene.layers) {
        if (layer.off) continue;
        const la = anim(layer.alpha, tt, loop, wind);
        if (la <= 0.001) continue;
        if (layer.type === 'image') {
          R.image(layer, Math.min(1, la));
          continue;
        }
        count = 0;
        if (layer.type === 'particles') particles(layer, tt, la);
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
        R.instances(buf, count, layer.blend);
      }
      R.end();
    }

    return { render, loop, renderer: R.kind, layers: scene.layers, wind };
  }

  window.ArtAnimator = { create };
})();
