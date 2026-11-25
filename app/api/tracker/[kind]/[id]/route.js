import { sql } from '../../../../../lib/db';
import { json, options } from '../../../../../lib/http';
import { withTenant, visibleAudiences, defaultAudience, AUDIENCES } from '../../../../../lib/tenant';
import { logEvent } from '../../../../../lib/events';
import {
  KINDS, validateItem, decisionRefusal, validItemId, publicItem,
  planEnabled, metricKeys, whoami, findItem, fieldsFor,
} from '../../../../../lib/plan';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

const notFound = () => json({ error: 'not found' }, 404);

// Claude-Brain's spec writes an actual's numbers as top-level fields. The board keys them
// under `values` so one table can serve any metric set, so anything that is a declared
// metric is folded in rather than refused — a write against the original shape still lands.
function foldMetrics(kind, body, keys) {
  const data = { ...body };
  if (kind !== 'actual' || !keys) return data;
  const values = { ...(data.values || {}) };
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(data, k)) { values[k] = data[k]; delete data[k]; }
  }
  if (Object.keys(values).length) data.values = values;
  return data;
}

const prepare = async (req, params, t, c) => {
  const kind = String(params.kind);
  if (!KINDS.includes(kind)) return { fail: notFound() };
  const itemId = String(params.id);
  if (!validItemId(itemId)) {
    return { fail: json({ error: 'id: 1-64 chars of a-z, 0-9, dot, underscore, hyphen' }, 400) };
  }
  const b = await req.json().catch(() => ({}));
  return { kind, itemId, b };
};

export const GET = withTenant(async (req, { params }, t, c) => {
  if (!planEnabled(t)) return notFound();
  if (!KINDS.includes(String(params.kind))) return notFound();
  const [row] = await findItem(t.id, String(params.kind), String(params.id), visibleAudiences(c));
  return row ? json(publicItem(row)) : notFound();
});

// Create or replace the whole row. Send `version` and a 409 says somebody changed it first,
// rather than quietly losing their edit.
export const PUT = withTenant(async (req, { params }, t, c) => {
  if (!planEnabled(t)) return notFound();
  const p = await prepare(req, params, t, c);
  if (p.fail) return p.fail;
  const { kind, itemId, b } = p;

  const keys = metricKeys(t);
  const data = foldMetrics(kind, b, keys);
  delete data.audience; delete data.version;
  if (kind === 'log') data.by = whoami(c);

  const bad = validateItem(kind, data, { metricKeys: keys });
  if (bad) return json({ error: bad.error, field: bad.field }, 422);
  const refused = decisionRefusal(kind, data, c);
  if (refused) return json({ error: refused }, 403);

  const [existing] = await sql`select * from tracker_items
    where tenant_id=${t.id} and kind=${kind} and lower(item_id)=lower(${itemId})`;

  if (existing) {
    if (!visibleAudiences(c).includes(existing.audience)) return notFound();
    if (b.version != null && Number(b.version) !== existing.version) {
      return json({
        error: 'version mismatch — re-read the row and apply your change to it',
        expected: Number(b.version), current: existing.version, item: publicItem(existing),
      }, 409);
    }
    const [row] = await sql`update tracker_items set
        data = ${JSON.stringify(data)}::jsonb,
        audience = ${b.audience && AUDIENCES.includes(b.audience) ? b.audience : existing.audience},
        version = version + 1, updated_by = ${whoami(c)}, updated_at = now()
      where id=${existing.id} returning *`;
    await logEvent(c, t, `tracker.${kind}.updated`, 'tracker', `${kind}/${row.item_id}`,
      { version: row.version });
    return json(publicItem(row));
  }

  const audience = b.audience || defaultAudience(c, t);
  if (!AUDIENCES.includes(audience)) {
    return json({ error: `audience must be one of ${AUDIENCES.join(', ')}` }, 400);
  }
  if (audience === 'human_only' && c.agent) {
    return json({ error: 'an agent cannot create a human_only row' }, 400);
  }
  const [row] = await sql`insert into tracker_items
      (tenant_id, kind, item_id, data, audience, updated_by)
    values (${t.id}, ${kind}, ${itemId}, ${JSON.stringify(data)}::jsonb, ${audience}, ${whoami(c)})
    returning *`;
  await logEvent(c, t, `tracker.${kind}.created`, 'tracker', `${kind}/${row.item_id}`, {});
  return json(publicItem(row), 201);
});

// Merge fields into the row. The same version rule applies, because a merge against a stale
// read is how two agents each think they only changed one thing.
export const PATCH = withTenant(async (req, { params }, t, c) => {
  if (!planEnabled(t)) return notFound();
  const p = await prepare(req, params, t, c);
  if (p.fail) return p.fail;
  const { kind, itemId, b } = p;

  const [existing] = await findItem(t.id, kind, itemId, visibleAudiences(c));
  if (!existing) return notFound();
  if (b.version != null && Number(b.version) !== existing.version) {
    return json({
      error: 'version mismatch — re-read the row and apply your change to it',
      expected: Number(b.version), current: existing.version, item: publicItem(existing),
    }, 409);
  }

  const keys = metricKeys(t);
  const incoming = foldMetrics(kind, b, keys);
  delete incoming.audience; delete incoming.version;
  const data = { ...existing.data, ...incoming };
  if (kind === 'actual' && incoming.values) {
    data.values = { ...(existing.data.values || {}), ...incoming.values };
  }
  // A null clears a field rather than storing a null, so a merged row stays the shape the
  // validator describes.
  for (const k of fieldsFor(kind)) if (data[k] === null) delete data[k];
  if (kind === 'log') data.by = whoami(c);

  const bad = validateItem(kind, data, { metricKeys: keys });
  if (bad) return json({ error: bad.error, field: bad.field }, 422);
  const refused = decisionRefusal(kind, data, c);
  if (refused) return json({ error: refused }, 403);

  const [row] = await sql`update tracker_items set
      data = ${JSON.stringify(data)}::jsonb,
      audience = ${b.audience && AUDIENCES.includes(b.audience) ? b.audience : existing.audience},
      version = version + 1, updated_by = ${whoami(c)}, updated_at = now()
    where id=${existing.id} returning *`;
  await logEvent(c, t, `tracker.${kind}.updated`, 'tracker', `${kind}/${row.item_id}`,
    { version: row.version });
  return json(publicItem(row));
});

// Decisions and actuals are the record of what was chosen and what was true, so they are
// superseded rather than removed; the API still allows a delete for a row created in error,
// and the event log keeps the fact that it existed.
export const DELETE = withTenant(async (req, { params }, t, c) => {
  if (!planEnabled(t)) return notFound();
  const kind = String(params.kind);
  if (!KINDS.includes(kind)) return notFound();
  const [existing] = await findItem(t.id, kind, String(params.id), visibleAudiences(c));
  if (!existing) return notFound();
  const b = await req.json().catch(() => ({}));
  if (b.version != null && Number(b.version) !== existing.version) {
    return json({ error: 'version mismatch', current: existing.version }, 409);
  }
  await sql`delete from tracker_items where id=${existing.id}`;
  await logEvent(c, t, `tracker.${kind}.deleted`, 'tracker', `${kind}/${existing.item_id}`, {});
  return json({ ok: true });
});
