-- 017_plan_sections_and_config_history.sql
-- Sections become addressable, and every config change keeps its predecessor.
--
-- Applied to dev and production on 2026-11-26, after being rehearsed twice on a throwaway
-- branch cloned from production: once to check the backfill against all 11 live sections,
-- and once more on top of itself to check it is idempotent (it is — re-running reassigns
-- nothing and seeds no second version).
--
-- Two changes, and they are one change: neither is much use without the other.
--
-- 1. SECTION IDS
--
-- A Plan section was an anonymous item in an array, rendered by its array index. That had
-- three consequences nobody chose:
--
--   * Any edit was a replace of the whole plan. Two people editing two different sections
--     meant the later write silently discarded the earlier one. There was no version to
--     check because there was nothing to attach a version to.
--   * Nothing could point at a section. Not a card, not an event, not a history row, not
--     an agent saying "the phases table is out of date".
--   * The only way to fix one sentence was to send the entire constitution back.
--
-- Ids are assigned once, from the title, and then never follow it: renaming "The math" to
-- "The arithmetic" keeps `the-math`, because the id is what everything else points at. The
-- backfill below reproduces exactly what lib/plan-sections.mjs computes in JavaScript —
-- verified against all 11 live sections before this was written — so a section created
-- through the API and a section backfilled here get the same shape of id.
--
-- 2. CONFIG HISTORY
--
-- This is the price of letting anything other than one careful person edit the plan, and
-- it is also the one thing here that cannot be added later: history you did not record is
-- gone. The table is append-only and holds the WHOLE board config, not just the plan —
-- `names`, `tags`, `brand` and the rest go stale and get mis-edited too, and a revert that
-- restores only part of a config is a revert that half works.
--
-- Seeded with version 1 for every board that has a config, so there is a floor to revert
-- to rather than a board whose history begins at its first edit after today.
--
-- What this migration deliberately does NOT do: decide who may edit a section. That is a
-- permission question answered in the route. The structural guard that outlives any such
-- decision — a metric key with actuals recorded against it cannot be renamed or dropped,
-- by anyone, because every number already filed would point at a definition that no longer
-- exists — lives in metricKeyRefusal and applies to master admins and agents alike.

begin;

-- ---------------------------------------------------------------- section ids

with secs as (
  select t.id as tenant_id, s.ord, s.sec
  from tenants t,
       lateral jsonb_array_elements(t.config->'plan'->'sections') with ordinality s(sec, ord)
  where t.config->'plan' is not null
    and jsonb_typeof(t.config->'plan'->'sections') = 'array'
), slugged as (
  -- lower, drop apostrophes, every other run of non-alphanumerics becomes one dash, trim
  -- dashes, cap at 40, and fall back to `section` for a title that leaves nothing behind.
  select tenant_id, ord, sec,
    coalesce(nullif(rtrim(left(trim(both '-' from regexp_replace(
      lower(translate(coalesce(sec->>'title', ''), '''’', '')),
      '[^a-z0-9]+', '-', 'g')), 40), '-'), ''), 'section') as base
  from secs
), numbered as (
  select tenant_id, ord, sec, base,
    row_number() over (partition by tenant_id, base order by ord) as n
  from slugged
), withids as (
  -- A second "Ground rules" on one board gets -2, not a random suffix: the id goes into
  -- documents and agent prompts, so it has to be something a person can read back.
  select tenant_id, ord,
    case when sec ? 'id' then sec
         else sec || jsonb_build_object('id',
           case when n = 1 then base else left(base, 36) || '-' || n end) end as sec
  from numbered
), rebuilt as (
  select tenant_id, jsonb_agg(sec order by ord) as sections
  from withids group by tenant_id
)
update tenants t
   set config = jsonb_set(t.config, '{plan,sections}', r.sections)
  from rebuilt r
 where r.tenant_id = t.id;

-- ---------------------------------------------------------------- config history

create table if not exists config_versions (
  id          bigserial primary key,
  tenant_id   int not null references tenants(id) on delete cascade,
  version     int not null,
  config      jsonb not null,
  -- Who, in the same words every other attribution on the board uses: a person's display
  -- name, an agent's name, ADMIN_KEY, or `board passphrase`.
  changed_by  text not null,
  -- A short line saying what moved, written by the route that made the change — `section
  -- the-math updated`, `section phases added`, `settings updated`. The diff is recoverable
  -- from the two configs; this is so a list of versions reads as a list rather than as
  -- fourteen identical rows.
  change      text,
  changed_at  timestamptz not null default now(),
  unique (tenant_id, version)
);

-- Every read is "the latest few for this board", in that order.
create index if not exists config_versions_tenant_version_idx
  on config_versions (tenant_id, version desc);

-- Version 1 is wherever each board stands right now, attributed to the migration rather
-- than to a person: nobody made this change, it is the floor.
insert into config_versions (tenant_id, version, config, changed_by, change)
select t.id, 1, t.config, 'migration 017', 'where this board stood when history began'
  from tenants t
 where t.config is not null
   and not exists (select 1 from config_versions v where v.tenant_id = t.id);

commit;
