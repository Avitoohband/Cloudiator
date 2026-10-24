-- Task 24.10: what scripts/restore-hosted.ps1 checks before it loads a backup into a hosted project (checkHostedTarget in
-- scripts/restore-compare.mjs), and reads again after the load (hosted-compare). READ-ONLY: one SELECT that prints one JSON
-- object; counts and flags only. With row security off, a row hidden by a policy makes the query fail instead of reading
-- as a new project.
set row_security = off;
select jsonb_build_object(
  'migrations', coalesce((select jsonb_agg(jsonb_build_object('version', version, 'name', name) order by version)
    from supabase_migrations.schema_migrations), '[]'::jsonb),
  'accounts', (select count(*) from auth.users),
  'identities', (select count(*) from auth.identities),
  'characters', (select count(*) from public.gladiators),
  'epochSet', exists (select 1 from private.season_epoch),
  'schedulerEnabled', coalesce((select bool_or(enabled) from private.scheduler), false)
)::text;
