import { sql } from '../../../../../../lib/db';
import { json, options } from '../../../../../../lib/http';
import { withAdmin } from '../../../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// A master admin can see every board but opens none of them: access still means a
// membership row. This is how they give themselves one — deliberately an action they take,
// and a row that records it, rather than a rule that quietly lets them in everywhere.
export const POST = withAdmin(async (req, { params }, c) => {
  if (!c.person) {
    return json({ error: 'ADMIN_KEY is not a person; sign in to join a board' }, 400);
  }
  const [tenant] = await sql`select * from tenants where slug=${params.slug}`;
  if (!tenant) return json({ error: 'not found' }, 404);

  try {
    await sql`insert into memberships (person_id, tenant_id, is_admin)
      values (${c.person.id}, ${tenant.id}, true)`;
  } catch (e) {
    if (e.code === '23505') return json({ error: 'you are already on this board' }, 409);
    throw e;
  }

  // Keep the assignee roster in step, as adding anyone else does.
  if (!(tenant.config.names || []).includes(c.person.display_name)) {
    const names = [...(tenant.config.names || []), c.person.display_name];
    await sql`update tenants set config = jsonb_set(config, '{names}', ${JSON.stringify(names)}::jsonb)
      where id=${tenant.id}`;
  }
  return json({ ok: true, slug: tenant.slug });
});
