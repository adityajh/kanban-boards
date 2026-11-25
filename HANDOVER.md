# Handover — kanban-boards

> **Read the last section first: "Update — 2026-11-25".** Everything between here and there
> is the September record, kept as written. Parts of it are superseded and are marked
> **SUPERSEDED** where they sit. The worst: the `users` table is dead (use `people` +
> `memberships`), the board UI no longer takes a passphrase, and the old-deployment login
> bypass is still open and is the most serious thing in this file.

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

*SUPERSEDED as a snapshot: this is the 2026-09-16 state. The current one is in the 2026-11-25 update.*

| Area | State |
|------|-------|
| Production app | Live, multi-tenant, deployed manually via `vercel deploy --prod` |
| Inditress | *(Sept)* Intact: same passphrase, 16 cards / 84 subtasks / 12 links / 4 notes / 3 library links |
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
  *(2026-11-25: `key_hash` is now nullable, and a person's session no longer names a tenant at
  all; see the update below.)*
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

**Deploy.** *(SUPERSEDED: GitHub is connected, push to `main` deploys.)* `vercel deploy --prod --yes` from this folder.
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
- ~~"Who are you?" is still an honour-system name picker, not a login. Real per-person auth
  was deliberately deferred.~~ **SUPERSEDED 2026-09-16**: it is a real login now (below).
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
own `users`, and people sign in with a username and password. *(SUPERSEDED by 004 on
2026-09-17+: `users` is replaced by `people` + `memberships`; see the 2026-11-25 update.)* Boards also got a settings
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

*(Counts here are the September ones; now 98 unit and 451 live checks.)*
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

*SUPERSEDED 2026-11-25: this list is stale in both directions. The current one is in the
update below. Do not run the SQL in this list; it queries a dead table.*

- **Rollout is partial.** Adi has signed in to `inditress` and `zealxle` and changed both
  passwords; the browser flow — login, forced first-password change, settings, promoting
  someone to admin — is confirmed working on both. `jbj` has not been touched: nobody has
  signed in and Rahul has not been sent his login. That board is also still empty.
- **Everyone else is still on the password they were issued** (`must_change = true`). Those
  values were handed over by WhatsApp and are the only copies; once a person signs in and
  replaces theirs, any copy in `kanban-boards.env` is dead and should be deleted. To see who
  is still on an issued password:
  `select t.slug, u.username, u.must_change, u.last_login_at from users u join tenants t on t.id=u.tenant_id order by t.id, u.username;`
  **WRONG NOW: `users` has been dead since 004 and nothing reads it. Use the query in the
  2026-11-25 update.**
- A forgotten password is not recoverable by anyone, including whoever issued it. A board
  admin resets it in Settings → People, which prints a new one-time password and signs that
  person out everywhere.
- **Old Vercel deployments bypass the login.** *(Still open and unverified; restated at the
  top of the 2026-11-25 update.)* Vercel keeps every past deployment at its own
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


---

# Update — 2026-11-25: people, agents, the Plan, directed work, no-passphrase boards

Written by the agent that brought this file up to date. It was written from the migration
headers, `AGENT-BRIEF.md`, `API.md` and the code, plus figures read off production on the
day. Nothing in it was run against a deployment (see "Still open").

## Still open — read this before anything else

1. **The old-deployment login bypass is still open, and it is the most serious thing here.**
   Any Vercel deployment built before 2026-09-16 still serves the pre-auth UI against the
   live production database, and that UI needs only a board passphrase. Rotating passphrases
   does **not** close it: `KEY_PEPPER` is unchanged, so a new passphrase hashes the same on
   an old build, and `ADMIN_KEY` is baked in at build time, so an old build keeps accepting
   the old key. Only Vercel Deployment Protection, or deleting those deployments, closes it.
   Recorded in September and **never verified end to end**, because no session since has had
   a network route to Vercel. Treat it as live until someone has tried an old URL from
   outside. Migration 012 helps only indirectly: a board with no passphrase gives that old
   UI nothing to authenticate with.
