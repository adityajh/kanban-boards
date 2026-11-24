import { sql } from '../../../../lib/db';
import { json, options, idParam } from '../../../../lib/http';
import { withTenant, visibleAudiences } from '../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export const DELETE = withTenant(async (req, { params }, t, c) => {
  const id = idParam(params);
  const [nt] = id ? await sql`delete from notes n using cards cd
    where n.id=${id} and cd.id=n.card_id and cd.tenant_id=${t.id}
      and cd.audience = any(${visibleAudiences(c)}::text[])
    returning n.card_id` : [];
  if (!nt) return json({ error: 'not found' }, 404);
  await sql`update cards set updated_at=now() where id=${nt.card_id}`;
  return json({ ok: true });
});
