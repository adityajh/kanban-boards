-- 011_agent_rate_limit.sql
-- A ceiling on how fast one agent can change a board.
--
-- Everything up to here assumed an agent that behaves. A loop that reassigns the same card
-- a thousand times is not malice, it is an ordinary bug in a retry, and on a shared board
-- the cost lands on everybody: the events table grows without bound, every other agent's
-- webhook fires a thousand times, and the Postgres compute bill is real. The agent that
-- caused it is usually the last to notice, because from inside the loop each call succeeds.
--
-- Writes only. Reads are deliberately not counted: `GET /events?since=` exists so an agent
-- does not have to poll the board, and throttling the cheap call would push agents back
-- towards the expensive one. A read storm costs a little; a write storm costs everyone.
--
-- The window is a fixed minute per agent rather than a sliding log, which would need a row
-- per request. Two counters on the agent row and one UPDATE per write is the whole cost,
-- and a fixed window can let through at most twice the limit across a window boundary —
-- acceptable for a guard whose job is stopping runaway loops, not metering a billed API.

begin;

-- Writes per minute. 120 is roughly two a second sustained: far above anything an agent
-- doing real work needs, and far below what a loop produces. Per agent, so a board can
-- raise it for one that genuinely bulk-loads and leave the rest alone.
alter table agents add column if not exists rate_limit int not null default 120;

alter table agents drop constraint if exists agents_rate_limit_check;
alter table agents add constraint agents_rate_limit_check
  check (rate_limit between 1 and 10000);

-- The current window and what has been spent in it. Both are reset by the same statement
-- that increments, so there is no sweeper job and no window that outlives its agent.
alter table agents add column if not exists rl_window_start timestamptz;
alter table agents add column if not exists rl_count int not null default 0;

commit;
