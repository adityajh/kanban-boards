import { sql } from '../../../../../lib/db';
import { json, options } from '../../../../../lib/http';
import { withUser, isMaster } from '../../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// People who already have an account and are NOT on this board, so a board can be filled
// from the accounts that exist instead of by typing a username and hoping it matches.
//
// WHO MAY SEE THIS IS THE WHOLE DESIGN. An account is global — one person, one password,
// many boards — so the list of people is not board-scoped information, and handing it to
// any board admin would let whoever runs one client's board read off the names of everyone
// on every other. That is the same boundary cards and documents sit behind, and a name is
// not less private than a card title.
//
// So it is served to a master admin only. Everyone else gets an empty list and goes on
// typing a username, which adds exactly the same people and reveals nothing: POST
// /settings/users already resolves an existing account by name without confirming anything
// to a caller who guessed wrong beyond what it has always said.
export const GET = withUser(async (req, ctx, t, c) => {
  if (!isMaster(c)) return json({ people: [], restricted: true });

  const rows = await sql`select p.id, p.username, p.display_name,
      (select count(*)::int from memberships m2 where m2.person_id = p.id) as boards,
      p.must_change
    from people p
    where not exists (
      select 1 from memberships m where m.person_id = p.id and m.tenant_id = ${t.id})
    order by lower(p.display_name)`;

  return json({
    restricted: false,
    people: rows.map((p) => ({
      id: p.id,
      username: p.username,
      displayName: p.display_name,
      // How many boards they are already on, so an admin can tell a real colleague from a
      // leftover test account at a glance without opening anything.
      boards: p.boards,
      neverSignedIn: p.must_change,
    })),
  });
}, { adminOnly: true });
