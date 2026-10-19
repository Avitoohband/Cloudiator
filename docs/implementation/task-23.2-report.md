# Task 23.2 report: timing correctness (Lane A, M18)

**Status:** DONE_WITH_CONCERNS (all gates green; two refinements of Decision 4 need a controller ruling, see Concerns 1).
Branch `claude/task-23` in `C:\Avi\Studies\Projects\Cloudiator-claude`. Commits:
- `27a9e62` fix: make slot timing independent of when a run starts (M18)
- this report: docs: report Task 23.2

Brief: `.superpowers/sdd/2026-10-19-task-23-release-readiness/task-23.2-brief.md` (Decisions 3–6, Review Focus 2).

## What I implemented

**Decision 3 (C16): stable-slot waits.**
- New static check `tests/stable-slot-waits.test.ts` (runs in `npm test`). It parses `tests/db/*.test.ts` with the TypeScript
  compiler API and finds every `stableRealSlot(margin)` call, through any helper in the same file that wraps it (for example
  `realTimeWorld()`), and every inline `if (remaining < margin) await new Promise(resolve => setTimeout(resolve, remaining +
  1_000))` wait. It first checks that `stableRealSlot` still has the known shape, so the bound `margin + 1 000` holds.
- Each test (or hook) must time out at least at the sum of its reachable longest sleeps plus the default timeout for its own
  work: testTimeout 20 s for a test, hookTimeout 30 s for a hook (read from `vitest.db.config.ts`). Failures name the file and
  line of the test and of each wait. A wait inside a loop, a non-constant margin or timeout, and a wait outside any test, hook
  or called helper are also reported. A second case proves the checker on synthetic sources.
- It found the two named causes and two more, all now fixed with timeouts written as the sum:

  | Where | Longest sleep | Old timeout | New timeout |
  |---|---|---|---|
  | `tests/db/arena.test.ts` "promotes from real Task 8 acquisitions…" | 121 s | 60 s | `121_000 + 60_000` |
  | `tests/db/tournaments.test.ts` "saves the flag through the real command path…" | 61 s | 20 s (default) | `61_000 + 20_000` |
  | `tests/db/market.test.ts` `beforeAll` (inline wait) | 181 s | 200 s | `181_000 + 30_000` |
  | `tests/db/shops.test.ts` `beforeAll` (inline wait) | 121 s | 150 s | `121_000 + 30_000` |

- Every other margin was checked against measured work (final replay run, JSON reporter): activities 120 s / 0.3 s, 30 s /
  0.4 s, 1.1 s, 0.4 s; arena cadence 30 s / 14.3 s (database time is a stand-in after the wait); arena promote 120 s / 0.4 s;
  recovery 90 s / 0.2 s; retention 60 s / 0.3 s; tournaments 60 s / 0.5 s. Every margin covers its work.
- Observed in replay run 2: the run started 305 s before a slot boundary, and the market hook really slept about 150 s (the
  run took 358 s instead of about 220 s) and passed.

**Decision 4 (C2): coordinator busy race.** `runWorker` (`supabase/functions/_shared/backend/jobs.ts`):
- A coordination after the invocation's own work that answers `busy` is retried at most 3 times, at least 250 ms apart
  (`COORDINATION_RETRY = { attempts: 3, delayMs: 250, jitterMs: 250 }`). One still busy after that counts in the report's
  `deferred`; the report shape is unchanged. The `deferred` doc in `domain/types.ts` says so.
- `WorkerDependencies` gains injectable `sleep` and `random` (defaults: a real timer and `Math.random`).
- Two refinements of the literal rule, each from an observed failure (Concerns 1):
  - The opening coordination, before any work, is asked once.
  - Each wait adds up to 250 ms of random jitter.
- Tests in `tests/backend/worker.test.ts` (fake database):
  - "retries coordination three times when busy, then reports deferred";
  - the C2 race itself (busy right after the last preparation, then the released pairing is claimed in the same invocation);
  - the opening coordination asked once;
  - the jitter bounds (250, 375, 499 ms);
  - the real timer under `vi.useFakeTimers` (attempts at 0, 0, 250, 500 ms).

**Decision 5 (C3): dispatch budget per scheduled minute.**
- `private.dispatch_workers()` in `supabase/sql/15-release.sql` counts invocations dispatched in `[minute start, minute start +
  60 s)` of database time. That time is sampled after the dispatch advisory lock, as AGENTS.md requires. Before, it counted
  those of the last rolling 60 s.
- The ceiling stays 5 per scheduled minute (about 216 000 a month). The function stays owner-only.
- Tests in `tests/db/activities.test.ts`: "spends the dispatch budget per scheduled minute at offsets +300 ms and +60,250 ms"
  (offsets 300, 59 999, 60 250, 119 999, 120 000, 179 999 → 5, 0, 5, 0, 5, 0; 5 log rows per minute).
