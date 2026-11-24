import { sql } from '../../../../../lib/db';
import { json, options, idParam } from '../../../../../lib/http';
import { withUser, hashKey } from '../../../../../lib/tenant';
import { publicAgent, newAgentToken, SCOPES } from '../../../../../lib/agents';
import { newWebhookSecret, validWebhookUrl } from '../../../../../lib/webhooks';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Change scope, disable, rotate the token, or set where this agent is woken. Disabling is
// the reversible half of deleting: the agent stops being able to call anything and stops
// being woken, but its name stays on the work it did and its rows stay in the event log.
export const PATCH = withUser(async (req, ctx, t) => {
  const id = idParam(ctx.params);
  if (!id) return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => ({}));
  if (b.scope != null && !SCOPES.includes(b.scope)) {
    return json({ error: `scope must be ${SCOPES.join(' or ')}` }, 400);
  }

  const [cur] = await sql`select * from agents where id=${id} and tenant_id=${t.id}`;
  if (!cur) return json({ error: 'not found' }, 404);

  // Setting a URL mints a new signing secret and returns it once. Sending null clears the
  // webhook, and the agent falls back to reading the event feed.
  let webhookSecret = null;
  let setUrl, setSecret;
  if (b.webhookUrl !== undefined) {
    if (b.webhookUrl === null || b.webhookUrl === '') {
      setUrl = null; setSecret = null;
    } else if (!validWebhookUrl(b.webhookUrl)) {
      return json({ error: 'webhookUrl must be an https address, and not a private one' }, 400);
    } else {
      setUrl = String(b.webhookUrl);
      webhookSecret = newWebhookSecret();
      setSecret = webhookSecret;
    }
  }

  let verbs;
  if (b.webhookVerbs !== undefined) {
    verbs = Array.isArray(b.webhookVerbs) && b.webhookVerbs.length
      ? b.webhookVerbs.map(String) : null;
  }

  const token = b.rotate ? newAgentToken(t.slug) : null;
  const disabledAt = b.disabled == null ? undefined : (b.disabled ? new Date().toISOString() : null);

  const [agent] = await sql`update agents set
      scope = coalesce(${b.scope ?? null}, scope),
      token_hash = coalesce(${token ? hashKey(token) : null}, token_hash),
      disabled_at = ${disabledAt === undefined ? cur.disabled_at : disabledAt},
      webhook_url = ${setUrl === undefined ? cur.webhook_url : setUrl},
      webhook_secret = ${setUrl === undefined ? cur.webhook_secret : setSecret},
      webhook_verbs = ${verbs === undefined ? cur.webhook_verbs : verbs}
    where id=${id} and tenant_id=${t.id} returning *`;

  const out = { agent: publicAgent(agent) };
  if (token) out.token = token;
  if (webhookSecret) out.webhookSecret = webhookSecret;
  return json(out);
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
