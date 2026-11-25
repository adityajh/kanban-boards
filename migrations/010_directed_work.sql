-- 010_directed_work.sql
-- Make work addressable, so an agent has a reason to wake and something to read.
--
-- Up to now a board could say what existed but not who it was waiting on. A card carried an
-- `assignee`, but assigning one emitted `card.updated` with nothing but a title, so no agent
-- could tell it had been handed work; a note carried an author but nobody it was addressed
-- to; and nothing stopped two agents picking up the same card and doing the same outreach
-- twice. Four columns fix all three, and none of them is a new table:
--
--   notes.addressed_to  — who a note is for. With `card.assigned` and the inbox query this
--                         is the whole of "messaging": no message store, no second data
--                         model to drift out of step with the cards.
--   cards.claimed_by    — who is working on this right now, with an expiring lease, so a
--   cards.claimed_at      crash or a dropped turn releases it instead of parking the card
--   cards.claim_expires_at  forever. An expired claim is treated as no claim at all.
--   cards.answered      — a plain boolean a PERSON ticks, meaning "a human has dealt with
--                         this". Deliberately outside the agent contract: an agent token is
--                         refused, because anything agents must maintain, they drift on.
--
-- Additive and back-compatible: every column is nullable or defaulted, and a client that
-- has never heard of them behaves exactly as it did. Apply to `dev`, verify against a
-- preview deployment, then `production`.

begin;

-- Nobody in particular, until somebody addresses it. Unindexed text rather than a foreign
-- key to people or agents for the same reason events.actor_name is: the note must still
-- read correctly after the person it was written to leaves the board.
alter table notes add column if not exists addressed_to text;

alter table cards add column if not exists claimed_by text;
alter table cards add column if not exists claimed_at timestamptz;
alter table cards add column if not exists claim_expires_at timestamptz;

-- A lease with no expiry is a lock, and a lock held by a crashed agent is a card nobody can
-- ever touch again. The API always sets both columns together; this check is the backstop
-- that stops a future route setting a holder with no way out.
alter table cards drop constraint if exists cards_claim_check;
alter table cards add constraint cards_claim_check
  check ((claimed_by is null) = (claim_expires_at is null));

alter table cards add column if not exists answered boolean not null default false;

-- The five columns the board renders. A status outside them renders nowhere and the card is
-- effectively lost, which until now was a silent failure on a typo. The API refuses one
-- with a 422 naming the five; this constraint is what makes that true of every future route
-- as well, including one written by somebody who has not read the API.
--
-- Verified safe before writing: production holds only these five values.
alter table cards drop constraint if exists cards_status_check;
alter table cards add constraint cards_status_check
  check (status in ('todo', 'in_progress', 'stuck', 'review', 'done'));

-- The inbox query is "cards assigned to me" and "notes written to me", both case-insensitive
-- because a name typed by a person and a name sent by an agent differ in case more often
-- than they differ in spelling.
create index if not exists cards_tenant_assignee_idx on cards (tenant_id, lower(assignee));
create index if not exists cards_tenant_claimed_idx  on cards (tenant_id, lower(claimed_by));
create index if not exists notes_addressed_idx        on notes (lower(addressed_to));

commit;