2. **Board passphrases are live on all 7 boards**, including four that have no agents at
   all (everything except `counsellor`). 012 exists so they can be retired. See "Boards
   without a passphrase" for how, because there is no button yet.
3. **This session's work has not been run against a deployment.** The 451 live checks in
   `tests/isolation-test.sh` are unrun. 98 unit checks pass under plain `node`
   (`tests/auth-test.mjs`, re-run today). Everything from 006 onward (agents, events,
   webhooks, the Plan, directed work, rate limits, the gate, 012) is covered by checks nobody
   has yet seen go green against a live app. Run the suite against a preview before
   trusting any of it; to run against a protected preview you need `VERCEL_BYPASS` (README).
4. **Five people have never signed in** (still on an issued password): across `admissions`,
   `inditress`, `inditress-sales`, `jbj` and `zealxle`. Same as September in kind: the issued
   values went out by WhatsApp and are the only copies. Query below.
5. The hub registry entry on the VPS is still titled "Inditress Board".

Closed since September: the GitHub repo and auto-deploy (done 2026-09-16); `jbj` exists and
has people; the three-board seeding problem is moot (there are seven boards, and board
creation now creates its first admin).

## Where things stand (2026-11-25, read from production)

- **7 boards:** `admissions`, `counsellor`, `inditress`, `inditress-sales`, `jbj`,
  `yelloskye`, `zealxle`.
- **Only `counsellor` has agents:** AdiClaude and AdiGrok, both write scope. Every other
  board has zero.
- **Only `counsellor` has a Plan.**
- **Every board still has a passphrase.**
- Tests: 98 unit, 451 live (unrun, above).
- There is no migration `007`. The numbering goes 006, 008. Nothing was lost as far as this
  agent can tell from the repo, but it could not establish why; do not go looking for a
  missing file.

## Who is still on an issued password

**The September recipe queried `users`. Do not use it.** Migration 004 replaced `users` with
`people` + `memberships`; the old table survives only as the rollback point
(`migrations/004_rollback.sql`) and has not been written since, so that query gives a
confident, wrong answer. Usernames are global now (one person, one password, many boards).

```sql
select p.username, p.display_name, p.must_change, p.last_login_at,
       string_agg(t.slug, ', ' order by t.slug) as boards
  from people p
  join memberships m on m.person_id = p.id
  join tenants t on t.id = m.tenant_id
 where p.must_change
 group by p.id
 order by p.username;
```

`must_change` is the "still on the issued password" flag. `last_login_at is null` is "never
signed in"; the two normally agree, but a person can sign in and be held at the change
screen, so they can differ. Today it returns five people. Remember `must_change` is a prompt
the UI enforces, not an API gate (September note, still true).

## What changed since September

### 004 and 005: people, memberships, master admin

- `people` (global username, **one** password, `is_master`) and `memberships` (person x board,
  `is_admin` per board). Sessions name a person; each request names its board with
  `X-Tenant` and `withTenant()` proves membership. A non-member gets the same 404 as a board
  that does not exist.
- **Master admin** is a property of an account (`people.is_master`), for creating,
  configuring and deleting boards. It grants **no** access to any board's contents: a
  master admin joins a board (leaving a membership row) like anyone else. There is no UI to
  grant it; set the column. `ADMIN_KEY` still works as the way back in.
- Taking someone off their last board deletes their account.
- 004 was a one-off that assumed a username on several boards was the same human. That is
  unsafe for any future data; do not re-run it against anything new.

### 006: agents, events, documents, audience

- **Agents** are per-board identities with their own token, stored as
  `HMAC-SHA256(KEY_PEPPER, token)`, so **rotating `KEY_PEPPER` invalidates every agent token
  as well as every passphrase**. Scope is `read` or write. Minted in Settings -> Agents,
  token shown once. Every write is attributed to the agent; `author`/`by` in a body is
  ignored for them.
