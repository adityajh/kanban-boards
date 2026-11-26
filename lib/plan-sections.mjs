// Plan sections: identity, editing rules, and the one guard that is structural rather than
// a matter of permission. Pure — no database, no request handling — so tests/auth-test.mjs
// exercises the rules the server actually runs.
//
// A section used to be an anonymous item in an array, rendered by its index. That made any
// edit a replace of the whole plan, which is how two edits to two different sections lost
// one of the two silently: there was nothing to attach a version to. Ids fix that, and they
// are the floor under everything else here.

// What a section may carry, taken from what components/Plan.js actually renders. A field
// outside this list would be stored and never shown, which is a worse outcome than a
// refusal — so an unknown field is a 422 rather than a shrug.
export const SECTION_FIELDS = [
  'title', 'note', 'text', 'bullets', 'diagram', 'diagramDoc', 'links', 'columns', 'rows',
];

// Ids are chosen from the title once and then never follow it: renaming a section keeps its
// id, because the id is what cards, history and an agent's last read all point at.
export const validSectionId = (s) => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(s || ''));

const MAX_ID = 40;
const MAX_BYTES = 64 * 1024;
const MAX_ROWS = 200;
const MAX_BULLETS = 100;

export function slugifySection(title, taken = []) {
  const used = new Set(taken.map((t) => String(t).toLowerCase()));
  const base = String(title || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID)
    .replace(/-+$/, '') || 'section';
  if (!used.has(base)) return base;
  // A second "Ground rules" on one board gets -2, not a random suffix: the id goes in
  // documents and agent prompts, so it has to be something a person can read back.
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base.slice(0, MAX_ID - 4)}-${n}`.replace(/--+/g, '-');
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, MAX_ID - 8)}-${Date.now().toString(36)}`;
}

// Every section carries an id, assigned from its title the first time it is seen. Existing
// ids are never reassigned, so this is safe to run on every config write — which is where
// it runs, so a section added through the settings screen cannot arrive anonymous.
export function withSectionIds(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.sections)) return plan;
  const taken = [];
  const sections = plan.sections.map((s) => {
    const sec = (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
    const existing = validSectionId(sec.id) ? String(sec.id) : null;
    const id = existing && !taken.some((t) => t.toLowerCase() === existing.toLowerCase())
      ? existing
      : slugifySection(sec.title, taken);
    taken.push(id);
    return { ...sec, id };
  });
  return { ...plan, sections };
}

export const planSections = (plan) =>
  (plan && Array.isArray(plan.sections)) ? plan.sections : [];

// Case-insensitive, like every other id on the board: an agent that read `Ground-rules` off
// a page should not get a 404 for the capital.
export function findSection(plan, id) {
  const sections = planSections(plan);
  const want = String(id || '').toLowerCase();
  const index = sections.findIndex((s) => String(s && s.id).toLowerCase() === want);
  return index === -1 ? null : { section: sections[index], index };
}

// Walks every string a section holds, however deeply nested, because the likely place for a
// phone number is a table cell rather than the title.
function* strings(value) {
  if (typeof value === 'string') { yield value; return; }
  if (Array.isArray(value)) { for (const v of value) yield* strings(v); return; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) yield* strings(v); }
}

// Returns null when the patch is fine, or { field, error } for a 422. `findContact` is
// injected rather than imported so this module stays the only thing a test has to set up.
export function sectionRefusal(patch, { findContact = () => null, partial = true } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { field: 'body', error: 'a section must be an object' };
  }
  for (const k of Object.keys(patch)) {
    if (k === 'id') {
      return { field: 'id', error: 'a section id is assigned once and cannot be changed; add a new section instead' };
    }
    if (!SECTION_FIELDS.includes(k)) {
      return { field: k, error: `a section has no field "${k}" (expected: ${SECTION_FIELDS.join(', ')})` };
    }
  }
  if (!partial && String(patch.title || '').trim() === '') {
    return { field: 'title', error: 'title required' };
  }
  if ('title' in patch && String(patch.title ?? '').trim() === '') {
    return { field: 'title', error: 'title cannot be emptied; delete the section instead' };
  }
  for (const k of ['title', 'note', 'text', 'diagram', 'diagramDoc']) {
    if (k in patch && patch[k] !== null && typeof patch[k] !== 'string') {
      return { field: k, error: `${k} must be text` };
    }
  }
  for (const [k, max] of [['bullets', MAX_BULLETS], ['rows', MAX_ROWS], ['links', MAX_ROWS], ['columns', 64]]) {
    if (k in patch && patch[k] !== null) {
      if (!Array.isArray(patch[k])) return { field: k, error: `${k} must be a list` };
      if (patch[k].length > max) return { field: k, error: `${k}: at most ${max}` };
    }
  }
  if (Array.isArray(patch.rows) && patch.rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
    return { field: 'rows', error: 'each row must be an object keyed by column name' };
  }
  if (Buffer.byteLength(JSON.stringify(patch)) > MAX_BYTES) {
    return { field: 'body', error: `a section must be under ${MAX_BYTES} bytes` };
  }
  for (const s of strings(patch)) {
    const found = findContact(s);
    if (found) {
      return { field: 'body', error: `this section contains ${found}. Contact details belong in the CRM, never on the board` };
    }
  }
  return null;
}

