-- 004_people_memberships.sql
-- Split identity from membership: one person, one password, many boards.
--
-- Until now a person was a row per board (`users.tenant_id`), so somebody on four boards
-- had four independent accounts and four passwords. This introduces `people` (who you are,
-- and your password) and `memberships` (which boards you are on, and whether you run them).
--
-- The isolation property is unchanged: a request still acts on exactly one tenant, and
-- withTenant() now proves membership of that tenant instead of reading it off the
-- credential. A non-member gets the same 404 a wrong passphrase always did.
--
-- Apply to `dev` first, verify against a preview deployment, then `production`.

begin;

create table if not exists people (
  id            serial primary key,
  username      text        not null,
  display_name  text        not null,
  password_hash text        not null,
  must_change   boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- Usernames are global now, not per board. Case-insensitive: "adi" and "Adi" are one person.
create unique index if not exists people_username_uniq on people (lower(username));

create table if not exists memberships (
  id         serial primary key,
  person_id  integer     not null references people(id)  on delete cascade,
  tenant_id  integer     not null references tenants(id) on delete cascade,
  is_admin   boolean     not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists memberships_person_tenant_uniq on memberships (person_id, tenant_id);
create index if not exists memberships_tenant_idx on memberships (tenant_id);

-- Fold users into people, one row per username.
--
-- This assumes a username appearing on several boards is the same human. Verified true
-- before running: the only such username was 'adi', on four boards, all created by Adi
-- himself. That assumption gets unsafe once a client names a user on their own board, so
-- this migration is not repeatable against arbitrary future data — it is a one-off.
--
-- The most recently updated row wins, so the password someone last set is the one kept.
with ranked as (
  select u.*,
         row_number() over (partition by lower(u.username) order by u.updated_at desc) as rn,
         min(u.created_at)    over (partition by lower(u.username)) as first_created,
         max(u.last_login_at) over (partition by lower(u.username)) as last_login
    from users u
)
insert into people (username, display_name, password_hash, must_change, created_at, updated_at, last_login_at)
select username, display_name, password_hash, must_change, first_created, updated_at, last_login
  from ranked
 where rn = 1;

-- One membership per (person, board), carrying that board's admin flag.
insert into memberships (person_id, tenant_id, is_admin, created_at)
select p.id, u.tenant_id, bool_or(u.is_admin), min(u.created_at)
  from users u
  join people p on lower(p.username) = lower(u.username)
 group by p.id, u.tenant_id;

-- Sessions are keyed on the person now, not on a user row, and no longer carry a tenant:
-- one sign-in covers every board you belong to. Existing sessions cannot be migrated
-- meaningfully, so everyone signs in again once.
drop table if exists sessions;

create table sessions (
  token_hash text        primary key,
  person_id  integer     not null references people(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

create index sessions_person_idx  on sessions (person_id);
create index sessions_expires_idx on sessions (expires_at);

commit;

-- `users` is deliberately left in place and untouched: it is the rollback point for this
-- migration. Nothing reads it after 004. Drop it in a later migration once this has run
-- in production long enough to trust.
