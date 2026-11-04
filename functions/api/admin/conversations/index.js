// GET /api/admin/conversations?limit=50&before=<iso>
// Authorization: Bearer <ADMIN_TOKEN>
import { spentToday } from '../../../_lib/budget.js';
import { utcDay, num, json, isAdmin } from '../../../_lib/util.js';

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return json({ error: 'not_found' }, 404);
  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, num(url.searchParams.get('limit'), 50)));
  const before = url.searchParams.get('before') || '9999';
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.created_at, c.updated_at, c.turns, c.cost_micros, c.country, c.user_agent, c.visitor,
            (SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS first_message
     FROM conversations c WHERE c.updated_at < ?1 ORDER BY c.updated_at DESC LIMIT ?2`,
  )
    .bind(before, limit)
    .all();
  const day = utcDay();
  const today = await spentToday(env.DB, day);
  const totals = await env.DB.prepare(
    'SELECT COUNT(*) AS conversations, COALESCE(SUM(turns), 0) AS turns, COALESCE(SUM(cost_micros), 0) AS cost_micros FROM conversations',
  ).first();
  return json({
    today: {
      day,
      spent_usd: today.spent / 1e6,
      held_usd: today.held / 1e6,
      limit_usd: num(env.DAILY_LIMIT_USD, 1),
      api_calls: today.requests,
    },
    all_time: { conversations: totals.conversations, turns: totals.turns, cost_usd: totals.cost_micros / 1e6 },
    conversations: results,
  });
}
