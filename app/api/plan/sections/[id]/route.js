import { json, options } from '../../../../../lib/http';
import { withTenant, normalizeConfig, mayEditSections, isPerson } from '../../../../../lib/tenant';
import { logEvent } from '../../../../../lib/events';
import { planConfig, planEnabled, whoami, findContactDetail } from '../../../../../lib/plan';
import {
  findSection, sectionRefusal, applySectionPatch, moveSection, planSections,
} from '../../../../../lib/plan-sections.mjs';
import { configVersion, writeConfig } from '../../../../../lib/config-history';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// One Plan section, addressable at last. Before migration 017 a section was an anonymous
// item in an array and every edit was a replace of the whole plan, so two people editing
// two different sections meant one of the two edits vanished with nothing to show it had.
//
// What may be changed here is the board's prose: titles, notes, bullets, tables, diagrams.
// What may not is the goal, the metrics and the periods — those still go through the
// settings route and still belong to whoever runs every board, because changing them
// reinterprets numbers already recorded rather than correcting a sentence.

const notFound = () => json({ error: 'not found' }, 404);

export const GET = withTenant(async (req, { params }, t, c) => {
  if (!planEnabled(t)) return notFound();
  const found = findSection(planConfig(t), params.id);
  if (!found) return notFound();
  return json({ section: found.section, position: found.index, planVersion: await configVersion(t.id) });
});

// Edit one section. `expected_version` is the plan version you read; send it and a 409 says
// somebody changed the plan first, rather than quietly losing their edit. `position` moves
// the section, because moving one is a different act from editing it.
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

  const bad = sectionRefusal(patch, { findContact: findContactDetail });
  if (bad) return json({ error: bad.error, field: bad.field }, 422);
  if (position != null && !Number.isFinite(Number(position))) {
    return json({ field: 'position', error: 'position must be a number' }, 422);
  }
  if (!Object.keys(patch).length && position == null) {
    return json({ error: 'nothing to change' }, 400);
  }

  const plan = planConfig(t);
  const found = findSection(plan, params.id);
  if (!found) return notFound();

  const current = await configVersion(t.id);
  if (expected != null && Number(expected) !== current) {
    return json({
      error: 'version mismatch — re-read the plan and apply your change to it',
      expected: Number(expected), current, section: found.section,
    }, 409);
  }

  const next = applySectionPatch(found.section, patch);
  let sections = planSections(plan).map((s, i) => (i === found.index ? next : s));
  if (position != null) sections = moveSection(sections, found.index, Number(position));

  const config = normalizeConfig({ ...t.config, plan: { ...plan, sections } }, t.name);
  const fields = Object.keys(patch);
  const written = await writeConfig(t.id, {
    config, name: t.name, changedBy: whoami(c),
    change: `section ${found.section.id} updated`
      + (fields.length ? ` (${fields.join(', ')})` : '')
      + (position != null ? ' and moved' : ''),
  });
  if (written.conflict) {
    return json({
      error: 'the plan changed while this was being written — re-read it and try again',
      current: await configVersion(t.id),
    }, 409);
  }

  // The event names what moved; the full previous config is in the history, which is where
  // a diff belongs. An event carrying two whole configs would make the feed unreadable.
  await logEvent(c, t, 'plan.section.updated', 'plan', found.section.id, {
    title: next.title, fields, moved: position != null ? Number(position) : undefined,
    version: written.version,
  });
  return json({ section: next, planVersion: written.version });
});

// Deleting a section destroys content rather than correcting it. It is revertible now, so
// this is not reserved for a master admin — but it does ask for a person, because an agent
// that can delete the board's prose has no reason to edit it instead.
export const DELETE = withTenant(async (req, { params }, t, c) => {
  if (!planEnabled(t)) return notFound();
  if (!isPerson(c)) {
    return json({ error: 'only a signed-in person may delete a plan section' }, 403);
  }
  const plan = planConfig(t);
  const found = findSection(plan, params.id);
  if (!found) return notFound();

  const b = await req.json().catch(() => ({}));
  const current = await configVersion(t.id);
  if (b.expected_version != null && Number(b.expected_version) !== current) {
    return json({ error: 'version mismatch', expected: Number(b.expected_version), current }, 409);
  }

  const sections = planSections(plan).filter((_, i) => i !== found.index);
  const config = normalizeConfig({ ...t.config, plan: { ...plan, sections } }, t.name);
  const written = await writeConfig(t.id, {
    config, name: t.name, changedBy: whoami(c),
    change: `section ${found.section.id} deleted`,
  });
  if (written.conflict) {
    return json({ error: 'the plan changed while this was being written — re-read it and try again' }, 409);
  }
  await logEvent(c, t, 'plan.section.deleted', 'plan', found.section.id,
    { title: found.section.title, version: written.version });
  return json({ ok: true, planVersion: written.version });
});
