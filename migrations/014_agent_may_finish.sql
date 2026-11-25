-- 014_agent_may_finish.sql
-- Which agents may mark work done.
--
-- Applied to dev and production on 2026-11-25, and wired up in the same commit:
-- caller() carries may_finish onto c.agent, approvalRefusal enforces the rule below,
-- publicAgent exposes it, the agents PATCH route sets it, and each agent row in Settings
-- has a checkbox for it.
--
-- 011 made the approval gate admin-only: with it on, a board admin could reach `done` and
-- nobody else could. That was the right first cut and the wrong shape. Two things were
-- wrong with it.
--
-- It conflated two different questions. "Is this a person?" and "does this person run the
-- board?" are not the same, and finishing a piece of work is the first, not the second.
-- Gargi closing her own follow-up is not an administrative act and should not need one.
--
-- And it made "no agent may ever finish anything" a property of the software rather than a
-- choice per board. Some agents genuinely should: one whose whole job is to keep a plan
-- true, on a board where a person reviews the result anyway. Others never should. That is
-- a judgement about a particular agent on a particular board, which is exactly what a
-- column on `agents` is.
--
-- So with the gate on, the rule becomes:
--   any signed-in person            may finish   (and ADMIN_KEY, which is the break-glass)
--   an agent with may_finish        may finish
--   any other agent                 may not
--   a board passphrase              may not      — it is a shared secret naming nobody, and
--                                                  an approval nobody can be asked about
--                                                  later is not an approval
--
-- Default false, so every agent that exists today keeps exactly the behaviour 011 gave it
-- and granting the right stays a deliberate act.

begin;

alter table agents add column if not exists may_finish boolean not null default false;

commit;
