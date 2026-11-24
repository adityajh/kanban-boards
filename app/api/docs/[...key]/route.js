import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withTenant, visibleAudiences, defaultAudience, AUDIENCES } from '../../../../lib/tenant';
import { logEvent } from '../../../../lib/events';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Keys carry slashes — `icp/zeal`, `prospect/acme-corp` — so the segment is a catch-all and
// the parts are joined back together. That also decides the verbs: POST appends to a
// document rather than creating a child, because a nested /append path would be swallowed
// by this same catch-all.
const MAX_BYTES = 256 * 1024;
const keyOf = (params) => (Array.isArray(params.key) ? params.key.join('/') : String(params.key || ''));
const validKey = (k) => /^[a-z0-9][a-z0-9._\-/]{0,119}$/i.test(k) && !k.includes('//') && !k.endsWith('/');

const publicDoc = (d) => ({
  key: d.key, title: d.title, body: d.body, audience: d.audience,
  version: d.version, updatedBy: d.updated_by, updatedAt: d.updated_at, createdAt: d.created_at,
});

const whoami = (c) => (c.person ? c.person.display_name
  : c.agent ? c.agent.name
  : c.admin ? 'ADMIN_KEY' : 'board passphrase');

export const GET = withTenant(async (req, { params }, t, c) => {
  const key = keyOf(params);
  const [doc] = await sql`select * from documents
    where tenant_id=${t.id} and lower(key)=lower(${key})
      and audience = any(${visibleAudiences(c)}::text[])`;
  if (!doc) return json({ error: 'not found' }, 404);
  return json(publicDoc(doc));
});

// Replace the whole document. `expected_version` is optional but is the only way two agents
// editing the same brief do not silently lose one of the two edits: send the version you
// read, get a 409 if it has moved on since.
export const PUT = withTenant(async (req, { params }, t, c) => {
  const key = keyOf(params);
  if (!validKey(key)) {
    return json({ error: 'key: 1-120 chars of a-z, 0-9, dot, dash, underscore and slash' }, 400);
  }
  const b = await req.json().catch(() => ({}));
  const body = String(b.body ?? '');
  if (Buffer.byteLength(body) > MAX_BYTES) {
    return json({ error: `body must be under ${MAX_BYTES} bytes` }, 413);
  }
  const audience = b.audience || defaultAudience(c);
  if (!AUDIENCES.includes(audience)) {
    return json({ error: `audience must be one of ${AUDIENCES.join(', ')}` }, 400);
  }
  if (audience === 'human_only' && c.agent) {
    return json({ error: 'an agent cannot create a human_only document' }, 400);
  }

  const [existing] = await sql`select * from documents
    where tenant_id=${t.id} and lower(key)=lower(${key})`;

  if (existing) {
    // A document an agent may not read is one it may not overwrite either, and the answer
    // is the same 404 a read would give: the refusal must not confirm the key exists.
    if (!visibleAudiences(c).includes(existing.audience)) return json({ error: 'not found' }, 404);
    if (b.expected_version != null && Number(b.expected_version) !== existing.version) {
      return json({
        error: 'version mismatch — re-read the document and apply your change to it',
        expected: Number(b.expected_version), current: existing.version,
      }, 409);
    }
    const [doc] = await sql`update documents set
        title = ${b.title ?? existing.title},
        body = ${body},
        audience = ${b.audience || existing.audience},
        version = version + 1,
        updated_by = ${whoami(c)},
        updated_at = now()
      where id=${existing.id} returning *`;
    await logEvent(c, t.id, 'doc.updated', 'doc', doc.key, { version: doc.version });
    return json(publicDoc(doc));
  }

  const [doc] = await sql`insert into documents (tenant_id, key, title, body, audience, updated_by)
    values (${t.id}, ${key}, ${b.title || key}, ${body}, ${audience}, ${whoami(c)}) returning *`;
  await logEvent(c, t.id, 'doc.created', 'doc', doc.key, { title: doc.title });
  return json(publicDoc(doc), 201);
});

// Append a block. There is no version to send and no conflict to lose: two agents appending
// at once both end up in the document. Most of what agents share — a decision register, a
// running log, a list of findings — is this shape rather than a rewrite.
export const POST = withTenant(async (req, { params }, t, c) => {
  const key = keyOf(params);
  if (!validKey(key)) {
    return json({ error: 'key: 1-120 chars of a-z, 0-9, dot, dash, underscore and slash' }, 400);
  }
  const b = await req.json().catch(() => ({}));
  const block = String(b.body ?? '').trim();
  if (!block) return json({ error: 'body required' }, 400);

  const [existing] = await sql`select * from documents
    where tenant_id=${t.id} and lower(key)=lower(${key})`;
  if (existing && !visibleAudiences(c).includes(existing.audience)) {
    return json({ error: 'not found' }, 404);
  }
  const stamp = `\n\n---\n${whoami(c)} · ${new Date().toISOString()}\n\n`;

  if (!existing) {
    const audience = b.audience || defaultAudience(c);
    if (!AUDIENCES.includes(audience)) {
      return json({ error: `audience must be one of ${AUDIENCES.join(', ')}` }, 400);
    }
    if (audience === 'human_only' && c.agent) {
      return json({ error: 'an agent cannot create a human_only document' }, 400);
    }
    const [doc] = await sql`insert into documents (tenant_id, key, title, body, audience, updated_by)
      values (${t.id}, ${key}, ${b.title || key}, ${stamp.trimStart() + block}, ${audience}, ${whoami(c)})
      returning *`;
    await logEvent(c, t.id, 'doc.appended', 'doc', doc.key, { created: true });
    return json(publicDoc(doc), 201);
  }

  // Appending in SQL rather than read-then-write, so two appends landing together cannot
  // overwrite one another the way a client-side concatenation would.
  if (Buffer.byteLength(existing.body) + Buffer.byteLength(stamp + block) > MAX_BYTES) {
    return json({ error: `document would exceed ${MAX_BYTES} bytes` }, 413);
  }
  const [doc] = await sql`update documents set
      body = body || ${stamp + block},
      version = version + 1,
      updated_by = ${whoami(c)},
      updated_at = now()
    where id=${existing.id} returning *`;
  await logEvent(c, t.id, 'doc.appended', 'doc', doc.key, { version: doc.version });
  return json(publicDoc(doc));
});

export const DELETE = withTenant(async (req, { params }, t, c) => {
  const key = keyOf(params);
  const [gone] = await sql`delete from documents
    where tenant_id=${t.id} and lower(key)=lower(${key})
      and audience = any(${visibleAudiences(c)}::text[])
    returning key`;
  if (!gone) return json({ error: 'not found' }, 404);
  await logEvent(c, t.id, 'doc.deleted', 'doc', gone.key, {});
  return json({ ok: true });
});
