import { sql } from '../../../../../lib/db';
import { json, options, idParam } from '../../../../../lib/http';
import { withTenant, ownsCard } from '../../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export const POST = withTenant(async (req, { params }, t) => {
  const cardId = idParam(params);
  if (!cardId || !(await ownsCard(cardId, t.id))) return json({ error: 'not found' }, 404);
  const b = await req.json();
  if (!b.url) return json({ error: 'url required' }, 400);
  const [lk] = await sql`insert into links (card_id, label, url) values (${cardId}, ${b.label || ''}, ${b.url}) returning *`;
  await sql`update cards set updated_at=now() where id=${cardId}`;
  return json(lk, 201);
});
