-- 015_agent_work_is_assignment.sql
-- What makes a card "agent work" is who it is assigned to, not who typed it.
--
-- `audience` has been doing two unrelated jobs under one name.
--
--   human_only  is a PRIVACY BOUNDARY, enforced in SQL. An agent asking for such a row gets
--               a 404 indistinguishable from "no such row". That text must never reach a
--               model, and that is a property of the row itself.
--   agent_only  was a VIEW FILTER, enforced nowhere. It only decided whether a card showed
--               on the team's board by default, and any admin could lift it.
--
-- Those are not the same kind of thing and should not share a column. This migration keeps
-- the first and removes the second; whether a card is agent work becomes a question the
-- board answers by looking at its assignee against its own list of agents.
--
-- Why assignment is the better question:
--
--   It self-corrects. A card an agent created and handed to Gargi is Gargi's work. Under
--   the old rule it stayed branded as agent work for ever, because creation is a fact that
--   never changes. Under this one it stops being agent work the moment it is reassigned.
--
--   It removes a decision agents got wrong. The old default asked an agent to choose an
--   audience at creation. On the counsellor board AdiClaude overrode it on 25 cards out of
--   25 — and did NOT override it on 25 Plan rows, so seven milestones, seven risks and a
--   decision sat marked agent_only for no reason anyone chose. A field that is always
--   overridden, or silently accepted wrongly, should not exist.
--
-- No card or document anywhere holds agent_only, so for them this is a vocabulary change
-- with no effect. The 25 Plan rows that do hold it are all visible to people already —
-- people are served every audience — so collapsing them changes nothing anyone can see.
--
-- `config.agentCardsDefault`, added three days ago to let a board flip the creation default,
-- goes with it: it existed only to control the field being removed.

begin;

update cards         set audience = 'both' where audience = 'agent_only';
update documents     set audience = 'both' where audience = 'agent_only';
update tracker_items set audience = 'both' where audience = 'agent_only';

alter table cards drop constraint if exists cards_audience_check;
alter table cards add constraint cards_audience_check
  check (audience in ('both', 'human_only'));

alter table documents drop constraint if exists documents_audience_check;
alter table documents add constraint documents_audience_check
  check (audience in ('both', 'human_only'));

alter table tracker_items drop constraint if exists tracker_items_audience_check;
alter table tracker_items add constraint tracker_items_audience_check
  check (audience in ('both', 'human_only'));

update tenants set config = config - 'agentCardsDefault'
 where config ? 'agentCardsDefault';

commit;
