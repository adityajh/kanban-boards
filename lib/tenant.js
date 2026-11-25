import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { sql } from './db';
import { json, bearer } from './http';
import { sessionPerson, membership } from './auth';
import { defaultAudienceFor, AGENT_CARD_DEFAULTS } from './cards.mjs';
import { retryAfterSeconds } from './ratelimit.mjs';

// Passphrases are stored as HMAC-SHA256(KEY_PEPPER, passphrase). The bearer token alone
// identifies the tenant, so agents keep calling /api/cards with no tenant in the path.
export function hashKey(key) {
  if (!process.env.KEY_PEPPER) throw new Error('KEY_PEPPER is not set');
  return createHmac('sha256', process.env.KEY_PEPPER).update(key).digest('hex');
}

function isAdminKey(token) {
  const admin = process.env.ADMIN_KEY || '';
  if (!admin || token.length !== admin.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(admin));
}

const askedFor = (req) =>
  req.headers.get('x-tenant') || new URL(req.url).searchParams.get('tenant');

// Four ways in, all resolving to exactly one tenant:
//
//   passphrase       — the token itself names the board (X-Tenant is ignored), unchanged.
//                      Shared by whoever holds it, so it names no actor.
//   agent token      — names both the board and *which agent*, so a write can be attributed.
//                      This is 006, and it is what a passphrase could never do.
//   ADMIN_KEY        — acts on the board named by X-Tenant, or on none for /api/admin/*
//   session cookie   — names a person, not a board; the board comes from X-Tenant and the
//                      person's membership of it is what grants access
//
// That last one is the change in 004. A session spans every board you belong to, so the
// board can no longer be read off the credential. Access now rests on the membership row
// rather than on the cookie naming a tenant — and a non-member is indistinguishable from
// a board that does not exist, which is the same 404 a wrong passphrase has always given.
export async function caller(req) {
  const token = bearer(req);
  if (token) {
    if (isAdminKey(token)) {
      const slug = askedFor(req);
      if (!slug) return { admin: true, tenant: null, person: null, agent: null, memberAdmin: false };
      const [tenant] = await sql`select * from tenants where slug=${slug}`;
      return tenant ? { admin: true, tenant, person: null, agent: null, memberAdmin: false } : null;
    }
    const hash = hashKey(token);
    const [tenant] = await sql`select * from tenants where key_hash=${hash}`;
    if (tenant) return { admin: false, tenant, person: null, agent: null, memberAdmin: false };

    // An agent token is stored the same way a passphrase is, so one hash answers both
    // questions; the join hands back the agent and its board together.
    const [row] = await sql`select a.id as agent_id, a.name as agent_name, a.scope as agent_scope,
             a.disabled_at, t.*
      from agents a join tenants t on t.id = a.tenant_id where a.token_hash=${hash}`;
    if (!row || row.disabled_at) return null;
    const { agent_id, agent_name, agent_scope, disabled_at, ...tenant2 } = row;
    // Cheap liveness for the Agents tab. Rate-limited to a write a minute so an agent
    // polling hard does not turn every read into a write.
    await sql`update agents set last_seen_at=now() where id=${agent_id}
      and (last_seen_at is null or last_seen_at < now() - interval '1 minute')`;
    return {
      admin: false, tenant: tenant2, person: null, memberAdmin: false,
      agent: { id: agent_id, name: agent_name, scope: agent_scope },
    };
  }

  const person = await sessionPerson(req);
  if (!person) return null;
  const slug = askedFor(req);
  if (!slug) return { admin: false, tenant: null, person, agent: null, memberAdmin: false };
  const [tenant] = await sql`select * from tenants where slug=${slug}`;
  if (!tenant) return null;
  const m = await membership(person.id, tenant.id);
  if (!m) return null;
  return { admin: false, tenant, person, agent: null, memberAdmin: m.is_admin };
}

