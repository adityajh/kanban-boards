import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withUser, normalizeConfig } from '../../../../lib/tenant';
import { hashPassword, newPassword, validUsername, publicPerson } from '../../../../lib/auth';
import { boardPeople, withRole } from '../../../../lib/people';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

export const GET = withUser(async (req, ctx, t) =>
  json((await boardPeople(t.id)).map(withRole)), { adminOnly: true });

// Add someone to this board. If they already have an account — because they are on another
// board — they keep their existing password and simply gain a membership here; issuing a
// second password for the same person is exactly what 004 removed.
export const POST = withUser(async (req, ctx, t) => {
  const b = await req.json().catch(() => ({}));
  const username = String(b.username || '').trim();
  const displayName = String(b.displayName || '').trim() || username;
  const isAdmin = b.isAdmin === true;
  if (!validUsername(username)) {
    return json({ error: 'username: 2-32 chars of a-z, 0-9, dot, underscore, hyphen' }, 400);
  }

  const [existing] = await sql`select * from people where lower(username)=lower(${username})`;
  let person = existing, password = null;

  if (!person) {
    password = newPassword();
    [person] = await sql`insert into people (username, display_name, password_hash, must_change)
      values (${username}, ${displayName}, ${await hashPassword(password)}, true) returning *`;
  }

  try {
    await sql`insert into memberships (person_id, tenant_id, is_admin)
      values (${person.id}, ${t.id}, ${isAdmin})`;
  } catch (e) {
    if (e.code === '23505') return json({ error: 'they are already on this board' }, 409);
    throw e;
  }

  // Keep the assignee roster in step, so a new person is immediately assignable.
  if (!(t.config.names || []).includes(person.display_name)) {
    const config = normalizeConfig(
      { ...t.config, names: [...(t.config.names || []), person.display_name] }, t.name);
    await sql`update tenants set config=${JSON.stringify(config)}::jsonb where id=${t.id}`;
  }

  return json({
    user: { ...publicPerson(person), isAdmin },
    password,                 // null when they already had an account
    existing: !!existing,
  }, 201);
}, { adminOnly: true });