- The existing "dispatches at most five workers per minute…" test now pins database time too. Under per-minute accounting a
  real minute edge between its calls would otherwise make it flaky. Both tests run in one transaction that always rolls back;
  the clock stand-in is discarded by the rollback and checked byte-equal afterwards.

**Decision 6 (C5): published-slot signal.**
- `public.world_revision_state.published_slot_index` (bigint, null before the first coordination) copies
  `private.coordinator.published_slot`.
- The copy is written by `private.mirror_published_slot()` through a deferred constraint trigger, `after update of
  published_slot … when (old.published_slot is distinct from new.published_slot)`. It changes exactly at the coordinator's
  commit and never on a rollback. It takes the hot revision row last, like every projection write; a publication already holds
  that row from phase 8.
- The function is owner-only, because a trigger fires without an EXECUTE grant. That was tested: the worker coordinates as
  `service_role`.
- There is a backfill.
- `public.world_revision` appends the column (`create or replace … with(security_invoker=true)`; its grants are kept).
- `RevisionState.publishedSlotIndex?: number | null` (additive and optional, so fixture worlds and `src/` constructors are
  unchanged). `readRevision` (`src/lib/api/reads.ts`) selects and maps it. No UI changed; the consumer is Task 23.4.
- Tests:
  - `tests/db/projections.test.ts` "exposes the published slot in the public revision state": a visitor and a player; a real
    boundary through preparation and publication; the copy unchanged inside an uncommitted transaction and after a rollback;
    null; one new view column; a visitor's write refused.
  - `tests/api/projection-gateway.test.ts`: the select list and number/null mapping.
- `OPEN` and the service_role snapshot are unchanged (no new object; no new grant).
- **Access matrix (deliberate test change).** The new plain column made `world_revision` auto-updatable for that column. The
  matrix's update probe used the first (computed) column and so got 0A000 before any privilege check (full source run 1). The
  probe now picks the first updatable column when there is one (`pg_column_is_updatable`). The refusal is then the privilege
  check (42501).

**Production-cadence tests.**
- `tests/db/arena.test.ts` is renamed "publishes a cleared and a held window within 120 s at production cadence".
- `tests/db/tournaments.test.ts` (cadence test) ticks at realistic offsets:
  - cleared: every tick at +300 ms;
  - held: +300 ms then +60 250 ms alternately, so the tick after the cutoff comes 59 950 ms later.
- Both require publication under 120 s in both cases. Neither has its old 180 s allowances or the busy-race branch any more.
- The arena test checks that the tick after the cutoff dispatches everything its claimable work needs. Its zero-total for
  failures, conflicts, unrecorded and deferred now prints the flagged reports.

## Files

- Code:
  - `supabase/functions/_shared/backend/jobs.ts`, `backend/database.ts`, `domain/types.ts`, `contracts/reads.ts`;
  - `src/lib/api/reads.ts`.
- SQL: `supabase/sql/15-release.sql` (Task 23.2 part); `supabase/migrations/20261019102324_timing.sql` (M18, new).
- Tests:
  - `tests/stable-slot-waits.test.ts` (new);
  - `tests/backend/worker.test.ts`, `tests/api/projection-gateway.test.ts`;
  - `tests/db/activities.test.ts`, `arena.test.ts`, `tournaments.test.ts`, `projections.test.ts`, `access-matrix.test.ts`,
    `market.test.ts`, `shops.test.ts`.
- Docs: `docs/operations/migrations.md` (new M18 section; the Task 7 dispatch sentence notes M18).

## RED

- **Unit** (`npx vitest run` on the three files): **7 failed**.
  - worker: 3 (1 coordinate call instead of 4; no sleeps; attempts `[0]`);
  - gateway: 3 (no `publishedSlotIndex`);
  - static check: 1, the two named causes with file:line:
    - `arena.test.ts:1192` (wait line 1193), 121 000 ms against 60 000;
    - `tournaments.test.ts:174` (wait line 176), 61 000 ms against 20 000.
- **DB `red-db-fast`** (activities + projections, `-t "dispatch|published slot"`): **2 failed**, 2 passed.
  - Dispatch gave `[5, 0, 0, 5, 0, 5]` (rolling) for `[5, 0, 5, 0, 5, 0]`.
  - `publishedSlotIndex` was `undefined`.
- **DB `red-arena-cadence`:** **failed** with `expected 2 to be 3`. The held tick after the cutoff dispatched 2 invocations
  where 3 were needed. Held publication **121 345 ms**; cleared 61 459 ms; cold 979 ms.
- The tournament cadence test was not run RED, to save a run. Its pre-change behaviour is the recorded 121 s held case
  (Task 19 report).

