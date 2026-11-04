// POST /api/chat  { conversation_id?: string, message: string }
// Streams Karyon's reply as server-sent events:
//   meta  { conversation_id, model }    once per API call (model can change mid-reply)
//   scene { scene, caption?, svg? }     when Karyon repaints the background
//   text  { delta }                     reply text as it is generated
//   done  { stop_reason }               reply finished
//   error { code, message }             budget, limits, or upstream trouble
// Every visitor message, reply, tool call, and error is logged to D1.
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM, PAINT_TOOL, SCENE_NAMES, validatePaint, harnessNote } from '../_lib/karyon.js';
import { responseMicros, worstCaseMicros } from '../_lib/pricing.js';
import { reserve, settle, spentToday, countVisitorMessage } from '../_lib/budget.js';
import { utcDay, nowIso, num, json, isUuid, visitorId } from '../_lib/util.js';

const HISTORY_MESSAGES = 24; // earlier turns sent back to the model (12 exchanges)
const MAX_API_CALLS = 3; // per visitor message: paint, reply, and one spare
const MAX_TOKENS = 3072; // thinking + reply; also bounds the worst-case cost hold

const MESSAGES_FOR = {
  budget:
    "I've talked as much as I'm allowed to today. My budget resets at midnight UTC, so come back tomorrow. If you leave a message now, Michael will still read it.",
  visitor_limit: "We've talked a lot today. Let's pick this up tomorrow. Michael reads these, so anything you've said here will reach him.",
  conversation_limit: 'This conversation has reached its length limit. Reload the page to start a fresh one.',
  not_configured: "I'm not connected yet. Michael still needs to give me an API key.",
  busy: "Too many voices at once. I couldn't think. Try again in a moment?",
  upstream: 'Something went wrong on my side and I lost the thread. Try asking again?',
  refusal: "That's not something I can go into. Ask me something else about Michael?",
};

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: 'not_configured', message: MESSAGES_FOR.not_configured }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request', message: 'Expected a JSON body.' }, 400);
  }
  const maxChars = num(env.MAX_MESSAGE_CHARS, 1500);
  const text = typeof body?.message === 'string' ? body.message.replace(/\u0000/g, '').trim() : '';
  if (!text) return json({ error: 'empty', message: 'Say something first.' }, 400);
  if (text.length > maxChars) {
    return json({ error: 'too_long', message: `Keep it under ${maxChars} characters.` }, 400);
  }

  const db = env.DB;
  const day = utcDay();
  const visitor = await visitorId(request, env);
  const maxTurns = num(env.MAX_TURNS_PER_CONVERSATION, 40);

  // Find or start the conversation. Ids are random UUIDs made by this server.
  let conversationId = isUuid(body.conversation_id) ? body.conversation_id : null;
  let convo = conversationId
    ? await db.prepare('SELECT id, turns FROM conversations WHERE id = ?1').bind(conversationId).first()
    : null;
  if (!convo) {
    conversationId = crypto.randomUUID();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO conversations (id, created_at, updated_at, visitor, country, user_agent, referer)
         VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(
        conversationId,
        now,
        visitor,
        request.cf?.country || null,
        (request.headers.get('user-agent') || '').slice(0, 300),
        (request.headers.get('referer') || '').slice(0, 300),
      )
      .run();
    convo = { id: conversationId, turns: 0 };
  }

  const turn = convo.turns + 1;
  await logMessage(db, conversationId, { role: 'user', content: text });

  const refuseEarly = async (code, status) => {
    await logMessage(db, conversationId, { role: 'event', content: code });
    return json({ error: code, message: MESSAGES_FOR[code], conversation_id: conversationId }, status);
  };
  if (!env.ANTHROPIC_API_KEY) return refuseEarly('not_configured', 503);
  if (convo.turns >= maxTurns) return refuseEarly('conversation_limit', 429);
  const visitorCount = await countVisitorMessage(db, visitor, day);
  if (visitorCount > num(env.MAX_MESSAGES_PER_VISITOR_PER_DAY, 60)) return refuseEarly('visitor_limit', 429);

  const [history, currentScene] = await Promise.all([
    loadHistory(db, conversationId),
    lastScene(db, conversationId),
  ]);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let clientGone = false;
  let activeStream = null;
  const send = (event, data) => {
    if (clientGone) return;
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {
      // The visitor closed the tab: stop generating so we stop paying for it.
      clientGone = true;
      activeStream?.abort();
    });
  };

  const run = async () => {
    try {
      await reply({
        env, db, day, conversationId, text, history, currentScene, turn, maxTurns, send,
        setActive: (s) => (activeStream = s),
        isGone: () => clientGone,
      });
    } catch (err) {
      console.error('karyon reply failed', err);
      send('error', { code: 'upstream', message: MESSAGES_FOR.upstream });
      await logMessage(db, conversationId, { role: 'event', content: `crash: ${String(err?.message || err).slice(0, 500)}` }).catch(() => {});
    } finally {
      writer.close().catch(() => {});
    }
  };
  context.waitUntil(run());

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}

