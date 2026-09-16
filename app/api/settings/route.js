import { sql } from '../../../lib/db';
import { json, options } from '../../../lib/http';
import { withUser, isBoardAdmin, normalizeConfig, publicTenant } from '../../../lib/tenant';
import { publicUser } from '../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Everything the settings screen needs in one call: the board, who you are, and whether
// you may edit the board at all.
export const GET = withUser(async (req, ctx, t, c) => {
  const admin = isBoardAdmin(c);
  const users = admin
    ? await sql`select * from users where tenant_id=${t.id} order by lower(display_name)`
    : [];
  return json({
    tenant: publicTenant(t),
    me: c.user ? publicUser(c.user) : null,
    isAdmin: admin,
    users: users.map(publicUser),
  });
});

// Board settings. Merged into the existing config and re-normalized, so a partial patch
// can't drop keys and an invalid accent or dot count is simply ignored.
export const PATCH = withUser(async (req, ctx, t, c) => {
  const b = await req.json().catch(() => ({}));
  const name = String(b.name || '').trim() || t.name;
  const config = normalizeConfig({ ...t.config, ...(b.config || {}) }, name);
  if (!config.names.length) return json({ error: 'at least one person required' }, 400);
  const [tenant] = await sql`update tenants set name=${name},
      config=${JSON.stringify(config)}::jsonb where id=${t.id}
    returning slug, name, config, created_at`;
  return json({ tenant });
}, { adminOnly: true });
