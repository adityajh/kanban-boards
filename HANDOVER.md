# Handover — kanban-boards

Written 2026-09-16 by the agent that did the multi-tenant conversion. Everything below was
verified on the day, not assumed. Re-check anything load-bearing before you rely on it.

## What this is

One multi-tenant kanban app serving every client engagement. It started as the
single-tenant Inditress board (Next.js + Neon on Vercel, one shared passphrase) and was
converted in place on 2026-09-11..15 so a second client (JBJ Jeweller) could be added
without a second copy of the app.

- Live: https://board-iota-nine.vercel.app — `/inditress`, `/jbj`, `/admin`
- `/` redirects to `/inditress` so the old bookmarks and agents keep working
- Source: `~/Documents/COWORK/kanban-boards` (this folder). Read `README.md` and `API.md` first.

## Status

| Area | State |
|------|-------|
| Production app | Live, multi-tenant, deployed manually via `vercel deploy --prod` |
| Inditress | Intact: same passphrase, 16 cards / 84 subtasks / 12 links / 4 notes / 3 library links |
| JBJ Jeweller | Board created (people Adi, Rahul; no tags; accent `#9C7A3C`). Empty. Passphrase not yet sent to Rahul as far as this agent knows |
| Tests | `tests/isolation-test.sh` — 40/40 pass against dev **and** production |
| Git | 3 commits on `main`, local only. `origin` is set but the GitHub repo does not exist yet |
| Neon | `production` migrated; `dev` branch for previews; pre-migration backup branch kept |
| Vercel env | `KEY_PEPPER`, `ADMIN_KEY` on Production + Preview; `DATABASE_URL` on Preview → dev branch |

## One thing is unfinished

**GitHub repo + auto-deploy.** The repo `adityajh/kanban-boards` was never created: the
fine-grained PAT in `~/Documents/Claude/Credentials/github_pat_playful_scratchpad.rtf`
authenticates as `adityajh` but returns *"Resource not accessible by personal access token"*
on `POST /user/repos` — it can't create repos. Adi needs to create an empty private repo
(no README/.gitignore), or grant that token admin rights. Then:

```bash
cd ~/Documents/COWORK/kanban-boards && git push -u origin main
vercel git connect https://github.com/adityajh/kanban-boards --yes
```

Until then every deploy is manual from this folder.

Migration 002 is **done** (2026-09-16, production and dev): the temporary `DEFAULT 1` on
`cards.tenant_id` / `resources.tenant_id` is dropped, so an insert that forgets its tenant
now errors instead of silently landing on Inditress. `tenant_id` remains NOT NULL. The
40-check suite passed against production afterwards.

## How tenancy works

- `tenants` row per client: `slug`, `name`, `key_hash`, `config` (jsonb: `brand`, `tagline`,
  `names`, `tags`, `accent`, optional `dots`/`dotsTitle`).
- `key_hash` = `HMAC-SHA256(KEY_PEPPER, passphrase)` hex. The bearer token alone identifies
  the tenant, which is why agents still call `/api/cards` with no client in the path.
- `cards` and `resources` have `tenant_id`. `subtasks`, `links`, `notes` do **not** — they
  are scoped by joining to their card. Every child route does
  `... from cards c where x.id=$id and c.id=x.card_id and c.tenant_id=$tenant`, so a wrong
  tenant gets `404`, never a silent cross-client write. Don't add a child route that looks
  up by id alone; that was the original bug class this conversion fixed.
- All board routes are wrapped in `withTenant()` (`lib/tenant.js`) — keep it that way rather
  than hand-rolling auth per route.
- `ADMIN_KEY` + header `X-Tenant: <slug>` acts on any board (the board UI always sends
  `X-Tenant`, so Adi can open any board with the admin key). `/api/admin/*` takes only `ADMIN_KEY`.

## Secrets and access

- `~/Documents/Claude/Credentials/kanban-boards.env` (chmod 600): `KEY_PEPPER`, `ADMIN_KEY`,
  `INDITRESS_PASSPHRASE`, `JBJ_PASSPHRASE`. Nothing else holds these.
- **Changing `KEY_PEPPER` invalidates every board passphrase.** There is no recovery path
  short of rotating each board via the admin API.
