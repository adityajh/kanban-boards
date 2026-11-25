-- 013_webhook_auth.sql
-- How a wake proves it came from the board.
--
-- Until now there was one answer: HMAC-SHA256 over the body, under X-Board-Signature and
-- (since this slice) X-Hub-Signature-256 as well. That is the right default and stays the
-- default: it proves the sender holds the secret without ever putting the secret on the
-- wire, so a leaked request reveals nothing reusable.
--
-- Some receivers cannot do it. An agent living on somebody else's automation platform gets
-- the endpoint that platform gives it, and a common one authenticates with a plain API key
-- in an Authorization header and ignores signature headers entirely. The choice there is
-- Bearer or no wake at all, and no wake is the worse outcome — the agent falls back to
-- polling, which is what the whole webhook exists to avoid.
--
-- Bearer is weaker and it is worth being precise about how: the key travels on every
-- delivery instead of a proof of it, so anyone who can read one request has it, where with
-- an HMAC they would have only that request's digest. Over TLS to the key's own issuer that
-- is ordinary practice. It is still a per-agent, deliberate choice rather than a default,
-- because the difference should be visible to whoever makes it.
--
-- In bearer mode the signature headers are NOT sent. The stored value is then an API key,
-- not a signing secret, and signing with it would imply a guarantee that is not being made.

begin;

alter table agents add column if not exists webhook_auth text not null default 'signature';

alter table agents drop constraint if exists agents_webhook_auth_check;
alter table agents add constraint agents_webhook_auth_check
  check (webhook_auth in ('signature', 'bearer'));

commit;
