import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withAdmin } from '../../../../lib/tenant';
import { publicAgent } from '../../../../lib/agents';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

const STALE_DAYS = 7;

// Every agent on every board, for finding the one that has quietly stopped working. An
// agent that fails does not error anywhere an admin looks; it just stops calling, so the
// only visible sign is how long ago it last did.
export const GET = withAdmin(async () => {
  // Staleness is decided by the database clock, the same one that wrote last_seen_at, so a
  // skewed app server cannot mark a healthy agent stale. `a.*` is safe to select because
  // publicAgent picks fields by name: token_hash and webhook_secret are never copied out.
  const rows = await sql`select a.*, t.slug as b_slug, t.name as b_name,
      (a.last_seen_at is null
        or a.last_seen_at < now() - make_interval(days => ${STALE_DAYS})) as is_stale
    from agents a join tenants t on t.id = a.tenant_id
    order by lower(t.name), t.id, lower(a.name)`;

  const agents = rows.map((a) => ({
    board: { slug: a.b_slug, name: a.b_name },
    ...publicAgent(a),
    stale: a.is_stale,
  }));

  return json({
    agents,
    counts: {
      total: agents.length,
      disabled: agents.filter((a) => a.disabled).length,
      withWake: agents.filter((a) => a.webhookUrl).length,
      staleOverDays: agents.filter((a) => a.stale).length,
    },
    staleDays: STALE_DAYS,
  });
});
