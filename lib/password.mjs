// Pure credential helpers: no database, no request handling. Kept as .mjs and free of
// imports so tests/auth-test.mjs can run the shipped code directly under plain node.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCb);

// scrypt parameters live inside the stored string, so they can be raised later without a
// migration: old rows keep verifying with the cost they were written at.
const N = 16384, R = 8, P = 1, KEYLEN = 32, SALTLEN = 16;

// Deliberately not peppered with KEY_PEPPER. Rotating the pepper already invalidates every
// board passphrase with no recovery path; user passwords must not share that fate.
export async function hashPassword(password) {
  const salt = randomBytes(SALTLEN);
  const dk = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), dk.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  // Base64 decoding silently discards invalid characters, so a corrupt or truncated row
  // can decode to an empty buffer — and scrypt with keylen 0 returns an empty buffer that
  // compares equal to it, which would accept every password. Refuse anything undersized.
  if (salt.length < SALTLEN || expected.length < KEYLEN) return false;
  try {
    const dk = await scrypt(password, salt, expected.length,
      { N: Number(n), r: Number(r), p: Number(p) });
    return timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

// Burn roughly the same time as a real verify when the username doesn't exist, so the
// response time doesn't say whether it does. Salt and hash are full size on purpose:
// an undersized decoy would be rejected by the guard above without doing the work.
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
export const burnVerify = () => verifyPassword('x', DUMMY);

// 12 base64url chars ≈ 72 bits. Shown once at creation, like a board passphrase.
export const newPassword = () => randomBytes(9).toString('base64url');

export const MIN_PASSWORD = 10;

// Usernames are per-board and case-insensitive (the unique index is on lower(username)).
export const validUsername = (u) => /^[a-z0-9][a-z0-9._-]{1,31}$/i.test(u);

export const SESSION_COOKIE = 'board_session';
export const SESSION_DAYS = 30;

// Only the hash is stored: a database leak does not hand over live sessions.
export const tokenHash = (t) => createHash('sha256').update(t).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export function readCookie(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

// SameSite=Lax blocks cross-site POST/PATCH/DELETE, which is what stands in for CSRF
// tokens here. The API's CORS header is a wildcard with no Allow-Credentials, so the
// cookie is never sent cross-origin either — cookie auth is same-origin only, by design.
export function cookie(value, maxAge) {
  const bits = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (process.env.NODE_ENV === 'production') bits.push('Secure');
  return { 'Set-Cookie': bits.join('; ') };
}

export const clearSessionCookie = () => cookie('', 0);

// Admin is per board now, so it is not part of who someone is — it comes from their
// membership of the board being acted on.
export const publicPerson = (p) => ({
  id: p.id, username: p.username, displayName: p.display_name, mustChange: p.must_change,
  // Master admin is about managing boards, not about being on one — so unlike is_admin it
  // does belong to the person, and travels with them.
  isMaster: p.is_master === true,
});
