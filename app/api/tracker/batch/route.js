import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import {
  withTenant, visibleAudiences, defaultAudience, AUDIENCES, chargeAgentWrites,
} from '../../../../lib/tenant';
import { logEvent } from '../../../../lib/events';
import {
  KINDS, validateItem, decisionRefusal, validItemId, publicItem,
  planEnabled, metricKeys, whoami, fieldsFor,
} from '../../../../lib/plan';
import { retryAfterSeconds } from '../../../../lib/ratelimit.mjs';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Many tracker writes, applied together or not at all.
//
// This is a correctness argument rather than a convenience one. Updating the Plan after a
// team meeting took about forty separate calls, and a failure at call twenty-three left the
// Plan contradicting itself — a status row saying one thing and the milestone it belongs to
// saying another — with nobody aware that it had half happened. "Mostly applied" is the one
// state a source of truth must not be able to reach.
//
// How all-or-none is actually achieved, since it is easy to claim and harder to mean:
//
//   1. Every operation is validated first, against one read of every row it touches. A
//      refusal here writes nothing at all and names the operation that failed by index.
//   2. The writes then go as ONE transaction, and each carries the row version from that
//      read in its WHERE clause. A guard turns "matched no row" into an error, which aborts
//      the transaction — so a row that moved underneath us between the read and the write
//      takes the whole batch down with it rather than landing half a change.
//
// That second rule makes a batch stricter than the single-row routes, where `version` is
// optional. It has to be: the alternative is a batch that silently reflects somebody else's
// concurrent edit in some of its rows and not others.

const MAX_OPS = 50;
const OPS = ['put', 'patch', 'delete'];

// `update ... returning` that matched nothing is not an error in Postgres, and here it has
// to be: a version guard that fails quietly is not a guard. Each write is wrapped in a CTE
// and its row count divided into 1, so zero matches raises a division by zero, which aborts
// the transaction and with it the whole batch. The caller never sees that message — the
// route re-reads below and says which operation went stale.
//
// Written out three times rather than through a helper that takes a query, because the
// driver's tagged template does not compose: interpolating one query into another passes it
// as a parameter instead of inlining its SQL, which would have failed quietly in exactly
// the way this guard exists to prevent.
const guardedDelete = (p) => sql`
  with w as (
    delete from tracker_items where id=${p.row.id} and version=${p.row.version} returning id
  ) select 1 / (select count(*) from w)::int as ok`;

const guardedUpdate = (p, by) => sql`
  with w as (
    update tracker_items set
        data=${JSON.stringify(p.data)}::jsonb, audience=${p.audience},
        version=version+1, updated_by=${by}, updated_at=now()
      where id=${p.row.id} and version=${p.row.version} returning id
  ) select 1 / (select count(*) from w)::int as ok`;

