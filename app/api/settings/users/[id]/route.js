import { sql } from '../../../../../lib/db';
import { json, options, idParam } from '../../../../../lib/http';
import { withUser } from '../../../../../lib/tenant';
import { hashPassword, newPassword, publicUser } from '../../../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Every lookup is scoped by tenant_id as well as id: a board admin must not be able to
// reach a user on another board by guessing a serial.
const find = async (params, tenantId) => {
  const id = idParam(params);
  if (!id) return null;
  const [u] = await sql`select * from users where id=${id} and tenant_id=${tenantId}`;
  return u || null;
};

// A board with no admin can only be repaired with ADMIN_KEY, so don't let the UI create one.
const wouldStrandBoard = async (tenantId, userId) => {
  const [{ count }] = await sql`select count(*)::int as count from users
    where tenant_id=${tenantId} and is_admin=true and id <> ${userId}`;
  return count === 0;
};

export const PATCH = withUser(async (req, { params }, t) => {
  const user = await find(params, t.id);
  if (!user) return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => ({}));

  if (b.isAdmin === false && user.is_admin && await wouldStrandBoard(t.id, user.id)) {
    return json({ error: 'this is the only admin on the board' }, 409);
  }

  // Reset hands back a new one-time password; it is never echoed back afterwards.
  let password = null;
  if (b.resetPassword) password = newPassword();

  const [updated] = await sql`update users set
      display_name = coalesce(${b.displayName ? String(b.displayName).trim() : null}, display_name),
      is_admin     = coalesce(${typeof b.isAdmin === 'boolean' ? b.isAdmin : null}, is_admin),
      password_hash = coalesce(${password ? await hashPassword(password) : null}, password_hash),
      must_change  = coalesce(${password ? true : null}, must_change),
      updated_at   = now()
    where id=${user.id} and tenant_id=${t.id} returning *`;

  // A reset must also evict whoever is holding the old password's sessions.
  if (password) await sql`delete from sessions where user_id=${user.id}`;

  return json(password ? { user: publicUser(updated), password } : { user: publicUser(updated) });
}, { adminOnly: true });

export const DELETE = withUser(async (req, { params }, t, c) => {
  const user = await find(params, t.id);
  if (!user) return json({ error: 'not found' }, 404);
  if (c.user?.id === user.id) return json({ error: 'you cannot remove yourself' }, 409);
  if (user.is_admin && await wouldStrandBoard(t.id, user.id)) {
    return json({ error: 'this is the only admin on the board' }, 409);
  }
  // Sessions cascade with the row. config.names is left alone on purpose: cards may still
  // be assigned to this person, and the name should stay selectable.
  await sql`delete from users where id=${user.id} and tenant_id=${t.id}`;
  return json({ ok: true });
}, { adminOnly: true });
