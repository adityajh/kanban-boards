# kanban-boards

One multi-tenant kanban app for client engagements. Each client gets its own board at
`/<slug>` with its own passphrase, people, tags and accent colour. Next.js on Vercel,
Neon Postgres. Started life as the Inditress board.

- Live: https://board-iota-nine.vercel.app/<slug> (Vercel project `board`)
- Admin overview: `/admin` (all boards, Review queue, stalled cards, recent notes, create a board)
- API reference: [API.md](API.md)

## How tenancy works

- `tenants` holds one row per client: `slug`, `name`, `key_hash`, `config` (brand, tagline,
  people, tags, accent, optional dot motif).
- `cards` and `resources` carry `tenant_id`. Subtasks, links and notes belong to a tenant
  through their card.
- The bearer token picks the tenant: `HMAC-SHA256(KEY_PEPPER, passphrase)` is looked up in
  `tenants.key_hash`. Every board route is wrapped in `withTenant()` (`lib/tenant.js`) and
  every query filters by that tenant; child rows are checked via a join to their card.
  A token for board A gets `404` on board B's rows.
- `ADMIN_KEY` can act on any board by sending `X-Tenant: <slug>` (the board UI does this),
  and is the only key accepted by `/api/admin/*`.

## Layout

- `app/[slug]/page.js` + `components/Board.js`: the board UI
- `app/admin/page.js`: admin overview
- `app/api/**`: REST API (board routes + `admin/`)
- `lib/tenant.js`: auth, tenant resolution, config normalisation · `lib/http.js`: JSON/CORS helpers
- `schema.sql`: full schema for a fresh DB · `migrations/`: upgrades for the existing DB
- `public/docs/`: Inditress brand docs (public URLs, kept so existing Library links work;
  new boards use links only)

## Environment (Vercel)

| Var | What |
|-----|------|
| `DATABASE_URL` | Neon. Production = `production` branch; Preview = `dev` branch |
| `KEY_PEPPER` | HMAC pepper for passphrases. Changing it invalidates every board passphrase |
| `ADMIN_KEY` | Cross-board admin key |

Local dev: put the three vars in `.env.local` (git-ignored) pointing at the `dev` branch, then `npm run dev`.

## Deploy

Push to `main` → Vercel production. Other branches/PRs → preview deployments on the `dev` DB branch.

## New client

Open `/admin` → **New board** (name, slug, people, tags, accent). The passphrase is shown
once; only its hash is stored. Or `POST /api/admin/tenants` (see API.md).
Rotate a passphrase: `PATCH /api/admin/tenants/<slug>` with `{"rotate": true}`.
