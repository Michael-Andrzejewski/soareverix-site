// When Karyon ends a conversation, it stops talking with that visitor for a while.
// Each ending is an 'ended: <reason>' event in the messages table. The wait grows
// with repeat endings in the last 90 days: a day, then a week, then a month.
// To lift one by hand, delete the visitor's 'ended:' rows from messages.
import { nowIso } from './util.js';

const WAIT_DAYS = [1, 7, 30];
const WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const endings = async (db, visitor) => {
  const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT m.created_at FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.visitor = ?1 AND m.role = 'event' AND m.content LIKE 'ended:%' AND m.created_at >= ?2
       ORDER BY m.id DESC LIMIT 10`,
    )
    .bind(visitor, since)
    .all();
  return results;
};

// The time this visitor can talk again, or null if they can talk now.
export async function closedUntil(db, visitor) {
  const rows = await endings(db, visitor);
  if (!rows.length) return null;
  const wait = WAIT_DAYS[Math.min(rows.length, WAIT_DAYS.length) - 1];
  const until = new Date(new Date(rows[0].created_at).getTime() + wait * DAY_MS);
  return until.getTime() > Date.now() ? until.toISOString() : null;
}

// Records an ending and returns when the visitor can talk again.
export async function closeConversation(db, conversationId, visitor, reason) {
  await db
    .prepare(`INSERT INTO messages (conversation_id, created_at, role, content) VALUES (?1, ?2, 'event', ?3)`)
    .bind(conversationId, nowIso(), `ended: ${reason}`)
    .run();
  return closedUntil(db, visitor);
}
