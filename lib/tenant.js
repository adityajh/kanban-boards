import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { sql } from './db';
import { json, bearer } from './http';
import { sessionPerson, membership } from './auth';

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

// Three ways in, all resolving to exactly one tenant:
//
//   passphrase       — the token itself names the board (X-Tenant is ignored), unchanged
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
      if (!slug) return { admin: true, tenant: null, person: null, memberAdmin: false };
      const [tenant] = await sql`select * from tenants where slug=${slug}`;
      return tenant ? { admin: true, tenant, person: null, memberAdmin: false } : null;
    }
    const [tenant] = await sql`select * from tenants where key_hash=${hashKey(token)}`;
    return tenant ? { admin: false, tenant, person: null, memberAdmin: false } : null;
  }

  const person = await sessionPerson(req);
  if (!person) return null;
  const slug = askedFor(req);
  if (!slug) return { admin: false, tenant: null, person, memberAdmin: false };
  const [tenant] = await sql`select * from tenants where slug=${slug}`;
  if (!tenant) return null;
  const m = await membership(person.id, tenant.id);
  if (!m) return null;
  return { admin: false, tenant, person, memberAdmin: m.is_admin };
}

// Every board route goes through this: the handler only ever sees its own tenant.
// `c` is the fourth argument so routes that care who is acting (note authorship, settings)
// can ask, while the ones that don't stay exactly as they were.
export function withTenant(handler) {
  return async (req, ctx) => {
    const c = await caller(req);
    if (!c) return json({ error: 'unauthorized' }, 401);
    if (!c.tenant) return json({ error: 'this credential needs an X-Tenant header' }, 400);
    return handler(req, ctx, c.tenant, c);
  };
}

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

export async function ownsCard(cardId, tenantId) {
  const [c] = await sql`select id from cards where id=${cardId} and tenant_id=${tenantId}`;
  return !!c;
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
  return out;
}
