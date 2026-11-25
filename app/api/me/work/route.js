import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { caller, clean } from '../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

const NOTE_LIMIT = 20;

// The inbox question asked across every board at once. It takes no X-Tenant because the
// answer is not about one board, so it cannot use withTenant and reads the caller directly.
export async function GET(req) {
  const c = await caller(req);
  if (!c) return json({ error: 'unauthorized' }, 401);
  // An agent token names one board by design; widening it here would quietly turn a
  // per-board credential into a cross-board one.
  if (c.agent) {
    return json({ error: 'an agent token names one board by design; hold one token per board' }, 403);
  }
  if (!c.person) {
    // ADMIN_KEY is not a person, so there is no "me" to gather work for.
    if (c.admin) return json({ error: 'ADMIN_KEY is not a person: sign in to see your work across boards' }, 400);
    return json({ error: 'unauthorized' }, 401);
  }
  const me = c.person;

  // Both queries are driven from `memberships`, never from cards. That join is what keeps
  // this endpoint from widening anybody's access: it answers across boards, but only the
  // boards membership already opened. A card is reachable here only through a tenant the
  // person holds a row for, so no clause below needs to remember to check.
  //
  // No audience filter, and that is not an omission: a person is served every audience
  // (see visibleAudiences), and agents are refused above before we get here.
  const cards = await sql`select c.*, t.slug as b_slug, t.name as b_name
    from memberships m
    join tenants t on t.id = m.tenant_id
    join cards c on c.tenant_id = t.id
    where m.person_id=${me.id} and lower(c.assignee) = lower(${me.display_name})
      and c.status <> 'done'
    order by lower(t.name), t.id, c.due_at asc nulls last, c.id`;

  // Newest first, capped per board rather than overall so one noisy board cannot push
  // every other board's notes off the end.
  const notes = await sql`select * from (
      select n.*, c.id as c_id, c.title as c_title, c.status as c_status,
             t.slug as b_slug, t.name as b_name,
             row_number() over (partition by t.id order by n.created_at desc, n.id desc) as rn
      from memberships m
      join tenants t on t.id = m.tenant_id
      join cards c on c.tenant_id = t.id
      join notes n on n.card_id = c.id
      where m.person_id=${me.id} and lower(n.addressed_to) = lower(${me.display_name})
    ) x where rn <= ${NOTE_LIMIT}
    order by lower(b_name), b_slug, created_at desc, id desc`;

  const byBoard = new Map();
  const slot = (slug, name) => {
    if (!byBoard.has(slug)) byBoard.set(slug, { board: { slug, name }, assigned: [], addressed: [] });
    return byBoard.get(slug);
  };
  for (const { b_slug, b_name, ...card } of cards) slot(b_slug, b_name).assigned.push(clean(card));
  for (const { b_slug, b_name, c_id, c_title, c_status, rn, ...n } of notes) {
    slot(b_slug, b_name).addressed.push({ ...n, card: { id: c_id, title: c_title, status: c_status } });
  }

  // A board with nothing waiting is never inserted above, so a board the person is on can
  // be missing from this response. That is deliberate: the list is for what needs doing,
  // and /api/auth/me is where the full set of boards lives.
  const now = Date.now();
  const boards = [...byBoard.values()]
    .sort((a, b) => a.board.name.toLowerCase().localeCompare(b.board.name.toLowerCase()))
    .map((b) => ({
      ...b,
      counts: {
        assigned: b.assigned.length,
        addressed: b.addressed.length,
        overdue: b.assigned.filter((r) => r.due_at && new Date(r.due_at).getTime() < now).length,
      },
    }));

  return json({ me: { kind: 'person', name: me.display_name, username: me.username }, boards });
}
