import { sql } from '../../../lib/db';
import { json, options } from '../../../lib/http';
import { withUser, isBoardAdmin, normalizeConfig, publicTenant } from '../../../lib/tenant';
import { publicPerson } from '../../../lib/auth';
import { boardPeople, withRole } from '../../../lib/people';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Everything the settings screen needs in one call: the board, who you are here, and
// whether you may edit it.
export const GET = withUser(async (req, ctx, t, c) => {
  const admin = isBoardAdmin(c);
  return json({
    tenant: publicTenant(t),
    me: c.person ? { ...publicPerson(c.person), isAdmin: c.memberAdmin } : null,
    isAdmin: admin,
    users: admin ? (await boardPeople(t.id)).map(withRole) : [],
  });
});

// Board settings. Merged into the existing config and re-normalized, so a partial patch
// can't drop keys and an invalid accent or dot count is simply ignored.
export const PATCH = withUser(async (req, ctx, t) => {
  const b = await req.json().catch(() => ({}));
  const name = String(b.name || '').trim() || t.name;
  const config = normalizeConfig({ ...t.config, ...(b.config || {}) }, name);
  if (!config.names.length) return json({ error: 'at least one person required' }, 400);
  const [tenant] = await sql`update tenants set name=${name},
      config=${JSON.stringify(config)}::jsonb where id=${t.id}
    returning slug, name, config, created_at`;
  return json({ tenant });
}, { adminOnly: true });
