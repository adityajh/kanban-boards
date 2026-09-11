import { sql } from '../../../../lib/db';
import { json, options, idParam } from '../../../../lib/http';
import { withTenant } from '../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export const DELETE = withTenant(async (req, { params }, t) => {
  const id = idParam(params);
  const [lk] = id ? await sql`delete from links l using cards c
    where l.id=${id} and c.id=l.card_id and c.tenant_id=${t.id} returning l.card_id` : [];
  if (!lk) return json({ error: 'not found' }, 404);
  await sql`update cards set updated_at=now() where id=${lk.card_id}`;
  return json({ ok: true });
});
