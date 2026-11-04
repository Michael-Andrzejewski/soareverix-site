// A tiny stand-in for the Anthropic Messages API, for local end-to-end tests.
// It streams the same SSE event shapes as the real API: on a fresh visitor
// message it repaints the background (tool_use), and after the tool result it
// streams a reply. Every request body is appended to MOCK_LOG for assertions.
//
//   node scripts/mock-anthropic.mjs            (listens on :4010)
//   ANTHROPIC_BASE_URL=http://127.0.0.1:4010 in .dev.vars points Karyon at it.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.MOCK_PORT || 4010);
const LOG = process.env.MOCK_LOG || '.wrangler/mock-requests.jsonl';

const PICK = [
  [/utopia|future|planet/i, 'planet', 'Diversified Utopia'],
  [/philosoph|meaning|code|believe/i, 'horizon', 'The Code'],
  [/research|eval|alignment|prefdecay/i, 'network', 'PrefDecay-Eval'],
  [/mod|vintage|rustfall/i, 'gears', 'Vintage Story'],
  [/staravorix|story|magic/i, 'fire', 'Staravorix'],
  [/draw|custom|octopus/i, 'custom', 'A small octopus'],
];
const OCTOPUS =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#000"/>' +
  '<ellipse cx="80" cy="34" rx="22" ry="18" fill="#fff"/><circle cx="72" cy="32" r="4" fill="#000"/>' +
  '<circle cx="88" cy="32" r="4" fill="#000"/><path d="M60 46 q-6 20 -16 28 M70 50 q-2 18 -10 30 M80 52 v30 ' +
  'M90 50 q2 18 10 30 M100 46 q6 20 16 28" stroke="#ccc" stroke-width="5" fill="none" stroke-linecap="round"/></svg>';

let n = 0;

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stream(res, model, blocks, stopReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_mock_${n}` });
  sse(res, 'message_start', {
    message: {
      id: `msg_mock_${++n}`, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 900, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 7000 },
    },
  });
  let out = 0;
  for (const [i, b] of blocks.entries()) {
    if (b.type === 'thinking') {
      sse(res, 'content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
      sse(res, 'content_block_delta', { index: i, delta: { type: 'signature_delta', signature: `sig_${n}_${i}` } });
    } else if (b.type === 'text') {
      sse(res, 'content_block_start', { index: i, content_block: { type: 'text', text: '' } });
      for (const word of b.text.split(/(?<= )/)) {
        sse(res, 'content_block_delta', { index: i, delta: { type: 'text_delta', text: word } });
        out += 2;
        await sleep(15);
      }
    } else if (b.type === 'tool_use') {
      sse(res, 'content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      for (let k = 0; k < json.length; k += 40) {
        sse(res, 'content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: json.slice(k, k + 40) } });
      }
      out += Math.ceil(json.length / 3);
    }
    sse(res, 'content_block_stop', { index: i });
  }
  sse(res, 'message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: out + 40 } });
  sse(res, 'message_stop', {});
  res.end();
}

http
  .createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
      res.writeHead(404).end('{}');
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    fs.mkdirSync('.wrangler', { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ headers: req.headers, body }) + '\n');

    const last = body.messages[body.messages.length - 1];
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
    const question = lastUser?.content || '';
    const afterTool = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');

    if (/please refuse/i.test(question)) {
      return stream(res, body.model, [], 'refusal');
    }
    if (/lightning/i.test(question)) {
      return stream(
        res,
        body.model,
        [
          { type: 'text', text: 'That is enough for today. Goodbye.' },
          { type: 'tool_use', id: `toolu_mock_${n}`, name: 'end_conversation', input: { reason: 'Mock: the visitor asked for lightning.' } },
        ],
        'tool_use',
      );
    }
    if (/squint|suspicious/i.test(question) && !afterTool) {
      return stream(
        res,
        body.model,
        [{ type: 'tool_use', id: `toolu_mock_${n}`, name: 'set_eyes', input: { expression: 'suspicious' } }],
        'tool_use',
      );
    }
    const pick = PICK.find(([re]) => re.test(question));
    if (!afterTool && pick && body.tool_choice?.type !== 'none') {
      const input = { scene: pick[1], caption: pick[2], ...(pick[1] === 'custom' ? { svg: OCTOPUS } : {}) };
      return stream(
        res,
        body.model,
        [{ type: 'thinking' }, { type: 'tool_use', id: `toolu_mock_${n}`, name: 'paint_background', input }],
        'tool_use',
      );
    }
    const scene = pick?.[2] || 'Michael';
    return stream(
      res,
      body.model,
      [
        { type: 'thinking' },
        {
          type: 'text',
          text: `(mock reply) You asked: "${question.slice(0, 80)}". Here is a short answer about ${scene}, streamed word by word so the page can show it arriving.`,
        },
      ],
      'end_turn',
    );
  })
  .listen(PORT, () => console.log(`mock Anthropic API on http://127.0.0.1:${PORT}`));