async function reply({ env, db, day, conversationId, text, history, currentScene, turn, maxTurns, send, setActive, isGone }) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Only set for local testing against scripts/mock-anthropic.mjs.
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    maxRetries: 1,
    timeout: 90_000,
  });
  const limitMicros = Math.round(num(env.DAILY_LIMIT_USD, 1) * 1e6);
  const economyAfterMicros = Math.round(num(env.KARYON_ECONOMY_AFTER_USD, 0.5) * 1e6);
  const primary = env.KARYON_MODEL || 'claude-haiku-5-5';
  const economy = env.KARYON_ECONOMY_MODEL || 'claude-haiku-5-5';

  const messages = [
    ...history,
    { role: 'user', content: text },
    { role: 'system', content: harnessNote({ scene: currentScene, turn, maxTurns, day }) },
  ];

  let painted = null;
  let replyText = '';
  let stopReason = null;
  let lastModel = null;
  let totalMicros = 0;
  const calls = [];
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (let call = 0; call < MAX_API_CALLS && !isGone(); call++) {
    const { spent } = await spentToday(db, day);
    let model = spent >= economyAfterMicros ? economy : primary;
    let params = buildParams(env, model, messages, call === MAX_API_CALLS - 1);
    let hold = await reserve(db, day, holdFor(env, params), limitMicros);
    if (!hold && model !== economy) {
      model = economy;
      params = buildParams(env, model, messages, call === MAX_API_CALLS - 1);
      hold = await reserve(db, day, holdFor(env, params), limitMicros);
    }
    if (!hold) {
      stopReason = 'budget';
      if (!replyText) send('text', { delta: MESSAGES_FOR.budget });
      replyText ||= MESSAGES_FOR.budget;
      await logMessage(db, conversationId, { role: 'event', content: 'budget: daily limit reached' });
      break;
    }

    send('meta', { conversation_id: conversationId, model });
    let message = null;
    let failure = null;
    const stream = client.beta.messages.stream(params);
    setActive(stream);
    stream.on('text', (delta) => {
      replyText += delta;
      send('text', { delta });
    });
    stream.on('contentBlock', (block) => {
      // Repaint as soon as the tool call is complete, before the reply text.
      if (block.type !== 'tool_use' || block.name !== PAINT_TOOL.name || painted) return;
      const check = validatePaint(block.input);
      if (check.ok) {
        painted = check.value;
        send('scene', painted);
      }
    });
    try {
      message = await stream.finalMessage();
    } catch (err) {
      failure = err;
    } finally {
      setActive(null);
    }

    // Book the real cost, even for a failed or aborted call.
    const used = message || stream.currentMessage;
    const micros = used ? responseMicros(used, model) : 0;
    await settle(db, day, hold, micros);
    totalMicros += micros;
    lastModel = used?.model || model;
    if (used?.usage) {
      tokens.input += used.usage.input_tokens || 0;
      tokens.output += used.usage.output_tokens || 0;
      tokens.cacheRead += used.usage.cache_read_input_tokens || 0;
      tokens.cacheWrite += used.usage.cache_creation_input_tokens || 0;
    }
    calls.push({ model: lastModel, stop_reason: used?.stop_reason || null, usage: used?.usage || null, content: used?.content || [] });

    if (failure) {
      stopReason = isGone() ? 'client_closed' : 'error';
      if (!isGone()) {
        const code = errorCode(failure);
        send('error', { code, message: MESSAGES_FOR[code] });
        await logMessage(db, conversationId, { role: 'event', content: `api error (${code}): ${String(failure.message).slice(0, 500)}` });
      }
      break;
    }

    stopReason = message.stop_reason;
    if (stopReason === 'refusal') {
      if (!replyText.trim()) {
        replyText = MESSAGES_FOR.refusal;
        send('text', { delta: replyText });
      }
      break;
    }

    const toolUses = message.content.filter((b) => b.type === 'tool_use');
    // max_tokens with a tool call means its input may be cut off: don't run it.
    if (stopReason !== 'tool_use' || toolUses.length === 0) break;
    for (const use of toolUses) {
      if (painted || use.name !== PAINT_TOOL.name) continue;
      const check = validatePaint(use.input);
      if (check.ok) {
        painted = check.value;
        send('scene', painted);
      }
    }

    messages.push({ role: 'assistant', content: message.content });
    messages.push({ role: 'user', content: toolUses.map((use) => toolResult(use, painted)) });
  }

  if (!replyText.trim() && stopReason !== 'client_closed' && stopReason !== 'error' && stopReason !== 'budget') {
    // A turn that only repainted the background still owes the visitor words.
    replyText = '…';
    send('text', { delta: replyText });
  }
  send('done', { stop_reason: stopReason });

  await logMessage(db, conversationId, {
    role: 'assistant',
    content: replyText,
    raw_json: JSON.stringify(calls),
    model: lastModel,
    scene: painted?.scene || null,
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cache_read_tokens: tokens.cacheRead,
    cache_write_tokens: tokens.cacheWrite,
    cost_micros: totalMicros,
    stop_reason: stopReason,
  });
  await db
    .prepare('UPDATE conversations SET turns = turns + 1, cost_micros = cost_micros + ?1, updated_at = ?2 WHERE id = ?3')
    .bind(totalMicros, nowIso(), conversationId)
    .run();
}

