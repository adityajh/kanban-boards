import { sql } from '../../../../../lib/db';
import { json, options, idParam } from '../../../../../lib/http';
import { withUser } from '../../../../../lib/tenant';
import { hashPassword, newPassword, publicPerson } from '../../../../../lib/auth';
import { personOnBoard, wouldStrandBoard } from '../../../../../lib/people';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

const find = async (params, tenantId) => {
  const id = idParam(params);
  return id ? personOnBoard(id, tenantId) : null;
};

export const PATCH = withUser(async (req, { params }, t) => {
  const person = await find(params, t.id);
  if (!person) return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => ({}));

  if (b.isAdmin === false && person.is_admin && await wouldStrandBoard(t.id, person.id)) {
    return json({ error: 'this is the only admin on the board' }, 409);
  }

  // The admin flag belongs to this board's membership; the name and password belong to the
  // person, so changing either is visible on every board they are on.
  if (typeof b.isAdmin === 'boolean') {
    await sql`update memberships set is_admin=${b.isAdmin}
      where person_id=${person.id} and tenant_id=${t.id}`;
  }

  const password = b.resetPassword ? newPassword() : null;
  const [updated] = await sql`update people set
      display_name  = coalesce(${b.displayName ? String(b.displayName).trim() : null}, display_name),
      password_hash = coalesce(${password ? await hashPassword(password) : null}, password_hash),
      must_change   = coalesce(${password ? true : null}, must_change),
      updated_at    = now()
    where id=${person.id} returning *`;

  // A reset must evict whoever holds the old password — on every board, since it is one
  // password now.
  if (password) await sql`delete from sessions where person_id=${person.id}`;

  const [m] = await sql`select is_admin from memberships
    where person_id=${person.id} and tenant_id=${t.id}`;
  const user = { ...publicPerson(updated), isAdmin: m?.is_admin === true };
  return json(password ? { user, password } : { user });
}, { adminOnly: true });

// Removing someone takes them off *this* board. Their account and any other board they are
// on are untouched — which is the whole point of separating people from membership.
export const DELETE = withUser(async (req, { params }, t, c) => {
  const person = await find(params, t.id);
  if (!person) return json({ error: 'not found' }, 404);
  if (c.person?.id === person.id) return json({ error: 'you cannot remove yourself' }, 409);
  if (person.is_admin && await wouldStrandBoard(t.id, person.id)) {
    return json({ error: 'this is the only admin on the board' }, 409);
  }
  await sql`delete from memberships where person_id=${person.id} and tenant_id=${t.id}`;

  // An account on no boards can sign in to nothing, holds its username reserved, and has
  // no route to remove it — so taking someone off their last board removes the account
  // too, sessions and all. Re-adding them later issues a fresh password, which is what
  // happened before people and memberships were separate.
  const [{ count }] = await sql`select count(*)::int as count from memberships
    where person_id=${person.id}`;
  const gone = count === 0;
  if (gone) await sql`delete from people where id=${person.id}`;

  // config.names is left alone on purpose: cards may still be assigned to this person.
  return json({ ok: true, accountRemoved: gone });
}, { adminOnly: true });
