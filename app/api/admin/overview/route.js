import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withAdmin } from '../../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

const STALE_DAYS = 14;

// Cross-board view for Adi: column counts per board, the Review queue, stalled work, recent notes.
export const GET = withAdmin(async () => {
  const boards = await sql`select t.slug, t.name, t.created_at,
      count(c.id) filter (where c.status='todo')::int as todo,
      count(c.id) filter (where c.status='in_progress')::int as in_progress,
      count(c.id) filter (where c.status='stuck')::int as stuck,
      count(c.id) filter (where c.status='review')::int as review,
      count(c.id) filter (where c.status='done')::int as done,
      max(c.updated_at) as last_activity
    from tenants t left join cards c on c.tenant_id=t.id
    group by t.id order by t.name`;
  const review = await sql`select c.id, c.title, c.assignee, c.updated_at, t.slug, t.name as board
    from cards c join tenants t on t.id=c.tenant_id
    where c.status='review' order by c.updated_at`;
  // Stuck is declared by someone, stalled is inferred from silence — so they are separate
  // lists. Oldest first, which puts whatever has been stuck longest at the top.
  const stuck = await sql`select c.id, c.title, c.assignee, c.updated_at, t.slug, t.name as board
    from cards c join tenants t on t.id=c.tenant_id
    where c.status='stuck' order by c.updated_at`;
  const stalled = await sql`select c.id, c.title, c.assignee, c.updated_at, t.slug, t.name as board
    from cards c join tenants t on t.id=c.tenant_id
    where c.status='in_progress' and c.updated_at < now() - make_interval(days => ${STALE_DAYS})
    order by c.updated_at`;
  const notes = await sql`select n.id, n.author, n.body, n.created_at, c.id as card_id, c.title as card, t.slug, t.name as board
    from notes n join cards c on c.id=n.card_id join tenants t on t.id=c.tenant_id
    order by n.created_at desc limit 12`;
  return json({ boards, review, stuck, stalled, notes, staleDays: STALE_DAYS });
});
