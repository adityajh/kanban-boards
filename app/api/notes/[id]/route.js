import { sql } from '../../../../lib/db';
import { json, options, idParam } from '../../../../lib/http';
import { withTenant } from '../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export const DELETE = withTenant(async (req, { params }, t) => {
  const id = idParam(params);
  const [nt] = id ? await sql`delete from notes n using cards c
    where n.id=${id} and c.id=n.card_id and c.tenant_id=${t.id} returning n.card_id` : [];
  if (!nt) return json({ error: 'not found' }, 404);
  await sql`update cards set updated_at=now() where id=${nt.card_id}`;
  return json({ ok: true });
});
