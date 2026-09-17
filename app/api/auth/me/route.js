import { json, options } from '../../../../lib/http';
import { sessionPerson, publicPerson, boardsFor } from '../../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Who the cookie belongs to, and every board it opens. The UI uses the board list both to
// decide whether this URL is one the person may see, and to fill the switcher.
export async function GET(req) {
  const person = await sessionPerson(req);
  if (!person) return json({ error: 'unauthorized' }, 401);
  return json({ user: publicPerson(person), boards: await boardsFor(person.id) });
}
