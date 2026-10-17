# Task 18.1 report: atomic listings in the database (M14)

- **Status:** DONE_WITH_CONCERNS. The concerns are interpretation choices and pre-existing infrastructure. No gate failed.
- **Branch and base:** branch `claude/task-18` in `C:\Avi\Studies\Projects\Cloudiator-claude`, base `a96c330`.
- **Commit:** `b052ea0 feat: trade equipment through atomic listings`. It is not pushed.

## What I implemented

### Source: `supabase/sql/12-market.sql`

The source is reapplicable. Its header documents the Decision 6 lock order, the two-UPDATE transfer, and that offers do not
bump the revision.

**`private.market_listings`** is the authoritative table.
- Columns are as in Decision 3.
- CHECKs:
  - price between 1 and 1,000,000,000;
  - `expires > listed`;
  - `sold` if and only if there is a buyer;
  - `sold` or `cancelled` if and only if there is a terminal receipt;
  - the buyer is not the seller.
- Indexes:
  - a unique open-item index;
  - a partial index on open listings' expiry, used by the sweep;
  - indexes on seller+status, buyer and terminal receipt.
- `item_id` has no foreign key, because a sold item may later be sold to an NPC or discarded.
- Access: RLS on, `revoke all`, service_role select/insert/update, and a `backend_only` policy.
- The `guard_market_listing` trigger lets only an open row change, and only its terminal fields.

**`public.market_offers`** is the sanitized projection.
- Columns: `id` (a foreign key to the listing), seller id and name, the item (`catalogId`, `catalogVersion`, `tier`, `rarity`,
  `stats`, `quantity`), price, and the listed and expiry times.
- Indexes on the seller and on `(listed_at_ms desc, id)`; the second is for 18.2's page order.
- Access: RLS on, `revoke all` from everyone, SELECT to anon and authenticated, select/insert/delete to service_role.
- One policy, `player_read for select to anon, authenticated using (expires_at_ms > clock_timestamp ms)`.
- It has no `projection_changed` trigger.

