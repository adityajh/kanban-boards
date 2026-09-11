import { sql } from '../../../../lib/db';
import { json, options, authed } from '../../../../lib/http';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export async function DELETE(req, { params }) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  await sql`delete from resources where id=${Number(params.id)}`;
  return json({ ok: true });
}
