// Pure webhook helpers: no database, no fetch. Kept as .mjs and free of imports beyond node
// builtins so tests/auth-test.mjs can exercise the shipped code, as password.mjs is.
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const newWebhookSecret = () => 'whsec_' + randomBytes(24).toString('base64url');

// Only https, and nothing that resolves to this machine or a private network. The board is
// about to make an outbound request to an address an agent's owner chose, which is a
// server-side request forgery waiting to happen if that address can be internal.
const PRIVATE = /^(localhost$|localhost\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.)/i;
export function validWebhookUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (PRIVATE.test(u.hostname)) return false;
  return true;
}

// A receiver that already has its own signing secret, and cannot be told to use ours, is
// the common case once an agent lives on someone else's automation platform. Letting an
// admin paste that secret in costs nothing in security — the board signs with it either
// way, and a secret it generated is no stronger than one it was given, as long as the one
// it was given is not trivially short.
export function secretRefusal(secret) {
  if (secret == null || secret === '') return null;
  const s = String(secret);
  if (s.length < 16) return { field: 'webhookSecret', error: 'a webhook secret must be at least 16 characters' };
  if (s.length > 200) return { field: 'webhookSecret', error: 'a webhook secret must be 200 characters or fewer' };
  if (/[\s\u0000-\u001f\u007f]/.test(s)) {
    return { field: 'webhookSecret', error: 'a webhook secret cannot contain spaces or control characters' };
  }
  return null;
}

// How a delivery proves it came from the board. 'signature' is the default and the stronger
// one: an HMAC proves the sender holds the secret without the secret ever travelling. 'bearer'
// exists because an agent living on somebody else's automation platform gets the endpoint that
// platform provides, and a real one (Cursor's automation webhooks) authenticates with a plain
// API key in an Authorization header and ignores signature headers entirely: sending only
// X-Hub-Signature-256 to it returns 401 "Missing Authorization header." For such a receiver
// the choice is Bearer or no wake at all, and no wake sends the agent back to polling, which
// is the thing the webhook exists to prevent.
export const WEBHOOK_AUTH = ['signature', 'bearer'];

// Absent or blank means "leave it alone", the same convention as secretRefusal, so a form
// that sends an untouched field does not read as a request to change the mode. Anything else
// must match exactly: guessing that 'Bearer' meant 'bearer' would be fine, but guessing that
// 'none' meant something is how a delivery ends up unauthenticated.
export function webhookAuthRefusal(mode) {
  if (mode == null || mode === '') return null;
  if (WEBHOOK_AUTH.includes(mode)) return null;
  return { field: 'webhookAuth', error: 'webhookAuth must be signature or bearer' };
}

export const sign = (secret, body) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

// Exported so a receiver can verify the same way the board signs, and so the tests check
// the thing the server actually sends rather than a reimplementation of it.
export function verifySignature(secret, body, header) {
  const expected = Buffer.from(sign(secret, body));
  const got = Buffer.from(String(header || ''));
  return expected.length === got.length && timingSafeEqual(expected, got);
}
