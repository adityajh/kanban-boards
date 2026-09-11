import { sql } from '../../../../lib/db';
import { json, options, authed } from '../../../../lib/http';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

export async function GET(req, { params }) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const id = Number(params.id);
  const [card] = await sql`select * from cards where id=${id}`;
  if (!card) return json({ error: 'not found' }, 404);
  card.subtasks = await sql`select * from subtasks where card_id=${id} order by position, id`;
  card.links = await sql`select * from links where card_id=${id} order by id`;
  card.notes = await sql`select * from notes where card_id=${id} order by created_at, id`;
  return json(card);
}

export async function PATCH(req, { params }) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const id = Number(params.id);
  const b = await req.json();
  const [card] = await sql`update cards set
    title = coalesce(${b.title ?? null}, title),
    description = coalesce(${b.description ?? null}, description),
    status = coalesce(${b.status ?? null}, status),
    assignee = coalesce(${b.assignee ?? null}, assignee),
    tag = coalesce(${b.tag ?? null}, tag),
    position = coalesce(${b.position ?? null}, position),
    updated_at = now()
    where id=${id} returning *`;
  if (!card) return json({ error: 'not found' }, 404);
  return json(card);
}

export async function DELETE(req, { params }) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  await sql`delete from cards where id=${Number(params.id)}`;
  return json({ ok: true });
}
