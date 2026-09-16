-- 003_users_sessions.sql
-- Per-person login for kanban-boards. Additive: nothing existing is dropped or altered.
-- Written against the live schema read from Neon branch `dev` (br-summer-union-aq52oiiq)
-- on 2026-09-16. Apply to `dev` first, verify, then `production`.
--
-- Design notes:
--  * Users are scoped per tenant, exactly like cards/resources. A username is unique
--    within a board, not globally, so "Adi" can exist on both Inditress and JBJ as
--    two separate rows with two separate passwords.
--  * `password_hash` holds a self-describing scrypt string:
--        scrypt$<N>$<r>$<p>$<salt_b64>$<hash_b64>
--    Parameters live inside the value so they can be raised later without a migration.
--    This is independent of KEY_PEPPER: rotating the pepper must NOT invalidate
--    passwords (the handover's "changing KEY_PEPPER invalidates every board
--    passphrase" trap should not be made worse by tying user auth to it too).
--  * Sessions store only sha256(token). The raw opaque token exists solely in the
--    user's cookie, so a database leak does not hand over live sessions.

begin;

create table if not exists users (
  id            serial primary key,
  tenant_id     integer     not null references tenants(id) on delete cascade,
  username      text        not null,
  display_name  text        not null,
  password_hash text        not null,
  is_admin      boolean     not null default false,
  must_change   boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- Case-insensitive uniqueness within a board: "adi" and "Adi" are the same person.
create unique index if not exists users_tenant_username_uniq
  on users (tenant_id, lower(username));

create index if not exists users_tenant_idx on users (tenant_id);

create table if not exists sessions (
  token_hash text        primary key,
  user_id    integer     not null references users(id) on delete cascade,
  tenant_id  integer     not null references tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

create index if not exists sessions_user_idx    on sessions (user_id);
create index if not exists sessions_expires_idx on sessions (expires_at);

commit;

-- Housekeeping, safe to run on a schedule or opportunistically at login:
--   delete from sessions where expires_at < now();
