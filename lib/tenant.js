import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { sql } from './db';
import { json, bearer } from './http';

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

// A tenant passphrase acts on its own tenant (X-Tenant is ignored). ADMIN_KEY acts on
// the tenant named by X-Tenant / ?tenant=, or on no tenant for /api/admin/*.
export async function caller(req) {
  const token = bearer(req);
  if (!token) return null;
  if (isAdminKey(token)) {
    const slug = req.headers.get('x-tenant') || new URL(req.url).searchParams.get('tenant');
    if (!slug) return { admin: true, tenant: null };
    const [tenant] = await sql`select * from tenants where slug=${slug}`;
    return tenant ? { admin: true, tenant } : null;
  }
  const [tenant] = await sql`select * from tenants where key_hash=${hashKey(token)}`;
  return tenant ? { admin: false, tenant } : null;
}

// Every board route goes through this: the handler only ever sees its own tenant.
export function withTenant(handler) {
  return async (req, ctx) => {
    const c = await caller(req);
    if (!c) return json({ error: 'unauthorized' }, 401);
    if (!c.tenant) return json({ error: 'admin key needs an X-Tenant header' }, 400);
    return handler(req, ctx, c.tenant);
  };
}

export function withAdmin(handler) {
  return async (req, ctx) => {
    const c = await caller(req);
    if (!c?.admin) return json({ error: 'unauthorized' }, 401);
    return handler(req, ctx);
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
