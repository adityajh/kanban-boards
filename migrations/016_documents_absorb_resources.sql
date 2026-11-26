-- 016_documents_absorb_resources.sql
-- One list of reference, whether the text is here or somewhere else.
--
-- A board had two places to keep reference. `resources` held a label and a URL: a link
-- library, rendered on the board as "shared docs". `documents` held text addressed by a key
-- an agent can construct, with versions, an audience, an append verb and attribution.
--
-- The second is the first plus everything. The only thing `resources` could do that
-- `documents` could not was point somewhere else, which is one nullable column. So that
-- column is added and the link library is folded in: a document is text kept here, OR a
-- pointer to something kept elsewhere, and there is one list to look in.
--
-- Keys for the migrated rows are derived from the label, prefixed `link/` so it is obvious
-- at a glance which documents are pointers. The label becomes the title, the URL the url,
-- and the body stays empty — a link has no text of its own, and inventing a summary for it
-- would be putting words in somebody's mouth.
--
-- `resources` is emptied but NOT dropped. Nothing reads it after this, and it is the
-- rollback point if the fold-in turns out wrong, exactly as `users` was for 004.

begin;

alter table documents add column if not exists url text;

-- A document is either text or a pointer. Both at once is not refused — a link with notes
-- about it is reasonable — but a document with neither is nothing at all.
-- Deliberately not enforced as a constraint: an empty document being written to over
-- several calls is a normal way for an agent to work, and failing its first write would be
-- surprising.

insert into documents (tenant_id, key, title, body, url, audience, updated_by, created_at)
select r.tenant_id,
       'link/' || left(regexp_replace(
           regexp_replace(lower(r.label), '[^a-z0-9]+', '-', 'g'),
           '(^-+|-+$)', '', 'g'), 80) || '-' || r.id,
       r.label,
       '',
       r.url,
       'both',
       'migrated from the board''s link library',
       r.created_at
  from resources r
 where not exists (
   select 1 from documents d
    where d.tenant_id = r.tenant_id and d.url = r.url);

delete from resources;

commit;
