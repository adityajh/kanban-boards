import { sql } from '../../../../lib/db';
import { json, options, authed } from '../../../../lib/http';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export async function DELETE(req, { params }) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const [nt] = await sql`delete from notes where id=${Number(params.id)} returning card_id`;
  if (nt) await sql`update cards set updated_at=now() where id=${nt.card_id}`;
  return json({ ok: true });
}
