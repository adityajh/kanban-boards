import { sql } from '../../../../../lib/db';
import { json, options, idParam } from '../../../../../lib/http';
import { withTenant, ownsCard } from '../../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export const POST = withTenant(async (req, { params }, t) => {
  const cardId = idParam(params);
  if (!cardId || !(await ownsCard(cardId, t.id))) return json({ error: 'not found' }, 404);
  const b = await req.json();
  if (!b.title) return json({ error: 'title required' }, 400);
  const [{ max }] = await sql`select coalesce(max(position),0) as max from subtasks where card_id=${cardId}`;
  const [st] = await sql`insert into subtasks (card_id, title, position) values (${cardId}, ${b.title}, ${Number(max) + 1}) returning *`;
  await sql`update cards set updated_at=now() where id=${cardId}`;
  return json(st, 201);
});