## GREEN, every DB run, and the Edge start time

Every `npm run test:db` ran with nothing else building, browsing or editing in this worktree. Times are
`docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator`; "same" means unchanged across the run. The Edge
container serves this worktree's `supabase/functions` (mount checked).

| Run | Scope | DB | Result | Edge before = after |
|---|---|---|---|---|
| red-db-fast | dispatch + published slot | M17 | 2 failed / 2 passed (RED) | 10:02:04.94 same |
| red-arena-cadence | arena cadence | M17 | failed (RED) | 10:03:02.10 same |
| green-db-focused | dispatch, published slot, cadence | source | 4 passed, cadence failed: 1 deferral | 10:06:22.40 same |
| green-arena-2 | arena cadence | source | failed: a simulation invocation's opening coordination deferred | 10:06:22.40 same |
| green-arena-3…6 | arena cadence ×4 | source | 4/4 passed (opening coordination not retried) | 10:09:56.27 same |
| green-tournament-1 | tournament cadence | source | passed | 10:09:56.27 same |
| full-source-1 | all | source | 268/269: matrix probe 0A000 on `world_revision` | 10:09:56.27 same |
| green-matrix-1 | matrix + visitor | source | 16/16 (probe fixed) | 10:09:56.27 same |
| full-source-2 | all | source | **269/269** | 10:09:56.27 same |
| full-replay-1 | all | M01–M18 replay | 268/269: a simulation invocation's post-work coordination deferred | 10:09:56.27 same |
| jitter-arena-1…5 | arena cadence ×5 | replay | 5/5 passed (jitter) | 10:31:22.74 same |
| jitter-tournament-1, 2 | tournament cadence ×2 | replay | 2/2 passed | 10:31:22.74 same |
| full-replay-2 | all | replay | **269/269** (crossed a slot boundary; the market hook slept about 150 s) | 10:31:22.74 same |
| full-replay-3 | all, at commit `27a9e62` | replay | **269/269** (220 s) | 10:31:22.74 same |

Edge recreations happened only between runs:
- 10:02:04 and 10:03:02, between test edits and runs;
- 10:06:22, 10:09:56 and 10:31:22, each after an edit of `jobs.ts`. These are what let the Edge runtime serve the new worker; a
  new baseline was taken each time.

Other gates:
- `npm test`: 1108/1108, then **1110/1110** in 51 files.
- `npm run typecheck` (tsc, `deno check --frozen`, Deno smoke 2/2): passed each time it ran (four times).
- `git diff --check`: clean.

## Production-cadence timings (50 entrants, ms after the cutoff)

| Case | Before (RED run, M17 + old worker) | After (full replay run 3) |
|---|---|---|
| Arena cold publication | 979 | 529 |
| Arena cleared publication | 61 459 (Task 19 observed about 121 s in 4 of 9 runs, the busy race) | **61 435** |
| Arena held publication | **121 345** (tick +60 250 dispatched 2 of the 3 needed) | **61 366** (dispatched 3) |
| Tournament cleared publication | about 61 s or about 121 s when raced (Task 19) | **61 479** |
| Tournament held publication | about 121 s (Task 19) | **61 392** |

Every after-run is between 61.3 and 61.7 s: the source runs, the jitter runs and the replay runs. Bouts and credits are
unchanged: simulated by about 121 s, credited at 80 min + 1.3 s. A held tournament run once took 412 ms from the last
preparation to pairing, which is a retry absorbing a busy coordination inside the tick.

## M18: generation and completion

