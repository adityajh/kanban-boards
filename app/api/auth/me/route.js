import { json, options } from '../../../../lib/http';
import { sessionCaller, publicUser } from '../../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Who the cookie belongs to, and which board. Used by the UI on load to decide between
// the login gate and the board.
export async function GET(req) {
  const s = await sessionCaller(req);
  if (!s) return json({ error: 'unauthorized' }, 401);
  return json({ user: publicUser(s.user), slug: s.tenant.slug });
}