- Neon project `Inditress-board` = `billowing-sun-22052519` (org `org-twilight-heart-58179471`).
  Branches: `production` `br-old-sound-aqdbj4b8`, `dev` `br-summer-union-aq52oiiq`,
  `backup-pre-multitenant-2026-09-11` `br-soft-pine-aq8g6fmf` (no compute; the rollback point).
- Vercel project `board`, team `adityas-projects-192de3cb`, `prj_sp26Gwkon9zyxX7eSMbnLEKQnHOv`.
- VPS hub card: `/root/hub/data/pages/inditress-kanban/index.html` on `root@91.108.110.72`
  (key `Credentials/vps_key`). Rewritten to drop the plain-text passphrase it used to show;
  previous version kept as `index.html.bak-pre-multitenant`. The hub registry entry is still
  titled "Inditress Board" — renaming it to "Client Boards" is a one-line edit nobody has done.

## Recipes

**Local dev.** Needs `DATABASE_URL` (point it at the **dev** branch, never production),
`KEY_PEPPER`, `ADMIN_KEY` in `.env.local`, then `npm run dev`. Note: `vercel link` /
`vercel env pull` writes a `.env.local` from the *Development* env, which points at the
**production** database and has no `KEY_PEPPER` — overwrite it before running anything.

**Tests.** Start the app (any URL works, local or deployed), then:

```bash
set -a && . ~/Documents/Claude/Credentials/kanban-boards.env && set +a && bash tests/isolation-test.sh https://board-iota-nine.vercel.app
```

It creates one throwaway JBJ card and deletes it; it only reads Inditress and asserts its
data is unchanged. Re-run it after any change to auth or a route.

**Deploy.** `vercel deploy --prod --yes` from this folder (until GitHub is connected).
Delete `.env.local` first so it isn't uploaded.

**New board.** `/admin` → New board, or `POST /api/admin/tenants`. The passphrase is shown
exactly once; store it in the Credentials env file. Rotate with
`PATCH /api/admin/tenants/<slug>` `{"rotate": true}`.

## Traps

- **macOS bash is 3.2.** A line-continued argument inside `"$( … )"` gets mangled — this
  silently sent a broken JSON body and cost a debugging round. Keep such bodies on one line
  or in a variable.
- **The auto-mode classifier blocks some steps for the agent**: `vercel env add` (pushing
  secrets), reading the Vercel/GitHub credential files in bulk, and destructive/DDL SQL via
  the Neon MCP. Hand those to Adi with a copy-pasteable command rather than looking for a
  way around them.
- **`public/docs/*` is world-readable** — no passphrase. Three Inditress brand docs live
  there and its Library links point at them. Decision on record: new clients get links only,
  no hosted files. If a client ever needs private files, that needs real object storage.
- **`localStorage` keys are namespaced per board** (`board_key:<slug>`), with a one-time
  adoption of the old un-namespaced `board_key` so Inditress users were never re-prompted.
  If you rename slugs, people get asked for the passphrase again.
- **Passphrase identifies the tenant, so `/api/tenant` is how the UI checks the key belongs
  to the board being viewed.** A valid key for another board is rejected client-side.
- Board IDs are global serials, so ids are unique across clients; `?card=<id>` deep links
  from the admin page rely on that.

## Decisions on record (don't silently reverse)

- One database, separated by `tenant_id`, not a schema per client. Chosen for simplicity;
  the mitigation is that scoping lives in one helper plus the test suite.
- Paths (`/slug`), not subdomains — `vercel.app` can't do wildcards. Adi plans to buy a
  domain later; subdomains become possible then.
- Per-client styling is limited to config (brand, tagline, accent, people, tags). Resist
  bespoke CSS per client or you're back to separate apps.
- "Who are you?" is still an honour-system name picker, not a login. Real per-person auth
  was deliberately deferred.
- The Inditress passphrase was deliberately **not** rotated, even though it sat in plain text
  on the hub page for months. Worth raising with Adi again.

## Rollback

App: `vercel rollback` (or redeploy the pre-cut-over deployment, 94 days old at the time).
Data: branch `backup-pre-multitenant-2026-09-11` is the pre-migration snapshot. The
migration was additive — no column or row was dropped. Note that since 002 ran, rolling the
*app* back alone is no longer enough: the old single-tenant code inserts without
`tenant_id`, which now fails against a NOT NULL column with no default. Reads would still
work. To truly roll back, re-add `alter table cards alter column tenant_id set default 1`
(and the same for `resources`) first.
