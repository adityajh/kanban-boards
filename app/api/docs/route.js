import { sql } from '../../../lib/db';
import { json, options } from '../../../lib/http';
import { withTenant, visibleAudiences } from '../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// The list never carries bodies. A board's documents are the thing an agent re-reads most
// often, and shipping every body on every list is how a cheap index becomes an expensive
// one; `GET /docs/<key>` fetches the text.
export const GET = withTenant(async (req, ctx, t, c) => {
  const rows = await sql`select key, title, audience, version, updated_by, updated_at,
      length(body) as bytes
    from documents where tenant_id=${t.id} and audience = any(${visibleAudiences(c)}::text[])
    order by lower(key)`;
  return json(rows.map(r => ({
    key: r.key, title: r.title, audience: r.audience, version: r.version,
    updatedBy: r.updated_by, updatedAt: r.updated_at, bytes: Number(r.bytes),
  })));
});
