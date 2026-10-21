-- Hosted checks (Task 24.1, plan Decision 1) for Tasks 24.4, 24.7, 24.8 and 24.9. READ-ONLY: one SELECT; it writes nothing.
-- Each row is `section | item | value`, every value text. It prints no secret, key, token, connection string or email:
-- Vault secrets by name only (present or missing, never decrypted), accounts and characters as counts or as the first 12
-- hex digits of md5(account id), HTTP responses as status codes and counts (never a body, header or error text), failure
-- codes only (the sanitized codes the backend stores), and the migrations by version and name (never their statements).
-- Times are UTC; "last 24 h" is measured back from private.planning_now_ms() (the database clock).
--
-- Sections, in order:
--   parity            migrations (count, first, last, versions), the server version, the schemas the search path resolves to,
--                     pg_net.ttl, and object counts with a digest of every public/private function (name, body hash, ACL), to
--                     set beside the same file's output on the local M01-M22 replay (Task 24.4; scripts/schema-fingerprint.sql
--                     is the full comparison)
--   scheduler         the scheduler flag and dispatch budget, the season epoch, the current and next slot, the coordinator
--                     (published slot, last SQLSTATE, lease), open boundaries, both cron jobs, the two Vault secrets by name,
--                     and the lowest processed slot of any character (Tasks 24.5 and 24.7)
--   dispatch          worker dispatches per scheduled minute over the last 24 h: total, minutes, maximum, minutes over the
--                     budget, and the last 30 minutes that dispatched (Task 24.9, C4: at most 5 a minute)
--   job-attempts      per job kind over the last 24 h: attempts by outcome, p50/p95/max duration in ms, failure codes (24.9)
--   boundary-latency  publication latency (completed_at_ms - cutoff_ms) of the boundaries completed in the last 24 h:
--                     count, p50, p95, max, how many over 120 s, and the last 10 boundaries (Tasks 24.8 and 24.9)
--   http-responses    pg_net's retained responses (pg_net.ttl, 6 hours by default) by status code, timed out and failed (24.9)
--   duplicate-grants  every way a grant could be recorded twice, each a count that must be 0, and their total
--                     (`duplicateGrants`, Task 24.8)
--   characters        accounts, characters, accounts with more than one character, identities per provider, and the 20
--                     newest characters by hashed account (Task 24.8: one character per account)
--   trades            listings by status; for every sale whether the buyer paid the price and the seller received the price
--                     less the 5 % fee floored in exactly one credit (every credit is summed and counted, so a sale credited
--                     twice is reported here and in duplicate-grants, never an error), and whether the item has exactly
--                     one owner, the buyer; the 10 newest sales
--                     (Task 24.8). Cleanup folds ledger rows older than 90 days into wallet checkpoints, so an older sale
--                     reads `missing` there; an item its buyer later sold or discarded reads `other` or `gone`.
--
-- Run it in the hosted SQL editor as the database owner (no row limit) and download the result as CSV, or locally after the
-- container label check (docs/operations/runbook.md):
--   docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1 --csv < scripts/hosted-checks.sql
-- tests/db/hosted-checks.test.ts runs it inside a read-only transaction.
with
  clock as (select private.planning_now_ms() as now_ms),
  scheduler as (select s.enabled, s.max_dispatch_per_minute from private.scheduler s where s.singleton),
  minutes as (
    select d.dispatched_at_ms / 60000 as minute, count(*) as n from private.dispatch_log d, clock
    where d.dispatched_at_ms > clock.now_ms - 86400000 and d.dispatched_at_ms <= clock.now_ms group by 1),
  kinds(kind, o) as (values ('prepare', 1), ('simulation', 2), ('reveal', 3), ('settlement', 4)),
  attempts as (
    select j.kind, a.outcome, a.failure_code, a.finished_at_ms - a.claimed_at_ms as ms
    from private.job_attempts a join private.jobs j on j.id = a.job_id, clock
    where a.claimed_at_ms > clock.now_ms - 86400000),
  latency as (
    select b.slot_index, b.completed_at_ms - b.cutoff_ms as ms, b.member_count
    from private.boundaries b, clock
    where b.status = 'complete' and b.completed_at_ms > clock.now_ms - 86400000),
  sales as (
    select l.id, l.price, l.price * 5 / 100 as fee, l.seller_gladiator_id as seller, l.buyer_gladiator_id as buyer, l.item_id,
      (select w.money_delta from public.wallet_ledger w where w.receipt_id = l.terminal_receipt_id and w.reason = 'market-purchase'
        and w.gladiator_id = l.buyer_gladiator_id) as buyer_delta,
      -- Every seller credit of the sale, summed and counted: market-sale receipts are not unique per listing, so a sale
      -- credited twice (duplicate-grants check 6) must be reported here, not abort the kit (fix round 1).
      (select sum(w.money_delta) from public.operation_receipts r join public.wallet_ledger w on w.receipt_id = r.receipt_id
        where r.request ->> 'kind' = 'market-sale' and r.request ->> 'listingId' = l.id::text and w.reason = 'market-sale'
          and w.gladiator_id = l.seller_gladiator_id) as seller_delta,
      (select count(*) from public.operation_receipts r join public.wallet_ledger w on w.receipt_id = r.receipt_id
        where r.request ->> 'kind' = 'market-sale' and r.request ->> 'listingId' = l.id::text and w.reason = 'market-sale'
          and w.gladiator_id = l.seller_gladiator_id) as seller_credits,
      (select count(*) from public.item_instances i where i.id = l.item_id) as owners,
      (select i.gladiator_id from public.item_instances i where i.id = l.item_id) as owner,
      (select r.created_at from public.operation_receipts r where r.receipt_id = l.terminal_receipt_id) as sold_at
    from private.market_listings l where l.status = 'sold'),
  checks(section, o, item, value) as (
    -- parity
    select 'parity', 1, 'migrations count', count(*)::text from supabase_migrations.schema_migrations
    union all select 'parity', 2, 'migrations first', min(version) from supabase_migrations.schema_migrations
    union all select 'parity', 3, 'migrations last', max(version) from supabase_migrations.schema_migrations
    union all select 'parity', 4, 'migrations versions', string_agg(version || ' ' || coalesce(name, ''), ', ' order by version)
      from supabase_migrations.schema_migrations
    union all select 'parity', 5, 'server version', current_setting('server_version_num')
    union all select 'parity', 6, 'search path schemas', current_schemas(false)::text
    union all select 'parity', 7, 'pg_net.ttl', coalesce(current_setting('pg_net.ttl', true), 'absent')
    union all select 'parity', 8, 'functions', count(*)::text
      from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
    union all select 'parity', 9, 'functions digest', md5(coalesce(string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid))
        || ':' || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text collate "C"), ''))
      from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
    union all select 'parity', 10, 'relations', count(*)::text
      from pg_class c where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'v', 'm', 'p', 'f', 'S')
    union all select 'parity', 11, 'policies', count(*)::text from pg_policies where schemaname in ('public', 'private')
    union all select 'parity', 12, 'triggers', count(*)::text from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relnamespace in ('public'::regnamespace, 'private'::regnamespace)
    union all select 'parity', 13, 'triggers disabled', count(*)::text from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and t.tgenabled = 'D' and c.relnamespace in ('public'::regnamespace, 'private'::regnamespace)
    -- scheduler
    union all select 'scheduler', 1, 'scheduler enabled', coalesce((select enabled::text from scheduler), 'missing')
    union all select 'scheduler', 2, 'scheduler maxDispatchPerMinute', coalesce((select max_dispatch_per_minute::text from scheduler), 'missing')
    union all select 'scheduler', 3, 'season epoch slot', coalesce((select e.epoch_slot::text from private.season_epoch e where e.singleton), 'unset')
    union all select 'scheduler', 4, 'current slot', (clock.now_ms / 4800000)::text from clock
    union all select 'scheduler', 5, 'next slot', ((clock.now_ms / 4800000) + 1)::text || ' starts '
        || to_char(to_timestamp(((clock.now_ms / 4800000) + 1) * 4800) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from clock
    union all select 'scheduler', 6, 'coordinator publishedSlot', coalesce((select c.published_slot::text from private.coordinator c where c.singleton), 'null')
    union all select 'scheduler', 7, 'coordinator lastError', coalesce((select c.last_error from private.coordinator c where c.singleton), 'none')
    union all select 'scheduler', 8, 'coordinator lastFailedSlot', coalesce((select c.last_failed_slot::text from private.coordinator c where c.singleton), 'none')
    union all select 'scheduler', 9, 'coordinator leaseHeld', coalesce((select (c.lease_until_ms > clock.now_ms)::text from private.coordinator c where c.singleton), 'missing')
      from clock
    union all select 'scheduler', 10, 'boundaries open', count(*)::text from private.boundaries b where b.status <> 'complete'
    union all select 'scheduler', 11, 'boundary oldest open', coalesce((select 'slot ' || b.slot_index || ' phase ' || b.phase || ' ' || b.status
        || coalesce(' ' || b.wait_reason, '') from private.boundaries b where b.status <> 'complete' order by b.slot_index limit 1), 'none')
    union all select 'scheduler', 12, 'cron ' || j.jobname, j.schedule || ' active=' || j.active::text from cron.job j
    union all select 'scheduler', 13, 'vault ' || v.name, case when exists (select 1 from vault.secrets s where s.name = v.name) then 'present' else 'missing' end
      from (values ('game_worker_url'), ('game_worker_secret')) v(name)
    union all select 'scheduler', 14, 'characters minProcessedSlot', coalesce(min(g.processed_slot_index)::text, 'null') from public.gladiators g
    -- dispatch
    union all select 'dispatch', 1, 'last 24 h dispatches', coalesce(sum(n), 0)::text from minutes
    union all select 'dispatch', 2, 'last 24 h minutes with a dispatch', count(*)::text from minutes
    union all select 'dispatch', 3, 'last 24 h most in one minute', coalesce(max(n), 0)::text from minutes
    union all select 'dispatch', 4, 'last 24 h minutes over the budget', count(*)::text from minutes, scheduler where n > scheduler.max_dispatch_per_minute
    union all select 'dispatch', 5, 'last dispatch at', coalesce((select to_char(to_timestamp(max(d.dispatched_at_ms) / 1000.0) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') from private.dispatch_log d), 'never')
    union all select 'dispatch', 6, 'minute ' || to_char(to_timestamp(m.minute * 60) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'), m.n::text
      from (select * from minutes order by minute desc limit 30) m
    -- job-attempts
    union all select 'job-attempts', k.o * 10 + 1, k.kind || ' attempts', count(a.kind)::text from kinds k left join attempts a on a.kind = k.kind group by k.kind, k.o
    union all select 'job-attempts', k.o * 10 + 2, k.kind || ' outcomes', 'completed ' || count(*) filter (where a.outcome = 'completed')
        || ', failed ' || count(*) filter (where a.outcome = 'failed') || ', expired ' || count(*) filter (where a.outcome = 'expired')
        || ', unfinished ' || count(*) filter (where a.kind is not null and a.outcome is null)
      from kinds k left join attempts a on a.kind = k.kind group by k.kind, k.o
    union all select 'job-attempts', k.o * 10 + 3, k.kind || ' durationMs', coalesce('p50 ' || round(percentile_cont(0.5) within group (order by a.ms))
        || ', p95 ' || round(percentile_cont(0.95) within group (order by a.ms)) || ', max ' || max(a.ms), 'none')
      from kinds k left join attempts a on a.kind = k.kind and a.ms is not null group by k.kind, k.o
    union all select 'job-attempts', k.o * 10 + 4, k.kind || ' failure ' || a.failure_code, count(*)::text
      from kinds k join attempts a on a.kind = k.kind where a.failure_code is not null group by k.kind, k.o, a.failure_code
    -- boundary-latency
    union all select 'boundary-latency', 1, 'last 24 h boundaries', count(*)::text from latency
    union all select 'boundary-latency', 2, 'last 24 h latencyMs', coalesce('p50 ' || round(percentile_cont(0.5) within group (order by ms))
        || ', p95 ' || round(percentile_cont(0.95) within group (order by ms)) || ', max ' || max(ms), 'none') from latency
    union all select 'boundary-latency', 3, 'last 24 h over 120 s', count(*) filter (where ms > 120000)::text from latency
    union all select 'boundary-latency', 4, 'slot ' || l.slot_index, 'latencyMs ' || l.ms || ', members ' || coalesce(l.member_count::text, 'unknown')
      from (select * from latency order by slot_index desc limit 10) l
    -- http-responses
    union all select 'http-responses', 1, 'retained', count(*)::text from net._http_response
    union all select 'http-responses', 2, 'oldest', coalesce(to_char(min(created) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'none') from net._http_response
    union all select 'http-responses', 3, 'timed out', count(*) filter (where timed_out)::text from net._http_response
    union all select 'http-responses', 4, 'failed without a status', count(*) filter (where status_code is null)::text from net._http_response
    union all select 'http-responses', 5, 'with an error', count(*) filter (where error_msg is not null)::text from net._http_response
    union all select 'http-responses', 6, 'status ' || status_code, count(*)::text from net._http_response where status_code is not null group by status_code
    -- duplicate-grants
    union all select 'duplicate-grants', 1, 'settled slots repeated', ((count(*) - count(distinct (gladiator_id, slot_index)))
        + (count(*) - count(distinct activity_id)) + (count(*) - count(distinct receipt_id)))::text from private.settled_slots
    union all select 'duplicate-grants', 2, 'activities settled more than once', coalesce(sum(n - 1), 0)::text
      from (select count(*) as n from public.operation_receipts r where r.request ->> 'kind' = 'activity-settlement' group by r.request ->> 'activityId') x
    union all select 'duplicate-grants', 3, 'completed activities without their guard', count(*)::text from public.activities a
      where a.status = 'completed' and not exists (select 1 from private.settled_slots s
        where s.gladiator_id = a.gladiator_id and s.slot_index = a.slot_index and s.activity_id = a.id)
    union all select 'duplicate-grants', 4, 'ledger rows beyond one per receipt', (count(*) - count(distinct receipt_id))::text from public.wallet_ledger
    union all select 'duplicate-grants', 5, 'season awards repeated', ((count(*) - count(distinct (season_index, gladiator_id)))
        + (count(*) - count(distinct (season_index, league, place))) + (count(*) - count(distinct receipt_id)))::text from private.season_awards
    union all select 'duplicate-grants', 6, 'sales credited more than once', coalesce(sum(n - 1), 0)::text
      from (select count(*) as n from public.operation_receipts r where r.request ->> 'kind' = 'market-sale' group by r.request ->> 'listingId') x
    union all select 'duplicate-grants', 7, 'total (duplicateGrants)', (
      (select (count(*) - count(distinct (gladiator_id, slot_index))) + (count(*) - count(distinct activity_id)) + (count(*) - count(distinct receipt_id))
         from private.settled_slots)
      + (select coalesce(sum(n - 1), 0) from (select count(*) as n from public.operation_receipts r
           where r.request ->> 'kind' = 'activity-settlement' group by r.request ->> 'activityId') x)
      + (select count(*) from public.activities a where a.status = 'completed' and not exists (select 1 from private.settled_slots s
           where s.gladiator_id = a.gladiator_id and s.slot_index = a.slot_index and s.activity_id = a.id))
      + (select count(*) - count(distinct receipt_id) from public.wallet_ledger)
      + (select (count(*) - count(distinct (season_index, gladiator_id))) + (count(*) - count(distinct (season_index, league, place)))
           + (count(*) - count(distinct receipt_id)) from private.season_awards)
      + (select coalesce(sum(n - 1), 0) from (select count(*) as n from public.operation_receipts r
           where r.request ->> 'kind' = 'market-sale' group by r.request ->> 'listingId') x))::text
    -- characters
    union all select 'characters', 1, 'accounts', count(*)::text from auth.users
    union all select 'characters', 2, 'accounts with a character', count(distinct owner_id)::text from public.gladiators
    union all select 'characters', 3, 'characters', count(*)::text from public.gladiators
    union all select 'characters', 4, 'accounts with more than one character', count(*)::text
      from (select owner_id from public.gladiators group by owner_id having count(*) > 1) x
    union all select 'characters', 5, 'characters without an account', count(*)::text from public.gladiators g
      where not exists (select 1 from auth.users u where u.id = g.owner_id)
    union all select 'characters', 6, 'identities ' || i.provider, count(*)::text from auth.identities i group by i.provider
    union all select 'characters', 7, 'account ' || left(md5(g.owner_id::text), 12), 'characters '
        || (select count(*) from public.gladiators x where x.owner_id = g.owner_id) || ', created '
        || to_char(to_timestamp(g.created_at_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || ', providers '
        || coalesce((select string_agg(distinct i.provider, ' ' order by i.provider) from auth.identities i where i.user_id = g.owner_id), 'none')
      from (select * from public.gladiators order by created_at_ms desc limit 20) g
    -- trades
    union all select 'trades', 1, 'listings ' || s.status, count(l.id)::text
      from (values ('open'), ('sold'), ('cancelled'), ('expired')) s(status) left join private.market_listings l on l.status = s.status group by s.status
    union all select 'trades', 2, 'sales with the price paid and the fee right', count(*) filter (where buyer_delta = -price
        and seller_credits = 1 and seller_delta = price - fee)::text from sales
    union all select 'trades', 3, 'sales with a wrong or missing ledger row', count(*) filter (where buyer_delta is distinct from -price
        or seller_credits <> 1 or seller_delta is distinct from price - fee)::text from sales
    union all select 'trades', 4, 'sales whose item has one owner, the buyer', count(*) filter (where owners = 1 and owner = buyer)::text from sales
    union all select 'trades', 5, 'sales whose item is elsewhere or gone', count(*) filter (where owners <> 1 or owner is distinct from buyer)::text from sales
    union all select 'trades', 6, 'sale ' || left(md5(s.id::text), 12), 'price ' || s.price || ', fee ' || s.fee
        || ', buyer paid ' || coalesce((-s.buyer_delta)::text, 'missing') || ', seller received ' || coalesce(s.seller_delta::text, 'missing')
        || ' in ' || s.seller_credits || case when s.seller_credits = 1 then ' credit' else ' credits' end
        || ', fee right ' || (s.buyer_delta is not distinct from -s.price and s.seller_credits = 1
          and s.seller_delta is not distinct from s.price - s.fee)::text
        || ', owners ' || s.owners || ', owner ' || case when s.owner = s.buyer then 'buyer' when s.owner = s.seller then 'seller'
          when s.owner is null then 'gone' else 'other' end
        || ', sold ' || coalesce(to_char(s.sold_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'unknown')
      from (select * from sales order by sold_at desc nulls last limit 10) s
  ),
  sections(section, s) as (values ('parity', 1), ('scheduler', 2), ('dispatch', 3), ('job-attempts', 4), ('boundary-latency', 5),
    ('http-responses', 6), ('duplicate-grants', 7), ('characters', 8), ('trades', 9))
select c.section, c.item, coalesce(c.value, '') as value
from checks c join sections s on s.section = c.section
order by s.s, c.o, c.item collate "C";
