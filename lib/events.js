import { sql } from './db';

// Who is acting, flattened from the caller. The name is written into the row rather than
// joined at read time, so the history still reads correctly after an agent or a person is
// removed from the board — a foreign key would either block that removal or blank the past.
export function actor(c) {
  if (c.person) return { kind: 'person', id: c.person.id, name: c.person.display_name };
  if (c.agent) return { kind: 'agent', id: c.agent.id, name: c.agent.name };
  if (c.admin) return { kind: 'admin', id: null, name: 'ADMIN_KEY' };
  return { kind: 'passphrase', id: null, name: 'board passphrase' };
}

// Append one row to the log. Deliberately not wrapped in a try/catch: if the audit trail
// cannot be written the caller should hear about it, because a change that happened with no
// record of who made it is worse than a failed request.
export async function logEvent(c, tenantId, verb, subjectType, subjectId, data = {}) {
  const a = actor(c);
  await sql`insert into events
      (tenant_id, actor_kind, actor_id, actor_name, verb, subject_type, subject_id, data)
    values (${tenantId}, ${a.kind}, ${a.id}, ${a.name}, ${verb},
            ${subjectType}, ${String(subjectId)}, ${JSON.stringify(data)}::jsonb)`;
}

// Row as returned to clients.
export const publicEvent = (e) => ({
  id: Number(e.id),
  actor: { kind: e.actor_kind, name: e.actor_name },
  verb: e.verb,
  subject: { type: e.subject_type, id: e.subject_id },
  data: e.data,
  at: e.created_at,
});
