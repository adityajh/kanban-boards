// The Plan's shape and rules: which kinds exist, what each may carry, and what is refused.
// Pure — no database, no request handling — so tests/auth-test.mjs exercises the validation
// the server actually runs, which is the only reason to trust a 422.

export const KINDS = ['status', 'decision', 'milestone', 'risk', 'actual', 'log'];

export const LANES = ['now', 'waiting', 'found', 'done'];
export const DECISION_STATES = ['proposed', 'decided', 'superseded'];
export const MILESTONE_STATES = ['upcoming', 'done', 'at-risk', 'missed'];
export const LEVELS = ['high', 'medium', 'low'];
export const RISK_STATES = ['open', 'watching', 'closed'];
export const LOG_KINDS = ['update', 'handoff', 'risk', 'decision'];

// The two states that assert something was actually settled, as opposed to raised. The API
// polices who may reach them — see decisionRefusal, which since 26 Nov asks only that the
// caller be somebody a person could ask about it later.
export const DECIDED_STATES = ['decided', 'superseded'];

const SPEC = {
  status: {
    fields: ['title', 'detail', 'lane', 'owner', 'source', 'as_of', 'order', 'card_id'],
    required: ['title', 'lane'],
    enums: { lane: LANES },
    dates: ['as_of'],
    numbers: ['order'],
    maybeLink: ['source'],
  },
  decision: {
    fields: ['title', 'state', 'owner', 'date', 'note', 'card_id', 'ref'],
    required: ['title', 'state'],
    enums: { state: DECISION_STATES },
    dates: ['date'],
    links: ['ref'],
  },
  milestone: {
    fields: ['title', 'date', 'owner', 'state', 'note', 'card_id'],
    required: ['title', 'date'],
    enums: { state: MILESTONE_STATES },
    dates: ['date'],
  },
  risk: {
    fields: ['title', 'level', 'why', 'mitigation', 'owner', 'state', 'card_id'],
    required: ['title', 'level'],
    enums: { level: LEVELS, state: RISK_STATES },
  },
  actual: {
    // Numbers live under `values`, keyed by whatever metrics the board declares, rather
    // than as named columns — that is what lets one table serve a counsellor funnel and a
    // release scorecard without the app knowing which is which.
    fields: ['as_of', 'source', 'values', 'note', 'card_id'],
    required: ['as_of', 'source'],
    dates: ['as_of'],
    maybeLink: ['source'],
  },
  log: {
    fields: ['at', 'by', 'kind', 'text', 'ref', 'card_id'],
    required: ['text'],
    enums: { kind: LOG_KINDS },
    links: ['ref'],
    maxLen: { text: 1200 },
  },
};

export const fieldsFor = (kind) => (SPEC[kind] ? SPEC[kind].fields.slice() : []);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;
const LOOKS_LIKE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

// The board must hold no contact details: not a student's, not a parent's, not anyone's.
// This catches the obvious shapes and nothing else — "adi at example dot com" sails past
// it. It is a speed bump that names what it caught so a write can be fixed and retried,
// not a guarantee that what is on the board is clean.
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const MOBILE_IN = /(?:^|\D)([6-9]\d{9})(?:\D|$)/;

export function findContactDetail(value) {
  const s = String(value);
  if (EMAIL.test(s)) return 'an email address';
  if (MOBILE_IN.test(s)) return 'what looks like a mobile number';
  return null;
}

