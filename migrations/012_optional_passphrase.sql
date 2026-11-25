-- 012_optional_passphrase.sql
-- Let a board exist without a passphrase.
--
-- A board passphrase is a single shared secret that grants full read and write to a board
-- and names nobody: every agent holding it writes as "board passphrase", any one of them
-- can sign as any other, and a leak cannot be traced to a holder or revoked from one. It
-- was the only credential this app had, so every board got one.
--
-- Both of its jobs now have better answers. People sign in and are named by their
-- membership (004); agents hold per-agent tokens that attribute every write and can be
-- scoped, rate-limited, rotated and disabled one at a time (006, 011). A passphrase is what
-- is left over, and on a board created today it is pure liability — not least because any
-- pre-2026-09-16 deployment still serves the old pre-auth UI to anyone holding one.
--
-- So key_hash becomes nullable, meaning "this board has no passphrase: sign in, or use an
-- agent token". Nothing else changes. caller() looks a board up by `key_hash = <hash>`, and
-- in SQL null is never equal to anything, so a passphrase-less board simply cannot be
-- opened that way. Existing boards keep theirs until they are retired one at a time.

begin;

alter table tenants alter column key_hash drop not null;

comment on column tenants.key_hash is
  'HMAC-SHA256(KEY_PEPPER, passphrase), or NULL when the board has no passphrase and is '
  'reached only by a signed-in person or a per-agent token. Never equal to anything when '
  'NULL, so a null here cannot be matched by any bearer token.';

commit;
