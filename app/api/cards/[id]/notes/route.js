import { sql } from '../../../../../lib/db';
import { json, options, authed } from '../../../../../lib/http';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export async function POST(req, { params }) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const cardId = Number(params.id);
  const b = await req.json();
  if (!b.body) return json({ error: 'body required' }, 400);
  const [nt] = await sql`insert into notes (card_id, author, body) values (${cardId}, ${b.author || 'Anon'}, ${b.body}) returning *`;
  await sql`update cards set updated_at=now() where id=${cardId}`;
  return json(nt, 201);
}
