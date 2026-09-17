# kanban-boards API

Base URL: `https://board-iota-nine.vercel.app/api`

The board UI and agents use the same REST API. CORS is open (`*`); bodies are JSON.

## Auth

There are two ways in, and both resolve to exactly one board.

**Bearer token — for agents and scripts.** Unchanged:

```
Authorization: Bearer <board passphrase>
```

The passphrase alone decides which board you're on; there is no board name in the path.
A wrong or missing token gets `401`. Rows that belong to another board get `404`.

**Session cookie — for people in a browser.** `POST /auth/login` sets an HttpOnly
`board_session` cookie that names **a person, not a board** — one sign-in covers every board
you belong to. Each request says which board it means via `X-Tenant: <slug>`, and the server
checks your membership of that board rather than taking the header's word for it. A board
you are not on is refused with `401`, exactly as a board that does not exist is. The cookie
is `SameSite=Lax` and CORS sends no `Allow-Credentials`, so it only works same-origin — a
script calling the API from elsewhere must use a bearer token.

A passphrase is a shared secret held by agents, so it is **not** a person: it gets `403`
on `/settings/*` and `/auth/password`. Conversely a session cannot reach `/admin/*`.

**Admin key:** `Authorization: Bearer <ADMIN_KEY>` plus `X-Tenant: <slug>` acts on that
board, including its settings and users — that is the way back in if nobody can sign in.
Without `X-Tenant` it only works on `/admin/*`.

## Data shape

```json
{
  "id": 1,
  "title": "Finalise the shade card",
  "description": "…",
  "status": "todo | in_progress | review | done",
  "assignee": "<one of the board's people> | Unassigned",
  "tag": "<one of the board's tags> | \"\"",
  "position": 173.5,
  "created_at": "…", "updated_at": "…",
  "subtasks": [{ "id": 1, "card_id": 1, "title": "…", "done": false, "position": 1 }],
  "links":    [{ "id": 1, "card_id": 1, "label": "…", "url": "https://…" }],
  "notes":    [{ "id": 1, "card_id": 1, "author": "Adi", "body": "…", "created_at": "…" }]
}
```

## Board endpoints

| Method | Path | Body | Does |
|--------|------|------|------|
| GET | `/tenant` | — | This board: `{slug, name, config}` (people, tags, brand) |
| GET | `/cards` | — | All cards with nested subtasks, links, notes |
| GET | `/cards/:id` | — | One card |
| POST | `/cards` | `{title, status?, assignee?, tag?, description?}` | Create a project |
| PATCH | `/cards/:id` | any of `{title, description, status, assignee, tag, position}` | Update (move column = change `status`) |
| DELETE | `/cards/:id` | — | Delete project + all children |
| POST | `/cards/:id/subtasks` | `{title}` | Add subtask |
| PATCH | `/subtasks/:id` | any of `{title, done, position}` | Update / check off / reorder |
| DELETE | `/subtasks/:id` | — | Delete subtask |
| POST | `/cards/:id/links` | `{url, label?}` | Add link |
| DELETE | `/links/:id` | — | Delete link |
| POST | `/cards/:id/notes` | `{body, author?}` | Add note. Signed-in people are attributed from their session and `author` is ignored; bearer-token callers set it themselves |
| DELETE | `/notes/:id` | — | Delete note |
| GET | `/resources` | — | Library: board-level reference links |
| POST | `/resources` | `{label, url, category?}` | Add a Library link |
| DELETE | `/resources/:id` | — | Remove a Library link |

## Auth endpoints

Cookie-based, same-origin. Not for agents.

| Method | Path | Body | Does |
|--------|------|------|------|
| POST | `/auth/login` | `{username, password}` | Sets the session cookie. Returns `{user, boards}`. No board is named: one account opens every board you are on. Every failure is the same `401` — it never says which part was wrong |
| POST | `/auth/logout` | — | Drops the session and clears the cookie |
| GET | `/auth/me` | — | `{user, boards}` for the current session, else `401`. `boards` is `[{slug, name, is_admin}]` — what the switcher shows, and the check that a URL is yours to open |
| POST | `/auth/password` | `{currentPassword, newPassword}` | Change your own password (min 10 chars). One password covers every board, so this changes it everywhere and signs out every other session you have |

