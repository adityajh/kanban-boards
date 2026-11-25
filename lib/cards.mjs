// What a card may be, who holds it, and who a note is written to.
//
// Pure — no database, no request handling — so tests/auth-test.mjs exercises the same rules
// the routes run, which is the only reason to trust a 422 or a 409 from this API.

import { findContactDetail } from './tracker.mjs';

// The five columns the board renders, in board order. Anything else renders nowhere, so a
// card with an invented status is not misfiled, it is lost. Refused on write rather than
// accepted and hidden — and backed by a check constraint in 010, so a route written later
// cannot reintroduce the silent version.
export const STATUSES = ['todo', 'in_progress', 'stuck', 'review', 'done'];

export function statusRefusal(status) {
  if (status == null || status === '') return null; // absent means "leave it alone"
  if (!STATUSES.includes(status)) {
    return { field: 'status', error: `status must be one of ${STATUSES.join(', ')}` };
  }
  return null;
}

// Names are compared case-insensitively throughout: a name typed by a person and a name
// sent by an agent differ in case far more often than they differ in spelling.
export const sameName = (a, b) =>
  !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// Who "me" is. A board passphrase is a shared secret held by several agents and ADMIN_KEY
// belongs to nobody, so neither of them is an identity work can be addressed to — they get
// null here, and the routes that need a name answer 400 rather than guessing.
export const identityName = (c = {}) =>
  c.person ? c.person.display_name : c.agent ? c.agent.name : null;

// ── Claims ────────────────────────────────────────────────────────────────────────────────
// A claim is a lease, not a lock. A lock held by an agent that crashed mid-turn is a card
// nobody can ever touch again, and on a board where most actors are processes that is not a
// rare case. So every claim carries an expiry, and an expired one is treated as no claim at
// all rather than as something to clean up on a timer.

export const DEFAULT_LEASE_MINUTES = 30;
export const MAX_LEASE_MINUTES = 480; // eight hours: beyond that, say so on the card instead

export function leaseRefusal(minutes) {
  if (minutes == null || minutes === '') return null;
  const n = Number(minutes);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LEASE_MINUTES) {
    return { field: 'minutes', error: `minutes must be a whole number from 1 to ${MAX_LEASE_MINUTES}` };
  }
  return null;
}

// The live holder of a card, or null. `now` is a parameter so this is testable without
// waiting eight hours.
export function claimState(card, now = Date.now()) {
  if (!card || !card.claimed_by) return null;
  const until = card.claim_expires_at ? new Date(card.claim_expires_at).getTime() : NaN;
  if (!Number.isFinite(until) || until <= now) return null;
  return { by: card.claimed_by, until: card.claim_expires_at };
}

// Null when `who` may claim this card: either it is free, or they already hold it and are
// extending their own lease. Otherwise the sentence to answer 409 with.
export function claimRefusal(card, who, now = Date.now()) {
  const held = claimState(card, now);
  if (!held) return null;
  if (sameName(held.by, who)) return null;
  return `${held.by} is working on this until ${held.until}`;
}

// ── Addressing ────────────────────────────────────────────────────────────────────────────
// `to` is one name, deliberately not validated against the board's roster. A board's list of
// people is often incomplete — several boards have agents that were never added to it — and
// refusing a write because a name is missing from a config field would break the surface
// this slice exists to provide. The cost is that a misspelt name is findable by nobody, so
// GET /api/inbox returns the roster it matched against for an agent to check itself.

export function addresseeRefusal(to) {
  if (to == null || to === '') return null;
  const s = String(to).trim();
  if (!s) return { field: 'to', error: 'to cannot be blank — leave it out instead' };
  if (s.length > 120) return { field: 'to', error: 'to must be 120 characters or fewer' };
  if (/[\n\r]/.test(s)) return { field: 'to', error: 'to is one name, not a list or a sentence' };
  const found = findContactDetail(s);
  if (found) {
    return { field: 'to', error: `to contains ${found}. Address a note by name; contact details belong in the CRM` };
  }
  return null;
}

// ── The answered flag ─────────────────────────────────────────────────────────────────────
// "Has a human dealt with this." Set by a person, never by an agent: anything agents are
// asked to maintain, they drift on, and a flag that drifts is worse than no flag. An agent
// writing a new note CLEARS it, because whatever a person answered, they did not answer
// that — a tick that survives the next question is decoration.
export function answeredRefusal(value, c = {}) {
  if (value == null) return null;
  if (typeof value !== 'boolean') return { field: 'answered', error: 'answered must be true or false' };
  if (c.agent) return { field: 'answered', error: 'answered is a person\'s tick; an agent cannot set it' };
  return null;
}

// ── Per-board audience default ────────────────────────────────────────────────────────────
// On a human-heavy board an agent's new card should stay out of the team's view until the
// agent puts it there. On an agent-heavy board that same default leaves the board looking
// empty to the one person watching it. Which it is, is a property of the board, so it lives
// in the board's config rather than in this file.
export const AGENT_CARD_DEFAULTS = ['agent_only', 'both'];

export function defaultAudienceFor(c = {}, tenant = null) {
  if (!c.agent) return 'both';
  const want = tenant?.config?.agentCardsDefault;
  return AGENT_CARD_DEFAULTS.includes(want) ? want : 'agent_only';
}
