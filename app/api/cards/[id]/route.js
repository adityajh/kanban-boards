import { sql } from '../../../../lib/db';
import { json, options, idParam } from '../../../../lib/http';
import { withTenant, clean } from '../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

export const GET = withTenant(async (req, { params }, t) => {
  const id = idParam(params);
  const [card] = id ? await sql`select * from cards where id=${id} and tenant_id=${t.id}` : [];
  if (!card) return json({ error: 'not found' }, 404);
  const out = clean(card);
  out.subtasks = await sql`select * from subtasks where card_id=${id} order by position, id`;
  out.links = await sql`select * from links where card_id=${id} order by id`;
  out.notes = await sql`select * from notes where card_id=${id} order by created_at, id`;
  return json(out);
});

export const PATCH = withTenant(async (req, { params }, t) => {
  const id = idParam(params);
  if (!id) return json({ error: 'not found' }, 404);
  const b = await req.json();
  const [card] = await sql`update cards set
    title = coalesce(${b.title ?? null}, title),
    description = coalesce(${b.description ?? null}, description),
    status = coalesce(${b.status ?? null}, status),
    assignee = coalesce(${b.assignee ?? null}, assignee),
    tag = coalesce(${b.tag ?? null}, tag),
    position = coalesce(${b.position ?? null}, position),
    updated_at = now()
    where id=${id} and tenant_id=${t.id} returning *`;
  if (!card) return json({ error: 'not found' }, 404);
  return json(clean(card));
});

export const DELETE = withTenant(async (req, { params }, t) => {
  const id = idParam(params);
  const [gone] = id ? await sql`delete from cards where id=${id} and tenant_id=${t.id} returning id` : [];
  if (!gone) return json({ error: 'not found' }, 404);
  return json({ ok: true });
});
