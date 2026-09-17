# kanban-boards

One multi-tenant kanban app for client engagements. Each client gets its own board at
`/<slug>` with its own people, tags and accent colour. People sign in with their own
username and password; agents keep using the board passphrase. Next.js on Vercel,
Neon Postgres. Started life as the Inditress board.

- Live: https://board-iota-nine.vercel.app/<slug> (Vercel project `board`)
- Board settings: `/<slug>/settings` (your password; and for board admins, board look-and-feel and people)
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
- `ADMIN_KEY` can act on any board by sending `X-Tenant: <slug>`, and is the only key
  accepted by `/api/admin/*`. It also passes the board-admin checks on `/api/settings/*`,
  which is the way back in if nobody can sign in to a board.

## Who can do what

| | Signs in as | Reaches |
|---|---|---|
| A person | username + password → `board_session` cookie | every board they are a member of; settings; their own password |
| A board admin | as above, with `is_admin` on that board's membership | plus that board's settings and people — nothing on any other board |
| An agent | board passphrase as a bearer token | the board's cards and resources — **not** settings or passwords |
| Adi | `ADMIN_KEY` (+ `X-Tenant`) | every board, `/api/admin/*`, and any board's settings |

Identity and membership are separate. `people` is who someone is — a globally unique
username and **one password**. `memberships` is which boards they are on and whether they
run each one, so admin is per board and never travels with the person. Somebody on four
boards is one account with one password.

A session names a person, not a board. Each request says which board it means
(`X-Tenant: <slug>`) and `withTenant()` proves membership of it — so the board is no longer
read off the credential, but access still resolves to exactly one tenant and a non-member is
refused indistinguishably from a board that does not exist.

Passwords are scrypt with a per-password salt, stored as `scrypt$N$r$p$salt$hash` — **not**
peppered with `KEY_PEPPER`, so rotating the pepper does not lock everyone out. Sessions store
only `sha256(token)`; the token itself lives in an HttpOnly `SameSite=Lax` cookie, so it is
same-origin only.

Every board has at least one admin: one is created with the board, and the last one cannot
be demoted or removed. Taking someone off their last board removes their account too — an
account on no boards can never be reached or removed again.

## Layout

- `app/[slug]/page.js` + `components/Board.js`: the board UI
- `app/admin/page.js`: admin overview
- `app/api/**`: REST API (board routes + `admin/`)
- `app/[slug]/settings/page.js` + `components/Settings.js`: per-board settings
- `lib/tenant.js`: tenant resolution, route wrappers (`withTenant`, `withUser`, `withAdmin`), config normalisation
- `lib/auth.js`: sessions and membership lookups · `lib/people.js`: board rosters
- `lib/password.mjs`: scrypt hashing, cookies (pure, no imports, unit-tested)
- `lib/http.js`: JSON/CORS helpers · `tests/`: `auth-test.mjs` (no DB) and `isolation-test.sh` (live)
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

**Connecting the repo to Vercel does not deploy what is already on `main`** — it only wires up
future pushes. After a fresh `vercel git connect`, either push a new commit or hit Redeploy in
the dashboard, or the last manual `vercel deploy --prod` stays live and it looks like nothing
happened. This cost a round of confused debugging on 2026-09-16.

## New client

Open `/admin` → **New board** (name, slug, people, tags, accent). You get back two secrets,
each shown **once**: the board passphrase (for agents) and the first admin's password. Store
both in the credentials env file. Or `POST /api/admin/tenants` (see API.md).

That admin signs in at `/<slug>`, is made to set their own password, then adds everyone else
under **Settings → People**. A new person's first password is generated and shown once;
somebody who already has an account on another board simply joins with the password they
already use, and nothing needs sending.

Rotate a passphrase: `PATCH /api/admin/tenants/<slug>` with `{"rotate": true}`.

## Tests

```bash
node tests/auth-test.mjs                    # password hashing and cookies, no DB needed
bash tests/isolation-test.sh <base-url>     # tenant isolation + auth, against a running app
```

The second needs `INDITRESS_PASSPHRASE`, `JBJ_PASSPHRASE` and `ADMIN_KEY` in the environment.
It creates and deletes its own throwaway card and user on JBJ, and only reads Inditress.
Re-run it after any change to auth or a route.
