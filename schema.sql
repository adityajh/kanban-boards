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
