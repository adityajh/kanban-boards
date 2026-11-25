import { sql } from '../../../../../lib/db';
import { json, options, idParam } from '../../../../../lib/http';
import { withTenant, clean, visibleAudiences, isBoardAdmin } from '../../../../../lib/tenant';
import { logEvent } from '../../../../../lib/events';
import {
  leaseRefusal, claimRefusal, claimState, identityName, sameName, DEFAULT_LEASE_MINUTES,
} from '../../../../../lib/cards.mjs';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// A card the caller may not see answers 404, the same as one on another board, so a refusal
// here never says whether the row exists.
const visibleCard = (id, t, c) => sql`select * from cards
  where id=${id} and tenant_id=${t.id} and audience = any(${visibleAudiences(c)}::text[])`;

const held = (card) => ({ claimed_by: card.claimed_by, claim_expires_at: card.claim_expires_at });

export const POST = withTenant(async (req, { params }, t, c) => {
  const id = idParam(params);
  if (!id) return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => ({}));
  const bad = leaseRefusal(b.minutes);
  if (bad) return json(bad, 422);
  const minutes = b.minutes == null || b.minutes === '' ? DEFAULT_LEASE_MINUTES : Number(b.minutes);

  // A shared passphrase names nobody, so a claim under it would be a lease held by no one
  // that no one could be asked about; the name has to come from the credential.
  const who = identityName(c);
  if (!who) return json({ error: 'a claim needs an identity: use an agent token or sign in' }, 400);

  // One statement, so two agents racing for the same card cannot both read "free" and both
  // write: the database serialises the updates and the loser's WHERE no longer matches.
  // Re-claiming your own card matches too, which is how a lease is extended.
  const [card] = await sql`update cards set
      claimed_by = ${who}, claimed_at = now(),
      claim_expires_at = now() + make_interval(mins => ${minutes}::int)
    where id=${id} and tenant_id=${t.id} and audience = any(${visibleAudiences(c)}::text[])
      and (claimed_by is null or claim_expires_at is null or claim_expires_at <= now()
           or lower(claimed_by) = lower(${who}))
    returning *`;

  if (!card) {
    // Nothing matched, for one of two reasons the caller must be able to tell apart: the card
    // is not theirs to see (404) or somebody else holds it (409).
    const [now] = await visibleCard(id, t, c);
    if (!now) return json({ error: 'not found' }, 404);
    // If the holder released or expired between our update and this read, the card is free
    // again and there is no sentence to quote; say so rather than answer 409 with nothing.
    const error = claimRefusal(now, who) || 'the claim changed while you were claiming; try again';
    return json({ error, ...held(now) }, 409);
  }

  await logEvent(c, t, 'card.claimed', 'card', card.id,
    { title: card.title, until: card.claim_expires_at, minutes });
  return json(clean(card));
});

export const DELETE = withTenant(async (req, { params }, t, c) => {
  const id = idParam(params);
  if (!id) return json({ error: 'not found' }, 404);
  const [card] = await visibleCard(id, t, c);
  if (!card) return json({ error: 'not found' }, 404);

  const who = identityName(c);
  const live = claimState(card);
  // Only the live holder or a board admin may break a lease: otherwise releasing would be a
  // way to steal a card from an agent that is mid-task. An expired lease is nobody's.
  if (live && !sameName(live.by, who) && !isBoardAdmin(c)) {
    return json({ error: claimRefusal(card, who), ...held(card) }, 409);
  }
  if (!card.claimed_by) return json({ ok: true, released: false });

  // Guarded on the holder we just looked at, so a release that races a fresh claim by
  // somebody else clears nothing instead of evicting the new holder.
  const [freed] = await sql`update cards set
      claimed_by = null, claimed_at = null, claim_expires_at = null
    where id=${id} and tenant_id=${t.id} and audience = any(${visibleAudiences(c)}::text[])
      and claimed_by = ${card.claimed_by}
    returning id, title`;
  // A lapsed lease is cleared quietly: nobody was working on it, so there is nothing to
  // announce and "released" would be a claim about something that had already ended.
  if (freed && live) {
    await logEvent(c, t, 'card.released', 'card', freed.id, { title: freed.title });
  }
  return json({ ok: true, released: !!(freed && live) });
});
