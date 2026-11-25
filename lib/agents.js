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
  // Writes per minute. rl_count and rl_window_start are plumbing for the limiter and are
  // deliberately not exposed: nobody should build on a counter that resets itself.
  rateLimit: a.rate_limit,
  // The URL is shown so an admin can see where wakes go; the secret never is, after the
  // one response that issued it.
  webhookUrl: a.webhook_url || null,
  webhookVerbs: a.webhook_verbs || null,
  lastDeliveryAt: a.last_delivery_at || null,
  lastDeliveryStatus: a.last_delivery_status || null,
});
