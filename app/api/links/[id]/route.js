import { sql } from '../../../../lib/db';
import { json, options, authed } from '../../../../lib/http';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export async function DELETE(req, { params }) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const [lk] = await sql`delete from links where id=${Number(params.id)} returning card_id`;
  if (lk) await sql`update cards set updated_at=now() where id=${lk.card_id}`;
  return json({ ok: true });
}
