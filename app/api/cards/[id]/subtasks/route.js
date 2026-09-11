import { sql } from '../../../../../lib/db';
import { json, options, authed } from '../../../../../lib/http';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export async function POST(req, { params }) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const cardId = Number(params.id);
  const b = await req.json();
  if (!b.title) return json({ error: 'title required' }, 400);
  const [{ max }] = await sql`select coalesce(max(position),0) as max from subtasks where card_id=${cardId}`;
  const [st] = await sql`insert into subtasks (card_id, title, position) values (${cardId}, ${b.title}, ${Number(max) + 1}) returning *`;
  await sql`update cards set updated_at=now() where id=${cardId}`;
  return json(st, 201);
}
