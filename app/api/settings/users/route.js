import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withUser, normalizeConfig } from '../../../../lib/tenant';
import { hashPassword, newPassword, validUsername, publicUser } from '../../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

export const GET = withUser(async (req, ctx, t) => {
  const users = await sql`select * from users where tenant_id=${t.id} order by lower(display_name)`;
  return json(users.map(publicUser));
}, { adminOnly: true });

// The generated password is returned exactly once and only its hash is stored — the same
// contract as a board passphrase.
export const POST = withUser(async (req, ctx, t) => {
  const b = await req.json().catch(() => ({}));
  const username = String(b.username || '').trim();
  const displayName = String(b.displayName || '').trim() || username;
  if (!validUsername(username)) {
    return json({ error: 'username: 2-32 chars of a-z, 0-9, dot, underscore, hyphen' }, 400);
  }
  const password = newPassword();
  try {
    const [user] = await sql`insert into users
      (tenant_id, username, display_name, password_hash, is_admin, must_change)
      values (${t.id}, ${username}, ${displayName}, ${await hashPassword(password)},
              ${b.isAdmin === true}, true)
      returning *`;
    // Keep the assignee roster in step, so a new person is immediately assignable.
    if (!(t.config.names || []).includes(displayName)) {
      const config = normalizeConfig({ ...t.config, names: [...(t.config.names || []), displayName] }, t.name);
      await sql`update tenants set config=${JSON.stringify(config)}::jsonb where id=${t.id}`;
    }
    return json({ user: publicUser(user), password }, 201);
  } catch (e) {
    if (e.code === '23505') return json({ error: 'that username is already taken on this board' }, 409);
    throw e;
  }
}, { adminOnly: true });
