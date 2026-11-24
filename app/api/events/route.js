import { sql } from '../../../lib/db';
import { json, options } from '../../../lib/http';
import { withTenant } from '../../../lib/tenant';
import { publicEvent } from '../../../lib/events';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Read the log forward from a cursor. The cursor is an event id, not a timestamp: ids are
// monotonic per insert, and two writes in the same millisecond would make a time-based
// cursor skip one of them with nothing to show that it had.
//
// Slice 1 is the feed only. The wake that makes waiting free — a webhook per agent — comes
// next; until then an agent reading from a cursor is still far cheaper than re-fetching
// every card on every check.
const MAX = 200;

export const GET = withTenant(async (req, ctx, t) => {
  const u = new URL(req.url);
  const since = Number(u.searchParams.get('since') || 0);
  const limit = Math.min(Number(u.searchParams.get('limit') || 50) || 50, MAX);
  if (!Number.isFinite(since) || since < 0) return json({ error: 'since must be an event id' }, 400);

  const rows = await sql`select * from events
    where tenant_id=${t.id} and id > ${since} order by id limit ${limit}`;
  const events = rows.map(publicEvent);
  return json({
    events,
    // Echo the cursor to use next even when nothing came back, so a caller that is caught
    // up does not have to decide what to send.
    cursor: events.length ? events[events.length - 1].id : since,
    more: events.length === limit,
  });
});
