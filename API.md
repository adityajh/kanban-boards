# kanban-boards API

Base URL: `https://board-iota-nine.vercel.app/api`

The board UI and agents use the same REST API. CORS is open (`*`); bodies are JSON.

## Auth

Every request sends the board's passphrase as a bearer token:

```
Authorization: Bearer <board passphrase>
```

The passphrase alone decides which board you're on; there is no board name in the path.
A wrong or missing token gets `401`. Rows that belong to another board get `404`.

**Admin key:** `Authorization: Bearer <ADMIN_KEY>` plus `X-Tenant: <slug>` acts on that board.
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
| POST | `/cards/:id/notes` | `{body, author?}` | Add note |
| DELETE | `/notes/:id` | — | Delete note |
| GET | `/resources` | — | Library: board-level reference links |
| POST | `/resources` | `{label, url, category?}` | Add a Library link |
| DELETE | `/resources/:id` | — | Remove a Library link |

## Admin endpoints (ADMIN_KEY only)

| Method | Path | Body | Does |
|--------|------|------|------|
| GET | `/admin/overview` | — | Per-board column counts, Review queue, stalled cards (in progress, 14+ days untouched), recent notes |
| GET | `/admin/tenants` | — | List boards (never returns passphrases) |
| POST | `/admin/tenants` | `{slug, name, passphrase?, config: {names, tags?, brand?, tagline?, accent?}}` | Create a board. Returns `{tenant, passphrase}`; the passphrase is shown only here |
| PATCH | `/admin/tenants/:slug` | `{name?, config?, rotate?, passphrase?}` | Rename, change settings (merged), or rotate the passphrase |

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