// Shallow merge, with null clearing a field. Arrays are replaced rather than merged: a patch
// sending three rows means three rows, not three rows appended to the nine already there.
export function applySectionPatch(section, patch) {
  const out = { ...section };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

// Moving a section is a different act from editing one, so it travels as its own field and
// lands here. A position past either end clamps instead of refusing: "put it last" is a
// reasonable thing to mean by 99.
export function moveSection(sections, from, to) {
  const list = [...sections];
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, Math.trunc(to)));
  const [moved] = list.splice(from, 1);
  list.splice(target, 0, moved);
  return list;
}

// ---------------------------------------------------------------------------- periods
//
// A period is a column of the Targets table: `{ id, label, targets }`. Adding one was
// master-admin-only along with the rest of the plan config, which meant Claude-Brain was
// blocked every month on a calendar fact — "December exists and we will be measuring it".
//
// The split, from 26 Nov: the MONTH is open, the NUMBERS are not. A period with no targets
// asserts nothing; it is an empty column. A target is what an actual is judged against, so
// moving one from 800 to 600 turns last month's miss into a hit without anybody touching
// the figure. That is the same reasoning as metricKeyRefusal and the reason `targets` is
// refused to anyone who may not edit the plan — enforced in the route, since it is a
// question about the caller rather than about the value.

export const PERIOD_FIELDS = ['label', 'targets'];

export const planPeriods = (plan) =>
  (plan && Array.isArray(plan.periods)) ? plan.periods : [];

export function findPeriod(plan, id) {
  const periods = planPeriods(plan);
  const want = String(id || '').toLowerCase();
  const index = periods.findIndex((p) => String(p && p.id).toLowerCase() === want);
  return index === -1 ? null : { period: periods[index], index };
}

// Unlike a section, a period's id is supplied rather than derived: `2026-11` and `6-dec`
// are chosen to line up with the `actual` rows filed against them, and inventing one from
// a label would break that correspondence silently.
export function periodRefusal(patch, {
  metricKeys = null, partial = true, taken = [], findContact = () => null,
} = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { field: 'body', error: 'a period must be an object' };
  }
  const allowed = partial ? PERIOD_FIELDS : ['id', ...PERIOD_FIELDS];
  for (const k of Object.keys(patch)) {
    if (k === 'id' && partial) {
      return { field: 'id', error: 'a period id cannot be changed; add a new period instead' };
    }
    if (!allowed.includes(k)) {
      return { field: k, error: `a period has no field "${k}" (expected: ${allowed.join(', ')})` };
    }
  }
  if (!partial) {
    const id = String(patch.id || '').trim();
    if (!validSectionId(id)) {
      return { field: 'id', error: 'id: 1-64 chars of a-z, 0-9, dot, underscore, hyphen — e.g. 2026-11' };
    }
    if (taken.some((t) => String(t).toLowerCase() === id.toLowerCase())) {
      return { field: 'id', error: `this board already has a period "${id}"` };
    }
  }
  if ('label' in patch && patch.label !== null && typeof patch.label !== 'string') {
    return { field: 'label', error: 'label must be text' };
  }
  if ('targets' in patch && patch.targets !== null) {
    const t = patch.targets;
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      return { field: 'targets', error: 'targets must be an object keyed by metric' };
    }
    for (const [k, v] of Object.entries(t)) {
      // The same rule an `actual` runs under: a key the board does not declare is refused
      // rather than stored, because a target nothing is measured against is a number nobody
      // will ever see and nobody will ever correct.
      if (metricKeys && !metricKeys.includes(k)) {
        return { field: `targets.${k}`, error: `this board does not track "${k}"` };
      }
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) {
        return { field: `targets.${k}`, error: 'a target must be a number, or null for none yet' };
      }
    }
  }
  for (const s of strings(patch)) {
    const found = findContact(s);
    if (found) {
      return { field: 'body', error: `this period contains ${found}. Contact details belong in the CRM, never on the board` };
    }
  }
  return null;
}

export function applyPeriodPatch(period, patch) {
  const out = { ...period };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue;
    if (v === null) delete out[k];
    else if (k === 'targets') out[k] = { ...(period.targets || {}), ...v };
    else out[k] = v;
  }
  return out;
}

// The guard that is not about who is calling.
//
// A board's metrics declare the keys every `actual` is recorded under. Rename or drop a key
// that already has numbers filed against it and those numbers stop meaning anything — they
// are still in the table, pointing at a definition that no longer exists. That is true
// whether a master admin does it or an agent does, which is why this is not a permission
// check: a permission check would let the one caller who can do the most damage do it.
//
// Targets, labels, prose and periods are all fair game and all revertible. This refuses
// exactly one thing, and names the keys so the refusal is actionable.
export function metricKeyRefusal(nextPlan, usedKeys = []) {
  if (!usedKeys.length) return null;
  const next = new Set(
    (nextPlan && Array.isArray(nextPlan.metrics) ? nextPlan.metrics : [])
      .map((m) => String(m && m.key)).filter(Boolean),
  );
  const orphaned = usedKeys.filter((k) => !next.has(String(k)));
  if (!orphaned.length) return null;
  const these = orphaned.length === 1 ? 'this metric has' : 'these metrics have';
  return `${orphaned.join(', ')}: ${these} actuals recorded against it, so the key cannot be `
    + 'removed or renamed — every number already filed would point at a definition that no '
    + 'longer exists. Change its label freely, or add a new metric alongside it.';
}
