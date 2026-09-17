-- 005_master_admin.sql
-- A master admin is a person who can create, configure and delete boards.
--
-- Until now "master admin" meant whoever holds ADMIN_KEY — a shared secret, not a person,
-- so nothing it did could be attributed to anybody. This makes it a property of an account.
--
-- It deliberately does NOT grant access to boards. A master admin sees every board and can
-- join any of them, but opening one still needs a membership row, exactly as it does for
-- everyone else. That keeps one rule — access means membership — instead of two, and leaves
-- a record of who had sight of a client's board and from when.
--
-- ADMIN_KEY is unchanged and still works, as the way back in when no account can sign in.

begin;

alter table people add column if not exists is_master boolean not null default false;

-- Bootstrap: Adi created every board here, and is the only person on more than one.
-- Further master admins are granted through the UI by an existing one.
update people set is_master = true where lower(username) = 'adi';

commit;