1. `db reset --local --no-seed --yes` to M01–M17. The fingerprint (Task 23.1's script, 1127 lines) matched Task 23.1's recorded
   M17 replay **byte for byte**.
2. Applied `15-release.sql` once with the psql fallback after the container label check (`Cloudiator`). The fingerprint diff
   is exactly the expected set:
   - the `dispatch_workers` body;
   - the new owner-only function;
   - the `world_revision` view definition (same ACL, `security_invoker=true`);
   - two columns;
   - the trigger, its constraint row and its enabled state.
3. Lint on the source: `{"results":[]}`.
4. `npx supabase db pull timing --local --schema public,private --yes` (migra) wrote `20261019102324_timing.sql` and recorded it
   locally. The draft (kept as `scratch t232/timing-draft-as-generated.sql`) needed four completions:
   1. Its `create or replace view` named no options. PostgreSQL then replaces the view's options, so it would have **dropped
      `security_invoker`**. It is replaced by the source's statement, verbatim.
   2. Both function ACLs (the source's revokes).
   3. The published-slot backfill.
   4. A provenance header and `notify pgrst`.
5. The column, both functions and the trigger are as generated; the trigger follows its function. There are no re-emitted
   unchanged functions. Both bodies are byte-identical to the source (compared programmatically), and so are the view, the
   revokes and the backfill.

## Replay, parity, lint, advisors

- A clean `db reset --local --no-seed --yes` replayed M01–M18, with no source applied afterwards. Edge was unchanged by both
  resets.
- **Parity:** the fingerprint (M17 coverage plus one line, coordinator published slot = public copy; 1134 lines) of the replay is
  **byte-identical** to the source-applied database. It was identical again after full replay runs 1–3.
- **Inspection of the replay:**
  - `dispatch_workers` and `mirror_published_slot`: `{postgres=X/postgres}`, invoker, `search_path=""`;
  - `world_revision`: `{security_invoker=true}`, SELECT for anon, authenticated and service_role only;
  - the trigger: enabled, deferrable, initially deferred; 44/44 public/private triggers enabled;
  - both cron jobs active; no function executable by anon or authenticated;
  - after the runs: scheduler off, no Vault worker secret, `planning_now_ms` unchanged.
- **Backfill** (it cannot act on an empty replay), checked on the replay inside a `DO` block that always raises. With the trigger
  disabled and the coordinator at 12345, the verbatim statement moved the copy from null to 12345; a second run updated 0 rows.
  Afterwards both were null and the trigger enabled.
- **Lint** (`db lint --local --schema public,private --fail-on warning`): `{"results":[]}` on the source and on the replay.
- **Advisors** (`db advisors --local --type all --level info --fail-on warn`):
  - fresh replay: 36 INFO `unused_index` (no statistics yet);
  - after the test runs: **1 INFO** (`jobs_gladiator_idx`), no WARN, no ERROR.
- `migration list --local` shows M01–M18.

## Self-review (fixed during the task)

- My first worker version retried every coordination. In the real cadence test it deferred one invocation's **opening**
  coordination: five invocations started together, and synchronized 250 ms retries admitted one per round. The fix: the opening
  coordination is asked once.
- The second version still deferred one **post-work** coordination: five simulation invocations finished together, the same
  lockstep. A Monte Carlo model (`scratch t232/herd.cjs`) gives about 100 % for fixed delays and 0–0.15 % with up to 250 ms
  jitter, at hold times of 5–50 ms. pg_stat_statements measured a mean of 3.5 ms and a maximum of 54 ms for
  `coordinate_work` through PostgREST. The fix: jitter.
- First full source run: the access-matrix probe failure on the now auto-updatable view. Fixed in the test, as above.
- Replay run 2 exposed the market/shops inline hook waits. The static check now covers inline waits, and their timeouts were
  raised.
- The arena test's old claim that the cutoff tick's spare slots cannot prepare is no longer true with retries ("prepare 10,
  settlement 10" was observed). The new assertion checks the following tick's full need instead of a fixed 3.
- Checked: retries never sleep while holding a job lease (every retry follows completed work). The worst added wall time is
  about 1.5 s per coordination, well under pg_net's 30 s.

## Concerns

1. **Decision 4 refinements need a ruling.** The literal rule ("retries … 3 times, 250 ms apart") gave false deferrals twice in
   the real cadence test.
   - I kept at most 3 retries and at least 250 ms between attempts.
   - I added up to 250 ms of jitter per wait (attempts 250–499 ms apart).
   - I do not retry the opening coordination, which follows no work of the invocation.
   - Both changes are tested and documented (`COORDINATION_RETRY`, `migrations.md`). If the controller wants the literal
     250 ms, the cadence tests' zero-deferral check must then tolerate herd deferrals.
2. **`deferred` now has two meanings:** deferred jobs, and coordinations still busy after their retries. This keeps the report
   shape, as instructed. Operators and the health report cannot tell the two apart.
3. **Deploy order (Task 24).** `readRevision` selects `published_slot_index`, which an M17 database refuses, so the revision
   read would fail. Deploy M18 and the worker before (or with) the client. Recorded in `migrations.md`.
4. **For Task 23.4 (Lane B).** `publishedSlotIndex` is optional (absent in fixture worlds) and `null` before the first
   coordination. The browser mocks (`tests/browser/live-routes.ts`) do not return the column, so `readRevision` yields `null`
   there until 23.4 updates them.
5. **Not measured here.** Bursts of up to 10 invocations within 60 s across a minute edge (accepted by Decision 5). Hosted
   `dispatch_log` spacing and CPU (C4) remain Task 24.
6. **Skill upkeep (for Avi, via the controller).** "Avi, shall I update AGENTS.md — *Generated migration completion* — to add:
   compare view options; migra (CLI 2.120.0) emitted `create or replace view` without the view's `security_invoker`, and
   CREATE OR REPLACE VIEW then resets options (observed in M18)?" This belongs with the pending question about migra's omitted
   view and column grants.
