-- Schema fingerprint (Task 24.1, plan Decision 1). READ-ONLY: one SELECT over the catalog plus the seed rows' counts. It writes
-- nothing and prints no values beyond definitions: function, view, trigger and index definitions as md5 hashes, policy
-- expressions, constraint definitions, column types and defaults, ACLs, function settings and view options, the pg_cron
-- schedules (job name, schedule, command) and counts of the rows the migrations seed. It reads no secret, key, token, email,
-- Vault value or player data.
--
-- It is the fingerprint every migration replay since Task 13 compared (scratch copies until now; Task 23.8's copy printed 1,160
-- lines on a clean M01-M22 replay), committed for the first time as one statement so it also runs in the hosted SQL editor.
-- Each row is one `line`, `<section>|<field>|...`, exactly as the scratch psql copy printed it (`\pset format unaligned`,
-- `fieldsep '|'`: booleans t/f, NULL empty), in an order that does not depend on the database's collation.
--
-- Sections, in order: fn (definition hash, security definer, volatility, settings, ACL), rel (kind, ACL, row security, forced,
-- options, view definition hash), col (number, name, type, not null, default, column ACL), pol (permissive, roles, command,
-- USING, WITH CHECK), trg (definition hash), con (definition), idx (definition hash), nsp (schema ACL), defacl (every
-- default-privilege entry, the platform's included), cron, seed-rules, seed-revision, seed-singletons, trg-enabled,
-- seed-retention, seed-published-mirror, seed-retention-jobs, seed-owner-signals.
--
-- Run it locally after the container label check (docs/operations/runbook.md), from an LF working copy:
--   docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At < scripts/schema-fingerprint.sql
-- and on the hosted project in the SQL editor as the database owner (no row limit), downloaded as CSV (compare its `line`
-- column, for example with Import-Csv as in the runbook's access-audit comparison). Compare like with like:
-- - deparsed names (policy expressions, trigger and constraint definitions, regclass names) are qualified by the session's
--   search path, so `select current_schemas(false)` must give the same schemas in both places;
-- - a function body applied with CRLF line endings hashes differently (docs/operations/migrations.md, Task 23.8);
-- - the seed lines count rows, so compare right after `db push`, before activation and before any player;
-- - `defacl` lists the platform's own default-privilege entries too: a difference there is the platform's, as in the audit.
-- tests/db/hosted-checks.test.ts runs it inside a read-only transaction.
with f(part, k1, k2, k3, line) as (
  select 1, p.oid::regprocedure::text, null::bigint, null::text,
    array_to_string(array['fn', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)), left(p.prosecdef::text, 1), p.provolatile::text,
      coalesce(array_to_string(p.proconfig, ','), ''), coalesce(p.proacl::text, '')], '|', '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')
  union all
  select 2, n.nspname || '.' || c.relname, null, null,
    array_to_string(array['rel', n.nspname || '.' || c.relname, c.relkind::text, coalesce(c.relacl::text, ''), left(c.relrowsecurity::text, 1),
      left(c.relforcerowsecurity::text, 1), coalesce(array_to_string(c.reloptions, ','), ''),
      case when c.relkind in ('v', 'm') then md5(pg_get_viewdef(c.oid)) else '' end], '|', '')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p', 'f', 'S')
  union all
  select 3, n.nspname || '.' || c.relname, a.attnum::bigint, null,
    array_to_string(array['col', n.nspname || '.' || c.relname, a.attnum::text, a.attname::text, format_type(a.atttypid, a.atttypmod),
      left(a.attnotnull::text, 1), coalesce(pg_get_expr(d.adbin, d.adrelid), ''), coalesce(a.attacl::text, '')], '|', '')
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p', 'f') and a.attnum > 0 and not a.attisdropped
  union all
  select 4, schemaname || '.' || tablename, null, policyname::text,
    array_to_string(array['pol', schemaname || '.' || tablename, policyname::text, permissive, roles::text, cmd,
      regexp_replace(coalesce(qual, ''), '[[:space:]]+', ' ', 'g'), regexp_replace(coalesce(with_check, ''), '[[:space:]]+', ' ', 'g')], '|', '')
    from pg_policies where schemaname in ('public', 'private')
  union all
  select 5, t.tgrelid::regclass::text, null, t.tgname::text,
    array_to_string(array['trg', t.tgrelid::regclass::text, t.tgname::text, md5(pg_get_triggerdef(t.oid))], '|', '')
    from pg_trigger t where not t.tgisinternal
      and t.tgrelid in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private'))
  union all
  select 6, o.conrelid::regclass::text, null, o.conname::text,
    array_to_string(array['con', o.conrelid::regclass::text, o.conname::text, pg_get_constraintdef(o.oid)], '|', '')
    from pg_constraint o where o.connamespace in ('public'::regnamespace, 'private'::regnamespace)
  union all
  select 7, schemaname || '.' || tablename, null, indexname::text,
    array_to_string(array['idx', schemaname || '.' || tablename, indexname::text, md5(indexdef)], '|', '')
    from pg_indexes where schemaname in ('public', 'private')
  union all
  select 8, nspname::text, null, null, array_to_string(array['nsp', nspname::text, coalesce(nspacl::text, '')], '|', '')
    from pg_namespace where nspname in ('public', 'private')
  union all
  select 9, defaclrole::regrole::text, null, coalesce(defaclnamespace::regnamespace::text, '-') || '|' || defaclobjtype::text,
    array_to_string(array['defacl', defaclrole::regrole::text, coalesce(defaclnamespace::regnamespace::text, '-'), defaclobjtype::text,
      defaclacl::text], '|', '')
    from pg_default_acl
  union all
  select 10, jobname::text, null, null, array_to_string(array['cron', jobname::text, schedule, command], '|', '') from cron.job
  union all
  select 11, version, null, null, array_to_string(array['seed-rules', version, left(active::text, 1)], '|', '') from private.rules_versions
  union all
  select 12, null, null, null, array_to_string(array['seed-revision', count(*)::text], '|', '') from public.world_revision_state
  union all
  select 13, null, null, null, array_to_string(array['seed-singletons', (select count(*) from private.coordinator)::text,
    (select count(*) from private.scheduler)::text], '|', '')
  union all
  select 14, t.tgrelid::regclass::text, null, t.tgname::text,
    array_to_string(array['trg-enabled', t.tgrelid::regclass::text, t.tgname::text, t.tgenabled::text], '|', '')
    from pg_trigger t where not t.tgisinternal
      and t.tgrelid in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private'))
  union all
  select 15, null, null, null, array_to_string(array['seed-retention', count(*)::text, min(detail_through_slot)::text,
    min(summary_through_slot)::text, count(last_run_at_ms)::text, count(last_result)::text], '|', '') from private.retention_state
  union all
  select 16, null, null, null, array_to_string(array['seed-published-mirror',
    left(((select c.published_slot from private.coordinator c where c.singleton)
      is not distinct from (select r.published_slot_index from public.world_revision_state r where r.singleton))::text, 1)], '|', '')
  union all
  select 17, null, null, null, array_to_string(array['seed-retention-jobs', count(*)::text, min(jobs_compacted_through_slot)::text], '|', '')
    from private.retention_state
  union all
  select 18, null, null, null, array_to_string(array['seed-owner-signals', count(*)::text], '|', '') from private.owner_signals
)
select line from f order by part, k1 collate "C", k2, k3 collate "C", line collate "C";