export const POST = withTenant(async (req, ctx, t, c) => {
  if (!planEnabled(t)) return json({ error: 'this board has no plan' }, 404);
  const b = await req.json().catch(() => ({}));
  const ops = Array.isArray(b.ops) ? b.ops : null;
  if (!ops || !ops.length) return json({ field: 'ops', error: 'ops must be a non-empty list' }, 422);
  if (ops.length > MAX_OPS) {
    return json({ field: 'ops', error: `at most ${MAX_OPS} operations in one batch` }, 422);
  }

  const fail = (index, error, status = 422, extra = {}) =>
    json({ error, index, op: ops[index], applied: 0, ...extra }, status);

  // ---- shape, before anything is read -------------------------------------------------
  const seen = new Map();
  for (let i = 0; i < ops.length; i += 1) {
    const o = ops[i];
    if (!o || typeof o !== 'object' || Array.isArray(o)) return fail(i, 'each operation must be an object');
    const op = String(o.op || 'put');
    if (!OPS.includes(op)) return fail(i, `op must be one of ${OPS.join(', ')}`);
    if (!KINDS.includes(String(o.kind))) return fail(i, `kind must be one of ${KINDS.join(', ')}`);
    if (!validItemId(String(o.id || ''))) {
      return fail(i, 'id: 1-64 chars of a-z, 0-9, dot, underscore, hyphen');
    }
    // Two operations on one row in one batch would have the second fail its version guard
    // against the first, which is a confusing way to say "you wrote this twice". Say it.
    const key = `${o.kind}/${String(o.id).toLowerCase()}`;
    if (seen.has(key)) {
      return fail(i, `${key} appears twice in this batch (also at ${seen.get(key)}) — `
        + 'combine them into one operation');
    }
    seen.set(key, i);
  }

  // ---- one read of everything this batch touches --------------------------------------
  const kinds = ops.map((o) => String(o.kind));
  const ids = ops.map((o) => String(o.id).toLowerCase());
  const rows = await sql`select * from tracker_items
    where tenant_id=${t.id} and (kind, lower(item_id)) in (
      select k, i from unnest(${kinds}::text[], ${ids}::text[]) as u(k, i))`;
  const existing = new Map(rows.map((r) => [`${r.kind}/${String(r.item_id).toLowerCase()}`, r]));

  const keys = metricKeys(t);
  const planned = [];

  for (let i = 0; i < ops.length; i += 1) {
    const o = ops[i];
    const op = String(o.op || 'put');
    const kind = String(o.kind);
    const itemId = String(o.id);
    const row = existing.get(`${kind}/${itemId.toLowerCase()}`);

    // A row this caller may not read is a row it may not write, and the answer is the 404 a
    // read would have given: the refusal must not confirm the row exists.
    if (row && !visibleAudiences(c).includes(row.audience)) {
      return fail(i, `${kind}/${itemId}: not found`, 404);
    }
    if (o.version != null && row && Number(o.version) !== row.version) {
      return fail(i, `${kind}/${itemId}: version mismatch`, 409,
        { expected: Number(o.version), current: row.version, item: publicItem(row) });
    }
    if (o.version != null && !row) {
      return fail(i, `${kind}/${itemId}: version sent for a row that does not exist`, 409);
    }

    if (op === 'delete') {
      if (!row) return fail(i, `${kind}/${itemId}: not found`, 404);
      planned.push({ i, op, kind, itemId, row });
      continue;
    }
    if (op === 'patch' && !row) return fail(i, `${kind}/${itemId}: not found`, 404);

    const { op: _op, kind: _kind, id: _id, version: _v, audience: wantAudience, ...body } = o;
    const incoming = foldMetrics(kind, body, keys);
    let data;
    if (op === 'patch') {
      data = { ...row.data, ...incoming };
      if (kind === 'actual' && incoming.values) {
        data.values = { ...(row.data.values || {}), ...incoming.values };
      }
      for (const k of fieldsFor(kind)) if (data[k] === null) delete data[k];
    } else {
      data = incoming;
    }
    if (kind === 'log') data.by = whoami(c);

    const bad = validateItem(kind, data, { metricKeys: keys });
    if (bad) return fail(i, `${kind}/${itemId}: ${bad.error}`, 422, { field: bad.field });
    const refused = decisionRefusal(kind, data, c);
    if (refused) return fail(i, `${kind}/${itemId}: ${refused}`, 403);

    let audience = row ? row.audience : defaultAudience();
    if (wantAudience != null) {
      if (!AUDIENCES.includes(wantAudience)) {
        return fail(i, `audience must be one of ${AUDIENCES.join(', ')}`);
      }
      if (wantAudience === 'human_only' && c.agent) {
        return fail(i, 'an agent cannot create a human_only row', 403);
      }
      audience = wantAudience;
    }
    planned.push({ i, op, kind, itemId, row, data, audience });
  }

  // ---- charge the agent for all of it, then write -------------------------------------
  const rl = await chargeAgentWrites(c.agent?.id, planned.length - 1);
  if (rl && rl.rl_count > rl.rate_limit) {
    return json({
      error: `rate limit exceeded: this batch of ${planned.length} writes would put this `
        + `agent over ${rl.rate_limit} writes per minute. Nothing was written.`,
      limit: rl.rate_limit, window: '1 minute', applied: 0,
    }, 429, { 'Retry-After': String(retryAfterSeconds(rl.rl_window_start)) });
  }

  const by = whoami(c);
  const writes = planned.map((p) => {
    if (p.op === 'delete') return guardedDelete(p);
    if (p.row) return guardedUpdate(p, by);
    // No version to guard a creation with; the unique index on (tenant_id, kind,
    // lower(item_id)) is the guard, and a concurrent insert of the same key aborts the
    // transaction exactly as a stale version does.
    return sql`insert into tracker_items (tenant_id, kind, item_id, data, audience, updated_by)
      values (${t.id}, ${p.kind}, ${p.itemId}, ${JSON.stringify(p.data)}::jsonb,
              ${p.audience}, ${by}) returning id`;
  });

  try {
    await sql.transaction(writes);
  } catch (e) {
    // Something moved between the read and the write, so nothing was applied. Work out what
    // and say so, rather than handing back a Postgres message about division by zero.
    const now = await sql`select kind, item_id, version from tracker_items
      where tenant_id=${t.id} and (kind, lower(item_id)) in (
        select k, i from unnest(${kinds}::text[], ${ids}::text[]) as u(k, i))`;
    const at = new Map(now.map((r) => [`${r.kind}/${String(r.item_id).toLowerCase()}`, r.version]));
    const moved = planned.filter((p) => {
      const key = `${p.kind}/${p.itemId.toLowerCase()}`;
      return p.row ? at.get(key) !== p.row.version : at.has(key);
    });
    if (moved.length) {
      return json({
        error: 'a row changed while this batch was being written, so none of it was applied '
          + '— re-read and send it again',
        applied: 0,
        stale: moved.map((p) => ({ index: p.i, id: `${p.kind}/${p.itemId}` })),
      }, 409);
    }
    throw e;
  }

  // One event per row, not one for the batch. The feed is how an agent catches up, and
  // "a batch happened" would force it to re-read everything the batch might have touched.
  for (const p of planned) {
    const verb = p.op === 'delete' ? 'deleted' : (p.row ? 'updated' : 'created');
    await logEvent(c, t, `tracker.${p.kind}.${verb}`, 'tracker', `${p.kind}/${p.itemId}`,
      { batch: planned.length });
  }

  return json({
    ok: true, applied: planned.length,
    results: planned.map((p) => ({
      index: p.i, id: `${p.kind}/${p.itemId}`,
      op: p.op === 'delete' ? 'deleted' : (p.row ? 'updated' : 'created'),
    })),
  });
});

// Same folding the single-row routes do: Claude-Brain's spec writes an actual's numbers as
// top-level fields, and the board keys them under `values` so one table serves any metric
// set. Kept here rather than imported because the single-row route holds it privately.
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
