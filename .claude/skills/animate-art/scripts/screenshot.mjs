#!/usr/bin/env node
// Screenshot the viewer page as a person sees it (UI included), paused at time t.
//   node screenshot.mjs <page.html> <out.png> [--w 1280] [--h 900] [--t 3] [--dpr 1]
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
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const [page, out] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const w = Number(opt('w', 1280)), h = Number(opt('h', 900)), t = opt('t', '3'), dpr = Number(opt('dpr', 1));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const p = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr })).newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await p.goto('file://' + path.resolve(page) + `?t=${t}`);
await p.waitForFunction(() => window.sceneReady === true, null, { timeout: 60000 });
await p.waitForTimeout(800); // web fonts
await p.screenshot({ path: out });
const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log(`saved ${out}${overflow ? '  (WARNING: horizontal overflow)' : ''}`);
if (errors.length) console.error('page errors:\n' + errors.join('\n'));
await browser.close();
