import { waitUntil } from '@vercel/functions';
import { sql } from './db';
import { dispatch } from './webhooks';

// Who is acting, flattened from the caller. The name is written into the row rather than
// joined at read time, so the history still reads correctly after an agent or a person is
// removed from the board — a foreign key would either block that removal or blank the past.
export function actor(c) {
  if (c.person) return { kind: 'person', id: c.person.id, name: c.person.display_name };
  if (c.agent) return { kind: 'agent', id: c.agent.id, name: c.agent.name };
  if (c.admin) return { kind: 'admin', id: null, name: 'ADMIN_KEY' };
  return { kind: 'passphrase', id: null, name: 'board passphrase' };
}

// Row as returned to clients, and the body of a webhook.
export const publicEvent = (e) => ({
  id: Number(e.id),
  actor: { kind: e.actor_kind, name: e.actor_name },
  verb: e.verb,
  subject: { type: e.subject_type, id: e.subject_id },
  data: e.data,
  at: e.created_at,
});

// Append one row to the log, then wake whoever asked to hear about it.
//
// The insert is awaited and deliberately not wrapped in a try/catch: if the audit trail
// cannot be written the caller should hear about it, because a change with no record of
// who made it is worse than a failed request. The webhooks are the opposite — they run
// after the response through waitUntil, so a slow or dead endpoint costs the person who
// moved the card nothing. On a runtime without waitUntil the fan-out is simply skipped
// rather than awaited; the event feed is what makes that safe.
export async function logEvent(c, tenantOrId, verb, subjectType, subjectId, data = {}) {
  const tenant = typeof tenantOrId === 'object' ? tenantOrId : null;
  const tenantId = tenant ? tenant.id : tenantOrId;
  const a = actor(c);
  const [row] = await sql`insert into events
      (tenant_id, actor_kind, actor_id, actor_name, verb, subject_type, subject_id, data)
    values (${tenantId}, ${a.kind}, ${a.id}, ${a.name}, ${verb},
            ${subjectType}, ${String(subjectId)}, ${JSON.stringify(data)}::jsonb)
    returning *`;

  if (tenant) {
    const fanOut = dispatch(tenant, publicEvent(row), c.agent ? c.agent.id : null)
      .catch(() => {}); // a wake that fails is recorded on the agent, never raised here
    try { waitUntil(fanOut); } catch { /* not on Vercel: the feed is the catch-up path */ }
  }
  return row;
}
