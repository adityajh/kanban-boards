-- 006_agents_events_docs.sql
-- Slice 1 of running several AI agents and the team on one board.
--
-- Four things, and they only make sense together:
--
--   agents     — an identity per agent, so a write can be attributed to one. Until now every
--                agent shared the board passphrase and typed its own name into notes.author,
--                which means any agent could sign as any other and nothing could tell them
--                apart. Everything else here depends on knowing who acted.
--   events     — one append-only row per change, carrying who did it. This is the audit
--                trail, the feed an agent reads instead of re-fetching the board, and the
--                source a webhook would fire from later.
--   documents  — board-scoped text addressed by a stable key, for what agents write and
--                re-read (a brief, an ICP, a decision register). Cards are work; documents
--                are reference.
--   audience   — on cards and on documents: who each item is for.
--
-- `audience` is enforced in two different ways on purpose. `human_only` is enforced in the
-- query: an agent token never sees those rows, so the text cannot reach a model. `agent_only`
-- is NOT enforced against people — it is a view filter the board UI applies by default and
-- any admin can lift. Agent work that no human could see would defeat the point of the
-- events table it is written beside.

begin;

-- One identity per agent, scoped to a board. The token is stored the way a board passphrase
-- is: HMAC-SHA256(KEY_PEPPER, token). Only the hash is kept, so a database leak hands over
-- no working credential — and, as with passphrases, rotating KEY_PEPPER invalidates every
-- agent token with no way back but reissuing them.
create table if not exists agents (
  id serial primary key,
  tenant_id int not null references tenants(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  scope text not null default 'write',          -- 'read' | 'write'
  webhook_url text,                             -- unused in slice 1; the wake comes later
  disabled_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists agents_tenant_name on agents (tenant_id, lower(name));
create index if not exists agents_token on agents (token_hash);

-- Who did what, to which thing, when. actor_name is denormalised deliberately: the log has
-- to still read correctly after an agent is deleted, and a foreign key would either block
-- that delete or blank the history.
create table if not exists events (
  id bigserial primary key,
  tenant_id int not null references tenants(id) on delete cascade,
  actor_kind text not null,                     -- 'person' | 'agent' | 'admin' | 'passphrase'
  actor_id int,                                 -- people.id or agents.id; null for the others
  actor_name text not null,
  verb text not null,                           -- 'card.created', 'note.added', 'doc.appended'
  subject_type text not null,                   -- 'card' | 'note' | 'doc'
  subject_id text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
-- The cursor an agent reads from is this index: id is monotonic per insert, which a
-- timestamp is not — two writes in the same millisecond would make a time-based cursor
-- skip one of them silently.
create index if not exists events_tenant_id_idx on events (tenant_id, id);

-- Text agents author and re-read, addressed by a key they can construct rather than look up:
-- 'icp/zeal', 'prospect/acme-corp', 'decisions/2026-q4'.
create table if not exists documents (
  id serial primary key,
  tenant_id int not null references tenants(id) on delete cascade,
  key text not null,
  title text not null default '',
  body text not null default '',
  audience text not null default 'both',
  version int not null default 1,
  updated_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists documents_tenant_key on documents (tenant_id, lower(key));

alter table cards add column if not exists audience text not null default 'both';
alter table cards add column if not exists due_at timestamptz;

-- Both columns are text with a check rather than an enum, so adding a value later is an
-- ALTER of the constraint and not a type migration.
alter table cards drop constraint if exists cards_audience_check;
alter table cards add constraint cards_audience_check
  check (audience in ('both', 'human_only', 'agent_only'));
alter table documents drop constraint if exists documents_audience_check;
alter table documents add constraint documents_audience_check
  check (audience in ('both', 'human_only', 'agent_only'));

commit;
