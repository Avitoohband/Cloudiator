# Lease expiry checks after lock waits

This persistent project supplement to Supabase Postgres Best Practices was
approved by Avi on 2026-10-13 for **Concurrency & Locking**. It complements the
vendor's short-transaction and SKIP LOCKED guidance; vendor caches are unchanged.
The standing skill-upkeep policy remains in root [AGENTS.md](../../AGENTS.md).

## Authority under the lock

Time captured on RPC entry may be stale when `SELECT ... FOR UPDATE` returns.
Validate a time-limited operation at its authority decision under the established
guard locks. Sample `clock_timestamp()` there, then check the current token,
status and expiry. PostgreSQL's `now()`/`CURRENT_TIMESTAMP` use transaction-start
time, and `statement_timestamp()` uses statement-start time; placing either
after the lock does not make it fresh. See the official
[PostgreSQL 17 date/time reference](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).

For Cloudiator, preserve the documented coordinator/account/character/dependent
lock ordering and its explicit exhausted-lease sweep exception. Avoid adding a
reverse wait path merely to move a clock read. If a later guard lock can block
before the time-dependent decision, sample/revalidate after that wait too.
Keep external calls and simulations outside the transaction.

Backend-only lease validation body excerpt (not a standalone migration):

```sql
select * into lease_row
from private.jobs
where id = requested_job_id
for update;

-- Handle a missing job before accessing its fields.
checked_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
if lease_row.status <> 'leased'
   or lease_row.lease_token is distinct from requested_token
   or lease_row.lease_until_ms <= checked_ms then
  -- Return conflict; do not publish, grant or extend this lease.
end if;
```

Completion/reveal/settlement must use the verified current lease. An immutable
already-committed result may replay without a new grant; do not mistake receipt
replay for permission to accept a new write after expiry. Renewal returns the
database's new expiry, and the executor must consume that response rather than
continue with the old expiry or invent a client deadline.

## Regression and migration proof

- Establish a separate transaction holding the relevant row lock.
- Start the completion/renewal contender while the current lease is still valid.
- Synchronize or observe its lock wait, then let the lease expire before releasing
  the blocker. Avoid a timing assertion that can pass merely because the RPC
  started late.
- Assert conflict and no grant, publication, completion or renewal. Include
  current/stolen/reclaimed/exact-expiry cases and valid committed-result replay.
- Observe meaningful RED on pre-wait time sampling and GREEN on the correction.
  Record the commands and actual results; source inspection alone is not a run.
- Put a subsequent correction in a new generated migration. Never edit committed
  migrations. Clean replay migrations alone and compare function bodies, ACLs,
  invoker/search-path settings and relevant policies/triggers. Do not reapply
  source after reset and describe it as migration-artifact proof.

## Evidence status

Task 9 implementation identified entry-time sampling in completion/renewal and
added post-lock checks plus blocked-row regression cases. At the time this guide
was committed, the implementation had been interrupted before its final report
and replay verification. The observed defect, proposed correction and final
verification must remain distinct. Read the eventual Task 9 report/review for
confirmed RED/GREEN, changed functions, the actual new migration and any limits.
This guide does not itself claim that those pending checks passed.
