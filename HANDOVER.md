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

## GitHub + auto-deploy — done (2026-09-16)

The repo now exists, `main` is pushed, and the Vercel GitHub App is connected, so pushes to
`main` deploy to production and branches get previews. Manual `vercel deploy --prod` is no
longer the only route.

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
- The board passphrases were deliberately **not** rotated, the Inditress one included, even
  though it sat in plain text on the hub page for months. Raised again on 2026-09-17 with
  the old-deployment finding above as a fresh reason; Adi's answer was still no. Don't
  rotate without asking — it breaks every agent integration, and per that finding it would
  not close the bypass anyway.

## Rollback

App: `vercel rollback` (or redeploy the pre-cut-over deployment, 94 days old at the time).
Data: branch `backup-pre-multitenant-2026-09-11` is the pre-migration snapshot. The
migration was additive — no column or row was dropped. Note that since 002 ran, rolling the
*app* back alone is no longer enough: the old single-tenant code inserts without
`tenant_id`, which now fails against a NOT NULL column with no default. Reads would still
work. To truly roll back, re-add `alter table cards alter column tenant_id set default 1`
(and the same for `resources`) first.


---

# Update — 2026-09-16: per-user login and board settings

Written by the agent that added authentication. Branch `claude/relaxed-franklin-ybgt9t`.

## What changed

"Who are you?" was an honour-system name picker; it is now a real login. Each board has its
own `users`, and people sign in with a username and password. Boards also got a settings
screen at `/<slug>/settings`.

Decisions taken with Adi before building:

- The board passphrase **survives, for agents only**. It is still a bearer token for
  `/api/*`, so every existing agent integration is untouched. The board UI no longer
  accepts it, and it is refused (`403`) on `/api/settings/*` and `/api/auth/password` —
  a shared secret is not a person.
- Login is by **username**, seeded from each board's existing `config.names`.
- First passwords are **generated and shown once**, like a board passphrase. `must_change`
  holds the person at a change-password screen until they replace it.
- **Adi is admin on both boards.**

## Things worth knowing

- **Passwords are not peppered with `KEY_PEPPER`**, on purpose. The pepper already has no
  recovery path if rotated; user passwords must not share that fate. Per-password salt
  (scrypt, `scrypt$N$r$p$salt$hash`) is enough, and the cost parameters live in the stored
  string so they can be raised later without a migration.
- **Cookie auth is same-origin only.** CORS is a wildcard with no `Allow-Credentials`, and
  the cookie is `HttpOnly; SameSite=Lax`. Lax is what stands in for CSRF tokens. If anyone
  ever adds `Access-Control-Allow-Credentials`, that protection is gone — don't.
- `withTenant()` now resolves three credentials — passphrase, `ADMIN_KEY` + `X-Tenant`, and
  a session cookie — to the same tenant shape, and passes the caller as a fourth argument.
  Keep new routes going through it (or `withUser` for anything that acts on a person)
  rather than hand-rolling auth.
- **`ADMIN_KEY` is the way back into a board nobody can sign in to.** It passes the
  board-admin checks on `/api/settings/*`, so Adi can always add or reset a user. The last
  admin on a board cannot be demoted or deleted, so the UI can't strand a board either.
- **Note authorship is now taken from the session**, not the request body, for signed-in
  people. Agents on a bearer token still pass `author` as before.
- A bug worth remembering, caught by the unit tests: `Buffer.from(x, 'base64')` silently
  drops invalid characters, so a corrupt `password_hash` decoded to an empty buffer — and
  scrypt with keylen 0 returns an empty buffer that compares *equal*, accepting every
  password. `verifyPassword` now rejects any undersized salt or hash. If you touch that
  function, keep `tests/auth-test.mjs` green.
- `must_change` is enforced by the UI, not the API: a user who has not changed their
  generated password can still call the API with it. It is a hygiene prompt, not a gate.

## Deployed — 2026-09-16

