#!/usr/bin/env node
// Render frames of an animate-art page deterministically with headless Chromium.
//
//   node capture.mjs <page.html> <outdir> [--fps 30] [--seconds 12] [--start 0]
//                    [--times 0,3,6] [--scale 1] [--off layerA,layerB] [--query duration=3]
//
// The page must expose window.renderAt(t) and set window.sceneReady (template.html
// does both when opened with ?capture). Frames are written as PNG straight from
// the canvas (lossless; no screenshot scaling), named f00000.png ...
// Use --times to grab a few stills instead of a sequence.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const [page, outdir] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!page || !outdir) {
  console.error('usage: node capture.mjs <page.html> <outdir> [--fps 30] [--seconds 12] [--times a,b] [--scale 1] [--off ids]');
  process.exit(1);
}
const fps = Number(opt('fps', 30));
const seconds = Number(opt('seconds', 12));
const start = Number(opt('start', 0));
const scale = Number(opt('scale', 1));
const off = opt('off', '');
const query = opt('query', '');  // extra page parameters, e.g. duration=3 for an intro
const times = opt('times', '')
  .split(',')
  .filter(Boolean)
  .map(Number);

fs.mkdirSync(outdir, { recursive: true });
// Chromium comes from PLAYWRIGHT_BROWSERS_PATH; set CHROMIUM_PATH to force a binary.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--allow-file-access-from-files'] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 1400 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const url = 'file://' + path.resolve(page) + `?capture=1&scale=${scale}` + (off ? `&off=${off}` : '') + (query ? `&${query}` : '');
await p.goto(url);
await p.waitForFunction(() => window.sceneReady === true, null, { timeout: 60000 });

const list = times.length ? times : Array.from({ length: Math.round(fps * seconds) }, (_, i) => start + i / fps);
const t0 = Date.now();
for (let i = 0; i < list.length; i++) {
  const dataUrl = await p.evaluate((t) => {
    window.renderAt(t);
    return document.getElementById('art').toDataURL('image/png');
  }, list[i]);
  // zero-padded so stills sort by time (t003.00 before t010.50)
  const name = times.length ? `t${list[i].toFixed(2).padStart(6, '0')}.png` : `f${String(i).padStart(5, '0')}.png`;
  fs.writeFileSync(path.join(outdir, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
  if (!times.length && i % 60 === 0) console.log(`frame ${i}/${list.length}`);
}
console.log(`wrote ${list.length} frame(s) to ${outdir} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (errors.length) {
  console.error('page errors:\n' + errors.join('\n'));
  process.exitCode = 2;
}
await browser.close();
