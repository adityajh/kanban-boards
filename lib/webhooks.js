import { sql } from './db';
import { sign } from './webhook-sign.mjs';

// The pure half lives in webhook-sign.mjs so it can be unit tested under plain node.
export { newWebhookSecret, validWebhookUrl, sign, verifySignature, secretRefusal } from './webhook-sign.mjs';

const TIMEOUT_MS = 4000;

async function deliver(agent, payload) {
  const body = JSON.stringify(payload);
  const sig = sign(agent.webhook_secret || '', body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let status;
  try {
    const r = await fetch(agent.webhook_url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Board-Event': payload.verb,
        'X-Board-Delivery': String(payload.id),
        'X-Board-Signature': sig,
        // The identical value under GitHub's header name. Receivers that verify webhooks at
        // all overwhelmingly implement GitHub's convention — hex HMAC-SHA256 of the raw body
        // behind this header — and many cannot be told to read a different one. Sending both
        // costs a few bytes and makes the board work with them out of the box; nothing reads
        // this end, so there is no ambiguity about which is authoritative.
        'X-Hub-Signature-256': sig,
      },
      body,
    });
    status = String(r.status);
  } catch (e) {
    status = e.name === 'AbortError' ? 'timeout' : 'error';
  } finally {
    clearTimeout(timer);
  }
  // Recorded rather than thrown: a failed wake must not fail the write that caused it,
  // and a dead endpoint should be visible in the Agents tab rather than silent.
  await sql`update agents set last_delivery_at=now(), last_delivery_status=${status}
    where id=${agent.id}`;
}

// Everyone on this board who asked to hear this verb, except whoever caused it. Not
// notifying the actor of its own action is what stops two agents waking each other
// forever over a card they are both touching.
export async function dispatch(tenant, event, actorAgentId) {
  const agents = await sql`select id, webhook_url, webhook_secret, webhook_verbs from agents
    where tenant_id=${tenant.id}
      and webhook_url is not null
      and disabled_at is null
      and (${actorAgentId ?? null}::int is null or id <> ${actorAgentId ?? null})
      and (webhook_verbs is null or ${event.verb} = any(webhook_verbs))`;
  if (!agents.length) return;
  const payload = { ...event, board: tenant.slug };
  await Promise.allSettled(agents.map((a) => deliver(a, payload)));
}
