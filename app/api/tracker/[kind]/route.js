import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withTenant, visibleAudiences, defaultAudience, AUDIENCES } from '../../../../lib/tenant';
import { logEvent } from '../../../../lib/events';
import {
  KINDS, validateItem, decisionRefusal, newLogId, publicItem,
  planEnabled, metricKeys, whoami,
} from '../../../../lib/plan';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

const MAX = 200;

export const GET = withTenant(async (req, { params }, t, c) => {
  if (!planEnabled(t)) return json({ error: 'this board has no plan' }, 404);
  const kind = String(params.kind);
  if (!KINDS.includes(kind)) return json({ error: 'not found' }, 404);
  const u = new URL(req.url);
  const limit = Math.min(Number(u.searchParams.get('limit') || 100) || 100, MAX);
  const before = u.searchParams.get('before');
  const rows = before
    ? await sql`select * from tracker_items
        where tenant_id=${t.id} and kind=${kind}
          and audience = any(${visibleAudiences(c)}::text[]) and created_at < ${before}
        order by created_at desc limit ${limit}`
    : await sql`select * from tracker_items
        where tenant_id=${t.id} and kind=${kind}
          and audience = any(${visibleAudiences(c)}::text[])
        order by created_at desc limit ${limit}`;
  return json(rows.map(publicItem));
});

// Append a row the writer does not name. In practice this is the log: every other kind is
// addressed by a key its writer chooses, and goes through PUT.
export const POST = withTenant(async (req, { params }, t, c) => {
  if (!planEnabled(t)) return json({ error: 'this board has no plan' }, 404);
  const kind = String(params.kind);
  if (!KINDS.includes(kind)) return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => ({}));

  const data = { ...b };
  delete data.audience;
  if (kind === 'log') {
    data.at = data.at || new Date().toISOString();
    // `by` is taken from the credential, never from the body — the same rule note authors
    // run under. A person relaying somebody else says so in the text.
    data.by = whoami(c);
    data.kind = data.kind || 'update';
  }

  const bad = validateItem(kind, data, { metricKeys: metricKeys(t) });
  if (bad) return json({ error: bad.error, field: bad.field }, 422);
  const refused = decisionRefusal(kind, data, c);
  if (refused) return json({ error: refused }, 403);

  const audience = b.audience || defaultAudience(c);
  if (!AUDIENCES.includes(audience)) {
    return json({ error: `audience must be one of ${AUDIENCES.join(', ')}` }, 400);
  }
  if (audience === 'human_only' && c.agent) {
    return json({ error: 'an agent cannot create a human_only row' }, 400);
  }

  const [row] = await sql`insert into tracker_items
      (tenant_id, kind, item_id, data, audience, updated_by)
    values (${t.id}, ${kind}, ${newLogId()}, ${JSON.stringify(data)}::jsonb,
            ${audience}, ${whoami(c)}) returning *`;
  await logEvent(c, t, `tracker.${kind}.created`, 'tracker', `${kind}/${row.item_id}`, {});
  return json(publicItem(row), 201);
});
