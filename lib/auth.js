import { sql } from './db';
import { SESSION_DAYS, cookie, readCookie, tokenHash, newToken } from './password.mjs';

// The pure credential helpers live in password.mjs so they can be tested under plain node;
// re-exported here so routes have one place to import auth from.
export {
  hashPassword, verifyPassword, burnVerify, newPassword, MIN_PASSWORD,
  validUsername, readCookie, clearSessionCookie, SESSION_COOKIE,
} from './password.mjs';

export async function startSession(person, req) {
  const token = newToken();
  const ua = (req.headers.get('user-agent') || '').slice(0, 300);
  await sql`insert into sessions (token_hash, person_id, expires_at, user_agent)
    values (${tokenHash(token)}, ${person.id},
            now() + make_interval(days => ${SESSION_DAYS}), ${ua})`;
  // Expired rows are only ever dead weight; clear them out on the way past.
  await sql`delete from sessions where expires_at < now()`;
  return cookie(token, SESSION_DAYS * 86400);
}

export async function endSession(req) {
  const token = readCookie(req, 'board_session');
  if (token) await sql`delete from sessions where token_hash=${tokenHash(token)}`;
}

// Drop every session for a person except the one making the request — used after a password
// change so a session someone else is holding dies with the old password. A person's
// sessions span every board they are on, so this signs them out of all of them.
export async function dropOtherSessions(personId, req) {
  const token = readCookie(req, 'board_session');
  if (token) {
    await sql`delete from sessions where person_id=${personId} and token_hash <> ${tokenHash(token)}`;
  } else {
    await sql`delete from sessions where person_id=${personId}`;
  }
}

// Resolve the cookie to a person. Deliberately says nothing about boards: which board a
// request acts on is decided per request, by membership, in lib/tenant.js.
export async function sessionPerson(req) {
  const token = readCookie(req, 'board_session');
  if (!token) return null;
  const [row] = await sql`
    select p.id, p.username, p.display_name, p.must_change
    from sessions s join people p on p.id = s.person_id
    where s.token_hash=${tokenHash(token)} and s.expires_at > now()`;
  return row || null;
}

// Is this person on this board, and do they run it? Null means not a member, which every
// caller must treat exactly as "no such board".
export async function membership(personId, tenantId) {
  const [m] = await sql`select is_admin from memberships
    where person_id=${personId} and tenant_id=${tenantId}`;
  return m || null;
}

// The boards a person can open, for the switcher and for /api/auth/me.
export async function boardsFor(personId) {
  return sql`select t.slug, t.name, m.is_admin
    from memberships m join tenants t on t.id = m.tenant_id
    where m.person_id=${personId} order by t.name`;
}

export { publicPerson } from './password.mjs';
