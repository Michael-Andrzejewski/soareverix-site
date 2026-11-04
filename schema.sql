-- Karyon conversation logs and spend ledger (Cloudflare D1 / SQLite).
-- Apply with: npm run db:init   (or db:init:local for wrangler pages dev)

CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,          -- random UUID made by the server
  created_at   TEXT NOT NULL,             -- ISO 8601 UTC
  updated_at   TEXT NOT NULL,
  visitor      TEXT,                      -- salted SHA-256 of the IP (never the raw IP)
  country      TEXT,                      -- Cloudflare's country code
  user_agent   TEXT,
  referer      TEXT,
  turns        INTEGER NOT NULL DEFAULT 0,
  cost_micros  INTEGER NOT NULL DEFAULT 0 -- 1e-6 USD
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);

-- Every visitor message, every Karyon reply (with the raw API content blocks,
-- tool calls and usage), and every refusal, error or limit event.
CREATE TABLE IF NOT EXISTS messages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id    TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  role               TEXT NOT NULL,       -- 'user' | 'assistant' | 'event'
  content            TEXT NOT NULL,       -- what was shown on screen
  raw_json           TEXT,                -- assistant: every API response's content blocks
  model              TEXT,
  scene              TEXT,                -- background painted during this reply
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_micros        INTEGER,
  stop_reason        TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

-- One row per UTC day: what the API calls actually cost (from response usage).
CREATE TABLE IF NOT EXISTS daily_spend (
  day          TEXT PRIMARY KEY,          -- YYYY-MM-DD (UTC)
  spent_micros INTEGER NOT NULL DEFAULT 0,
  requests     INTEGER NOT NULL DEFAULT 0
);

-- Worst-case cost of each API call in flight. A call only starts if
-- spent + live holds + its own hold fits under the daily limit, so concurrent
-- visitors can never push the day past it. Holds expire on their own, so a
-- crashed request can't lock the budget.
CREATE TABLE IF NOT EXISTS spend_holds (
  id         TEXT PRIMARY KEY,
  day        TEXT NOT NULL,
  micros     INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_holds_day ON spend_holds(day, expires_at);

-- Messages per visitor per day, for the abuse limit.
CREATE TABLE IF NOT EXISTS visitor_days (
  visitor  TEXT NOT NULL,
  day      TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor, day)
);

-- Extra time Karyon has given a visitor today, and how much of it they've used.
-- functions/_lib/budget.js also creates this table when it's missing.
CREATE TABLE IF NOT EXISTS visitor_extensions (
  visitor      TEXT NOT NULL,
  day          TEXT NOT NULL,
  extensions   INTEGER NOT NULL DEFAULT 0,
  bonus_micros INTEGER NOT NULL DEFAULT 0,
  over_micros  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor, day)
);
