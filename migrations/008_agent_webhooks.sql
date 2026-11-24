-- 008_agent_webhooks.sql
-- Wake an agent instead of making it poll.
--
-- 006 added the event log and left `webhook_url` on agents unused. This fills it in: when
-- something happens on a board, every agent that asked to hear about it is posted to, and
-- can end its turn in between rather than re-fetching the board on a timer. The measured
-- difference over a day of waiting is roughly 152,000 tokens against a couple of hundred.
--
-- Delivery is best effort and deliberately so: one attempt, a short timeout, no queue and
-- no retries. The guarantee lives in `GET /events?since=<id>`, which an agent reads to
-- catch up on anything a webhook missed. Building a retry queue to make the fast path
-- reliable would be rebuilding the feed that already is.

begin;

-- Stored in the clear, unlike a token hash, because signing requires producing the HMAC
-- rather than checking one somebody presented. This is how every webhook signature works.
alter table agents add column if not exists webhook_secret text;

-- Which verbs this agent wants. NULL means all of them. Without it an agent watching for
-- one thing is woken by every note anyone writes, which is the fast way to make a wake
-- worth ignoring.
alter table agents add column if not exists webhook_verbs text[];

-- So a dead endpoint is visible in the Agents tab instead of silently swallowing wakes.
alter table agents add column if not exists last_delivery_at timestamptz;
alter table agents add column if not exists last_delivery_status text;

commit;
