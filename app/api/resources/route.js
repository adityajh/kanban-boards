import { sql } from '../../../lib/db';
import { json, options, authed } from '../../../lib/http';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export async function GET(req) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  return json(await sql`select * from resources order by position, id`);
}
export async function POST(req) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const b = await req.json();
  if (!b.url || !b.label) return json({ error: 'label and url required' }, 400);
  const [{ max }] = await sql`select coalesce(max(position),0) as max from resources`;
  const [r] = await sql`insert into resources (label, url, category, position)
    values (${b.label}, ${b.url}, ${b.category || 'Brand & Reference'}, ${Number(max) + 1}) returning *`;
  return json(r, 201);
}
