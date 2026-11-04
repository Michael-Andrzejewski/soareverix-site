// End-to-end check of the whole site against the local mock API:
// intro -> greeting -> question -> streamed reply -> background repaint ->
// D1 logs -> admin API -> economy-model switch -> daily budget cap.
//
//   npm run test:e2e
//
// Needs .dev.vars pointing ANTHROPIC_BASE_URL at the mock (see .dev.vars.example)
// and Playwright with Chromium available.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = (fs.readFileSync('.dev.vars', 'utf8').match(/^ADMIN_TOKEN=(.*)$/m) || [])[1];
const SHOTS = process.env.SHOTS_DIR || 'test-results';
fs.mkdirSync(SHOTS, { recursive: true });

const procs = [];
const run = (cmd, args, env = {}) => {
  const p = spawn(cmd, args, { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
};
const cleanup = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));

const d1 = (sql) =>
  JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'karyon', '--local', '--json', '--command', sql], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }).toString());
const today = new Date().toISOString().slice(0, 10);

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function chat(message, conversation_id) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, conversation_id }),
  });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const ev = (chunk.match(/^event: (.*)$/m) || [])[1];
      const data = (chunk.match(/^data: (.*)$/m) || [])[1];
      return { ev, data: data ? JSON.parse(data) : null };
    });
  return { status: res.status, events, json: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
}