- **Events** are an append-only log, one row per change, with `actor_name` denormalised on
  purpose so history still reads correctly after an agent is deleted. It is the audit trail
  and the feed agents read (`GET /events?since=<id>`). The cursor is an **id**, not a
  timestamp: two writes in one millisecond would make a time cursor skip one.
- **Documents** are board-scoped text under a key the writer can construct
  (`icp/zeal`, `decisions/2026-q4`). `PUT` replaces (send `expected_version`); `POST`
  appends and cannot conflict. Cards are work, documents are reference.
- **Audience** on cards and documents: `both`, `human_only`, `agent_only`. See decisions.

### 008: per-agent webhooks

An agent can have a `webhookUrl` and `webhookVerbs` (null = all verbs). Delivery is signed
(`X-Board-Signature: sha256=<HMAC of the exact body>`; the secret is shown once and is
stored **in the clear**, because signing needs to produce an HMAC, not check one). It is
**best effort: one attempt, short timeout, no queue, no retry.** The guarantee is the feed:
an agent that missed a wake catches up with `GET /events?since=`. Do not build a retry queue;
that is rebuilding the feed. A failing endpoint shows in the Agents tab.

### 009: the Plan

A per-board page at `/<slug>/plan`, present only where the board's config declares a `plan`.
One table for six kinds (`status`, `decision`, `milestone`, `risk`, `actual`, `log`), each
with a writer-chosen key, a `version` for optimistic concurrency, an audience, attribution
from the credential and an event. The rule it lives under: **it holds statuses and pointers,
never tasks and never contacts.** Tasks are cards (a row may point at one via `card_id`);
contacts live in the CRM; where the Plan disagrees with a source, the source wins. An
`actual`'s `values` are keyed by the board's declared `plan.metrics`; an undeclared key is
422, and `null` means "not known", not zero. An email address or Indian mobile number in
any field is 422; this is a speed bump, not a guarantee.

### 010: directed work

Four columns, no new table: `notes.addressed_to`, `cards.claimed_by` / `claimed_at` /
`claim_expires_at`, and `cards.answered`. With `card.assigned` events and `GET /inbox` this is
the whole of "messaging" on a board. `/me/work` is the same question for a signed-in person
across every board. A status outside the five columns is now refused by a check constraint
as well as by the API (422), so no future route can lose a card to a typo. `to` is not
validated against the roster, so a misspelt name reaches nobody; the inbox is
case-insensitive.

### 011: rate limits and the approval gate

Per-agent write limit: default 120 writes a minute, settable 1 to 10000 per agent by a board
admin, `429` with `Retry-After` past it. Two counters on the agent row, a fixed one-minute
window. The window can let through up to twice the limit across its edge; it stops
runaway loops, it does not meter. A refused request still counts, so a loop that ignores the
429 stays throttled.

The **approval gate** is opt-in per board: `config.reviewGate: true`. Then only a board
admin (or `ADMIN_KEY`) can bring a card to `done`; agents and passphrases get 403. The
`card.moved` event then carries `approvedBy`. The gate has no migration; it is board config.
Note the 011 migration file itself only adds the rate-limit columns, so read the gate rules
in `API.md`, not the migration.

### 012: boards without a passphrase

`tenants.key_hash` is nullable. NULL means "no passphrase: sign in, or use an agent token".
`caller()` looks a board up with `key_hash = <hash>`, and in SQL NULL equals nothing, so such
a board cannot be opened by any bearer token. Nothing else changed.

## Boards without a passphrase

Facts the code shows, which the migration header does not say:

- **No route creates or retires one yet.** `POST /api/admin/tenants` always generates or
  accepts a passphrase (12 characters minimum), and `PATCH /api/admin/tenants/<slug>` uses
  `coalesce(new, key_hash)`, so it cannot set it to NULL. Retiring a passphrase today means
  running `update tenants set key_hash = null where slug = '<slug>'` by hand (Neon DDL/DML
  is a step the auto-mode classifier may hand back to Adi).
