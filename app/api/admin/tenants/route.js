import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withAdmin, hashKey, validSlug, newPassphrase, normalizeConfig } from '../../../../lib/tenant';
import { hashPassword, newPassword, validUsername } from '../../../../lib/auth';
import { whoami } from '../../../../lib/plan';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

export const GET = withAdmin(async () =>
  json(await sql`select slug, name, config, created_at from tenants order by name`));

// Create a board. The passphrase is returned once and only its hash is stored.
//
// An explicit `"passphrase": null` creates a board with no passphrase at all. A passphrase is
// one shared secret with full read and write that names nobody: every agent holding it writes
// as "board passphrase", any of them can sign as any other, and a leak cannot be traced to a
// holder or revoked from one. People sign in and are named by membership, and agents hold
// per-agent tokens that attribute, scope, rate-limit and revoke one at a time, so on a board
// created today a passphrase is pure liability. key_hash is NULL for such a board, and since
// null equals nothing in SQL, no bearer token can ever match it (see migration 012).
//
// Only a literal null opts out. An ABSENT key still mints one, exactly as before, and so does
// an empty string: the default was deliberately left alone so that existing callers and the
// admin screen do not change behaviour silently. Opting out is something a caller asks for.
export const POST = withAdmin(async (req, ctx, c) => {
  const b = await req.json().catch(() => ({}));
  const slug = String(b.slug || '').trim().toLowerCase();
  const name = String(b.name || '').trim();
  if (!validSlug(slug)) return json({ error: 'slug: 2-40 chars of a-z, 0-9, hyphen; not admin/api/docs' }, 400);
  if (!name) return json({ error: 'name required' }, 400);
  const config = normalizeConfig(b.config || {}, name);
  if (!config.names.length) return json({ error: 'at least one person required' }, 400);
  const noPassphrase = b.passphrase === null;
  const passphrase = noPassphrase ? null : (String(b.passphrase || '').trim() || newPassphrase(slug));
  if (passphrase !== null && passphrase.length < 12) return json({ error: 'passphrase must be at least 12 characters' }, 400);

  // Every board is created with one admin, so there is always somebody who can sign in and
  // add the rest. Defaults to the first person listed.
  // Only a username the caller actually asked for is worth rejecting the request over.
  const given = String(b.adminUsername || '').trim();
  if (given && !validUsername(given)) {
    return json({ error: 'adminUsername: 2-32 chars of a-z, 0-9, dot, underscore, hyphen' }, 400);
  }
  // A person's name need not make a usable username — "Mary Jane" has a space, "Jo" and "A"
  // are short. Fall back to the slug (already validated) rather than refusing the board,
  // and never fail here for a name we derived ourselves.
  const firstPerson = config.names[0];
  const derived = firstPerson.toLowerCase().replace(/[^a-z0-9._-]+/g, '');
  const adminUsername = given || (validUsername(derived) ? derived : slug.slice(0, 32));
  // Show the person's real name where the board lists people, not the derived username.
  const adminDisplay = config.names.find((n) => n.toLowerCase() === adminUsername.toLowerCase())
    || (given ? adminUsername : firstPerson);
  if (!config.names.includes(adminDisplay)) config.names = [...config.names, adminDisplay];
  const adminPassword = newPassword();

  try {
    const [tenant] = await sql`insert into tenants (slug, name, key_hash, config)
      values (${slug}, ${name}, ${passphrase === null ? null : hashKey(passphrase)}, ${JSON.stringify(config)}::jsonb)
      returning id, slug, name, config, created_at`;

    // Version 1 is the board as created. Migration 017 gave every board that already existed
    // this floor to revert to, and a board created after it should have the same guarantee
    // rather than a history that begins at its first edit — otherwise "put it back the way
    // it was" has no answer on a board whose first change was a mistake.
    await sql`insert into config_versions (tenant_id, version, config, changed_by, change)
      values (${tenant.id}, 1, ${JSON.stringify(config)}::jsonb, ${whoami(c)}, 'board created')`;

    // If that admin already has an account, they join this board with the password they
    // already use; only a genuinely new person gets one issued.
    const [existing] = await sql`select * from people where lower(username)=lower(${adminUsername})`;
    let admin = existing, issued = null;
    if (!admin) {
      issued = adminPassword;
      [admin] = await sql`insert into people (username, display_name, password_hash, must_change)
        values (${adminUsername}, ${adminDisplay}, ${await hashPassword(issued)}, true) returning *`;
    }
    await sql`insert into memberships (person_id, tenant_id, is_admin)
      values (${admin.id}, ${tenant.id}, true)`;

    const { id, ...publicRow } = tenant;
    // Passphrase (null when the board has none) and, for a new person, their password are
    // both shown exactly once.
    return json({
      tenant: publicRow,
      passphrase,
      admin: {
        username: admin.username, displayName: admin.display_name,
        password: issued, existing: !!existing,
      },
    }, 201);
  } catch (e) {
    if (e.code === '23505') return json({ error: 'that slug (or passphrase) is already taken' }, 409);
    throw e;
  }
});
