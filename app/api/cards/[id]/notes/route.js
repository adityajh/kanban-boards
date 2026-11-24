import { sql } from '../../../../../lib/db';
import { json, options, idParam } from '../../../../../lib/http';
import { withTenant, ownsCard } from '../../../../../lib/tenant';
import { logEvent } from '../../../../../lib/events';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }
export const POST = withTenant(async (req, { params }, t, c) => {
  const cardId = idParam(params);
  if (!cardId || !(await ownsCard(cardId, t.id, c))) return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => ({}));
  if (!b.body) return json({ error: 'body required' }, 400);
  // Attribution comes from the credential, never from the body. A signed-in person is their
  // display name and an agent is its own name; only the shared board passphrase, which is
  // nobody in particular, still gets to say who it is — and that is the reason to retire it.
  const author = c.person ? c.person.display_name
    : c.agent ? c.agent.name
    : (b.author || 'Anon');
  const [nt] = await sql`insert into notes (card_id, author, body)
    values (${cardId}, ${author}, ${b.body}) returning *`;
  await sql`update cards set updated_at=now() where id=${cardId}`;
  await logEvent(c, t.id, 'note.added', 'note', nt.id, { card_id: cardId });
  return json(nt, 201);
});
