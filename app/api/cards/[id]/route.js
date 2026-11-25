import { sql } from '../../../../lib/db';
import { json, options, idParam } from '../../../../lib/http';
import { withTenant, clean, visibleAudiences, AUDIENCES } from '../../../../lib/tenant';
import { logEvent } from '../../../../lib/events';
import { statusRefusal, answeredRefusal } from '../../../../lib/cards.mjs';
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
  const badStatus = statusRefusal(b.status);
  if (badStatus) return json(badStatus, 422);
  const badAnswered = answeredRefusal(b.answered, c);
  if (badAnswered) return json(badAnswered, 422);
  const [before] = await sql`select status, audience, assignee from cards
    where id=${id} and tenant_id=${t.id} and audience = any(${visibleAudiences(c)}::text[])`;
  if (!before) return json({ error: 'not found' }, 404);
  // An empty-string status means "leave it alone" to statusRefusal, so it is turned into null
  // here as well; passed through, coalesce would keep the '' and the check constraint would
  // answer 500.
  const nextStatus = b.status || null;
  // A finished card held by a lease nobody will release is a card that looks busy forever,
  // so reaching 'done' drops the claim in the same statement as the move. All three columns
  // go together because the table's check constraint ties the holder to its expiry.
  const releaseClaim = (nextStatus || before.status) === 'done';
  const [card] = await sql`update cards set
    title = coalesce(${b.title ?? null}, title),
    description = coalesce(${b.description ?? null}, description),
    status = coalesce(${nextStatus}, status),
    assignee = coalesce(${b.assignee ?? null}, assignee),
    tag = coalesce(${b.tag ?? null}, tag),
    position = coalesce(${b.position ?? null}, position),
    audience = coalesce(${b.audience ?? null}, audience),
    due_at = coalesce(${b.due_at ?? null}, due_at),
    answered = coalesce(${b.answered ?? null}, answered),
    claimed_by = case when ${releaseClaim}::boolean then null else claimed_by end,
    claimed_at = case when ${releaseClaim}::boolean then null else claimed_at end,
    claim_expires_at = case when ${releaseClaim}::boolean then null else claim_expires_at end,
    updated_at = now()
    where id=${id} and tenant_id=${t.id} returning *`;
  if (!card) return json({ error: 'not found' }, 404);
  // A move and a hand-over are different facts that a single edit can carry at once, and the
  // agent who is woken by card.assigned is not the one reading card.moved, so each gets its
  // own event rather than one being folded into the other.
  const moved = card.status !== before.status;
  const reassigned = card.assignee !== before.assignee;
  if (moved) {
    await logEvent(c, t, 'card.moved', 'card', card.id,
      { from: before.status, to: card.status, title: card.title });
  }
  if (reassigned) {
    await logEvent(c, t, 'card.assigned', 'card', card.id,
      { from: before.assignee, to: card.assignee, title: card.title });
  }
  if (!moved && !reassigned) {
    await logEvent(c, t, 'card.updated', 'card', card.id, { title: card.title });
  }
  return json(clean(card));
});

export const DELETE = withTenant(async (req, { params }, t, c) => {
  const id = idParam(params);
  const [gone] = id ? await sql`delete from cards
    where id=${id} and tenant_id=${t.id} and audience = any(${visibleAudiences(c)}::text[])
    returning id, title` : [];
  if (!gone) return json({ error: 'not found' }, 404);
  await logEvent(c, t, 'card.deleted', 'card', gone.id, { title: gone.title });
  return json({ ok: true });
});
