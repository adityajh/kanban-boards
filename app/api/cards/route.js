import { sql } from '../../../lib/db';
import { json, options } from '../../../lib/http';
import { withTenant, clean } from '../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

export const GET = withTenant(async (req, ctx, t) => {
  const cards = await sql`select * from cards where tenant_id=${t.id} order by status, position, id`;
  const subs = await sql`select s.* from subtasks s join cards c on c.id=s.card_id
    where c.tenant_id=${t.id} order by s.position, s.id`;
  const links = await sql`select l.* from links l join cards c on c.id=l.card_id
    where c.tenant_id=${t.id} order by l.id`;
  const notes = await sql`select n.* from notes n join cards c on c.id=n.card_id
    where c.tenant_id=${t.id} order by n.created_at, n.id`;
  const byCard = (arr) => arr.reduce((m, x) => ((m[x.card_id] ||= []).push(x), m), {});
  const S = byCard(subs), L = byCard(links), N = byCard(notes);
  const out = cards.map(c => ({ ...clean(c), subtasks: S[c.id] || [], links: L[c.id] || [], notes: N[c.id] || [] }));
  return json(out);
});

export const POST = withTenant(async (req, ctx, t) => {
  const b = await req.json();
  if (!b.title) return json({ error: 'title required' }, 400);
  const status = b.status || 'todo';
  const [{ max }] = await sql`select coalesce(max(position),0) as max from cards
    where tenant_id=${t.id} and status=${status}`;
  const [card] = await sql`insert into cards (tenant_id, title, description, status, assignee, tag, position)
    values (${t.id}, ${b.title}, ${b.description || ''}, ${status}, ${b.assignee || 'Unassigned'}, ${b.tag || ''}, ${Number(max) + 1})
    returning *`;
  return json({ ...clean(card), subtasks: [], links: [], notes: [] }, 201);
});
