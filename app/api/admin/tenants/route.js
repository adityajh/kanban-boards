import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withAdmin, hashKey, validSlug, newPassphrase, normalizeConfig } from '../../../../lib/tenant';
import { hashPassword, newPassword, validUsername } from '../../../../lib/auth';
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

  // Every board is created with one admin, so there is always somebody who can sign in and
  // add the rest. Defaults to the first person listed.
  // A person's name is not a username ("Mary Jane" has a space), so derive one when the
  // caller doesn't give it rather than rejecting the board.
  const given = String(b.adminUsername || '').trim();
  const firstPerson = config.names[0];
  const adminUsername = given || firstPerson.toLowerCase().replace(/[^a-z0-9._-]+/g, '');
  if (!validUsername(adminUsername)) {
    return json({ error: 'adminUsername: 2-32 chars of a-z, 0-9, dot, underscore, hyphen' }, 400);
  }
  // Show the person's real name where the board lists people, not the derived username.
  const adminDisplay = config.names.find((n) => n.toLowerCase() === adminUsername.toLowerCase())
    || (given ? adminUsername : firstPerson);
  if (!config.names.includes(adminDisplay)) config.names = [...config.names, adminDisplay];
  const adminPassword = newPassword();

  try {
    const [tenant] = await sql`insert into tenants (slug, name, key_hash, config)
      values (${slug}, ${name}, ${hashKey(passphrase)}, ${JSON.stringify(config)}::jsonb)
      returning id, slug, name, config, created_at`;
    await sql`insert into users (tenant_id, username, display_name, password_hash, is_admin, must_change)
      values (${tenant.id}, ${adminUsername}, ${adminDisplay}, ${await hashPassword(adminPassword)}, true, true)`;
    const { id, ...publicRow } = tenant;
    // Passphrase and admin password are both shown exactly once.
    return json({
      tenant: publicRow,
      passphrase,
      admin: { username: adminUsername, displayName: adminDisplay, password: adminPassword },
    }, 201);
  } catch (e) {
    if (e.code === '23505') return json({ error: 'that slug (or passphrase) is already taken' }, 409);
    throw e;
  }
});
