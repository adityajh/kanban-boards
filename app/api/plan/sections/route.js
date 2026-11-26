import { json, options } from '../../../../lib/http';
import { withTenant, normalizeConfig, mayEditSections } from '../../../../lib/tenant';
import { logEvent } from '../../../../lib/events';
import { planConfig, planEnabled, whoami, findContactDetail } from '../../../../lib/plan';
import { sectionRefusal, moveSection, planSections } from '../../../../lib/plan-sections.mjs';
import { configVersion, writeConfig } from '../../../../lib/config-history';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

const MAX_SECTIONS = 40;

// The section list and the plan's current version, which is what you send back as
// `expected_version`. The whole plan also comes down with GET /api/tracker; this is the
// cheap call for an agent that only wants to know the ids.
export const GET = withTenant(async (req, ctx, t, c) => {
  if (!planEnabled(t)) return json({ error: 'this board has no plan' }, 404);
  const sections = planSections(planConfig(t));
  return json({
    sections: sections.map((s, i) => ({ id: s.id, title: s.title, position: i })),
    planVersion: await configVersion(t.id),
  });
});

// Add a section. The id is assigned from the title and returned, because the caller needs it
// to edit the section afterwards and has no way to predict the de-duplication.
export const POST = withTenant(async (req, ctx, t, c) => {
  if (!planEnabled(t)) return json({ error: 'this board has no plan' }, 404);
  if (!mayEditSections(c)) {
    return json({
      error: 'a board passphrase cannot edit the plan, because it names nobody: sign in, '
        + 'or use an agent token',
    }, 403);
  }
  const b = await req.json().catch(() => ({}));
  const { expected_version: expected, position, ...section } = b;

  const bad = sectionRefusal(section, { findContact: findContactDetail, partial: false });
  if (bad) return json({ error: bad.error, field: bad.field }, 422);

  const plan = planConfig(t);
  const existing = planSections(plan);
  if (existing.length >= MAX_SECTIONS) {
    return json({ error: `a plan may have at most ${MAX_SECTIONS} sections` }, 422);
  }

  const current = await configVersion(t.id);
  if (expected != null && Number(expected) !== current) {
    return json({
      error: 'version mismatch — re-read the plan and apply your change to it',
      expected: Number(expected), current,
    }, 409);
  }

  // Appended first and moved second, so the id comes from normalizeConfig — the same
  // assignment every other path uses — rather than from this route guessing at it.
  const appended = normalizeConfig(
    { ...t.config, plan: { ...plan, sections: [...existing, section] } }, t.name,
  );
  const last = appended.plan.sections.length - 1;
  const added = appended.plan.sections[last];
  const config = position == null ? appended : normalizeConfig(
    { ...t.config, plan: { ...plan, sections: moveSection(appended.plan.sections, last, Number(position)) } },
    t.name,
  );

  const written = await writeConfig(t.id, {
    config, name: t.name, changedBy: whoami(c), change: `section ${added.id} added`,
  });
  if (written.conflict) {
    return json({
      error: 'the plan changed while this was being written — re-read it and try again',
      current: await configVersion(t.id),
    }, 409);
  }
  await logEvent(c, t, 'plan.section.added', 'plan', added.id,
    { title: added.title, version: written.version });
  return json({ section: added, planVersion: written.version }, 201);
});