function buildParams(env, model, messages, lastCall) {
  const params = {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    tools: [PAINT_TOOL],
    messages,
    // Thinking is adaptive (the default on both models); effort sets how much.
    output_config: { effort: model === (env.KARYON_ECONOMY_MODEL || 'claude-haiku-5-5') ? env.KARYON_ECONOMY_EFFORT || 'medium' : env.KARYON_EFFORT || 'low' },
    // Also cache the growing conversation, not just the system prompt.
    cache_control: { type: 'ephemeral' },
  };
  // On the last allowed call, insist on words rather than another repaint.
  if (lastCall) params.tool_choice = { type: 'none' };
  // Haiku 5.5 has no server-side fallback; Opus-class models do.
  if (usesFallback(env, model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

const usesFallback = (env, model) => (env.KARYON_FALLBACKS || 'default') === 'default' && /^claude-(opus|fable|sonnet)/.test(model);

function holdFor(env, params) {
  return worstCaseMicros(params.model, JSON.stringify(params).length, params.max_tokens, usesFallback(env, params.model));
}

function toolResult(use, painted) {
  if (use.name !== PAINT_TOOL.name) {
    return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown tool ${use.name}.` };
  }
  const check = validatePaint(use.input);
  if (!check.ok) {
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      is_error: true,
      content: JSON.stringify({ INVALID_INPUT: check.error, received: JSON.stringify(use.input).slice(0, 2000) }),
    };
  }
  const shown = painted && painted.scene === check.value.scene && (painted.svg || '') === (check.value.svg || '');
  return {
    type: 'tool_result',
    tool_use_id: use.id,
    content: shown
      ? `The background now shows "${painted.scene}". Now write your reply to the visitor.`
      : `The background was already repainted once in this reply, so it still shows "${painted?.scene}". Write your reply to the visitor now.`,
  };
}

function errorCode(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return 'not_configured';
  if (err instanceof Anthropic.RateLimitError) return 'busy';
  if (err instanceof Anthropic.APIError && (err.status === 529 || err.status === 503)) return 'busy';
  return 'upstream';
}

// Earlier turns go back to the model as plain text. Thinking blocks and tool
// calls from finished turns are not replayed, which keeps every request
// append-only within a turn and lets the model change between turns.
async function loadHistory(db, conversationId) {
  const { results } = await db
    .prepare(
      `SELECT role, content FROM messages
       WHERE conversation_id = ?1 AND role IN ('user', 'assistant')
       ORDER BY id DESC LIMIT ?2 OFFSET 1`,
    )
    .bind(conversationId, HISTORY_MESSAGES)
    .all();
  const rows = results.reverse().filter((r) => r.content && r.content !== '…');
  while (rows.length && rows[0].role !== 'user') rows.shift();
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.role === r.role) last.content += `\n\n${r.content}`;
    else out.push({ role: r.role, content: r.content });
  }
  // The newest message is added by the caller, so history must end on Karyon.
  while (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}

async function lastScene(db, conversationId) {
  const row = await db
    .prepare(`SELECT scene FROM messages WHERE conversation_id = ?1 AND scene IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .bind(conversationId)
    .first();
  return SCENE_NAMES.includes(row?.scene) ? row.scene : 'eyes';
}

async function logMessage(db, conversationId, m) {
  await db
    .prepare(
      `INSERT INTO messages (conversation_id, created_at, role, content, raw_json, model, scene,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros, stop_reason)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(
      conversationId,
      nowIso(),
      m.role,
      m.content,
      m.raw_json ?? null,
      m.model ?? null,
      m.scene ?? null,
      m.input_tokens ?? null,
      m.output_tokens ?? null,
      m.cache_read_tokens ?? null,
      m.cache_write_tokens ?? null,
      m.cost_micros ?? null,
      m.stop_reason ?? null,
    )
    .run();
}
