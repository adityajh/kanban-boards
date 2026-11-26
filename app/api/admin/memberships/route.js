import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withAdmin } from '../../../../lib/tenant';
import { wouldStrandBoard } from '../../../../lib/people';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// The per-board settings routes take the board from the credential, so none of them can say
// "put this person on that board". These two address a membership by board AND person, which
// is what a cross-board screen needs. They change memberships only: a `people` row is never
// created, deleted or reset here, because an account's lifecycle is not a board decision.
const target = async (b) => {
  const slug = String(b.slug || '').trim();
  const personId = Number(b.personId);
  if (!slug || !Number.isInteger(personId) || personId < 1) return { bad: true };
  const [tenant] = await sql`select * from tenants where slug=${slug}`;
  const [person] = await sql`select * from people where id=${personId}`;
  return { tenant, person };
};

// Add someone to a board, or change their admin flag if they are already on it.
export const POST = withAdmin(async (req) => {
  const b = await req.json().catch(() => ({}));
  const { bad, tenant, person } = await target(b);
  if (bad) return json({ error: 'slug and personId are required' }, 400);
  if (!tenant) return json({ error: 'board not found' }, 404);
  if (!person) return json({ error: 'person not found' }, 404);

  const [current] = await sql`select is_admin from memberships
    where person_id=${person.id} and tenant_id=${tenant.id}`;

  // Demoting is the other way to leave a board with nobody who can run it, so it gets the
  // same guard, and the same wording, as the per-board route.
  if (current?.is_admin && b.isAdmin === false && await wouldStrandBoard(tenant.id, person.id)) {
    return json({ error: 'this is the only admin on the board' }, 409);
  }

  // An omitted isAdmin means "be a member" for a new row and "leave the flag alone" for an
  // existing one, so re-posting a plain add can never quietly demote an admin.
  const isAdmin = typeof b.isAdmin === 'boolean' ? b.isAdmin : (current?.is_admin === true);
  await sql`insert into memberships (person_id, tenant_id, is_admin)
    values (${person.id}, ${tenant.id}, ${isAdmin})
    on conflict (person_id, tenant_id) do update set is_admin = excluded.is_admin`;

  // Keep the assignee roster in step, so the person is assignable at once, as adding them
  // from the board's own Settings does.
  const names = tenant.config?.names || [];
  if (!names.includes(person.display_name)) {
    await sql`update tenants set config = jsonb_set(config, '{names}', ${JSON.stringify([...names, person.display_name])}::jsonb)
      where id=${tenant.id}`;
  }
  return json({ ok: true, slug: tenant.slug, personId: person.id, isAdmin, added: !current });
});

// Take someone off one board. Their account and every other board are untouched.
export const DELETE = withAdmin(async (req) => {
  const b = await req.json().catch(() => ({}));
  const { bad, tenant, person } = await target(b);
  if (bad) return json({ error: 'slug and personId are required' }, 400);
  if (!tenant) return json({ error: 'board not found' }, 404);
  if (!person) return json({ error: 'person not found' }, 404);

  const [current] = await sql`select is_admin from memberships
    where person_id=${person.id} and tenant_id=${tenant.id}`;
  if (!current) return json({ error: 'not a member of this board' }, 404);

  // A board nobody can administer is repairable only with ADMIN_KEY, and this panel is where
  // that slip is easiest to make.
  if (current.is_admin && await wouldStrandBoard(tenant.id, person.id)) {
    return json({ error: 'this is the only admin on the board' }, 409);
  }
  await sql`delete from memberships where person_id=${person.id} and tenant_id=${tenant.id}`;

  // Unlike the per-board route, the account is NOT deleted when this was their last board.
  // That deletion is a decision about a person, and it is irreversible (a new password is
  // issued on re-adding); here the account is left standing and shows up under "on no board"
  // so someone chooses what to do with it. config.names is left alone for the same reason as
  // there: cards may still be assigned to this person.
  return json({ ok: true });
});
