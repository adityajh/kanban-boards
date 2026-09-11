import { sql } from '../../../lib/db';
import { json, options } from '../../../lib/http';
import { withTenant, clean } from '../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export const GET = withTenant(async (req, ctx, t) => {
  const rows = await sql`select * from resources where tenant_id=${t.id} order by position, id`;
  return json(rows.map(clean));
});
export const POST = withTenant(async (req, ctx, t) => {
  const b = await req.json();
  if (!b.url || !b.label) return json({ error: 'label and url required' }, 400);
  const [{ max }] = await sql`select coalesce(max(position),0) as max from resources where tenant_id=${t.id}`;
  const [r] = await sql`insert into resources (tenant_id, label, url, category, position)
    values (${t.id}, ${b.label}, ${b.url}, ${b.category || 'Brand & Reference'}, ${Number(max) + 1}) returning *`;
  return json(clean(r), 201);
});
