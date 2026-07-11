-- The application's runtime database role — DEV/CI ONLY (container init).
--
-- Why this exists: POSTGRES_USER (`hotelos`) is a SUPERUSER, and superusers bypass
-- Row-Level Security unconditionally. `FORCE ROW LEVEL SECURITY` defeats the
-- owner-bypass but NOT the superuser-bypass. An app connecting as `hotelos` has
-- no tenancy isolation at all, however many policies we write.
--
-- So the runtime connection uses `hotelos_app`: NOSUPERUSER, NOBYPASSRLS, and not
-- the owner of any table. Policies actually bind to it.
--
-- Migrations still run as the owner (`hotelos`) — they must, to create and alter
-- tables and to define policies.
--
-- In production this role is provisioned by infrastructure with a real secret;
-- this file never runs there (it is a docker-entrypoint-initdb.d script, which
-- only executes when the data directory is first created).

CREATE ROLE hotelos_app WITH
  LOGIN
  PASSWORD 'hotelos_app'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  NOINHERIT;

COMMENT ON ROLE hotelos_app IS
  'Application runtime role. Must never be superuser or table owner, or RLS silently stops applying.';
