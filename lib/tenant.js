import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { sql } from './db';
import { json, bearer } from './http';
import { sessionPerson, membership } from './auth';

import { retryAfterSeconds } from './ratelimit.mjs';
import { withSectionIds } from './plan-sections.mjs';

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
             a.may_finish as agent_may_finish, a.disabled_at, t.*
      from agents a join tenants t on t.id = a.tenant_id where a.token_hash=${hash}`;
    if (!row || row.disabled_at) return null;
    // Every alias is destructured out before the rest becomes the tenant: `t.*` and the
    // agent's columns share one row, so a field left in here would arrive as part of the
    // board's own record.
    const { agent_id, agent_name, agent_scope, agent_may_finish, disabled_at, ...tenant2 } = row;
    // Cheap liveness for the Agents tab. Rate-limited to a write a minute so an agent
    // polling hard does not turn every read into a write.
    await sql`update agents set last_seen_at=now() where id=${agent_id}
      and (last_seen_at is null or last_seen_at < now() - interval '1 minute')`;
    return {
      admin: false, tenant: tenant2, person: null, memberAdmin: false,
      agent: {
        id: agent_id, name: agent_name, scope: agent_scope,
        // Whether this agent may mark work done on a board whose gate is on. Carried on the
        // caller rather than looked up where it is needed, so approvalRefusal stays pure and
        // testable; see migration 014.
        mayFinish: agent_may_finish === true,
      },
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

// A batch write is one HTTP request and many writes, and withTenant above has only counted
// the request. Without this, a 50-operation batch would cost an agent one write against its
// per-minute limit and the limit would mean nothing: 120 requests a minute becomes 6000
// rows a minute. So the batch route charges for the rest of what it is about to do, by the
// same one-statement roll-over, and refuses the whole batch if that would go over.
//
// Charged before anything is written and never refunded on a later failure. An agent that
// sends a batch which fails validation has still used the board's time.
export async function chargeAgentWrites(agentId, extra) {
  if (!agentId || extra <= 0) return null;
  const [rl] = await sql`update agents set
      rl_window_start = case when rl_window_start is null or rl_window_start < now() - interval '1 minute'
                             then now() else rl_window_start end,
      rl_count = case when rl_window_start is null or rl_window_start < now() - interval '1 minute'
                      then ${extra} else rl_count + ${extra} end
    where id=${agentId}
    returning rl_count, rl_window_start, rate_limit`;
  return rl || null;
}

// Which audiences a caller may see. `audience` is one thing only: whether people alone may
// read a row. An agent is never served a human_only row — not in a list, not by id, and not
// through a child route — so that text cannot reach a model.
//
// There is no agent-only direction and deliberately so. Hiding a row from people would
// defeat the events log it is written beside, and the board's view filter for agent work
// now reads the assignee instead (isAgentWork in cards.mjs, migration 015).
export const visibleAudiences = (c = {}) =>
  (c.agent ? ['both'] : ['both', 'human_only']);

export const AUDIENCES = ['both', 'human_only'];

// Everything is readable by everyone unless it is deliberately marked human_only. Nothing
// an agent writes is hidden by default any more: the old default asked agents to choose an
// audience at creation, and they got it wrong in both directions — overridden on 25 cards
// out of 25, and silently accepted on 25 Plan rows nobody meant to hide.
export const defaultAudience = () => 'both';

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
  // Sections get their ids here rather than in the routes, so a section cannot arrive
  // anonymous by any path — the settings screen, a section POST, or a board created with a
  // plan already in it. Existing ids are never reassigned (see withSectionIds).
  if (c.plan && typeof c.plan === 'object' && !Array.isArray(c.plan)) out.plan = withSectionIds(c.plan);
  // Whether reaching Done on this board needs a board admin. Stored only when true, so a
  // board that has never been asked carries no key and behaves as it always has.
  if (c.reviewGate === true) out.reviewGate = true;
  return out;
}

// Running one board says nothing about any other, so some things are reserved for whoever
// runs them all: ADMIN_KEY, which belongs to nobody, and a signed-in master admin, whose
// actions are attributable. Being a master admin grants no access to any board's contents —
// it gates what is ABOUT the set of boards rather than what is inside one.
export const isMaster = (c) => c.admin === true || c.person?.is_master === true;

// A board's plan is its constitution: the goal everything is measured against and the
// metrics every `actual` is keyed by. Changing THOSE reinterprets every number already
// recorded, so they stay with whoever runs every board.
export const mayEditPlan = (c) => isMaster(c);

// Sections are the other half of the plan, and a different kind of thing. Section prose can
// be wrong and be fixed without rewriting history — a sentence describing the referral
// switch is not the referral numbers. That part the people and agents doing the work may
// edit, which is the 26 Nov decision: an agent that would rather somebody else decided
// assigns a card and says so, rather than filing a proposal into a second queue nobody
// reads.
//
// A bare board passphrase still may not, and that is not an oversight. It is a shared
// secret that names nobody, so its edit would land in the history as `board passphrase` —
// a change there is no way to ask anybody about afterwards. The whole value of the history
// is that each row names someone.
export const mayEditSections = (c) => !!(c.person || c.agent || c.admin === true);

// Deleting a section destroys content rather than correcting it, and reverting is a
// person's judgement about an agent's work — an agent holding its own undo is circular.
export const isPerson = (c) => !!c.person || c.admin === true;
