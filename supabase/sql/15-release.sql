-- Task 23.1 reapplicable source. Committed M01-M16 are immutable; deploy only the generated migration M17
-- (supabase/migrations/*_release.sql).
-- Release access hardening (plan 2026-10-19-task-23-release-readiness, Task 23.1, and the controller's rulings on the access
-- matrix's findings). tests/db/access-matrix.test.ts derives every expectation from the catalog through the exported audit
-- scripts/access-audit.sql. On the M01-M16 replay it found these client privileges, all revoked here:
--   1. anon's MAINTAIN on the eight M01 owner tables (C1). M01's generated revokes covered REFERENCES, TRIGGER and TRUNCATE
--      only; PostgreSQL 17's MAINTAIN came with the platform's default table privileges.
--   2. M01's default `grant update on sequences` to anon and authenticated in schema public.
--   A. authenticated's MAINTAIN on the same eight tables.
--   B. authenticated's MAINTAIN, REFERENCES, TRIGGER and TRUNCATE on the owner_state view (recorded by M13, not changed then).
--   C. The default table privileges in schema public: anon and authenticated TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on
--      every new table, which every later source had to revoke by hand.
-- Afterwards a client role holds only SELECT (anon on the open projections; authenticated on those and on its owner-filtered
-- tables) and USAGE on schema public.
--
-- Every statement is idempotent and names each non-SELECT privilege kind, so on a project whose platform defaults started
-- fuller (Task 24 compares the hosted project with scripts/access-audit.sql) the same source still leaves only SELECT. The
-- function defaults hold no client grant on the replay; their revoke is included for the same reason.
--
-- Accepted exceptions (controller rulings; documented in docs/operations/migrations.md, M17):
--   D. service_role (the backend) keeps MAINTAIN on the eight tables, MAINTAIN, REFERENCES, TRIGGER and TRUNCATE on
--      owner_state, and the default UPDATE on new public sequences and TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on new public
--      tables. They are pinned in the access matrix's service_role snapshot, so any change fails a test.
--   E. Platform-owned and outside this migration's scope: supabase_admin's default privileges in schema public (anon,
--      authenticated and service_role receive everything on its new tables, sequences and functions; postgres is not a member
--      of supabase_admin and cannot alter them) and in the graphql, graphql_public, storage and supabase_functions schemas;
--      the platform's defaults for postgres in schema storage (the same grants); PUBLIC's USAGE on schema public; PUBLIC's
--      CONNECT and TEMP on the database. None of our objects is created by supabase_admin or in those schemas. The access
--      matrix checks the defaults of the role that owns our objects (postgres) in public and private.
begin;

-- 1 and B (anon): the owner tables and the owner view grant a visitor nothing at all.
revoke all on public.builds, public.gladiators, public.item_instances, public.operation_receipts, public.reservations,
  public.schedules, public.wallet_ledger, public.wallets, public.owner_state from anon;
-- A and B: a signed-in player keeps only SELECT (filtered by the owner_read policies, and by the invoker view).
revoke insert, update, delete, truncate, references, trigger, maintain on public.builds, public.gladiators, public.item_instances,
  public.operation_receipts, public.reservations, public.schedules, public.wallet_ledger, public.wallets, public.owner_state
  from authenticated;

-- 2 and C: objects postgres creates in schema public from now on give anon and authenticated nothing by default.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

notify pgrst, 'reload schema';
commit;
