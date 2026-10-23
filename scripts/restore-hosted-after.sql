-- Task 24.10: the end of scripts/restore-hosted.ps1's load (see scripts/restore-hosted-before.sql), in the same transaction.
-- pg_restore's data script empties search_path, so every name here is qualified.

-- The game's triggers back on; scripts/restore-invariants.sql then checks that none is left disabled (guardsIntact).
do $$
declare t record;
begin
  for t in select format('%I.%I', n.nspname, c.relname) as ident from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and not c.relispartition and n.nspname in ('public', 'private') order by 1 loop
    execute 'alter table ' || t.ident || ' enable trigger user';
  end loop;
end $$;

-- The restored scheduler row carries the source's setting. It stays off until both Vault secrets exist (a backup never
-- carries them; docs/operations/runbook.md, "Hosted restore").
update private.scheduler set enabled = false where singleton;
