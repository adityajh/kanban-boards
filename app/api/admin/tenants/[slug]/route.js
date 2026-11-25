import { sql } from '../../../../../lib/db';
import { json, options } from '../../../../../lib/http';
import { withAdmin, hashKey, newPassphrase, normalizeConfig } from '../../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Rename, change settings (merged into the existing config), rotate the passphrase with
// {rotate: true} (optionally {passphrase}), or retire it with {removePassphrase: true}.
// No delete here on purpose.
//
// Retiring is its own flag rather than a mode of rotate: removing a credential and replacing
// one are different acts, and a typo should not be able to turn one into the other. Sending
// both is refused rather than guessed at. A board with no passphrase (key_hash NULL) is
// reached by signing in or with a per-agent token, which attribute and revoke individually
// where a shared passphrase cannot; see migration 012.
export const PATCH = withAdmin(async (req, { params }) => {
  const b = await req.json().catch(() => ({}));
  const [cur] = await sql`select * from tenants where slug=${params.slug}`;
  if (!cur) return json({ error: 'not found' }, 404);
  const name = String(b.name || '').trim() || cur.name;
  const config = b.config ? normalizeConfig({ ...cur.config, ...b.config }, name) : cur.config;
  if (b.rotate && b.removePassphrase) {
    return json({ error: 'send either rotate or removePassphrase, not both' }, 400);
  }
  let passphrase = null;
  if (b.rotate) {
    passphrase = String(b.passphrase || '').trim() || newPassphrase(cur.slug);
    if (passphrase.length < 12) return json({ error: 'passphrase must be at least 12 characters' }, 400);
  }
  // key_hash cannot say "leave it" and "clear it" through one coalesce, so retiring is a
  // separate statement, and runs before the shared update so the rename/config still apply.
  if (b.removePassphrase) {
    const [tenant] = await sql`update tenants set name=${name}, config=${JSON.stringify(config)}::jsonb,
        key_hash = null
      where id=${cur.id} returning slug, name, config, created_at`;
    // Anything still using the old passphrase stops working at once, which is the point. An
    // admin retiring one needs to know whether anything is left to pick up the work, so say
    // how many per-agent tokens exist on the board rather than just "ok".
    const [{ n }] = await sql`select count(*)::int as n from agents where tenant_id=${cur.id}`;
    return json({ tenant, passphraseRemoved: true, agentsOnBoard: n });
  }
  const [tenant] = await sql`update tenants set name=${name}, config=${JSON.stringify(config)}::jsonb,
      key_hash = coalesce(${passphrase ? hashKey(passphrase) : null}, key_hash)
    where id=${cur.id} returning slug, name, config, created_at`;
  return json(passphrase ? { tenant, passphrase } : { tenant });
});

// Delete a board and everything on it. Irreversible: cards, subtasks, links, notes and
// resources all cascade away with it.
//
// The slug has to be sent back in the body to go through. That is not UI politeness — it
// is enforced here, so a mis-aimed script cannot destroy a client's history on a bare
// DELETE. The response says exactly what went, because "ok: true" is a poor receipt for
// something that cannot be undone.
export const DELETE = withAdmin(async (req, { params }) => {
  const [tenant] = await sql`select * from tenants where slug=${params.slug}`;
  if (!tenant) return json({ error: 'not found' }, 404);

  const b = await req.json().catch(() => ({}));
  if (String(b.confirm || '') !== tenant.slug) {
    return json({ error: `to delete this board, send {"confirm": "${tenant.slug}"}` }, 400);
  }

  const [counts] = await sql`select
      (select count(*) from cards where tenant_id=${tenant.id})::int     as cards,
      (select count(*) from resources where tenant_id=${tenant.id})::int as resources,
      (select count(*) from memberships where tenant_id=${tenant.id})::int as people,
      (select count(*) from subtasks s join cards c on c.id=s.card_id
        where c.tenant_id=${tenant.id})::int as subtasks,
      (select count(*) from links l join cards c on c.id=l.card_id
        where c.tenant_id=${tenant.id})::int as links,
      (select count(*) from notes n join cards c on c.id=n.card_id
        where c.tenant_id=${tenant.id})::int as notes`;

  await sql`delete from tenants where id=${tenant.id}`;

  // Same rule as removing someone from their last board: an account on no boards can sign
  // in to nothing and can never be reached again, so it goes with it.
  const orphaned = await sql`delete from people p
    where not exists (select 1 from memberships m where m.person_id = p.id)
    returning p.username`;

  return json({
    deleted: { slug: tenant.slug, name: tenant.name, ...counts },
    accountsRemoved: orphaned.map((o) => o.username),
  });
});
