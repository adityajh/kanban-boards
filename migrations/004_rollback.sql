-- 004_rollback.sql — undo 004 far enough that the pre-004 app runs again.
--
-- Only needed if the code is rolled back. 004 left `users` untouched precisely so this
-- works: every pre-004 account and password is still there.
--
-- The one thing 004 destroyed is the old `sessions` shape, so the old code's
-- `join users u on u.id = s.user_id` errors on every cookie request until this runs.
-- Bearer-token callers (agents) are unaffected either way.
--
-- Order matters: roll the app back FIRST, then run this. The other way round leaves the
-- new code with no sessions table it understands.

begin;

drop table if exists sessions;

create table sessions (
  token_hash text        primary key,
  user_id    integer     not null references users(id)   on delete cascade,
  tenant_id  integer     not null references tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

create index sessions_user_idx    on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

commit;

-- Everyone signs in again, with the password they had before 004.
--
-- What is lost: anything done through the new model after 004 ran — a password someone
-- changed, a person added, a membership granted — because those live in `people` and
-- `memberships`, which the old code cannot see. `people` and `memberships` are left in
-- place rather than dropped, so that work can be read back out by hand if the window was
-- long enough to matter:
--
--   select p.username, p.display_name, p.updated_at, t.slug, m.is_admin
--     from memberships m
--     join people p  on p.id = m.person_id
--     join tenants t on t.id = m.tenant_id
--    order by p.username, t.slug;
