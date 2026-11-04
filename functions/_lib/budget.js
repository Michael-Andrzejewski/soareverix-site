// Daily spend ledger in D1. See schema.sql for the tables.

const HOLD_MINUTES = 10;

export async function spentToday(db, day) {
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT COALESCE((SELECT spent_micros FROM daily_spend WHERE day = ?1), 0) AS spent,
              COALESCE((SELECT SUM(micros) FROM spend_holds WHERE day = ?1 AND expires_at > ?2), 0) AS held,
              COALESCE((SELECT requests FROM daily_spend WHERE day = ?1), 0) AS requests`,
    )
    .bind(day, now)
    .first();
  return { spent: row?.spent || 0, held: row?.held || 0, requests: row?.requests || 0 };
}

// Places a hold for the worst-case cost of one call. Returns the hold id, or
// null if the call could push today past the limit. The insert and the check
// run as one statement, so two visitors can't both squeeze into the last cents.
export async function reserve(db, day, micros, limitMicros) {
  const id = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + HOLD_MINUTES * 60_000).toISOString();
  const [, insert] = await db.batch([
    db.prepare('INSERT INTO daily_spend (day) VALUES (?1) ON CONFLICT(day) DO NOTHING').bind(day),
    db
      .prepare(
        `INSERT INTO spend_holds (id, day, micros, expires_at)
         SELECT ?1, ?2, ?3, ?4
         WHERE (SELECT spent_micros FROM daily_spend WHERE day = ?2)
             + (SELECT COALESCE(SUM(micros), 0) FROM spend_holds WHERE day = ?2 AND expires_at > ?5)
             + ?3 <= ?6`,
      )
      .bind(id, day, micros, expires, now.toISOString(), limitMicros),
  ]);
  return insert.meta.changes === 1 ? id : null;
}

// Releases the hold and books what the call actually cost.
export async function settle(db, day, holdId, actualMicros) {
  const stale = new Date(Date.now() - 24 * 3600_000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM spend_holds WHERE id = ?1 OR expires_at < ?2').bind(holdId, stale),
    db
      .prepare('UPDATE daily_spend SET spent_micros = spent_micros + ?1, requests = requests + 1 WHERE day = ?2')
      .bind(Math.max(0, Math.ceil(actualMicros)), day),
  ]);
}

export async function countVisitorMessage(db, visitor, day) {
  const row = await db
    .prepare(
      `INSERT INTO visitor_days (visitor, day, messages) VALUES (?1, ?2, 1)
       ON CONFLICT(visitor, day) DO UPDATE SET messages = messages + 1
       RETURNING messages`,
    )
    .bind(visitor, day)
    .first();
  return row?.messages || 1;
}

// ---------- extra time ----------
// Karyon can give a visitor extra spending past the limits. bonus_micros is what
// Karyon has given them today, and over_micros is how much of it they've used.
// The table creates itself, so a deploy needs no database step.
let extensionsReady = false;
async function ensureExtensions(db) {
  if (extensionsReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS visitor_extensions (
         visitor      TEXT NOT NULL,
         day          TEXT NOT NULL,
         extensions   INTEGER NOT NULL DEFAULT 0,
         bonus_micros INTEGER NOT NULL DEFAULT 0,
         over_micros  INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (visitor, day)
       )`,
    )
    .run();
  extensionsReady = true;
}

export async function extensionState(db, visitor, day) {
  await ensureExtensions(db);
  const row = await db
    .prepare(
      `SELECT COALESCE((SELECT extensions FROM visitor_extensions WHERE visitor = ?1 AND day = ?2), 0) AS extensions,
              COALESCE((SELECT bonus_micros FROM visitor_extensions WHERE visitor = ?1 AND day = ?2), 0) AS bonus,
              COALESCE((SELECT over_micros FROM visitor_extensions WHERE visitor = ?1 AND day = ?2), 0) AS over,
              COALESCE((SELECT SUM(bonus_micros) FROM visitor_extensions WHERE day = ?2), 0) AS total`,
    )
    .bind(visitor, day)
    .first();
  return { extensions: row?.extensions || 0, bonus: row?.bonus || 0, over: row?.over || 0, total: row?.total || 0 };
}

// Adds extra time, unless that would pass the per-visitor or daily ceiling. The
// check and the update run as one statement. Returns true if it was granted.
export async function grantExtension(db, visitor, day, micros, maxPerVisitor, maxTotalMicros) {
  await ensureExtensions(db);
  const [, update] = await db.batch([
    db.prepare('INSERT INTO visitor_extensions (visitor, day) VALUES (?1, ?2) ON CONFLICT(visitor, day) DO NOTHING').bind(visitor, day),
    db
      .prepare(
        `UPDATE visitor_extensions SET extensions = extensions + 1, bonus_micros = bonus_micros + ?3
         WHERE visitor = ?1 AND day = ?2 AND extensions < ?4
           AND (SELECT SUM(bonus_micros) FROM visitor_extensions WHERE day = ?2) + ?3 <= ?5`,
      )
      .bind(visitor, day, micros, maxPerVisitor, maxTotalMicros),
  ]);
  return update.meta.changes === 1;
}

export async function useExtension(db, visitor, day, micros) {
  await db
    .prepare('UPDATE visitor_extensions SET over_micros = over_micros + ?3 WHERE visitor = ?1 AND day = ?2')
    .bind(visitor, day, Math.max(0, Math.ceil(micros)))
    .run();
}
