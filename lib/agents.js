import { sql } from './db';

// The pure credential helpers live in agent-token.mjs so they can be tested under plain
// node; re-exported here so routes have one place to import agents from.
export { newAgentToken, validAgentName, SCOPES } from './agent-token.mjs';

export const boardAgents = (tenantId) => sql`
  select * from agents where tenant_id=${tenantId} order by lower(name)`;

// The token hash never leaves the server, and there is no endpoint that returns a token
// after the one response that issues it.
export const publicAgent = (a) => ({
  id: a.id,
  name: a.name,
  scope: a.scope,
  disabled: a.disabled_at != null,
  lastSeenAt: a.last_seen_at,
  createdAt: a.created_at,
});
