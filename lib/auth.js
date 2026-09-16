import { sql } from './db';
import { SESSION_DAYS, cookie, readCookie, tokenHash, newToken } from './password.mjs';

// The pure credential helpers live in password.mjs so they can be tested under plain node;
// re-exported here so routes have one place to import auth from.
export {
  hashPassword, verifyPassword, burnVerify, newPassword, MIN_PASSWORD,
  validUsername, publicUser, readCookie, clearSessionCookie, SESSION_COOKIE,
} from './password.mjs';

export async function startSession(user, req) {
  const token = newToken();
  const ua = (req.headers.get('user-agent') || '').slice(0, 300);
  await sql`insert into sessions (token_hash, user_id, tenant_id, expires_at, user_agent)
    values (${tokenHash(token)}, ${user.id}, ${user.tenant_id},
            now() + make_interval(days => ${SESSION_DAYS}), ${ua})`;
  // Expired rows are only ever dead weight; clear them out on the way past.
  await sql`delete from sessions where expires_at < now()`;
  return cookie(token, SESSION_DAYS * 86400);
}

export async function endSession(req) {
  const token = readCookie(req, 'board_session');
  if (token) await sql`delete from sessions where token_hash=${tokenHash(token)}`;
}

// Drop every session for a user except the one making the request — used after a password
// change so a session someone else is holding dies with the old password.
export async function dropOtherSessions(userId, req) {
  const token = readCookie(req, 'board_session');
  if (token) {
    await sql`delete from sessions where user_id=${userId} and token_hash <> ${tokenHash(token)}`;
  } else {
    await sql`delete from sessions where user_id=${userId}`;
  }
}

// Resolve the cookie to { user, tenant }, or null. Joins the tenant so a session carries
// its board with it, exactly as a passphrase does.
export async function sessionCaller(req) {
  const token = readCookie(req, 'board_session');
  if (!token) return null;
  const [row] = await sql`
    select u.id, u.tenant_id, u.username, u.display_name, u.is_admin, u.must_change,
           t.id as t_id, t.slug, t.name, t.key_hash, t.config, t.created_at
    from sessions s
    join users u   on u.id = s.user_id
    join tenants t on t.id = s.tenant_id
    where s.token_hash=${tokenHash(token)} and s.expires_at > now()`;
  if (!row) return null;
  return {
    user: {
      id: row.id, tenant_id: row.tenant_id, username: row.username,
      display_name: row.display_name, is_admin: row.is_admin, must_change: row.must_change,
    },
    tenant: {
      id: row.t_id, slug: row.slug, name: row.name,
      key_hash: row.key_hash, config: row.config, created_at: row.created_at,
    },
  };
}
