import { sql } from '../../../lib/db';
import { json, options } from '../../../lib/http';
import { withTenant, visibleAudiences, clean } from '../../../lib/tenant';
import { identityName, claimState } from '../../../lib/cards.mjs';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// "What is waiting on me" on one board: cards handed to me, notes written to me, and the
// cards I am working on right now. Messaging here is just 010's columns plus this query, so
// there is no second store to drift out of step with the cards.
const NOTE_LIMIT = 50;

export const GET = withTenant(async (req, ctx, t, c) => {
  let who = identityName(c);
  let kind = c.person ? 'person' : 'agent';

  // A board passphrase is shared by several agents and ADMIN_KEY belongs to nobody, so an
  // inbox for either is meaningless. ADMIN_KEY may look at somebody else's inbox on purpose
  // (that is how Adi checks why an agent has gone quiet), but nobody else may name a
  // stranger: ?who= is honoured only when the credential is the admin key itself.
  if (!who) {
    const asked = (new URL(req.url).searchParams.get('who') || '').trim();
    if (!c.admin || !asked) {
      return json({
        error: 'this credential is nobody in particular: use an agent token, sign in, or ADMIN_KEY with ?who=',
      }, 400);
    }
    who = asked;
    kind = 'admin';
  }

  // An agent is never shown a human_only row. Notes carry no audience of their own — they
  // inherit their card's — so the same filter is applied to the card each note hangs on.
  const aud = visibleAudiences(c);

  const assigned = await sql`select * from cards
    where tenant_id=${t.id} and audience = any(${aud}::text[])
      and lower(assignee) = lower(${who}) and status <> 'done'
    order by due_at asc nulls last, id`;

  const noteRows = await sql`select n.*, c.id as c_id, c.title as c_title, c.status as c_status
    from notes n join cards c on c.id = n.card_id
    where c.tenant_id=${t.id} and c.audience = any(${aud}::text[])
      and lower(n.addressed_to) = lower(${who})
    order by n.created_at desc, n.id desc limit ${NOTE_LIMIT}`;
  const addressed = noteRows.map(({ c_id, c_title, c_status, ...n }) =>
    ({ ...n, card: { id: c_id, title: c_title, status: c_status } }));

  // The SQL filter says what is live; claimState is the one definition of "live" the claim
  // routes use, so it is applied again rather than trusting two spellings to agree.
  const claimRows = await sql`select * from cards
    where tenant_id=${t.id} and audience = any(${aud}::text[])
      and lower(claimed_by) = lower(${who}) and claim_expires_at > now()
    order by claim_expires_at, id`;
  const claims = claimRows.filter((r) => claimState(r)).map(clean);

  // The roster exists for a specific reason. `to` and `assignee` are deliberately NOT
  // validated against a roster, because a board's people list is often incomplete, so a
  // misspelt name is findable by nobody. Returning the names this board actually knows is
  // how an agent checks itself when its inbox is empty and it expected otherwise.
  const people = await sql`select p.display_name from memberships m
    join people p on p.id = m.person_id
    where m.tenant_id=${t.id} order by lower(p.display_name)`;
  const agents = await sql`select name from agents
    where tenant_id=${t.id} and disabled_at is null order by lower(name)`;

  const now = Date.now();
  const overdue = assigned.filter((r) => r.due_at && new Date(r.due_at).getTime() < now).length;

  return json({
    me: { kind, name: who },
    assigned: assigned.map(clean),
    addressed,
    claims,
    roster: { people: people.map((p) => p.display_name), agents: agents.map((a) => a.name) },
    counts: { assigned: assigned.length, addressed: addressed.length, claims: claims.length, overdue },
  });
});
