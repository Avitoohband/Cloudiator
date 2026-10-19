-- Release access audit (Task 23.1, M17). One read-only SELECT over the catalog; it changes nothing.
--
-- Local:  tests/db/access-matrix.test.ts runs this file and checks every row against the access matrix.
-- Hosted: Task 24 runs it as the database owner (docs/operations/runbook.md, "Release access audit") and compares every row
--         with the same file's output on a clean local replay of the same commit. Any difference is investigated.
--
-- Scope: the `public` and `private` schemas, minus objects owned by an extension (pg_depend deptype 'e'). Every row is
-- (section, object, grantee, privilege, detail); detail is empty except on policy rows. The grantees are PUBLIC and the three
-- Data API roles: anon (visitors),
-- authenticated (signed-in players) and service_role (the backend).
--   PUBLIC rows come from the ACLs themselves (aclexplode, with the built-in default when an ACL is null).
--   anon, authenticated and service_role rows are their *effective* privileges (has_*_privilege), so a PUBLIC grant or a
--   role membership shows up under them too.
--
-- Listing sections (every privilege held):
--   relation    tables, views, materialized, partitioned and foreign tables: SELECT INSERT UPDATE DELETE TRUNCATE
--               REFERENCES TRIGGER MAINTAIN (MAINTAIN needs PostgreSQL 17)
--   column      a column privilege the grantee does not also hold on the whole relation: SELECT INSERT UPDATE REFERENCES
--   sequence    USAGE SELECT UPDATE
--   function    EXECUTE, on every function, procedure and aggregate
--   schema      USAGE CREATE on public and private
--   default     the default privileges new objects receive, for each role that owns an object in public or private, per
--               schema (object `<owner>:<schema>:<kind>`, `*` = all schemas). It is the global entry (or the built-in default
--               when there is none) plus the schema's entry, as PostgreSQL combines them. Types are left out: PostgreSQL
--               gives PUBLIC USAGE on every new type, and that grants no access to data.
--   membership  a role the grantee is a member of (privilege MEMBER)
--   policy      every row-security policy: one row per role it applies to, privilege = its command (SELECT INSERT UPDATE
--               DELETE ALL), object `<schema>.<table>.<policy>`, detail = `permissive` or `restrictive` and `md5:` of its
--               USING and WITH CHECK expressions (pg_get_expr, so a changed policy body changes the row; the deparsed text
--               qualifies names by the session's search_path, so compare runs made with the same search_path)
-- Platform sections (outside the matrix: the platform's settings, accepted exceptions recorded for comparison):
--   platform-default  every other default-privilege entry that grants PUBLIC or a Data API role something: other roles'
--                     entries (supabase_admin), and the owner's entries for other schemas (object `<role>:<schema>:<kind>`,
--                     raw entries, not combined)
--   database          the grantee's privileges on the current database: CONNECT TEMPORARY CREATE
-- Finding sections (listed only when present; grantee is empty):
--   rls-disabled          a table without row security
--   not-security-invoker  a view without security_invoker=true
--   materialized-view     any materialized view (row security cannot apply to it)
--   security-definer      a SECURITY DEFINER function
--   search-path           a function whose configuration is not exactly search_path="" (privilege = what it has)
with
  nsp as (select oid, nspname, nspacl, nspowner from pg_namespace where nspname in ('public', 'private')),
  api(grantee) as (values ('anon'), ('authenticated'), ('service_role')),
  rel as (
    select c.oid, n.nspname || '.' || c.relname as object, c.relkind, c.relacl, c.relowner, c.relrowsecurity, c.reloptions
    from pg_class c join nsp n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')),
  fn as (
    select p.oid, n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as object, p.prosecdef, p.proconfig,
      p.proacl, p.proowner
    from pg_proc p join nsp n on n.oid = p.pronamespace
    where not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')),
  owners as (select relowner as owner from rel union select proowner from fn),
  default_kinds(objtype, builtin, kind) as (values ('r'::"char", 'r'::"char", 'tables'), ('S', 's', 'sequences'),
    ('f', 'f', 'functions'), ('n', 'n', 'schemas')),
  default_scopes as (
    select o.owner, k.objtype, k.builtin, k.kind, s.oid as nspoid, coalesce(s.nspname, '*') as scope
    from owners o cross join default_kinds k
    left join nsp s on k.objtype <> 'n'),
  default_acls as (
    select d.owner, d.kind, d.scope,
      coalesce((select a.defaclacl from pg_default_acl a
                where a.defaclrole = d.owner and a.defaclnamespace = 0 and a.defaclobjtype = d.objtype),
               acldefault(d.builtin, d.owner))
      || coalesce((select a.defaclacl from pg_default_acl a
                   where a.defaclrole = d.owner and a.defaclnamespace = d.nspoid and a.defaclobjtype = d.objtype),
                  '{}'::aclitem[]) as acl
    from default_scopes d),
  rel_priv(privilege) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'),
    ('MAINTAIN')),
  col_priv(privilege) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')),
  seq_priv(privilege) as (values ('USAGE'), ('SELECT'), ('UPDATE')),
  audit(section, object, grantee, privilege) as (
    -- relation
    select 'relation', r.object, a.grantee, p.privilege from rel r cross join api a cross join rel_priv p
      where r.relkind <> 'S' and has_table_privilege(a.grantee, r.oid, p.privilege)
    union all
    select 'relation', r.object, 'PUBLIC', x.privilege_type from rel r cross join aclexplode(coalesce(r.relacl, acldefault('r', r.relowner))) x
      where r.relkind <> 'S' and x.grantee = 0
    -- column
    union all
    select 'column', r.object || '.' || t.attname, a.grantee, p.privilege
      from rel r join pg_attribute t on t.attrelid = r.oid and t.attnum > 0 and not t.attisdropped
      cross join api a cross join col_priv p
      where r.relkind <> 'S' and has_column_privilege(a.grantee, r.oid, t.attnum, p.privilege)
        and not has_table_privilege(a.grantee, r.oid, p.privilege)
    union all
    select 'column', r.object || '.' || t.attname, 'PUBLIC', x.privilege_type
      from rel r join pg_attribute t on t.attrelid = r.oid and t.attnum > 0 and not t.attisdropped
      cross join aclexplode(t.attacl) x where r.relkind <> 'S' and x.grantee = 0
    -- sequence
    union all
    select 'sequence', r.object, a.grantee, p.privilege from rel r cross join api a cross join seq_priv p
      where r.relkind = 'S' and has_sequence_privilege(a.grantee, r.oid, p.privilege)
    union all
    select 'sequence', r.object, 'PUBLIC', x.privilege_type from rel r cross join aclexplode(coalesce(r.relacl, acldefault('s', r.relowner))) x
      where r.relkind = 'S' and x.grantee = 0
    -- function
    union all
    select 'function', f.object, a.grantee, 'EXECUTE' from fn f cross join api a
      where has_function_privilege(a.grantee, f.oid, 'EXECUTE')
    union all
    select 'function', f.object, 'PUBLIC', x.privilege_type from fn f cross join aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) x
      where x.grantee = 0
    -- schema
    union all
    select 'schema', n.nspname, a.grantee, p.privilege from nsp n cross join api a cross join (values ('USAGE'), ('CREATE')) p(privilege)
      where has_schema_privilege(a.grantee, n.oid, p.privilege)
    union all
    select 'schema', n.nspname, 'PUBLIC', x.privilege_type from nsp n cross join aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) x
      where x.grantee = 0
    -- default
    union all
    select distinct 'default', pg_get_userbyid(d.owner) || ':' || d.scope || ':' || d.kind,
      case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end, x.privilege_type
      from default_acls d cross join aclexplode(d.acl) x
      where x.grantee = 0 or pg_get_userbyid(x.grantee) in (select grantee from api)
    -- platform-default
    union all
    select 'platform-default', pg_get_userbyid(a.defaclrole) || ':' || coalesce(n.nspname, '*') || ':' ||
        case a.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' when 'T' then 'types'
          when 'n' then 'schemas' else a.defaclobjtype::text end,
      case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end, x.privilege_type
      from pg_default_acl a left join pg_namespace n on n.oid = a.defaclnamespace cross join aclexplode(a.defaclacl) x
      where (x.grantee = 0 or pg_get_userbyid(x.grantee) in (select grantee from api))
        and not (a.defaclrole in (select owner from owners) and (a.defaclnamespace = 0 or n.nspname in ('public', 'private')))
    -- database
    union all
    select 'database', current_database(), a.grantee, p.privilege from api a
      cross join (values ('CONNECT'), ('TEMPORARY'), ('CREATE')) p(privilege)
      where has_database_privilege(a.grantee, current_database(), p.privilege)
    union all
    select 'database', d.datname, 'PUBLIC', x.privilege_type from pg_database d
      cross join aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) x where d.datname = current_database() and x.grantee = 0
    -- membership
    union all
    select 'membership', g.rolname, m.rolname, 'MEMBER' from pg_auth_members am
      join pg_roles g on g.oid = am.roleid join pg_roles m on m.oid = am.member
      where m.rolname in (select grantee from api)
    -- findings
    union all
    select 'rls-disabled', r.object, '', 'row security off' from rel r where r.relkind in ('r', 'p') and not r.relrowsecurity
    union all
    select 'not-security-invoker', r.object, '', coalesce(array_to_string(r.reloptions, ','), 'no options') from rel r
      where r.relkind = 'v' and coalesce((select lower(o.option_value) from pg_options_to_table(r.reloptions) o
        where o.option_name = 'security_invoker'), 'false') not in ('true', 'on', 'yes', '1')
    union all
    select 'materialized-view', r.object, '', 'no row security' from rel r where r.relkind = 'm'
    union all
    select 'security-definer', f.object, '', 'SECURITY DEFINER' from fn f where f.prosecdef
    union all
    select 'search-path', f.object, '', coalesce(array_to_string(f.proconfig, ','), 'unset') from fn f
      where f.proconfig is distinct from array['search_path=""']
  ),
  policy(section, object, grantee, privilege, detail) as (
    select 'policy', r.object || '.' || p.polname, case when x.member = 0 then 'PUBLIC' else pg_get_userbyid(x.member) end,
      case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end,
      case when p.polpermissive then 'permissive' else 'restrictive' end || ' md5:'
        || md5(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
      from pg_policy p join rel r on r.oid = p.polrelid cross join unnest(p.polroles) x(member)
  )
select distinct section, object, grantee, privilege, '' as detail from audit
union all
select section, object, grantee, privilege, detail from policy
order by section, object, grantee, privilege, detail;
