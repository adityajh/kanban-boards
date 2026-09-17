import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import {
  verifyPassword, burnVerify, startSession, publicPerson, boardsFor,
} from '../../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// One message for every failure: never say whether the username or the password was the
// wrong part.
const DENIED = { error: 'Wrong username or password' };

// No board here on purpose. A session covers every board you belong to, so signing in is
// about who you are; which boards that opens is answered by /api/auth/me.
export async function POST(req) {
  const b = await req.json().catch(() => ({}));
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!username || !password) return json(DENIED, 401);

  const [person] = await sql`select * from people where lower(username)=lower(${username})`;
  if (!person) { await burnVerify(); return json(DENIED, 401); }
  if (!(await verifyPassword(password, person.password_hash))) return json(DENIED, 401);

  const cookie = await startSession(person, req);
  await sql`update people set last_login_at=now() where id=${person.id}`;
  return json({ user: publicPerson(person), boards: await boardsFor(person.id) }, 200, cookie);
}