// Returns null when the row is fine, or { field, error } for a 422.
export function validateItem(kind, data, { metricKeys = null } = {}) {
  const spec = SPEC[kind];
  if (!spec) return { field: 'kind', error: `kind must be one of ${KINDS.join(', ')}` };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { field: 'data', error: 'data must be an object' };
  }

  for (const k of Object.keys(data)) {
    if (!spec.fields.includes(k)) {
      return { field: k, error: `a ${kind} has no field "${k}" (expected: ${spec.fields.join(', ')})` };
    }
  }
  for (const k of spec.required) {
    const v = data[k];
    if (v === undefined || v === null || String(v).trim() === '') {
      return { field: k, error: `${k} is required on a ${kind}` };
    }
  }
  for (const [k, allowed] of Object.entries(spec.enums || {})) {
    if (data[k] != null && !allowed.includes(data[k])) {
      return { field: k, error: `${k} must be one of ${allowed.join(', ')}` };
    }
  }
  for (const k of spec.dates || []) {
    if (data[k] != null && data[k] !== '' && !ISO_DATE.test(String(data[k]))) {
      return { field: k, error: `${k} must be a date as YYYY-MM-DD` };
    }
  }
  for (const k of spec.numbers || []) {
    if (data[k] != null && data[k] !== '' && !Number.isFinite(Number(data[k]))) {
      return { field: k, error: `${k} must be a number` };
    }
  }
  for (const k of spec.links || []) {
    if (data[k] != null && data[k] !== '' && !/^https:\/\//i.test(String(data[k]))) {
      return { field: k, error: `${k} must be an https link` };
    }
  }
  // A source may be a sentence ("Friday review") or a link; if it is a link it must be https.
  for (const k of spec.maybeLink || []) {
    const v = data[k];
    if (v != null && LOOKS_LIKE_URL.test(String(v)) && !/^https:\/\//i.test(String(v))) {
      return { field: k, error: `${k} looks like a link, and a link must be https` };
    }
  }
  for (const [k, max] of Object.entries(spec.maxLen || {})) {
    if (data[k] != null && String(data[k]).length > max) {
      return { field: k, error: `${k} must be ${max} characters or fewer` };
    }
  }

  if (kind === 'actual') {
    const v = data.values;
    if (v != null) {
      if (typeof v !== 'object' || Array.isArray(v)) {
        return { field: 'values', error: 'values must be an object of metric key to number' };
      }
      for (const [k, n] of Object.entries(v)) {
        if (metricKeys && !metricKeys.includes(k)) {
          return { field: `values.${k}`, error: `this board tracks ${metricKeys.join(', ')} — not "${k}"` };
        }
        if (n != null && !Number.isFinite(Number(n))) {
          return { field: `values.${k}`, error: 'must be a number, or null when unknown' };
        }
      }
    }
  }

  // P5: every kind can now point at the card the work is happening on. Claude-Brain asked
  // for a `cards: []` array plus a `plan_row` back-pointer on the card; this is one field
  // in one direction instead, because two things to keep in step is two things that can
  // disagree, and nothing has yet needed a row to name more than one card.
  //
  // This only checks the id could be an id. Whether the card EXISTS, on this board, and is
  // visible to the caller is checked in the route — a link that points at nothing is worse
  // than no link, and that question needs the database.
  if (data.card_id != null && data.card_id !== '') {
    // A number or the numeric string a form would send — and nothing else. Number(true) is
    // 1, so without the type check `card_id: true` would quietly link to card 1.
    const v = data.card_id;
    const n = (typeof v === 'number' || typeof v === 'string') ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 1) {
      return { field: 'card_id', error: 'card_id must be the id of a card on this board' };
    }
  }

  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string') continue;
    const found = findContactDetail(v);
    if (found) {
      return { field: k, error: `${k} contains ${found}. Contact details belong in the CRM, never on the board` };
    }
  }
  return null;
}

// An agent may propose. Making something decided or superseded is a person's act, and on
// this board one person's: the same rule the funnel has always run under, now in code
// rather than in a sentence somebody has to remember.
// Settling a decision needs a caller who can be named, and nothing more than that.
//
// This used to be master-admin-only, and agents were refused outright: "an agent may only
// propose a decision, never settle one". Adi settled that on 26 Nov the other way — agents
// may decide, and an agent that would rather somebody else took the call assigns a card and
// says so. That is a better mechanism than a proposal queue, because the board already has
// exactly one place where things wait on a person, and a second one would be the one nobody
// checks.
//
// Lifting it for agents takes the rationale out from under the master-admin gate too: the
// rule existed because settling was treated as an act of authority, and it is no longer
// treated that way. One rule now covers every caller.
//
// A bare board passphrase is still refused. It is a shared secret that names nobody, so the
// row would record that "board passphrase" decided something — and a decision there is no
// way to ask anybody about afterwards is not a decision. That is the same reasoning that
// keeps a passphrase from marking work done (see approvalRefusal).
export function decisionRefusal(kind, data, caller) {
  if (kind !== 'decision' || !data || !DECIDED_STATES.includes(data.state)) return null;
  if (caller.person || caller.agent || caller.admin) return null;
  return 'a board passphrase cannot settle a decision, because it names nobody: sign in, '
    + 'or use an agent token';
}

// P6: a row goes stale when nobody has touched it for a week AND it claims to describe the
// present. That second half is the whole distinction, and it is why this is not simply
// "older than 7 days":
//
//   status  — says what is happening now, so silence makes it wrong
//   risk    — an open or watched risk nobody has revisited is the definition of neglected;
//             a closed one is a record and cannot go stale
//
//   decision  — October's decision is still true in July. That is the entire reason the
//               Plan exists beside the board, so marking it stale would be nonsense
//   actual    — a dated measurement of a moment; it does not rot
//   milestone — has its own `date` and its own states; "overdue" is the useful question
//               there and it is a different one
//   log       — append-only history
//
// Computed on read rather than stored, so it cannot itself go stale.
export const STALE_AFTER_DAYS = 7;

const GOES_STALE = {
  status: () => true,
  risk: (d) => d.state !== 'closed',
};

export function isStale(kind, data = {}, updatedAt, now = Date.now(), days = STALE_AFTER_DAYS) {
  const can = GOES_STALE[kind];
  if (!can || !can(data || {})) return false;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return false;
  return now - t > days * 86400000;
}

// Log rows are not addressed by anybody, so they get a key that sorts by when it was made.
// The timestamp is padded to a fixed width: base36 of a larger number is a longer string,
// and unpadded they stop sorting lexicographically the moment they cross a digit boundary.
// Nine characters covers dates past the year 5000.
export const newLogId = (now = Date.now(), rand = Math.random) =>
  now.toString(36).padStart(9, '0') + '-' +
  Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0');

export const validItemId = (s) => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(s));
