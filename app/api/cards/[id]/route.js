import { sql } from '../../../../lib/db';
import { json, options, idParam } from '../../../../lib/http';
import { withTenant, clean, visibleAudiences, AUDIENCES } from '../../../../lib/tenant';
import { logEvent } from '../../../../lib/events';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// A card the caller may not see answers 404, the same as a card on another board: the
// refusal must not say whether the row exists.
export const GET = withTenant(async (req, { params }, t, c) => {
  const id = idParam(params);
  const [card] = id ? await sql`select * from cards
    where id=${id} and tenant_id=${t.id} and audience = any(${visibleAudiences(c)}::text[])` : [];
  if (!card) return json({ error: 'not found' }, 404);
  const out = clean(card);
  out.subtasks = await sql`select * from subtasks where card_id=${id} order by position, id`;
  out.links = await sql`select * from links where card_id=${id} order by id`;
  out.notes = await sql`select * from notes where card_id=${id} order by created_at, id`;
  return json(out);
});

export const PATCH = withTenant(async (req, { params }, t, c) => {
  const id = idParam(params);
  if (!id) return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => ({}));
  if (b.audience != null && !AUDIENCES.includes(b.audience)) {
    return json({ error: `audience must be one of ${AUDIENCES.join(', ')}` }, 400);
  }
  // An agent must not be able to hide a card from the people it is working for, nor
  // reach one that is already hidden from it.
  if (b.audience === 'human_only' && c.agent) {
    return json({ error: 'an agent cannot make a card human_only' }, 400);
  }
  const [before] = await sql`select status, audience from cards
    where id=${id} and tenant_id=${t.id} and audience = any(${visibleAudiences(c)}::text[])`;
  if (!before) return json({ error: 'not found' }, 404);
  const [card] = await sql`update cards set
    title = coalesce(${b.title ?? null}, title),
    description = coalesce(${b.description ?? null}, description),
    status = coalesce(${b.status ?? null}, status),
    assignee = coalesce(${b.assignee ?? null}, assignee),
    tag = coalesce(${b.tag ?? null}, tag),
    position = coalesce(${b.position ?? null}, position),
    audience = coalesce(${b.audience ?? null}, audience),
    due_at = coalesce(${b.due_at ?? null}, due_at),
    updated_at = now()
    where id=${id} and tenant_id=${t.id} returning *`;
  if (!card) return json({ error: 'not found' }, 404);
  // A column change is the event worth reading in a feed; everything else is an edit.
  if (card.status !== before.status) {
    await logEvent(c, t.id, 'card.moved', 'card', card.id,
      { from: before.status, to: card.status, title: card.title });
  } else {
    await logEvent(c, t.id, 'card.updated', 'card', card.id, { title: card.title });
  }
  return json(clean(card));
});

export const DELETE = withTenant(async (req, { params }, t, c) => {
  const id = idParam(params);
  const [gone] = id ? await sql`delete from cards
    where id=${id} and tenant_id=${t.id} and audience = any(${visibleAudiences(c)}::text[])
    returning id, title` : [];
  if (!gone) return json({ error: 'not found' }, 404);
  await logEvent(c, t.id, 'card.deleted', 'card', gone.id, { title: gone.title });
  return json({ ok: true });
});
