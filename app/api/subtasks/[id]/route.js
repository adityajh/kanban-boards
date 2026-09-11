import { sql } from '../../../../lib/db';
import { json, options, idParam } from '../../../../lib/http';
import { withTenant } from '../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Subtasks have no tenant_id of their own: they're scoped through their card.
export const PATCH = withTenant(async (req, { params }, t) => {
  const id = idParam(params);
  if (!id) return json({ error: 'not found' }, 404);
  const b = await req.json();
  const [st] = await sql`update subtasks s set
    title = coalesce(${b.title ?? null}, s.title),
    done = coalesce(${b.done ?? null}, s.done),
    position = coalesce(${b.position ?? null}, s.position)
    from cards c
    where s.id=${id} and c.id=s.card_id and c.tenant_id=${t.id}
    returning s.*`;
  if (!st) return json({ error: 'not found' }, 404);
  await sql`update cards set updated_at=now() where id=${st.card_id}`;
  return json(st);
});

export const DELETE = withTenant(async (req, { params }, t) => {
  const id = idParam(params);
  const [st] = id ? await sql`delete from subtasks s using cards c
    where s.id=${id} and c.id=s.card_id and c.tenant_id=${t.id} returning s.card_id` : [];
  if (!st) return json({ error: 'not found' }, 404);
  await sql`update cards set updated_at=now() where id=${st.card_id}`;
  return json({ ok: true });
});
