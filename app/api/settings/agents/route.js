import { sql } from '../../../../lib/db';
import { json, options } from '../../../../lib/http';
import { withUser, hashKey, normalizeConfig } from '../../../../lib/tenant';
import { rateLimitRefusal } from '../../../../lib/ratelimit.mjs';
import { boardAgents, publicAgent, newAgentToken, validAgentName, SCOPES } from '../../../../lib/agents';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

export const GET = withUser(async (req, ctx, t) =>
  json((await boardAgents(t.id)).map(publicAgent)), { adminOnly: true });

// Mint an agent. The token is shown exactly once, here, and only its HMAC is stored — the
// same arrangement as a board passphrase, so there is no endpoint anywhere that can hand
// the token back later. Lose it and the answer is to rotate, not to recover.
export const POST = withUser(async (req, ctx, t, c) => {
  const b = await req.json().catch(() => ({}));
  const name = String(b.name || '').trim();
  const scope = String(b.scope || 'write');
  if (!validAgentName(name)) {
    return json({ error: 'name: 2-40 chars of a-z, 0-9, dot, underscore, hyphen — no spaces' }, 400);
  }
  if (!SCOPES.includes(scope)) return json({ error: `scope must be ${SCOPES.join(' or ')}` }, 400);

  const refusal = rateLimitRefusal(b.rateLimit);
  if (refusal) return json(refusal, 422);
  const limit = b.rateLimit === undefined || b.rateLimit === null || b.rateLimit === '' ? null : b.rateLimit;

  const token = newAgentToken(t.slug);
  let agent;
  try {
    // Absent means the column default, so the number lives in one place (the migration)
    // and the route does not repeat it.
    [agent] = limit == null
      ? await sql`insert into agents (tenant_id, name, token_hash, scope)
          values (${t.id}, ${name}, ${hashKey(token)}, ${scope}) returning *`
      : await sql`insert into agents (tenant_id, name, token_hash, scope, rate_limit)
          values (${t.id}, ${name}, ${hashKey(token)}, ${scope}, ${limit}) returning *`;
  } catch (e) {
    if (e.code === '23505') return json({ error: 'an agent with that name is already on this board' }, 409);
    throw e;
  }

  // An agent's name has to be assignable, or work handed to it cannot be addressed to it.
  if (!(t.config.names || []).includes(name)) {
    const config = normalizeConfig({ ...t.config, names: [...(t.config.names || []), name] }, t.name);
    await sql`update tenants set config=${JSON.stringify(config)}::jsonb where id=${t.id}`;
  }
  return json({ agent: publicAgent(agent), token }, 201);
});
