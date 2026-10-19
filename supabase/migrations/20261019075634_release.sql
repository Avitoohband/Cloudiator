-- Created by Supabase CLI 2.120.0: migration new release, and completed from the tested supabase/sql/15-release.sql
-- (Task 23.1: release access hardening; the access matrix tests/db/access-matrix.test.ts and the operator audit
-- scripts/access-audit.sql).
-- Generation: db pull release --local --schema public,private --yes (migra) on the source-applied database reported "No
-- schema changes found" and wrote no draft. Its diff does not see this source's changes: MAINTAIN, the owner view's
-- privileges, and default privileges. Every statement below is therefore the source's, verbatim apart from the transaction
-- (the CLI runs each migration in one); the schema reload ends it. No function, trigger, policy, table, backfill or
-- initialization changes. See the source header for each finding and the accepted exceptions (service_role, platform).

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
