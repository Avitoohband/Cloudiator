-- Task 24.10: the start of scripts/restore-hosted.ps1's load, in the same psql --single-transaction as the data and
-- scripts/restore-hosted-after.sql, so any failure leaves the project exactly as `db push` made it.
-- The hosted postgres role may not set session_replication_role (42501 on the bench, 2026-10-24), so the restore check's
-- replica mode is unavailable; instead the owner turns its own triggers off for the load. Foreign keys stay checked: pg_dump
-- orders a data-only dump's tables by their foreign keys, and the accounts load before the characters that reference them.

-- Still a new project: the same refusal as checkHostedTarget, now inside the transaction. With row security off, a row
-- hidden by a policy fails the check instead of passing it.
set local row_security = off;
do $$
begin
  if exists (select 1 from auth.users) or exists (select 1 from auth.identities) or exists (select 1 from public.gladiators)
    or exists (select 1 from private.season_epoch) or coalesce((select bool_or(enabled) from private.scheduler), false) then
    raise exception 'target-not-fresh' using errcode = 'P0001';
  end if;
end $$;

-- The game's triggers (guards, projections, the first schedule revision) would refuse or duplicate restored rows.
do $$
declare t record;
begin
  for t in select format('%I.%I', n.nspname, c.relname) as ident from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and not c.relispartition and n.nspname in ('public', 'private') order by 1 loop
    execute 'alter table ' || t.ident || ' disable trigger user';
  end loop;
end $$;

-- The rows the migrations seeded (the singletons and reference rows) make way for the backup's own.
do $$
begin
  execute (select 'truncate table ' || string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname)
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and not c.relispartition and n.nspname in ('public', 'private'));
end $$;
