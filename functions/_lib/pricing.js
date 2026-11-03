// Anthropic API prices in USD per million tokens. Used to keep the daily spend
// under DAILY_LIMIT_USD. Where the price sheet has a cheaper cache-read rate we
// still charge cache reads at 0.1x input: the ledger should round up, not down.
// Check https://platform.claude.com/docs/en/about-claude/pricing when models change.
const RATES = {
  'claude-opus-5-5': { in: 4, out: 20 },
  // Haiku 5.5 has a second rate card for prompts over 100K tokens.
  'claude-haiku-5-5': { in: 0.1, out: 0.5, longAt: 100_000, longIn: 0.5, longOut: 2.5 },
  // Possible server-side refusal fallbacks for Opus 5.5.
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
};
// Anything not listed is charged at the most expensive tier we know of.
const UNKNOWN = { in: 10, out: 50 };
const FALLBACK_TIER = { in: 5, out: 25 };

export function rateFor(model, promptTokens = 0) {
  const key = Object.keys(RATES).find((k) => model === k || (model || '').startsWith(`${k}-`));
  const r = key ? RATES[key] : UNKNOWN;
  if (r.longAt && promptTokens > r.longAt) return { in: r.longIn, out: r.longOut };
  return { in: r.in, out: r.out };
}

function usageMicros(u, model) {
  const input = u.input_tokens || 0;
  const write = u.cache_creation_input_tokens || 0;
  const read = u.cache_read_input_tokens || 0;
  const out = u.output_tokens || 0;
  const r = rateFor(model, input + write + read);
  // 5-minute cache writes cost 1.25x input.
  const usd = (input * r.in + write * r.in * 1.25 + read * r.in * 0.1 + out * r.out) / 1e6;
  return Math.ceil(usd * 1e6);
}

// Cost of one API response. With server-side fallback, usage.iterations has one
// entry per model that ran, each with its own model and token counts.
export function responseMicros(message, requestedModel) {
  const usage = message?.usage;
  if (!usage) return 0;
  const its = Array.isArray(usage.iterations) ? usage.iterations : [];
  if (its.length) {
    return its.reduce((sum, it) => sum + usageMicros(it, it.model || message.model || requestedModel), 0);
  }
  return usageMicros(usage, message.model || requestedModel);
}

// Worst case for one call: every prompt token is a fresh cache write and the
// reply runs to max_tokens. Prompt size is estimated from the request JSON
// (about 3 characters per token, which over-counts English text).
export function worstCaseMicros(model, requestChars, maxTokens, withFallback) {
  const promptTokens = Math.ceil(requestChars / 3) + 256;
  let r = rateFor(model, promptTokens);
  if (withFallback) r = { in: Math.max(r.in, FALLBACK_TIER.in), out: Math.max(r.out, FALLBACK_TIER.out) };
  return Math.ceil(((promptTokens * r.in * 1.25 + maxTokens * r.out) / 1e6) * 1e6);
}
