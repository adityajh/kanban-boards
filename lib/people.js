import { sql } from './db';
import { publicPerson } from './password.mjs';

// Everyone on one board, carrying the admin flag that belongs to that board rather than
// anything about the person globally.
export const boardPeople = (tenantId) => sql`
  select p.*, m.is_admin from memberships m join people p on p.id = m.person_id
  where m.tenant_id=${tenantId} order by lower(p.display_name)`;

export const withRole = (row) => ({ ...publicPerson(row), isAdmin: row.is_admin });

// Look a person up *through* this board's membership, never by id alone — the same rule
// that keeps every child route from reaching another board's rows.
export async function personOnBoard(personId, tenantId) {
  const [row] = await sql`select p.*, m.is_admin from memberships m
    join people p on p.id = m.person_id
    where m.person_id=${personId} and m.tenant_id=${tenantId}`;
  return row || null;
}

// A board with no admin can only be repaired with ADMIN_KEY, so don't let the UI create one.
export async function wouldStrandBoard(tenantId, personId) {
  const [{ count }] = await sql`select count(*)::int as count from memberships
    where tenant_id=${tenantId} and is_admin=true and person_id <> ${personId}`;
  return count === 0;
}
