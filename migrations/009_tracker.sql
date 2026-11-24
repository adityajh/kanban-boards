-- 009_tracker.sql
-- A per-board plan tracker: the counsellor funnel's goal, status, decisions, milestones,
-- risks, monthly actuals and log, in one place every agent and person can read and write.
--
-- One table, not six. The six kinds differ only in which fields they carry, and they all
-- want the same machinery around them: a key the writer chooses, a version for optimistic
-- concurrency, an audience, attribution from the credential and a row in the event log.
-- Six tables would be six copies of that, and every new kind another copy.
--
-- The rule the tracker exists under: it holds statuses and pointers, never tasks and never
-- contacts. Tasks stay as cards (a row may point at one with data->>'card_id'); counsellors
-- and counts stay in the outreach CRM. Where this disagrees with a source, the source wins.

begin;

create table if not exists tracker_items (
  id serial primary key,
  tenant_id int not null references tenants(id) on delete cascade,
  kind text not null check (kind in
    ('status', 'decision', 'milestone', 'risk', 'actual', 'log')),
  -- The key the writer chose: a slug for status/milestone/risk, 'D-07' for a decision,
  -- '2026-11' for an actual, and a generated id for a log entry. Addressable means an
  -- agent can write to a known row without a lookup first.
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
-- The log is read newest-first and nothing else is, so it gets the one ordered index.
create index if not exists tracker_items_kind_idx
  on tracker_items (tenant_id, kind, created_at desc);

commit;
