import { sql } from '../../../lib/db';
import { json, options, authed } from '../../../lib/http';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

export async function GET(req) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const cards = await sql`select * from cards order by status, position, id`;
  const subs = await sql`select * from subtasks order by position, id`;
  const links = await sql`select * from links order by id`;
  const notes = await sql`select * from notes order by created_at, id`;
  const byCard = (arr) => arr.reduce((m, x) => ((m[x.card_id] ||= []).push(x), m), {});
  const S = byCard(subs), L = byCard(links), N = byCard(notes);
  const out = cards.map(c => ({ ...c, subtasks: S[c.id] || [], links: L[c.id] || [], notes: N[c.id] || [] }));
  return json(out);
}

export async function POST(req) {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401);
  const b = await req.json();
  if (!b.title) return json({ error: 'title required' }, 400);
  const status = b.status || 'todo';
  const [{ max }] = await sql`select coalesce(max(position),0) as max from cards where status=${status}`;
  const [card] = await sql`insert into cards (title, description, status, assignee, tag, position)
    values (${b.title}, ${b.description || ''}, ${status}, ${b.assignee || 'Unassigned'}, ${b.tag || ''}, ${Number(max) + 1})
    returning *`;
  return json({ ...card, subtasks: [], links: [], notes: [] }, 201);
}
