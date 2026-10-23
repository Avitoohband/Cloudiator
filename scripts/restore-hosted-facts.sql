-- Task 24.10: what scripts/restore-hosted.ps1 checks before it loads a backup into a hosted project (checkHostedTarget in
-- scripts/restore-compare.mjs). READ-ONLY: one SELECT that prints one JSON object; counts and flags only.
select jsonb_build_object(
  'migrations', coalesce((select jsonb_agg(jsonb_build_object('version', version, 'name', name) order by version)
    from supabase_migrations.schema_migrations), '[]'::jsonb),
  'accounts', (select count(*) from auth.users),
  'characters', (select count(*) from public.gladiators),
  'epochSet', exists (select 1 from private.season_epoch),
  'schedulerEnabled', coalesce((select bool_or(enabled) from private.scheduler), false)
)::text;
