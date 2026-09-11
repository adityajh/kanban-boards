import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withAdmin, hashKey, validSlug, newPassphrase, normalizeConfig } from '../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

export const GET = withAdmin(async () =>
  json(await sql`select slug, name, config, created_at from tenants order by name`));

// Create a board. The passphrase is returned once and only its hash is stored.
export const POST = withAdmin(async (req) => {
  const b = await req.json().catch(() => ({}));
  const slug = String(b.slug || '').trim().toLowerCase();
  const name = String(b.name || '').trim();
  if (!validSlug(slug)) return json({ error: 'slug: 2-40 chars of a-z, 0-9, hyphen; not admin/api/docs' }, 400);
  if (!name) return json({ error: 'name required' }, 400);
  const config = normalizeConfig(b.config || {}, name);
  if (!config.names.length) return json({ error: 'at least one person required' }, 400);
  const passphrase = String(b.passphrase || '').trim() || newPassphrase(slug);
  if (passphrase.length < 12) return json({ error: 'passphrase must be at least 12 characters' }, 400);
  try {
    const [tenant] = await sql`insert into tenants (slug, name, key_hash, config)
      values (${slug}, ${name}, ${hashKey(passphrase)}, ${JSON.stringify(config)}::jsonb)
      returning slug, name, config, created_at`;
    return json({ tenant, passphrase }, 201);
  } catch (e) {
    if (e.code === '23505') return json({ error: 'that slug (or passphrase) is already taken' }, 409);
    throw e;
  }
});
