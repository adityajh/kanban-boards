import { json, options } from '../../../../lib/http';
import { endSession, clearSessionCookie } from '../../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Always succeeds, so a stale cookie can always be cleared.
export async function POST(req) {
  await endSession(req);
  return json({ ok: true }, 200, clearSessionCookie());
}
