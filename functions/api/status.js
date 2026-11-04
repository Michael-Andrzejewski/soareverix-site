// GET /api/status -> { configured, open, model, closed_until }
// Lets the page say when Karyon is resting (budget spent) before anyone types,
// and show the static page to a visitor Karyon has stopped talking with.
import { spentToday } from '../_lib/budget.js';
import { closedUntil } from '../_lib/closures.js';
import { utcDay, num, json, visitorId } from '../_lib/util.js';

export async function onRequestGet({ env, request }) {
  const configured = Boolean(env.ANTHROPIC_API_KEY && env.DB);
  if (!configured) return json({ configured, open: false, model: null });
  const { spent, held } = await spentToday(env.DB, utcDay());
  const limit = num(env.DAILY_LIMIT_USD, 1) * 1e6;
  const economyAfter = num(env.KARYON_ECONOMY_AFTER_USD, 0.5) * 1e6;
  // "Open" if at least a cheap reply still fits under today's limit.
  const open = spent + held + 20_000 <= limit;
  const model = spent >= economyAfter ? env.KARYON_ECONOMY_MODEL || 'claude-haiku-5-5' : env.KARYON_MODEL || 'claude-haiku-5-5';
  const closed_until = await closedUntil(env.DB, await visitorId(request, env));
  return json({ configured, open, model, closed_until });
}
