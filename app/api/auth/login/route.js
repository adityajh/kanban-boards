import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { verifyPassword, burnVerify, startSession, publicUser } from '../../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// One message for every failure: never say whether the board, the username or the
// password was the wrong part.
const DENIED = { error: 'Wrong username or password' };

export async function POST(req) {
  const b = await req.json().catch(() => ({}));
  const slug = String(b.slug || '').trim().toLowerCase();
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!slug || !username || !password) return json(DENIED, 401);

  const [user] = await sql`
    select u.* from users u join tenants t on t.id = u.tenant_id
    where t.slug=${slug} and lower(u.username)=lower(${username})`;
  if (!user) { await burnVerify(); return json(DENIED, 401); }
  if (!(await verifyPassword(password, user.password_hash))) return json(DENIED, 401);

  const cookie = await startSession(user, req);
  await sql`update users set last_login_at=now() where id=${user.id}`;
  return json({ user: publicUser(user) }, 200, cookie);
}
