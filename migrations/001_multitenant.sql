-- 001 · Single-tenant Inditress board -> multi-tenant. Existing rows become tenant 'inditress'.
-- Run once, as one transaction. Replace :inditress_key_hash with
-- HMAC-SHA256(KEY_PEPPER, <current Inditress passphrase>) in hex, so the passphrase keeps working.
-- Applied: dev branch 2026-09-11.
begin;

create table tenants (
  id serial primary key,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name text not null,
  key_hash text not null unique,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into tenants (slug, name, key_hash, config) values ('inditress', 'Inditress', :'inditress_key_hash',
  '{"brand":"INDITRESS","tagline":"The Honest Hair Company","names":["Adi","Aadhya","Deepak"],"tags":["A","B","Onboarding"],"accent":"#D67D2E","dots":5,"dotsTitle":"Origin · Cuticle · Processing · Performance · Supply"}'::jsonb);

-- The temporary DEFAULT 1 (= inditress) keeps the old single-tenant deployment able to
-- insert rows during the cut-over. 002 drops it once the multi-tenant code is live.
alter table cards add column tenant_id int references tenants(id) on delete cascade;
update cards set tenant_id = (select id from tenants where slug = 'inditress');
alter table cards alter column tenant_id set not null;
alter table cards alter column tenant_id set default 1;

alter table resources add column tenant_id int references tenants(id) on delete cascade;
update resources set tenant_id = (select id from tenants where slug = 'inditress');
alter table resources alter column tenant_id set not null;
alter table resources alter column tenant_id set default 1;

create index cards_tenant_idx on cards (tenant_id, status, position);
create index resources_tenant_idx on resources (tenant_id, position);

commit;
