import { json, options } from '../../../../../lib/http';
import {
  withTenant, normalizeConfig, mayEditSections, mayEditPlan, isPerson,
} from '../../../../../lib/tenant';
import { logEvent } from '../../../../../lib/events';
import {
  planConfig, planEnabled, whoami, findContactDetail, metricKeys, actualsForPeriod,
} from '../../../../../lib/plan';
import { findPeriod, periodRefusal, applyPeriodPatch, planPeriods, moveSection } from '../../../../../lib/plan-sections.mjs';
import { configVersion, writeConfig } from '../../../../../lib/config-history';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// One column of the Targets table. The label is prose and anybody who can be named may fix
// it; the targets are the numbers every actual is judged against and stay with whoever runs
// every board. See the periods note in app/api/plan/periods/route.js for why the line is
// drawn there rather than around the period as a whole.

const notFound = () => json({ error: 'not found' }, 404);

export const GET = withTenant(async (req, { params }, t) => {
  if (!planEnabled(t)) return notFound();
  const found = findPeriod(planConfig(t), params.id);
  if (!found) return notFound();
  return json({
    period: found.period, position: found.index, planVersion: await configVersion(t.id),
  });
});

export const PATCH = withTenant(async (req, { params }, t, c) => {
  if (!planEnabled(t)) return notFound();
  if (!mayEditSections(c)) {
    return json({
      error: 'a board passphrase cannot edit the plan, because it names nobody: sign in, '
        + 'or use an agent token',
    }, 403);
  }
  const b = await req.json().catch(() => ({}));
  const { expected_version: expected, position, ...patch } = b;

  if ('targets' in patch && !mayEditPlan(c)) {
    return json({
      error: 'only a master admin may change a period\'s targets — moving one reinterprets '
        + 'every actual already recorded against it',
      field: 'targets',
    }, 403);
  }

  const bad = periodRefusal(patch, { metricKeys: metricKeys(t), findContact: findContactDetail });
  if (bad) return json({ error: bad.error, field: bad.field }, 422);
  if (!Object.keys(patch).length && position == null) {
    return json({ error: 'nothing to change' }, 400);
  }

  const plan = planConfig(t);
  const found = findPeriod(plan, params.id);
  if (!found) return notFound();

  const current = await configVersion(t.id);
  if (expected != null && Number(expected) !== current) {
    return json({
      error: 'version mismatch — re-read the plan and apply your change to it',
      expected: Number(expected), current, period: found.period,
    }, 409);
  }

  const next = applyPeriodPatch(found.period, patch);
  let periods = planPeriods(plan).map((p, i) => (i === found.index ? next : p));
  if (position != null) periods = moveSection(periods, found.index, Number(position));

  const config = normalizeConfig({ ...t.config, plan: { ...plan, periods } }, t.name);
  const fields = Object.keys(patch);
  const written = await writeConfig(t.id, {
    config, name: t.name, changedBy: whoami(c),
    change: `period ${found.period.id} updated`
      + (fields.length ? ` (${fields.join(', ')})` : '')
      + (position != null ? ' and moved' : ''),
  });
  if (written.conflict) {
    return json({ error: 'the plan changed while this was being written — re-read it and try again' }, 409);
  }
  await logEvent(c, t, 'plan.period.updated', 'plan', found.period.id,
    { fields, version: written.version });
  return json({ period: next, planVersion: written.version });
});

// A person's act, like deleting a section — and with one extra refusal. Removing a period
// that has numbers filed against it leaves those `actual` rows measured against nothing,
// which is the same orphaning metricKeyRefusal exists to prevent, so it is refused for the
// same reason and to everybody. Clear its targets instead if it was a mistake.
export const DELETE = withTenant(async (req, { params }, t, c) => {
  if (!planEnabled(t)) return notFound();
  if (!isPerson(c)) {
    return json({ error: 'only a signed-in person may delete a plan period' }, 403);
  }
  const plan = planConfig(t);
  const found = findPeriod(plan, params.id);
  if (!found) return notFound();

  const b = await req.json().catch(() => ({}));
  const current = await configVersion(t.id);
  if (b.expected_version != null && Number(b.expected_version) !== current) {
    return json({ error: 'version mismatch', expected: Number(b.expected_version), current }, 409);
  }

  // The link between an actual and a period is the id and nothing else, so that is what is
  // counted. Checking instead whether the period's target metrics have actuals somewhere on
  // the board would refuse deleting a 2027 period because November has figures.
  const n = await actualsForPeriod(t.id, found.period.id);
  if (n) {
    return json({
      error: `${found.period.id} has ${n} actual${n === 1 ? '' : 's'} recorded against it. `
        + 'Deleting the period would leave them measured against nothing. Clear its targets '
        + 'instead, or delete those rows first if they were filed in error.',
      actuals: n,
    }, 409);
  }

  const periods = planPeriods(plan).filter((_, i) => i !== found.index);
  const config = normalizeConfig({ ...t.config, plan: { ...plan, periods } }, t.name);
  const written = await writeConfig(t.id, {
    config, name: t.name, changedBy: whoami(c), change: `period ${found.period.id} deleted`,
  });
  if (written.conflict) {
    return json({ error: 'the plan changed while this was being written — re-read it and try again' }, 409);
  }
  await logEvent(c, t, 'plan.period.deleted', 'plan', found.period.id,
    { label: found.period.label || null, version: written.version });
  return json({ ok: true, planVersion: written.version });
});
