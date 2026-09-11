-- 002 · Run after the multi-tenant code is live in production. From here on every insert
-- must name its tenant; a row can no longer silently land on Inditress.
alter table cards alter column tenant_id drop default;
alter table resources alter column tenant_id drop default;
