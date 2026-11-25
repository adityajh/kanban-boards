import { sql } from '../../../../../lib/db';
import { json, options, idParam } from '../../../../../lib/http';
import { withTenant, visibleAudiences } from '../../../../../lib/tenant';
import { logEvent } from '../../../../../lib/events';
import { addresseeRefusal } from '../../../../../lib/cards.mjs';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export const POST = withTenant(async (req, { params }, t, c) => {
  const cardId = idParam(params);
  // The card is loaded with the same audience filter ownsCard applies, so a child route is
  // no side door onto a card the caller would get a 404 for; the title comes back with it
  // so the event below can say what the note is about.
  const [card] = cardId ? await sql`select id, title from cards
    where id=${cardId} and tenant_id=${t.id} and audience = any(${visibleAudiences(c)}::text[])` : [];
  if (!card) return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => ({}));
  if (!b.body) return json({ error: 'body required' }, 400);
  const badTo = addresseeRefusal(b.to);
  if (badTo) return json(badTo, 422);
  const addressedTo = b.to == null || b.to === '' ? null : String(b.to).trim();
  // Attribution comes from the credential, never from the body. A signed-in person is their
  // display name and an agent is its own name; only the shared board passphrase, which is
  // nobody in particular, still gets to say who it is — and that is the reason to retire it.
  const author = c.person ? c.person.display_name
    : c.agent ? c.agent.name
    : (b.author || 'Anon');
  const [nt] = await sql`insert into notes (card_id, author, body, addressed_to)
    values (${cardId}, ${author}, ${b.body}, ${addressedTo}) returning *`;
  // Whatever a person ticked as answered, they did not answer the question an agent has just
  // asked; a tick that survives the next question is decoration. So an agent's note clears
  // the flag in the same statement that bumps updated_at, and a person's note leaves it be.
  await sql`update cards set updated_at=now(),
    answered = case when ${!!c.agent}::boolean then false else answered end
    where id=${cardId}`;
  // The title rides along because a webhook body holding only an id makes an agent fetch the
  // card just to learn whether it cares.
  await logEvent(c, t, 'note.added', 'note', nt.id,
    { card_id: cardId, to: addressedTo, card_title: card.title });
  return json(nt, 201);
});
