import { sql } from '../../../../../lib/db';
import { json, options, idParam } from '../../../../../lib/http';
import { withUser, hashKey } from '../../../../../lib/tenant';
import { publicAgent, newAgentToken, SCOPES } from '../../../../../lib/agents';
import { rateLimitRefusal } from '../../../../../lib/ratelimit.mjs';
import { newWebhookSecret, validWebhookUrl, secretRefusal, webhookAuthRefusal } from '../../../../../lib/webhooks';
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

  const refusal = rateLimitRefusal(b.rateLimit);
  if (refusal) return json(refusal, 422);
  const setLimit = b.rateLimit === undefined || b.rateLimit === null || b.rateLimit === ''
    ? null : b.rateLimit;

  const [cur] = await sql`select * from agents where id=${id} and tenant_id=${t.id}`;
  if (!cur) return json({ error: 'not found' }, 404);

  // Setting a URL mints a signing secret and returns it once, unless the admin supplies one.
  // Sending a null URL clears the webhook and the agent falls back to reading the feed.
  //
  // `webhookSecret` exists because a receiver on somebody else's automation platform often
  // has a secret of its own that it cannot be told to change. Supplying it is not a weaker
  // arrangement: the board signs with whichever key it holds, and only a key it generated is
  // ever echoed back, because a key the admin typed is one they already have.
  const badSecret = secretRefusal(b.webhookSecret);
  if (badSecret) return json(badSecret, 422);
  const supplied = b.webhookSecret ? String(b.webhookSecret) : null;

  const badAuth = webhookAuthRefusal(b.webhookAuth);
  if (badAuth) return json(badAuth, 422);
  let setAuth = b.webhookAuth ? String(b.webhookAuth) : undefined;

  let generated = null;
  let setUrl, setSecret;
  if (b.webhookUrl !== undefined) {
    if (b.webhookUrl === null || b.webhookUrl === '') {
      setUrl = null; setSecret = null;
      // Clearing the URL also returns the mode to the default. Otherwise a later agent
      // pointed at a new endpoint would silently keep bearer, sending its key in the clear
      // to a receiver that may well have wanted a signature.
      setAuth = 'signature';
    } else if (!validWebhookUrl(b.webhookUrl)) {
      return json({ error: 'webhookUrl must be an https address, and not a private one' }, 400);
    } else {
      setUrl = String(b.webhookUrl);
      if (supplied) setSecret = supplied;
      else { generated = newWebhookSecret(); setSecret = generated; }
    }
  } else if (supplied) {
    // Replacing the key without touching where deliveries go: what rotating on the
    // receiver's side looks like from this end.
    setSecret = supplied;
  }

  // Bearer mode carries the stored value AS the credential, so it has to be the receiver's
  // own key. A secret the board generated is meaningless to them — it would be sent as
  // `Bearer whsec_...` and rejected every time, and the admin would have no way to tell
  // that from a wrong key. Refuse the combination instead of shipping a wake that cannot
  // work. The resulting mode and the resulting secret are both worked out above, so this
  // catches setting bearer on an agent that already holds a generated key just as well as
  // setting both at once.
  const finalAuth = setAuth === undefined ? (cur.webhook_auth || 'signature') : setAuth;
  const finalSecret = setSecret === undefined ? cur.webhook_secret : setSecret;
  const finalUrl = setUrl === undefined ? cur.webhook_url : setUrl;
  if (finalUrl && finalAuth === 'bearer' && (!finalSecret || finalSecret.startsWith('whsec_'))) {
    return json({
      field: 'webhookSecret',
      error: "bearer mode sends the stored value as the credential, so it must be the receiver's own key — supply webhookSecret",
    }, 422);
  }

  // Whether this agent may mark work done where the board's gate is on. A boolean and
  // nothing else: a string or a number here almost always means a client sent a form value
  // raw, and quietly reading it as true would grant a permission nobody chose.
  if (b.mayFinish != null && typeof b.mayFinish !== 'boolean') {
    return json({ field: 'mayFinish', error: 'mayFinish must be true or false' }, 422);
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
      webhook_secret = ${setSecret === undefined ? cur.webhook_secret : setSecret},
      webhook_auth = ${setAuth === undefined ? cur.webhook_auth : setAuth},
      webhook_verbs = ${verbs === undefined ? cur.webhook_verbs : verbs},
      may_finish = coalesce(${b.mayFinish ?? null}::boolean, may_finish),
      rate_limit = coalesce(${setLimit}::int, rate_limit),
      -- Changing the limit also forgets what has been spent. An admin who raises the limit
      -- for an agent that is being throttled right now wants it working now; without the
      -- reset the old count would sit against the new ceiling until the top of the minute.
      rl_window_start = case when ${setLimit != null} then null else rl_window_start end,
      rl_count = case when ${setLimit != null} then 0 else rl_count end
    where id=${id} and tenant_id=${t.id} returning *`;

  const out = { agent: publicAgent(agent) };
  if (token) out.token = token;
  if (generated) out.webhookSecret = generated;
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