`user` is `{id, username, displayName, mustChange}` — no `isAdmin`, because admin belongs to
a board, not to a person. `mustChange` is true until
someone replaces the password they were issued; the board UI holds them at a
change-password screen until they do.

## Settings endpoints

Board settings and people. A session cookie, or `ADMIN_KEY` + `X-Tenant`. Rows marked
**admin** need `isAdmin` on the signed-in user (or the admin key).

| Method | Path | Body | Does |
|--------|------|------|------|
| GET | `/settings` | — | `{tenant, me, isAdmin, users}`. Non-admins get an empty `users` |
| PATCH | `/settings` | `{name?, config?}` | **admin** — board name, brand, tagline, accent, people, tags, dots |
| GET | `/settings/users` | — | **admin** — everyone who can sign in to this board |
| POST | `/settings/users` | `{username, displayName?, isAdmin?}` | **admin** — add a person to this board. Returns `{user, password, existing}`. Someone who already has an account (they are on another board) joins with the password they already use and `password` is `null`; only a new person gets one issued, shown **only here**. Also adds the display name to the board's people list |
| PATCH | `/settings/users/:id` | `{displayName?, isAdmin?, resetPassword?}` | **admin** — `isAdmin` changes their role **on this board only**; `displayName` and `resetPassword` belong to the person, so they apply on every board they are on. A reset returns a new one-time `password` and signs them out everywhere |
| DELETE | `/settings/users/:id` | — | **admin** — take them off **this** board; other boards and their account are untouched. Removing their last board removes the account too (`{ok, accountRemoved}`), since an account on no boards can never be reached or removed again. Their name stays on work already assigned to them |

The last admin on a board cannot be demoted or removed (`409`), and you cannot remove
yourself. Usernames are 2–32 chars of `a-z 0-9 . _ -`, case-insensitive and **global** —
one username is one person across every board.

## Board-management endpoints

Creating, configuring and deleting boards. Two ways in: `ADMIN_KEY`, which belongs to
nobody and is the emergency route, or a signed-in **master admin** (`people.is_master`),
whose actions are attributable to an account.

Being a master admin grants **no access to any board's contents** — opening a board still
needs a membership, the same as for everyone else. `/tenants/:slug/join` is how a master
admin gives themselves one, which leaves a row recording it. A board admin is not a master
admin and gets `401` here.

| Method | Path | Body | Does |
|--------|------|------|------|
| GET | `/admin/overview` | — | Per-board column counts, Review queue, stalled cards (in progress, 14+ days untouched), recent notes |
| GET | `/admin/tenants` | — | List boards (never returns passphrases) |
| POST | `/admin/tenants` | `{slug, name, passphrase?, adminUsername?, config: {names, tags?, brand?, tagline?, accent?}}` | Create a board **and its first admin** (`adminUsername` defaults to the first person listed). Returns `{tenant, passphrase, admin:{username, displayName, password, existing}}`. If that admin already has an account they join with their existing password and `password` is `null` |
| PATCH | `/admin/tenants/:slug` | `{name?, config?, rotate?, passphrase?}` | Rename, change settings (merged), or rotate the passphrase |
| POST | `/admin/tenants/:slug/join` | — | Master admin only (not `ADMIN_KEY`, which is not a person) — join that board as an admin of it |
| DELETE | `/admin/tenants/:slug` | `{confirm: "<slug>"}` | **Irreversible.** Deletes the board and cascades every card, subtask, link, note and resource on it. The slug must be echoed back in `confirm` or it returns `400` — enforced server-side, so a bare DELETE cannot destroy a board. Returns `{deleted: {...counts}, accountsRemoved}` |

`names` and `tags` accept an array or a comma-separated string. `accent` is `#rrggbb`.

## curl examples

```bash
KEY="<board passphrase>"
BASE="https://board-iota-nine.vercel.app/api"

curl -s -H "Authorization: Bearer $KEY" "$BASE/cards"
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"title":"New project","status":"todo"}' "$BASE/cards"
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"status":"review"}' "$BASE/cards/3"
```

## Columns

`todo` → `in_progress` → `review` → `done`. "Review" is Adi's sign-off gate.
