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

export const sign = (secret, body) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

// Exported so a receiver can verify the same way the board signs, and so the tests check
// the thing the server actually sends rather than a reimplementation of it.
export function verifySignature(secret, body, header) {
  const expected = Buffer.from(sign(secret, body));
  const got = Buffer.from(String(header || ''));
  return expected.length === got.length && timingSafeEqual(expected, got);
}
