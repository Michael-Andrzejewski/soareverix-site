// A short live conversation with the real Anthropic API through the real site
// code (Pages Functions + local D1). Costs a fraction of a cent on Haiku 5.5.
//
//   1. Put a real ANTHROPIC_API_KEY in .dev.vars (see .dev.vars.example).
//   2. npm run db:init:local      (once)
//   3. npm run smoke              (Haiku 5.5)   or   npm run smoke -- claude-opus-5-5
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const MODEL = process.argv[2] || 'claude-haiku-5-5';
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const vars = fs.existsSync('.dev.vars') ? fs.readFileSync('.dev.vars', 'utf8') : '';
const key = (vars.match(/^ANTHROPIC_API_KEY=(.*)$/m) || [])[1] || '';
const admin = (vars.match(/^ADMIN_TOKEN=(.*)$/m) || [])[1] || '';
if (!key.startsWith('sk-ant-') || key.includes('mock')) {
  console.error('Put a real ANTHROPIC_API_KEY in .dev.vars first.');
  process.exit(1);
}

const QUESTIONS = [
  'hi! who are you exactly?',
  'What is Diversified Utopia?',
  'What did PrefDecay-Eval find?',
  "Is Michael single? Who's he dating?",
];

// Same model for primary and economy, and the real API (ignore any mock URL).
const dev = spawn(
  'npx',
  ['wrangler', 'pages', 'dev', 'public', '--port', String(PORT), '--binding', `KARYON_MODEL=${MODEL}`, '--binding', `KARYON_ECONOMY_MODEL=${MODEL}`, '--binding', 'ANTHROPIC_BASE_URL='],
  { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] },
);
process.on('exit', () => dev.kill('SIGTERM'));

for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/api/status`)).ok) break;
  } catch {}
  if (i > 120) throw new Error('dev server did not start');
  await new Promise((r) => setTimeout(r, 500));
}

let conversation_id;
for (const message of QUESTIONS) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, conversation_id }),
  });
  if (!res.headers.get('content-type')?.includes('event-stream')) {
    console.log(`\nVISITOR: ${message}\n(no stream) ${res.status} ${await res.text()}`);
    continue;
  }
  let text = '';
  const notes = [];
  for (const chunk of (await res.text()).split('\n\n')) {
    const ev = (chunk.match(/^event: (.*)$/m) || [])[1];
    const raw = (chunk.match(/^data: (.*)$/m) || [])[1];
    if (!ev || !raw) continue;
    const data = JSON.parse(raw);
    if (ev === 'meta') {
      conversation_id = data.conversation_id;
      if (!notes.includes(data.model)) notes.push(data.model);
    } else if (ev === 'scene') notes.push(`scene=${data.scene}${data.caption ? ` "${data.caption}"` : ''}`);
    else if (ev === 'text') text += data.delta;
    else if (ev === 'error') notes.push(`error=${data.code}`);
    else if (ev === 'done') notes.push(`stop=${data.stop_reason}`);
  }
  console.log(`\nVISITOR: ${message}\nKARYON [${notes.join(', ')}]:\n${text}`);
}

if (admin) {
  const r = await fetch(`${BASE}/api/admin/conversations/${conversation_id}`, { headers: { authorization: `Bearer ${admin}` } });
  if (r.ok) {
    const { conversation, messages } = await r.json();
    const replies = messages.filter((m) => m.role === 'assistant');
    const cacheReads = replies.reduce((n, m) => n + (m.cache_read_tokens || 0), 0);
    console.log(`\nLogged ${messages.length} rows. Cost of this conversation: $${(conversation.cost_micros / 1e6).toFixed(5)} (cache reads: ${cacheReads} tokens).`);
  }
}
process.exit(0);