(async () => {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'karyon', '--local', '--file=schema.sql'], { stdio: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  d1(`DELETE FROM daily_spend WHERE day = '${today}'; DELETE FROM spend_holds; DELETE FROM visitor_days; DELETE FROM messages WHERE role = 'event' AND content LIKE 'ended:%';`);
  run('node', ['scripts/mock-anthropic.mjs'], { MOCK_LOG: '.wrangler/e2e-mock.jsonl' });
  fs.rmSync('.wrangler/e2e-mock.jsonl', { force: true });
  // The site runs Haiku all day. Pin Opus as primary so the switch and the
  // fallback path below still get tested.
  run('npx', ['wrangler', 'pages', 'dev', 'public', '--port', String(PORT), '--binding', 'KARYON_MODEL=claude-opus-5-5']);
  await waitFor(`${BASE}/api/status`);

  const browser = await chromium.launch();

  // ---- UI: drawn intro, greeting, question, streamed reply, repaint ----
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/`);
  // The intro: the eyes open, look left, look right, and find the visitor.
  await page.waitForFunction(() => window.__karyon.engine.params.eyeOpen === 1, null, { timeout: 6000 });
  await page.waitForFunction(() => window.__karyon.engine.params.gazeX < -0.5, null, { timeout: 6000 });
  await page.waitForFunction(() => window.__karyon.engine.params.gazeX > 0.5, null, { timeout: 6000 });
  check(await page.evaluate(() => document.body.classList.contains('intro')), 'the eyes look around during the intro');
  await page.screenshot({ path: `${SHOTS}/1-intro.png` });
  await page.waitForFunction(() => !document.body.classList.contains('intro'), null, { timeout: 6000 });
  check(await page.evaluate(() => window.__karyon.engine.sceneName === 'eyes'), 'the intro ends on the eyes');
  await page.waitForFunction(() => !document.body.classList.contains('awaiting'), null, { timeout: 15000 });
  const greeting = await page.textContent('.msg.greeting .body');
  check(greeting.startsWith('My name is Karyon, an agent attempting CEV for Michael Andrzejewski.'), 'greeting typed beneath the eyes');
  check(await page.isVisible('#ask'), 'chat bar visible');
  await page.screenshot({ path: `${SHOTS}/2-greeting.png` });

  await page.fill('#q', 'What is Diversified Utopia?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__karyon.engine.sceneName === 'planet', null, { timeout: 10000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/3-morphing.png` });
  await page.waitForFunction(() => !document.querySelector('.msg.karyon:last-child .body').classList.contains('cursor'), null, { timeout: 15000 });
  const reply = await page.textContent('.msg.karyon:last-child .body');
  check(reply.includes('Diversified Utopia'), 'reply streamed into the transcript');
  check((await page.textContent('#caption')) === 'Diversified Utopia', 'caption shows the scene caption');
  check((await page.textContent('.msg.karyon:last-child .who .model')) === 'Opus 5.5', 'reply is labelled with the model that wrote it');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/4-planet.png` });

  await page.fill('#q', 'Can you draw me an octopus?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__karyon.engine.sceneName === 'custom', null, { timeout: 10000 });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${SHOTS}/5-custom-svg.png` });
  // ---- drawing on the painting, and clearing it with the eyes ----
  await page.mouse.move(250, 560);
  await page.mouse.down();
  await page.mouse.move(420, 640, { steps: 8 });
  await page.mouse.move(520, 520, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check(await page.isVisible('#ink-send'), 'drawing on the painting offers to show Karyon');
  await page.screenshot({ path: `${SHOTS}/5b-drawing.png` });
  await page.click('#ink-send');
  await page.waitForFunction(() => document.querySelector('.msg.you:last-of-type pre.drawing, pre.drawing'), null, { timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector('.msg.karyon:last-child .body').classList.contains('cursor'), null, { timeout: 15000 });
  const drawn = d1("SELECT content FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 1")[0].results[0].content;
  check(drawn.includes('drew this on your painting') && drawn.includes('#'), 'the drawing reaches Karyon as text');
  await page.evaluate(() => document.querySelector('#art-right').click());
  check(await page.evaluate(() => window.__karyon.engine.sceneName === 'eyes' && !document.body.classList.contains('painted')), 'clicking the eyes clears the painting');
  const forged = await chat('hello', undefined);
  check(forged.status === 200, 'chat still answers after clearing');

  // ---- expressions, lightning, and the static page ----
  await page.fill('#q', 'Are you suspicious of me?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__karyon.engine.params.expression === 'suspicious', null, { timeout: 15000 });
  check(true, 'set_eyes changes the expression');
  await page.waitForFunction(() => !document.querySelector('.msg.karyon:last-child .body').classList.contains('cursor'), null, { timeout: 15000 });

  await page.fill('#q', 'Send lightning');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.classList.contains('struck'), null, { timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/6-lightning.png` });
  await page.waitForFunction(() => document.body.classList.contains('static'), null, { timeout: 8000 });
  check(await page.isVisible('#closed-note') && !(await page.isVisible('#ask')), 'the strike replaces the chat with the static page');
  check((await page.textContent('#closed-parting')).includes('Goodbye'), "the static page keeps Karyon's last line");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/7-static.png` });
  const shut = await page.evaluate(async () => (await (await fetch('/api/status')).json()).closed_until);
  check(Boolean(shut), 'status reports the visitor closed');
  const denied2 = await chat('hello again');
  check(denied2.status === 403 && denied2.json?.error === 'closed', 'a closed visitor gets no API call');
  await page.reload();
  await page.waitForFunction(() => document.body.classList.contains('static'), null, { timeout: 8000 });
  check(true, 'a reload goes straight to the static page');
  // Lift it, so the budget checks below can still talk.
  d1("DELETE FROM messages WHERE role = 'event' AND content LIKE 'ended:%'");

  check(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close();

  // ---- what was sent to the API ----
  const sent = fs.readFileSync('.wrangler/e2e-mock.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const first = sent[0].body;
  check(first.model === 'claude-opus-5-5' && first.fallbacks === 'default', 'primary model with server-side fallback');
  check(sent[0].headers['anthropic-beta'] === 'server-side-fallback-2026-07-01', 'fallback beta header');
  check(first.system[0].cache_control?.type === 'ephemeral', 'system prompt is cached');
  check(first.tools[0].eager_input_streaming === true && first.tools[0].name === 'paint_background', 'paint tool streams its input');
  check(first.messages.at(-1).role === 'system' && /background currently shows "eyes"/.test(first.messages.at(-1).content), 'harness note tells Karyon the current scene');
  const second = sent[1].body;
  check(second.messages.at(-2).content.some((b) => b.type === 'thinking'), 'thinking blocks are passed back within a turn');

  // ---- logs ----
  const rows = d1("SELECT role, scene, model, cost_micros FROM messages WHERE scene = 'custom' ORDER BY id DESC LIMIT 4")[0].results;
  check(rows.some((r) => r.role === 'assistant' && r.scene === 'custom' && r.cost_micros > 0), 'reply logged with scene and cost');
  const list = await (await fetch(`${BASE}/api/admin/conversations`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
  check(list.conversations?.length > 0 && list.today.spent_usd > 0, 'admin API lists conversations and today’s spend');
  const denied = await fetch(`${BASE}/api/admin/conversations`, { headers: { authorization: 'Bearer wrong' } });
  check(denied.status === 404, 'admin API hidden without the token');

  // ---- economy model after half the budget ----
  d1(`INSERT INTO daily_spend (day, spent_micros) VALUES ('${today}', 600000) ON CONFLICT(day) DO UPDATE SET spent_micros = 600000`);
  const eco = await chat('Tell me about his research');
  const meta = eco.events.find((e) => e.ev === 'meta');
  check(meta?.data.model === 'claude-haiku-5-5', 'switches to the economy model after $0.50', meta?.data.model);
  const ecoReq = fs.readFileSync('.wrangler/e2e-mock.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1).body;
  check(!('fallbacks' in ecoReq) && ecoReq.output_config.effort === 'medium', 'Haiku request has no fallbacks, medium effort');

  // ---- hard daily cap ----
  d1(`UPDATE daily_spend SET spent_micros = 999990 WHERE day = '${today}'`);
  const status = await (await fetch(`${BASE}/api/status`)).json();
  check(status.open === false, 'status reports Karyon resting when the budget is spent');
  const capped = await chat('Are you still there?');
  const said = capped.events.filter((e) => e.ev === 'text').map((e) => e.data.delta).join('');
  check(/budget resets at midnight UTC/.test(said), 'over-budget message instead of an API call');
  const calls = fs.readFileSync('.wrangler/e2e-mock.jsonl', 'utf8').trim().split('\n').length;
  check(calls === sent.length + 2, 'no API call was made past the cap', `${calls} calls`);
  d1(`DELETE FROM daily_spend WHERE day = '${today}'`);

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
