import { json, options } from '../../../../lib/http';
import { withTenant } from '../../../../lib/tenant';
import { configHistory, configAtVersion, configVersion } from '../../../../lib/config-history';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

const MAX = 200;

// What this board's settings have said, newest first. Readable by anyone who can read the
// board, agents included: an agent that edited a section should be able to see that it did,
// and a history only people can read is a history an agent cannot check itself against.
//
// `?version=N` returns that version's config in full. The list leaves the configs out —
// a board's config is a few kilobytes and fifty of them is a response nobody reads.
export const GET = withTenant(async (req, ctx, t) => {
  const u = new URL(req.url);
  const want = u.searchParams.get('version');

  if (want != null) {
    const n = Number(want);
    if (!Number.isInteger(n) || n < 1) return json({ error: 'version must be a positive integer' }, 400);
    const [row] = await configAtVersion(t.id, n);
    if (!row) return json({ error: 'not found' }, 404);
    return json({
      version: row.version, config: row.config, changedBy: row.changed_by,
      change: row.change, changedAt: row.changed_at,
    });
  }

  const limit = Math.min(Number(u.searchParams.get('limit') || 50) || 50, MAX);
  const rows = await configHistory(t.id, limit);
  return json({
    current: await configVersion(t.id),
    versions: rows.map((r) => ({
      version: r.version, changedBy: r.changed_by, change: r.change,
      changedAt: r.changed_at, hasPlan: r.has_plan,
    })),
  });
});
