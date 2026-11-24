import { sql } from './db';

export {
  KINDS, LANES, DECISION_STATES, MILESTONE_STATES, LEVELS, RISK_STATES, LOG_KINDS,
  validateItem, decisionRefusal, newLogId, validItemId, fieldsFor, findContactDetail,
} from './tracker.mjs';

// A board shows the Plan only when its config declares one. Nothing appears on Inditress or
// ZEAL because the code shipped; the tab is a per-board decision.
export const planConfig = (tenant) => (tenant.config && tenant.config.plan) || null;
export const planEnabled = (tenant) => !!planConfig(tenant);

// The metric keys this board tracks. Counsellor declares contacted…enrolled; another board
// declares installs and crash-free. The app never knows which.
export function metricKeys(tenant) {
  const p = planConfig(tenant);
  if (!p || !Array.isArray(p.metrics)) return null;
  return p.metrics.map((m) => String(m && m.key)).filter(Boolean);
}

export const publicItem = (r) => ({
  kind: r.kind,
  id: r.item_id,
  ...r.data,
  audience: r.audience,
  version: r.version,
  updatedBy: r.updated_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const whoami = (c) => (c.person ? c.person.display_name
  : c.agent ? c.agent.name
  : c.admin ? 'ADMIN_KEY' : 'board passphrase');

export const listItems = (tenantId, kinds, audiences) => sql`
  select * from tracker_items
  where tenant_id=${tenantId} and kind = any(${kinds}::text[])
    and audience = any(${audiences}::text[])
  order by kind, created_at desc`;

export const findItem = (tenantId, kind, itemId, audiences) => sql`
  select * from tracker_items
  where tenant_id=${tenantId} and kind=${kind} and lower(item_id)=lower(${itemId})
    and audience = any(${audiences}::text[])`;
