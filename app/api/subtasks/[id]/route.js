import { sql } from '../../../../lib/db';
import { json, options, authed } from '../../../../lib/http';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export async function PATCH(req, { params }) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const id = Number(params.id);
  const b = await req.json();
  const [st] = await sql`update subtasks set
    title = coalesce(${b.title ?? null}, title),
    done = coalesce(${b.done ?? null}, done),
    position = coalesce(${b.position ?? null}, position)
    where id=${id} returning *`;
  if (!st) return json({ error: 'not found' }, 404);
  await sql`update cards set updated_at=now() where id=${st.card_id}`;
  return json(st);
}
export async function DELETE(req, { params }) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const [st] = await sql`delete from subtasks where id=${Number(params.id)} returning card_id`;
  if (st) await sql`update cards set updated_at=now() where id=${st.card_id}`;
  return json({ ok: true });
}
