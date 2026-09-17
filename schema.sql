-- Full schema for a fresh database. An existing single-tenant database is upgraded
-- with migrations/ instead.
create table if not exists tenants (
  id serial primary key,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name text not null,
  key_hash text not null unique,          -- HMAC-SHA256(KEY_PEPPER, passphrase), hex
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists cards (
  id serial primary key,
  tenant_id int not null references tenants(id) on delete cascade,
  title text not null,
  description text default '',
  status text not null default 'todo',
  assignee text default 'Unassigned',
  tag text default '',
  position double precision not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists cards_tenant_idx on cards (tenant_id, status, position);
-- subtasks, links and notes belong to a tenant through their card.
create table if not exists subtasks (
  id serial primary key,
  card_id int references cards(id) on delete cascade,
  title text not null,
  done boolean default false,
  position double precision not null default 0,
  created_at timestamptz default now()
);
create table if not exists links (
  id serial primary key,
  card_id int references cards(id) on delete cascade,
  label text default '',
  url text not null,
  created_at timestamptz default now()
);
create table if not exists notes (
  id serial primary key,
  card_id int references cards(id) on delete cascade,
  author text default 'Anon',
  body text not null,
  created_at timestamptz default now()
);
create table if not exists resources (
  id serial primary key,
  tenant_id int not null references tenants(id) on delete cascade,
  label text not null,
  url text not null,
  category text default 'Brand & Reference',
  position double precision default 0,
  created_at timestamptz default now()
);
create index if not exists resources_tenant_idx on resources (tenant_id, position);

-- Who someone is, and their one password. Global, not per board.
create table if not exists people (
  id serial primary key,
  username text not null,
  display_name text not null,
  password_hash text not null,          -- scrypt$N$r$p$<salt_b64>$<hash_b64>
  must_change boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists people_username_uniq on people (lower(username));

-- Which boards they are on, and whether they run each one. Admin is per board.
create table if not exists memberships (
  id serial primary key,
  person_id int not null references people(id) on delete cascade,
  tenant_id int not null references tenants(id) on delete cascade,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists memberships_person_tenant_uniq on memberships (person_id, tenant_id);
create index if not exists memberships_tenant_idx on memberships (tenant_id);

-- Browser sessions. Only sha256(token) is stored; the token itself lives in the cookie.
-- A session names a person, not a board: it covers every board they belong to.
create table if not exists sessions (
  token_hash text primary key,
  person_id int not null references people(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index if not exists sessions_person_idx on sessions (person_id);
create index if not exists sessions_expires_idx on sessions (expires_at);
