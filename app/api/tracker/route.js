import { json, options } from '../../../lib/http';
import { withTenant, visibleAudiences } from '../../../lib/tenant';
import { KINDS, listItems, publicItem, planConfig, planEnabled } from '../../../lib/plan';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Everything, grouped by kind, in one call — so an agent catching up reads the whole plan
// once instead of six times. The board's plan config comes with it, because an agent
// cannot interpret an `actual` without knowing which metrics this board tracks.
export const GET = withTenant(async (req, ctx, t, c) => {
  if (!planEnabled(t)) return json({ error: 'this board has no plan' }, 404);
  const rows = await listItems(t.id, KINDS, visibleAudiences(c));
  const items = {};
  for (const k of KINDS) items[k] = [];
  for (const r of rows) items[r.kind].push(publicItem(r));
  return json({ plan: planConfig(t), items });
});