Done in this order, which is the order that matters: the board UI requires a login, so the
`users` table has to exist before the code ships or every board is unreachable.

1. Migration 003 applied to `production` (and to `dev`, for previews).
2. Nine users seeded across all three boards, each with a generated password and
   `must_change = true`. Adi is admin on all three.
3. Merged to `main`, which auto-deploys to production.

The seeding was done by inserting hashes computed with the shipped `lib/password.mjs`
rather than by `scripts/seed-users.sh`, because the agent had neither `ADMIN_KEY` nor a
network route to the deployed app. The script is still the right tool for a new board.

**There were three boards, not two.** `zealxle` (ZEAL x LE — Adi, Ankita, Sharjeel,
DrSajid) was created on 2026-09-16, after the original handover was written. It would have
been locked out had it been missed. If you add a board through SQL rather than the admin
API, remember it needs an admin user or nobody can sign in to it.

## Tests

`tests/auth-test.mjs` — 44 checks on password hashing and cookie parsing. No database, no
server: `node tests/auth-test.mjs`. `tests/isolation-test.sh` grew from 40 to 95 checks;
the new ones cover session/board scoping, member-vs-admin permissions, the agent path
staying open while being refused on settings, password change evicting other sessions, and
the last-admin guard.

**95/95 against production, 2026-09-16.** The agent that wrote the suite could not run it —
that session had no network route to Neon or to the deployed app (egress policy) — so Adi
ran it. Two bugs came out of that, both now fixed:

- Creating a board returned 400 instead of 409 on a duplicate slug, because the new
  admin-username check ran ahead of the insert and rejected a username derived from a
  short name. A board whose first person had a short or unusual name could not be created
  at all.
- Three of the new password checks built their JSON inline inside `"$( … )"`, which bash
  3.2 mangles — the trap documented below, walked into anyway. curl sent an empty body, and
  since a missing `newPassword` reads as "too short", the two negative checks passed for
  the wrong reason. Bodies now go in variables, and a check parses the body before sending
  it so this fails loudly rather than silently.

The second is the one to remember: a green negative assertion is worth nothing if the
request never arrived. Only the positive check next to it exposed the problem.

## Still open

- **Rollout is partial.** Adi has signed in to `inditress` and `zealxle` and changed both
  passwords; the browser flow — login, forced first-password change, settings, promoting
  someone to admin — is confirmed working on both. `jbj` has not been touched: nobody has
  signed in and Rahul has not been sent his login. That board is also still empty.
- **Everyone else is still on the password they were issued** (`must_change = true`). Those
  values were handed over by WhatsApp and are the only copies; once a person signs in and
  replaces theirs, any copy in `kanban-boards.env` is dead and should be deleted. To see who
  is still on an issued password:
  `select t.slug, u.username, u.must_change, u.last_login_at from users u join tenants t on t.id=u.tenant_id order by t.id, u.username;`
- A forgotten password is not recoverable by anyone, including whoever issued it. A board
  admin resets it in Settings → People, which prints a new one-time password and signs that
  person out everywhere.
- **Old Vercel deployments bypass the login.** Vercel keeps every past deployment at its own
  permanent URL with that build's env vars attached, and they all read the same live
  database. Any deployment from before 2026-09-16 serves the pre-auth UI, which needs only
  a board passphrase — so a passphrase plus an old URL is full read/write access to
  production with no sign-in. Rotating passphrases does **not** close this: `KEY_PEPPER` is
  unchanged, so a new passphrase hashes the same on an old build, and `ADMIN_KEY` is baked
  into each deployment at build time, so an old build keeps accepting the old key whatever
  you set in Vercel now. The fix is Vercel Deployment Protection, or deleting the old
  deployments — nothing else removes the path. Not tested end-to-end: the session that
  found it had no network route to Vercel. Verify before relying on either direction.
- The hub registry entry on the VPS is still titled "Inditress Board".
