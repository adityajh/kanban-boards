import { json, options } from '../../../lib/http';
import { withUser, isBoardAdmin, normalizeConfig, publicTenant, mayEditPlan } from '../../../lib/tenant';
import { publicPerson } from '../../../lib/auth';
import { boardPeople, withRole } from '../../../lib/people';
import { whoami, usedMetricKeys } from '../../../lib/plan';
import { metricKeyRefusal } from '../../../lib/plan-sections.mjs';
import { writeConfig } from '../../../lib/config-history';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Everything the settings screen needs in one call: the board, who you are here, and
// whether you may edit it.
export const GET = withUser(async (req, ctx, t, c) => {
  const admin = isBoardAdmin(c);
  return json({
    tenant: publicTenant(t),
    me: c.person ? { ...publicPerson(c.person), isAdmin: c.memberAdmin } : null,
    isAdmin: admin,
    users: admin ? (await boardPeople(t.id)).map(withRole) : [],
  });
});

// Board settings. Merged into the existing config and re-normalized, so a partial patch
// can't drop keys and an invalid accent or dot count is simply ignored.
//
// Every change through here is recorded in the board's history, the same as a section edit
// made by an agent. That matters more than it sounds: a history holding only the edits
// agents make would tell you what the machines did to your board and nothing about what you
// did, which is the half that is usually the answer.
export const PATCH = withUser(async (req, ctx, t, c) => {
  const b = await req.json().catch(() => ({}));
  const name = String(b.name || '').trim() || t.name;
  // The goal, the metrics and the periods are the board's constitution, and still a master
  // admin's to change. Section prose is not, and no longer comes through here at all —
  // see /api/plan/sections, which people and agents share.
  if (b.config && 'plan' in b.config && !mayEditPlan(c)) {
    return json({ error: 'only a master admin may change this board\'s plan' }, 403);
  }
  const config = normalizeConfig({ ...t.config, ...(b.config || {}) }, name);
  if (!config.names.length) return json({ error: 'at least one person required' }, 400);

  // The one guard that is not about who is calling: a metric key with numbers already filed
  // against it cannot be renamed or dropped, by a master admin as much as by anybody. Those
  // numbers do not move when the key does — they stay in the table pointing at a definition
  // that no longer exists, which is the one change here that history cannot undo cleanly.
  const refused = metricKeyRefusal(config.plan, await usedMetricKeys(t.id));
  if (refused) return json({ field: 'plan.metrics', error: refused }, 409);

  const changed = [...new Set([...Object.keys(t.config || {}), ...Object.keys(config)])]
    .filter((k) => JSON.stringify((t.config || {})[k]) !== JSON.stringify(config[k]));
  const written = await writeConfig(t.id, {
    config, name, changedBy: whoami(c),
    change: changed.length ? `settings updated (${changed.join(', ')})` : 'settings saved',
  });
  if (written.conflict) {
    return json({ error: 'the board changed while this was being saved — reload and try again' }, 409);
  }
  return json({ tenant: written.tenant, planVersion: written.version });
}, { adminOnly: true });
