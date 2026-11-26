import { json, options } from '../../../../lib/http';
import { withTenant, normalizeConfig, mayEditSections, mayEditPlan } from '../../../../lib/tenant';
import { logEvent } from '../../../../lib/events';
import { planConfig, planEnabled, whoami, findContactDetail, metricKeys } from '../../../../lib/plan';
import { periodRefusal, planPeriods, moveSection } from '../../../../lib/plan-sections.mjs';
import { configVersion, writeConfig } from '../../../../lib/config-history';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// The Targets table's columns. Adding one was master-admin-only along with everything else
// in the plan config, which blocked an agent every month on a calendar fact — that December
// exists and will be measured.
//
// Since 26 Nov the month is open and the numbers are not. A period with no targets asserts
// nothing; it is an empty column. A target is what an `actual` is judged against, so moving
// one from 800 to 600 turns last month's miss into a hit without anybody touching the
// figure — which is why `targets` is refused to a caller who may not edit the plan, and the
// refusal is a 403 rather than a 422: the value is fine, the caller is not.

const MAX_PERIODS = 60;

export const GET = withTenant(async (req, ctx, t) => {
  if (!planEnabled(t)) return json({ error: 'this board has no plan' }, 404);
  const periods = planPeriods(planConfig(t));
  return json({
    periods: periods.map((p, i) => ({
      id: p.id, label: p.label || null, position: i,
      // Whether anybody has set numbers against it yet, without sending the numbers: an
      // agent deciding whether a period still needs targets does not need their values.
      hasTargets: !!(p.targets && Object.keys(p.targets).length),
    })),
    metrics: metricKeys(t) || [],
    planVersion: await configVersion(t.id),
  });
});

export const POST = withTenant(async (req, ctx, t, c) => {
  if (!planEnabled(t)) return json({ error: 'this board has no plan' }, 404);
  if (!mayEditSections(c)) {
    return json({
      error: 'a board passphrase cannot edit the plan, because it names nobody: sign in, '
        + 'or use an agent token',
    }, 403);
  }
  const b = await req.json().catch(() => ({}));
  const { expected_version: expected, position, ...period } = b;

  if ('targets' in period && !mayEditPlan(c)) {
    return json({
      error: 'only a master admin may set a period\'s targets — a target is what every '
        + 'actual is judged against. Add the period without them and ask for the numbers.',
      field: 'targets',
    }, 403);
  }

  const plan = planConfig(t);
  const existing = planPeriods(plan);
  const bad = periodRefusal(period, {
    metricKeys: metricKeys(t), partial: false, findContact: findContactDetail,
    taken: existing.map((p) => p.id),
  });
  if (bad) return json({ error: bad.error, field: bad.field }, 422);
  if (existing.length >= MAX_PERIODS) {
    return json({ error: `a plan may have at most ${MAX_PERIODS} periods` }, 422);
  }

  const current = await configVersion(t.id);
  if (expected != null && Number(expected) !== current) {
    return json({
      error: 'version mismatch — re-read the plan and apply your change to it',
      expected: Number(expected), current,
    }, 409);
  }

  const added = { id: String(period.id).trim(), ...(period.label != null ? { label: period.label } : {}) };
  if (period.targets) added.targets = period.targets;
  let periods = [...existing, added];
  if (position != null) periods = moveSection(periods, periods.length - 1, Number(position));

  const config = normalizeConfig({ ...t.config, plan: { ...plan, periods } }, t.name);
  const written = await writeConfig(t.id, {
    config, name: t.name, changedBy: whoami(c), change: `period ${added.id} added`,
  });
  if (written.conflict) {
    return json({
      error: 'the plan changed while this was being written — re-read it and try again',
      current: await configVersion(t.id),
    }, 409);
  }
  await logEvent(c, t, 'plan.period.added', 'plan', added.id,
    { label: added.label || null, hasTargets: !!added.targets, version: written.version });
  return json({ period: added, planVersion: written.version }, 201);
});
