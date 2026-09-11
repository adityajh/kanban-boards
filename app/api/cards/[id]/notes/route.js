import { sql } from '../../../../../lib/db';
import { json, options, idParam } from '../../../../../lib/http';
import { withTenant, ownsCard } from '../../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export const POST = withTenant(async (req, { params }, t) => {
  const cardId = idParam(params);
  if (!cardId || !(await ownsCard(cardId, t.id))) return json({ error: 'not found' }, 404);
  const b = await req.json();
  if (!b.body) return json({ error: 'body required' }, 400);
  const [nt] = await sql`insert into notes (card_id, author, body) values (${cardId}, ${b.author || 'Anon'}, ${b.body}) returning *`;
  await sql`update cards set updated_at=now() where id=${cardId}`;
  return json(nt, 201);
});
