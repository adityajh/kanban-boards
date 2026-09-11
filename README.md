# Inditress Board — source

Next.js + Neon Postgres kanban board. Deployed on Vercel at https://board-iota-nine.vercel.app

- `app/` — UI (`page.js`) + API route handlers (`app/api/**`)
- `lib/db.js` — Neon client · `lib/http.js` — auth + CORS helpers
- `schema.sql` — table definitions · `seed.mjs` — initial card seeding
- See `../inditress-board-API.md` for the full API reference.

Env vars (set in Vercel): `DATABASE_URL`, `BOARD_KEY`.
Redeploy: `vercel deploy --prod` from this folder.
