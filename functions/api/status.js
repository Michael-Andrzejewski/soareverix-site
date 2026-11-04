// GET /api/status -> { configured, open, model }
// Lets the page say when Karyon is resting (budget spent) before anyone types.
import { spentToday } from '../_lib/budget.js';
import { utcDay, num, json } from '../_lib/util.js';

export async function onRequestGet({ env }) {
  const configured = Boolean(env.ANTHROPIC_API_KEY && env.DB);
  if (!configured) return json({ configured, open: false, model: null });
  const { spent, held } = await spentToday(env.DB, utcDay());
  const limit = num(env.DAILY_LIMIT_USD, 1) * 1e6;
  const economyAfter = num(env.KARYON_ECONOMY_AFTER_USD, 0.5) * 1e6;
  // "Open" if at least a cheap reply still fits under today's limit.
  const open = spent + held + 20_000 <= limit;
  const model = spent >= economyAfter ? env.KARYON_ECONOMY_MODEL || 'claude-haiku-5-5' : env.KARYON_MODEL || 'claude-haiku-5-5';
  return json({ configured, open, model });
}
