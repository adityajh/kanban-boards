import { sql } from '../../../../../lib/db';
import { json, options } from '../../../../../lib/http';
import { withAdmin, hashKey, newPassphrase, normalizeConfig } from '../../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Rename, change settings (merged into the existing config), or rotate the passphrase
// with {rotate: true} (optionally {passphrase}). No delete here on purpose.
export const PATCH = withAdmin(async (req, { params }) => {
  const b = await req.json().catch(() => ({}));
  const [cur] = await sql`select * from tenants where slug=${params.slug}`;
  if (!cur) return json({ error: 'not found' }, 404);
  const name = String(b.name || '').trim() || cur.name;
  const config = b.config ? normalizeConfig({ ...cur.config, ...b.config }, name) : cur.config;
  let passphrase = null;
  if (b.rotate) {
    passphrase = String(b.passphrase || '').trim() || newPassphrase(cur.slug);
    if (passphrase.length < 12) return json({ error: 'passphrase must be at least 12 characters' }, 400);
  }
  const [tenant] = await sql`update tenants set name=${name}, config=${JSON.stringify(config)}::jsonb,
      key_hash = coalesce(${passphrase ? hashKey(passphrase) : null}, key_hash)
    where id=${cur.id} returning slug, name, config, created_at`;
  return json(passphrase ? { tenant, passphrase } : { tenant });
});