// Every board route goes through this: the handler only ever sees its own tenant.
// `c` is the fourth argument so routes that care who is acting (note authorship, settings)
// can ask, while the ones that don't stay exactly as they were.
export function withTenant(handler) {
  return async (req, ctx) => {
    const c = await caller(req);
    if (!c) return json({ error: 'unauthorized' }, 401);
    if (!c.tenant) return json({ error: 'this credential needs an X-Tenant header' }, 400);
    // A read-scoped agent is refused every method that changes anything, in one place
    // rather than in each route, so a new route cannot forget it.
    if (c.agent?.scope === 'read' && !SAFE_METHODS.has(req.method)) {
      return json({ error: 'this agent token is read-only' }, 403);
    }
    // An agent's writes are counted against its own per-minute limit, here for the same
    // reason the scope check is here: a route added next month cannot forget it. Reads are
    // deliberately not counted. `GET /events?since=` exists so an agent does not have to
    // poll the board, and throttling the cheap call would push agents back towards the
    // expensive one; a read storm costs a little, a write storm costs everybody.
    //
    // The increment and the window roll-over are one statement, so two concurrent writes
    // cannot both read the same count. Inside an UPDATE, a column on the right-hand side of
    // SET is the row's OLD value, which is what lets the second CASE test the window the
    // first one is replacing. A refused request returns before the handler, so nothing is
    // written; it still counts, so a loop that ignores the 429 stays throttled.
    if (c.agent && !SAFE_METHODS.has(req.method)) {
      const [rl] = await sql`update agents set
          rl_window_start = case when rl_window_start is null or rl_window_start < now() - interval '1 minute'
                                 then now() else rl_window_start end,
          rl_count = case when rl_window_start is null or rl_window_start < now() - interval '1 minute'
                          then 1 else rl_count + 1 end
        where id=${c.agent.id}
        returning rl_count, rl_window_start, rate_limit`;
      if (rl && rl.rl_count > rl.rate_limit) {
        return json(
          { error: `rate limit exceeded: this agent may make ${rl.rate_limit} writes per minute`,
            limit: rl.rate_limit, window: '1 minute' },
          429,
          { 'Retry-After': String(retryAfterSeconds(rl.rl_window_start)) },
        );
      }
    }
    return handler(req, ctx, c.tenant, c);
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Which audiences a caller may see. An agent is never served a human_only row — not in a
// list, not by id, and not through a child route — so that text cannot reach a model. The
// reverse is not symmetrical: people are served everything, and the board UI hides
// agent_only behind a toggle any admin can lift. Agent work no person could see would
// defeat the events log it is written beside.
export const visibleAudiences = (c = {}) =>
  (c.agent ? ['both', 'agent_only'] : ['both', 'agent_only', 'human_only']);

export const AUDIENCES = ['both', 'human_only', 'agent_only'];

// A card an agent creates is for agents until it says otherwise; one a person creates is
// for everyone. The friction runs in the right direction: an agent has to decide to put
// something in front of people.
//
// Except on a board where almost every actor is an agent, where that default leaves the
// board looking empty to the one person watching it. Which kind of board this is, is a
// property of the board, so `config.agentCardsDefault` can flip it per board. The rule
// itself lives in cards.mjs, where a test can reach it.
export const defaultAudience = (c, tenant = null) => defaultAudienceFor(c, tenant);

// Routes that act on a person, not a board. A board passphrase is a shared secret held by
// agents, so it is not a person and is refused here; ADMIN_KEY + X-Tenant still passes,
// which is what keeps Adi able to fix a board nobody can log into.
export function withUser(handler, { adminOnly = false } = {}) {
  return async (req, ctx) => {
    const c = await caller(req);
    if (!c) return json({ error: 'unauthorized' }, 401);
    if (!c.tenant) return json({ error: 'this credential needs an X-Tenant header' }, 400);
    if (!c.person && !c.admin) return json({ error: 'sign in to do that' }, 403);
    if (adminOnly && !isBoardAdmin(c)) return json({ error: 'admins only' }, 403);
    return handler(req, ctx, c.tenant, c);
  };
}

// Admin comes from the membership of the board being acted on, never from the person:
// running one board says nothing about any other.
export const isBoardAdmin = (c) => c.admin === true || c.memberAdmin === true;

// Board management: creating, configuring and deleting boards. Two ways in — ADMIN_KEY,
// which is the emergency route and belongs to nobody, and a signed-in master admin, whose
// actions are attributable. Being a master admin grants no access to any board's contents.
export function withAdmin(handler) {
  return async (req, ctx) => {
    const c = await caller(req);
    if (!c) return json({ error: 'unauthorized' }, 401);
    if (!c.admin && c.person?.is_master !== true) return json({ error: 'unauthorized' }, 401);
    return handler(req, ctx, c);
  };
}

// Pass the caller so a child route cannot become a side door onto a card the caller is not
// allowed to read: without it an agent could post a note to a human_only card it would get
// a 404 for.
export async function ownsCard(cardId, tenantId, c) {
  const [row] = await sql`select id from cards
    where id=${cardId} and tenant_id=${tenantId}
      and audience = any(${visibleAudiences(c)}::text[])`;
  return !!row;
}

// Row as returned to clients: tenant_id is internal.
export const clean = ({ tenant_id, ...row }) => row;
export const publicTenant = (t) => ({ slug: t.slug, name: t.name, config: t.config });

const RESERVED = new Set(['admin', 'api', 'docs']);
export const validSlug = (s) => /^[a-z0-9][a-z0-9-]{1,39}$/.test(s) && !RESERVED.has(s);
export const newPassphrase = (slug) => slug + '-' + randomBytes(12).toString('base64url');

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((s) => String(s).trim()).filter(Boolean);

// Per-board UI settings: brand line, people, tags, accent colour, optional dot motif.
export function normalizeConfig(c, name) {
  const out = {
    brand: String(c.brand || name).trim(),
    tagline: String(c.tagline ?? 'Project Board').trim(),
    names: list(c.names),
    tags: list(c.tags),
  };
  if (/^#[0-9a-f]{6}$/i.test(c.accent || '')) out.accent = c.accent;
  if (Number.isInteger(c.dots) && c.dots > 0 && c.dots <= 8) out.dots = c.dots;
  if (c.dotsTitle) out.dotsTitle = String(c.dotsTitle);
  // The Plan's shape for this board: its goal, the metrics it tracks, its periods and its
  // static sections. Carried through rather than rebuilt, because the app deliberately does
  // not know what any board measures — that is what makes one page serve a sales funnel and
  // a release scorecard. Who may change it is enforced in the settings route, not here.
  if (c.plan && typeof c.plan === 'object' && !Array.isArray(c.plan)) out.plan = c.plan;
  // What audience an agent's new card gets on this board. Absent means 'agent_only', the
  // behaviour every board had before this existed.
  if (AGENT_CARD_DEFAULTS.includes(c.agentCardsDefault)) out.agentCardsDefault = c.agentCardsDefault;
  // Whether reaching Done on this board needs a board admin. Stored only when true, so a
  // board that has never been asked carries no key and behaves as it always has.
  if (c.reviewGate === true) out.reviewGate = true;
  return out;
}

// A board's plan is its constitution: the goal everything is measured against and the
// metrics every `actual` is keyed by. Changing it reinterprets every number already
// recorded, so it is the one part of a board's settings a board admin cannot edit.
export const mayEditPlan = (c) => c.admin === true || c.person?.is_master === true;
