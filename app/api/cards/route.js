import { sql } from '../../../lib/db';
import { json, options } from '../../../lib/http';
import { withTenant, clean, visibleAudiences, defaultAudience, AUDIENCES } from '../../../lib/tenant';
import { logEvent } from '../../../lib/events';
import { statusRefusal, sameName, identityName } from '../../../lib/cards.mjs';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

export const GET = withTenant(async (req, ctx, t, c) => {
  const aud = visibleAudiences(c);
  const cards = await sql`select * from cards
    where tenant_id=${t.id} and audience = any(${aud}::text[])
    order by status, position, id`;
  const subs = await sql`select s.* from subtasks s join cards c on c.id=s.card_id
    where c.tenant_id=${t.id} and c.audience = any(${aud}::text[]) order by s.position, s.id`;
  const links = await sql`select l.* from links l join cards c on c.id=l.card_id
    where c.tenant_id=${t.id} and c.audience = any(${aud}::text[]) order by l.id`;
  const notes = await sql`select n.* from notes n join cards c on c.id=n.card_id
    where c.tenant_id=${t.id} and c.audience = any(${aud}::text[]) order by n.created_at, n.id`;
  const byCard = (arr) => arr.reduce((m, x) => ((m[x.card_id] ||= []).push(x), m), {});
  const S = byCard(subs), L = byCard(links), N = byCard(notes);
  const out = cards.map(c2 => ({ ...clean(c2), subtasks: S[c2.id] || [], links: L[c2.id] || [], notes: N[c2.id] || [] }));

  // An agent is told how many rows it was not shown, but not what they are: silence would
  // mean an agent asked to summarise the board answers confidently and wrongly. It goes in
  // a header rather than the body so the shape of this response never depends on who asked.
  if (c.agent) {
    const [{ hidden }] = await sql`select count(*)::int as hidden from cards
      where tenant_id=${t.id} and audience = 'human_only'`;
    if (hidden > 0) return json(out, 200, { 'X-Hidden-Cards': String(hidden) });
  }
  return json(out);
});

// The body is parsed with a catch so a missing, empty or malformed one falls through to the
// field checks below and answers 400 with what is wrong. Unguarded, `req.json()` throws and
// the route answers 500 — which tells a client nothing, and looks like the server is broken
// rather than the request. Reads never showed this because a GET carries no body.
export const POST = withTenant(async (req, ctx, t, c) => {
  const b = await req.json().catch(() => ({}));
  if (!b.title) return json({ error: 'title required' }, 400);
  const badStatus = statusRefusal(b.status);
  if (badStatus) return json(badStatus, 422);
  const status = b.status || 'todo';
  const audience = b.audience || defaultAudience(c, t);
  if (!AUDIENCES.includes(audience)) {
    return json({ error: `audience must be one of ${AUDIENCES.join(', ')}` }, 400);
  }
  const assignee = b.assignee || (c.agent ? c.agent.name : 'Unassigned');
  // Work nobody may look at is work nobody can take over, so refuse the combination
  // rather than create a card only one side of the board can ever see.
  if (audience === 'human_only' && c.agent) {
    return json({ error: 'an agent cannot create a human_only card' }, 400);
  }
  const [{ max }] = await sql`select coalesce(max(position),0) as max from cards
    where tenant_id=${t.id} and status=${status}`;
  const [card] = await sql`insert into cards
      (tenant_id, title, description, status, assignee, tag, position, audience, due_at)
    values (${t.id}, ${b.title}, ${b.description || ''}, ${status},
            ${assignee}, ${b.tag || ''}, ${Number(max) + 1}, ${audience}, ${b.due_at || null})
    returning *`;
  await logEvent(c, t, 'card.created', 'card', card.id,
    { title: card.title, status, audience, assignee: card.assignee });
  // A card created already assigned to somebody else is how an agent is most often handed
  // work, and card.created alone does not wake the assignee: only card.assigned is the
  // event an agent listens for. Without this second event it would never learn it has work.
  // Assigning a card to yourself, or to nobody, tells nobody anything, so those stay quiet.
  if (card.assignee && card.assignee !== 'Unassigned' && !sameName(card.assignee, identityName(c))) {
    await logEvent(c, t, 'card.assigned', 'card', card.id,
      { from: null, to: card.assignee, title: card.title });
  }
  return json({ ...clean(card), subtasks: [], links: [], notes: [] }, 201);
});
