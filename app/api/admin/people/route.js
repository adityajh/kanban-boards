import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withAdmin } from '../../../../lib/tenant';
import { publicPerson } from '../../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Every person with their membership on every board: the cross-board mirror of the agent
// registry. Settings answers "who is on this board" one board at a time; this answers "what
// can Gargi reach" and, just as usefully, "who can reach nothing", which no per-board screen
// can show because that person is on none of them.
export const GET = withAdmin(async () => {
  // `p.*` is safe to select because publicPerson picks fields by name: password_hash is
  // never copied out. Ordering is by the display name people actually read, case-folded, with
  // the id as a tiebreak so two Priyas do not swap places between refreshes.
  const people = await sql`select p.* from people p order by lower(p.display_name), p.id`;

  // key_hash and config are read only to be reduced to booleans: whether the board still
  // holds a passphrase, and whether its approval gate is on. The hash itself never leaves
  // this function. These are extra fields on each board, beyond slug and name, so the Boards
  // and Attention tabs need no second source for them.
  const boardRows = await sql`select t.slug, t.name, (t.key_hash is not null) as has_passphrase,
      (t.config->'reviewGate') = 'true'::jsonb as review_gate
    from tenants t order by lower(t.name), t.id`;

  const links = await sql`select m.person_id, m.is_admin, t.slug, t.name
    from memberships m join tenants t on t.id = m.tenant_id
    order by lower(t.name), t.id`;

  const byPerson = new Map();
  for (const l of links) {
    if (!byPerson.has(l.person_id)) byPerson.set(l.person_id, []);
    byPerson.get(l.person_id).push({ slug: l.slug, name: l.name, isAdmin: l.is_admin === true });
  }

  const out = people.map((p) => ({
    ...publicPerson(p),
    // Never signed in is read off last_login_at being null, not off must_change: a person can
    // have changed a password they were given and still never have used it to log in, and the
    // reverse after a reset.
    neverSignedIn: p.last_login_at == null,
    lastLoginAt: p.last_login_at,
    boards: byPerson.get(p.id) || [],
  }));

  return json({
    people: out,
    boards: boardRows.map((b) => ({
      slug: b.slug, name: b.name,
      hasPassphrase: b.has_passphrase === true, reviewGate: b.review_gate === true,
    })),
    counts: {
      total: out.length,
      neverSignedIn: out.filter((p) => p.neverSignedIn).length,
      onNoBoard: out.filter((p) => p.boards.length === 0).length,
    },
  });
});
