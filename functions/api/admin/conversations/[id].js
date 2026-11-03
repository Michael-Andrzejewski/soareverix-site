// GET /api/admin/conversations/:id  -> the conversation and every logged message
// Authorization: Bearer <ADMIN_TOKEN>
import { json, isAdmin, isUuid } from '../../../_lib/util.js';

export async function onRequestGet({ request, env, params }) {
  if (!isAdmin(request, env)) return json({ error: 'not_found' }, 404);
  if (!isUuid(params.id)) return json({ error: 'bad_id' }, 400);
  const conversation = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?1').bind(params.id).first();
  if (!conversation) return json({ error: 'not_found' }, 404);
  const { results } = await env.DB.prepare('SELECT * FROM messages WHERE conversation_id = ?1 ORDER BY id')
    .bind(params.id)
    .all();
  const messages = results.map((m) => ({ ...m, raw: m.raw_json ? JSON.parse(m.raw_json) : null, raw_json: undefined }));
  return json({ conversation, messages });
}