- **`schema.sql` still says `key_hash text not null unique`.** A fresh database built from
  it will not allow a passphrase-less board until someone applies 012 to it. Fix the file
  when you next touch the schema.
- **Before retiring one, check the board has an agent token** (only `counsellor` does) or
  its agents lose access. `ADMIN_KEY` + `X-Tenant` and signed-in people are unaffected.
  Retiring does **not** close the old-deployment bypass on its own (see Still open); it
  only leaves that board with nothing an old UI would accept.
- Adi's September answer on rotation was no, and it was about rotating, not retiring.
  Retiring is a different act that 012 was written for, but it still breaks any integration
  on that board's passphrase. Ask first.

## Decisions on record (don't silently reverse)

Added since September; the September list above still stands except where marked.

- **`audience` is enforced asymmetrically.** `human_only` is enforced in SQL against agents,
  so the text never reaches a model. `agent_only` is only a UI filter for people, which any
  admin can lift: agent work no human could see would defeat the point of the event log.
  (An agent cannot set `human_only`, and a card in Review is always visible to people.)
- **A claim is a lease, not a lock.** An expired lease is no claim at all, because a lock
  held by a crashed agent is a card nobody can touch. A check constraint requires holder and
  expiry together. A claim does not block anyone's edits.
- **`answered` is a person's tick.** An agent cannot set it (422) and an agent's note clears
  it. Anything agents must maintain, they drift on.
- **The approval gate is on reaching `done` from any column, not on leaving `review`.** A
  gate on `review` alone is bypassed by skipping `review`. Creating a card straight into
  `done` is refused too.
- **Write rate limits count writes only, never reads.** The events feed exists so agents
  need not poll; throttling the cheap call would push them back to the expensive one.
- **`/me/work` is driven from memberships**, so it answers across boards without widening
  anyone's access. **An agent token names one board by design**, so it gets 403 there; an
  agent on several boards holds one token per board.
- **Decisions in the Plan:** an agent may propose and never settle. **Code differs from the
  shorthand "a person marks it decided":** `lib/tracker.mjs` allows only a **master admin**
  or `ADMIN_KEY`. A plain board admin is refused too. Keep it that way unless Adi says
  otherwise.
- **A master admin, not a board admin, may change a board's plan** (`PATCH /settings` with
  a `plan` key is 403 otherwise): the plan is the board's constitution, and changing the
  metric set reinterprets every recorded number.
- **Webhooks are best effort, with the feed as the guarantee** (008). No retry queue.
- **Master admin grants no board access**; access means a membership, one rule only (005).
- The board passphrase **no longer survives "for agents only" as a policy**: it is still
  accepted as a legacy bearer token (attributable to nobody, refused on `/settings/*`,
  `/inbox` and claims), but per-agent tokens are the intended route and 012 is the path off
  it. The September wording above is therefore partly superseded.

## Traps added since September

- **`users` is a corpse.** Nothing reads it. Do not write recipes against it, and do not
  drop it: it is the 004 rollback point.
- **`KEY_PEPPER` now guards three things**: passphrases, agent tokens, and nothing else
  (user passwords are scrypt, unpeppered). Rotating it breaks every agent.
- **A passphrase gets `400` on `/inbox` and on claims** (it names nobody), and `403` on
  settings. A passphrase-using agent that "can't see its inbox" is not broken.
- **`ADMIN_KEY` is nobody**, so it cannot claim a card or call `/me/work` (400).
- **A green negative check proves nothing if the request never arrived** (September
  lesson, still the one to remember when you extend the suite).
- **The Plan rejects what it cannot interpret**: an unknown field, enum value or metric key
  is 422 naming the field. That is deliberate; do not loosen it to make a client work.
- **`README.md` is slightly behind:** it still describes the board passphrase as always
  present ("each client gets ... agents use the board passphrase") and `POST
  /admin/tenants` as always returning one. That is true of the code today, but not of what
  012 permits.
