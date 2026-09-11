import { sql } from '../../../../lib/db';
import { json, options, idParam } from '../../../../lib/http';
import { withTenant } from '../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export const DELETE = withTenant(async (req, { params }, t) => {
  const id = idParam(params);
  const [gone] = id ? await sql`delete from resources where id=${id} and tenant_id=${t.id} returning id` : [];
  if (!gone) return json({ error: 'not found' }, 404);
  return json({ ok: true });
});
