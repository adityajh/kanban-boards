import { sql } from '../../../../../lib/db';
import { json, options, authed } from '../../../../../lib/http';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export async function POST(req, { params }) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const cardId = Number(params.id);
  const b = await req.json();
  if (!b.url) return json({ error: 'url required' }, 400);
  const [lk] = await sql`insert into links (card_id, label, url) values (${cardId}, ${b.label || ''}, ${b.url}) returning *`;
  await sql`update cards set updated_at=now() where id=${cardId}`;
  return json(lk, 201);
}