**`private.market_command(actor, op, input, kind)`** backs three public SQL wrappers: `create_listing`, `cancel_listing` and
`buy_listing`. All are security invoker with `search_path=''`; only service_role may EXECUTE them.
- **Create and cancel order:** account lock, receipt lookup, gladiator, wallet, items by id, then the listing row (a cancel
  locks only the seller's own row).
- **Buy order:**
  1. Read the seller unlocked.
  2. Take both account locks in gladiator order.
  3. Receipt lookup.
  4. Both gladiators, then both wallets, in gladiator order.
  5. The buyer's items, plus the listed item while the seller still owns it, in id order.
  6. The listing row `FOR UPDATE`.
- `planning_now_ms()` is sampled once, after every lock. The processing gate, expiry and all checks use that sample.
- Shape errors return `invalid` with no receipt. Business refusals are stored. `processing` is never stored.
- Each command first expires its seller's own due listings: the actor's for create and cancel, the listing's seller's for buy.
- A sale makes two item UPDATEs, writes a seller receipt (`{kind:'market-sale', listingId}`, generated operation id), and two
  ledger rows (`market-purchase` −price and `market-sale` +price−fee).
- The fee is `price*5/100` in bigint division.
- The buyer's `peak_strength` is set from `prepared.nextPeakStrength`, after `baselinePeakStrength` matches.
- Refusal codes follow Decision 9.

**`private.market_close_listing`** and **`private.expire_seller_listings`** are helpers, service_role only.

**`private.expire_listings(now_ms bigint) returns integer`** is the sweep, granted to nobody.
- It try-locks each seller's account lock and skips a busy seller.
- It then takes that seller's due rows with `FOR UPDATE SKIP LOCKED`.

**`private.cron_tick()`** now runs the sweep in its own `begin … exception` block after coordination, and reports `expiry`.

### Other changes

- **`supabase/functions/_shared/domain/rules-v1.ts`:** `marketplace.maximumPrice: 1_000_000_000`.
- **`tests/db/visitor-access.test.ts`:** `market_offers` added to `OPEN`.
- **M14:** `supabase/migrations/20261017144347_market.sql` (see the migration evidence below).
- **`docs/operations/migrations.md`:** a new "Task 18.1: marketplace listings (M14)" section.

## TDD evidence

### RED

`npm run test:db -- tests/db/market.test.ts`, with the Edge start time `14:01:51.395531389Z` before and after. All 13 tests
failed:
- 11 with `Could not find the function public.create_listing(actor_id, input, operation_id)`;
- the expiry test with `function private.expire_listings(bigint) does not exist`;
- the refusals test with the old `maximumPrice` (`Number.MAX_SAFE_INTEGER`);
- the ACL test with `expected [] to deeply equal [ …(3) ]`, because the functions were missing.

### GREEN, while iterating on the applied source

These runs are not counted, and the Edge start time was stable in each.

1. The first run passed 12 of 13. The expiry test's own design was wrong: the seller's fresh listing was created after the
   due one, so Decision 7 correctly expired the due listing early. I reordered the test and added an explicit
   "seller's next command expires its own due listings" check.
2. Market plus visitor-access then passed 18/18, and the market file alone passed 13/13 twice.
3. **Race coverage:**
   - Two buyers and a cancel: one run gave sold,cancelled,cancelled,cancelled,sold,cancelled, and another
     sold,sold,cancelled×4.
   - Listing against equip and listing against NPC sale had the listing winning every round at first. With the listing call
     delayed by 0/0/25/50/75/100 ms, it won 2 of 6 rounds in each race, so both orders were exercised.

### Mutation checks

These ran on the final source, each applied and then restored with psql.

| Mutation | Owning test | Result |
| --- | --- | --- |
| `now_ms` sampled right after the receipt lookup, before the row locks | the expiry test's proven-wait case | FAIL: the buy sold the listing (`ok:true`) instead of returning `expired` |
| Buyer-first account locks (`order by` the buyer/seller position) | the gladiator-order deadlock test | FAIL: the purchase held 1 advisory lock while it waited for the lower account |

The restored source passed both tests again.

### Rework before commit

A review before commit found that the buy locked the listed item even after it had been sold to a third account, whose lock
the buy does not hold. I narrowed the lock to `id=listed_item and gladiator_id=seller_gid` and added a "stale page → `sold`"
assertion. Then I:
1. discarded the first M14 draft (`migration repair 20261017142821 --status reverted --local` and exact-file removal);
2. reset to M01–M13 (its fingerprint was identical to the baseline);
3. reapplied the source and reran every check below.

## Migration evidence (M14)

### Generation

- **Command:** `npx supabase db pull market --local --schema public,private --yes` (CLI 2.120.0; the log reports
  `engine":"migra"`).
- **Path:** `supabase/migrations/20261017144347_market.sql`. The CLI recorded it as applied.
- **Comparison with the discarded draft:** the regenerated draft differs from it only in the one changed statement.

### Completions

The completion script is `scratchpad/t18/complete-m14.cjs`; the original draft is kept as `scratchpad/t18/draft-original.sql`.

1. **Order.** The draft created `public.market_offers` and its foreign key to `private.market_listings(id)` before the private
   table existed, which would fail on replay. The private table's block (create, RLS, indexes, constraints) now comes first.
2. **Table revokes.** `revoke all … from public, anon, authenticated, service_role` now precedes the generated grants on both
   tables.
3. **Function ACLs.** The draft had none. The source's revoke/grant pair is appended for the 8 new functions and the replaced
   `cron_tick`.
4. **Provenance header and `notify pgrst`** were added.

### Unchanged by the completions

- The draft re-emits no unchanged function; it emits only the 8 new functions and `cron_tick`.
- The trigger follows its function. The public SQL wrappers come before `market_command`, which is safe under the draft's
  `check_function_bodies = off`.
- No backfill or initialization is needed. The cron job is unchanged: it already runs `cron_tick`.

### Clean replay

`db reset --local --no-seed --yes`, after checking the `com.supabase.cli.project=Cloudiator` label, replayed M01–M14. No source
was applied afterwards. `migration list --local` shows 14 migrations, with local and remote matching.

### Parity

- The fingerprint script is `scratchpad/t18/fingerprint.sql`: the Task 13.1 coverage plus the singleton counts.
- Source-applied: 956 lines.
- Replay: 956 lines, **byte-identical** to the source.
- After the counted replay test run: identical again.
- After the counted source test run: identical too, so no clock stand-in was left behind.

### Lint and advisors

- **Lint** (`--fail-on warning`): empty on both the source and the replay.
- **Advisors** (`--level info --fail-on warn`), no WARN or ERROR on either:
  - source: 7 INFO unused-index notices;
  - replay, after its test run: 8 INFO notices. Four are on the new tables: `market_listings_buyer_idx`,
    `market_listings_receipt_idx`, `market_offers_listed_idx` and `market_offers_seller_idx`.

## Counted gate runs (in order, after all committed-file edits except the doc's final evidence lines)

| Gate | Result |
| --- | --- |
| `npm test` | 995/995 in 44 files |
| `npm run typecheck` | pass (tsc, deno check, Deno runtime smoke 2/2) |
| `npm run test:db` on the source-applied database | **190/190** in 10 files |
| `npm run test:db` on the M01–M14 replay | **190/190** in 10 files |
| `git diff --cached --check` | clean |

## Edge start times (`supabase_edge_runtime_Cloudiator`)

| Run | Before | After | Counted |
| --- | --- | --- | --- |
| RED, market only, 13 failed | 14:01:51.395531389Z | same | RED evidence |
| Iterations: market and visitor 18/18, market 13/13 twice | 14:22:43.614186974Z | same | no |
| Full suite, source with the first draft, 190/190 | 14:22:43.614186974Z | same | superseded |
| Full suite, replay of the first draft, 190/190 | 14:28:32.643604619Z | same | superseded |
| Iteration on the final source, 18/18 | 14:33:24.01911854Z | same | no |
| Full suite on the final source, 189/190 | 14:33:24.01911854Z | `0001-01-01T00:00:00Z` (recreating; back at 14:40:26.61121523Z) | **discarded** |
| Full suite on the final source, 190/190 | 14:40:26.61121523Z | same | **yes** |
| Full suite on the final replay, 190/190 | 14:43:58.373013152Z | same | **yes** |

**About the discarded run.** Its failure was `arena.test.ts` "promotes from real Task 8 acquisitions only at a boundary…",
which timed out at 60 s while the Edge container was recreated. Nothing else ran in the worktree during it. The known flaky
`arena.test.ts:642` did not fail in any run.

**Recreations between runs.** The container was also recreated at 14:22, 14:28, 14:33 and 14:43. Each time coincided with my
file edits, the regenerated migration or a reset, as AGENTS.md describes. All dates are 2026-10-17.

## Files changed

| File | Change |
| --- | --- |
| `supabase/sql/12-market.sql` | new |
| `supabase/migrations/20261017144347_market.sql` | new (M14) |
| `tests/db/market.test.ts` | new, 13 tests |
| `tests/db/visitor-access.test.ts` | `OPEN` gains `market_offers` |
| `supabase/functions/_shared/domain/rules-v1.ts` | `maximumPrice: 1_000_000_000` |
| `docs/operations/migrations.md` | new M14 section |

## Concerns

### Interpretation choices for review

1. **Cancel outcomes.** A cancel of a sold or expired listing returns `sold` or `expired`. A cancel of a cancelled, unknown or
   someone else's listing returns `not-found`. The same mapping applies to buy.
2. **Unknown item.** `create-listing` of an unknown or someone else's item returns a stored `not-found`, as `sell-item` does.
   Decision 9 does not list this case.
3. **Wallet cap.** A seller's credit may reach exactly 9,007,199,254,740,991 (the `sell-item` precedent), and the test checks
   this. I read "stays below the cap" as "does not exceed it".
4. **Buy preparation.** A malformed buy preparation (missing, a wrong type, a next value below the baseline, more than two
   decimals) is an unrecorded `invalid`. A stale `baselinePeakStrength` is a stored `conflict`, as with `buy-shop`.
5. **Whose listings a buy expires.** In a buy, the listing's seller's due listings are the ones expired. The buyer's are not.
6. **Salvage stacks.** Tradable, non-renown salvage stacks can be listed; the offer carries `quantity`. If the market should
   accept equipment only, 18.2 or 18.3 must restrict it, or the SQL should.
7. **Parser price bound.** The Edge command parser (`backend/commands.ts`) still accepts prices up to `MAX_SAFE_INTEGER`; 18.2
   owns that file. SQL already refuses prices above 1,000,000,000 without a receipt.

### Lock-order note

A buy locks the seller's other due listings' items after the listing row (out of id order) when it expires them. The sweep
updates items without locking the gladiator row. Both are safe only because every writer of an account's rows holds that
account's lock first. The source header documents this.

### Test limits

- The deadlock test simulates `boundary_start`'s lock pattern (both account locks, lower then higher, in one raw session); it
  does not run a real boundary.
- The `cron_tick` test runs inside a rollback-only transaction.
- The expiry tests use the committed session-pinned clock stand-in. It is restored from `pg_get_functiondef` and verified byte
  for byte; the fingerprints after the runs confirm the restore.

### Line endings (not changed here)

`core.autocrlf=true` and there is no `.gitattributes`. The new migration and source are LF in both the index and the working
copy, as M13 is. A later checkout will write CRLF working copies, which is the M11 re-emission hazard.

### Infrastructure

One Edge recreation happened during a full run with nothing else active. That run is discarded above.

### Proposed AGENTS.md update (needs Avi's approval)

Avi, shall I update the **Generated migration completion** section of AGENTS.md (and `docs/operations/migrations.md` "Required
generated-artifact review", step 2) to add one item to the compare list: *table creation order for foreign keys between new
tables, including across `public` and `private`*?

- **Observed:** with CLI 2.120.0, the M14 draft created a public table, with its foreign key, before the private table it
  references.
- **Tested fix:** moving the referenced table's block first. Clean replay and parity then passed.
- **Not yet observed:** an order problem with tables in the same schema.
