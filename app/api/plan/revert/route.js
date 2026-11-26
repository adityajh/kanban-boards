import { json, options } from '../../../../lib/http';
import { withTenant, normalizeConfig, isPerson } from '../../../../lib/tenant';
import { logEvent } from '../../../../lib/events';
import { whoami, usedMetricKeys } from '../../../../lib/plan';
import { metricKeyRefusal } from '../../../../lib/plan-sections.mjs';
import { configAtVersion, configVersion, writeConfig } from '../../../../lib/config-history';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Put the board back the way it was at a given version.
//
// A revert is a forward move: the old config is written as a NEW version rather than the
// counter being rewound. The history stays append-only, so reverting a revert is just
// another revert and nothing is ever lost — including the thing you reverted away from,
// which you may want back when it turns out the agent was right.
//
// People only. This is the undo for an agent's edit, and an agent holding its own undo is
// circular: the whole reason section editing could be opened up on 26 Nov is that somebody
// who is not the editor can put it back.
export const POST = withTenant(async (req, ctx, t, c) => {
  if (!isPerson(c)) {
    return json({ error: 'only a signed-in person may revert this board\'s settings' }, 403);
  }
  const b = await req.json().catch(() => ({}));
  const n = Number(b.version);
  if (!Number.isInteger(n) || n < 1) {
    return json({ field: 'version', error: 'version must be a positive integer' }, 422);
  }

  const current = await configVersion(t.id);
  if (b.expected_version != null && Number(b.expected_version) !== current) {
    return json({ error: 'version mismatch', expected: Number(b.expected_version), current }, 409);
  }
  if (n === current) return json({ error: `version ${n} is already the current one` }, 409);

  const [row] = await configAtVersion(t.id, n);
  if (!row) return json({ error: 'not found' }, 404);

  const config = normalizeConfig(row.config, row.config?.brand || t.name);

  // A revert can orphan numbers just as an edit can: version 2 may predate a metric that
  // has actuals filed against it today. Same guard, same reason — it is about the data,
  // not about who is asking.
  const refused = metricKeyRefusal(config.plan, await usedMetricKeys(t.id));
  if (refused) {
    return json({
      error: `reverting to version ${n} would orphan recorded numbers. ${refused}`,
    }, 409);
  }

  const written = await writeConfig(t.id, {
    config, name: t.name, changedBy: whoami(c),
    change: `reverted to version ${n}`,
  });
  if (written.conflict) {
    return json({ error: 'the board changed while this was being written — try again' }, 409);
  }
  await logEvent(c, t, 'plan.reverted', 'plan', String(n),
    { to: n, version: written.version });
  return json({ ok: true, revertedTo: n, planVersion: written.version, config });
});
