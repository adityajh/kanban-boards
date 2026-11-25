-- 014_agent_may_finish.sql
-- Which agents may mark work done.
--
-- NOT APPLIED, AND NOT YET WIRED UP. This file is the design, committed so the
-- reasoning is not lost; the column exists on no branch, and approvalRefusal in
-- lib/cards.mjs still enforces 011's admin-only rule. Applying this alone changes
-- nothing, because nothing reads the column yet. The remaining work is: add
-- may_finish to caller()'s agent lookup in lib/tenant.js so it reaches c.agent,
-- rewrite approvalRefusal to the four-way rule below, expose it on publicAgent,
-- accept it in the agents PATCH route, and give it a checkbox per agent row in
-- Settings. Until then the gate behaves exactly as it has since 011.
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
