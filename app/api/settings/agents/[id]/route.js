import { sql } from '../../../../../lib/db';
import { json, options, idParam } from '../../../../../lib/http';
import { withUser, hashKey } from '../../../../../lib/tenant';
import { publicAgent, newAgentToken, SCOPES } from '../../../../../lib/agents';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Change scope, disable, or rotate the token. Disabling is the reversible half of deleting:
// the agent stops being able to call anything, but its name stays on the work it did and
// its rows stay in the event log.
export const PATCH = withUser(async (req, ctx, t) => {
  const id = idParam(ctx.params);
  if (!id) return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => ({}));
  if (b.scope != null && !SCOPES.includes(b.scope)) {
    return json({ error: `scope must be ${SCOPES.join(' or ')}` }, 400);
  }

  const [cur] = await sql`select * from agents where id=${id} and tenant_id=${t.id}`;
  if (!cur) return json({ error: 'not found' }, 404);

  const token = b.rotate ? newAgentToken(t.slug) : null;
  const disabledAt = b.disabled == null ? undefined : (b.disabled ? new Date().toISOString() : null);

  const [agent] = await sql`update agents set
      scope = coalesce(${b.scope ?? null}, scope),
      token_hash = coalesce(${token ? hashKey(token) : null}, token_hash),
      disabled_at = ${disabledAt === undefined ? cur.disabled_at : disabledAt}
    where id=${id} and tenant_id=${t.id} returning *`;
  return json(token ? { agent: publicAgent(agent), token } : { agent: publicAgent(agent) });
}, { adminOnly: true });

// Removing an agent does not remove what it wrote. Notes keep its name, and so does every
// row in the event log — that is the whole point of writing the name into the row rather
// than joining to this table.
export const DELETE = withUser(async (req, ctx, t) => {
  const id = idParam(ctx.params);
  const [gone] = id ? await sql`delete from agents where id=${id} and tenant_id=${t.id}
    returning name` : [];
  if (!gone) return json({ error: 'not found' }, 404);
  return json({ ok: true, name: gone.name });
}, { adminOnly: true });
