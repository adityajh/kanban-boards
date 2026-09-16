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

-- People who can sign in to a board. Scoped per tenant like cards and resources: a
-- username is unique within a board, not across the app.
create table if not exists users (
  id serial primary key,
  tenant_id int not null references tenants(id) on delete cascade,
  username text not null,
  display_name text not null,
  password_hash text not null,          -- scrypt$N$r$p$<salt_b64>$<hash_b64>
  is_admin boolean not null default false,
  must_change boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists users_tenant_username_uniq on users (tenant_id, lower(username));
create index if not exists users_tenant_idx on users (tenant_id);

-- Browser sessions. Only sha256(token) is stored; the token itself lives in the cookie.
create table if not exists sessions (
  token_hash text primary key,
  user_id int not null references users(id) on delete cascade,
  tenant_id int not null references tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_expires_idx on sessions (expires_at);
