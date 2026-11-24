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
  -- Who the card is for. human_only is enforced against agent tokens in every query;
  -- agent_only is a view filter the board UI applies and any admin can lift.
  audience text not null default 'both'
    check (audience in ('both', 'human_only', 'agent_only')),
  due_at timestamptz,
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

-- One identity per agent, scoped to a board. Token stored as HMAC-SHA256(KEY_PEPPER, token),
-- exactly like a board passphrase, so a leak of this table hands over no working credential.
create table if not exists agents (
  id serial primary key,
  tenant_id int not null references tenants(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  scope text not null default 'write',
  webhook_url text,
  disabled_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists agents_tenant_name on agents (tenant_id, lower(name));
create index if not exists agents_token on agents (token_hash);

-- Who did what, to which thing, when. actor_name is denormalised so the history still reads
-- after an agent or a person is removed. id is the cursor an agent reads forward from.
create table if not exists events (
  id bigserial primary key,
  tenant_id int not null references tenants(id) on delete cascade,
  actor_kind text not null,
  actor_id int,
  actor_name text not null,
  verb text not null,
  subject_type text not null,
  subject_id text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_tenant_id_idx on events (tenant_id, id);

-- Text agents author and re-read, addressed by a key they can construct: 'icp/zeal'.
create table if not exists documents (
  id serial primary key,
  tenant_id int not null references tenants(id) on delete cascade,
  key text not null,
  title text not null default '',
  body text not null default '',
  audience text not null default 'both'
    check (audience in ('both', 'human_only', 'agent_only')),
  version int not null default 1,
  updated_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists documents_tenant_key on documents (tenant_id, lower(key));

-- The Plan: the board's second surface. Cards are work in motion; these rows are what is
-- true — statuses, decisions, milestones, risks, period numbers and a log. One table with
-- a kind, because the six differ only in which fields they carry and all want the same
-- key, version, audience, attribution and event behind them.
create table if not exists tracker_items (
  id serial primary key,
  tenant_id int not null references tenants(id) on delete cascade,
  kind text not null check (kind in
    ('status', 'decision', 'milestone', 'risk', 'actual', 'log')),
  item_id text not null,
  data jsonb not null default '{}'::jsonb,
  audience text not null default 'both'
    check (audience in ('both', 'human_only', 'agent_only')),
  version int not null default 1,
  updated_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists tracker_items_key
  on tracker_items (tenant_id, kind, lower(item_id));
create index if not exists tracker_items_kind_idx
  on tracker_items (tenant_id, kind, created_at desc);
