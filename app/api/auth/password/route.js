import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import {
  sessionPerson, verifyPassword, hashPassword, startSession,
  dropOtherSessions, endSession, publicPerson, MIN_PASSWORD,
} from '../../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Self-service only: you can change your own password, never anyone else's. An admin
// resetting someone goes through /api/settings/users/[id].
export async function POST(req) {
  const person = await sessionPerson(req);
  if (!person) return json({ error: 'unauthorized' }, 401);

  const b = await req.json().catch(() => ({}));
  const next = String(b.newPassword || '');
  if (next.length < MIN_PASSWORD) {
    return json({ error: `New password must be at least ${MIN_PASSWORD} characters` }, 400);
  }

  const [row] = await sql`select password_hash from people where id=${person.id}`;
  if (!row || !(await verifyPassword(String(b.currentPassword || ''), row.password_hash))) {
    return json({ error: 'Current password is wrong' }, 403);
  }
  if (await verifyPassword(next, row.password_hash)) {
    return json({ error: 'New password must be different from the current one' }, 400);
  }

  await sql`update people set password_hash=${await hashPassword(next)},
      must_change=false, updated_at=now() where id=${person.id}`;

  // One password covers every board, so a change evicts this person everywhere and then
  // re-issues the session making the request.
  await dropOtherSessions(person.id, req);
  await endSession(req);
  const cookie = await startSession(person, req);

  return json({ user: { ...publicPerson(person), mustChange: false } }, 200, cookie);
}
