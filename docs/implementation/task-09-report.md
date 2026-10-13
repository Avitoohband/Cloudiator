# Task 9 — private expeditions and end-of-slot settlement

Status: **DONE_WITH_CONCERNS**. Local implementation and verification are complete;
independent review/push and the later integration/release gates below remain.
Completed 2026-10-13 in `C:/Avi/Studies/Projects/Cloudiator`, branch
`codex/gladiator-arena`.

## Provenance

- Full review BASE: `05b1ea0f79a1d28d839727128b661ea374dfe6bb`.
- Continuation starting HEAD: `395bc2dc53db780e6c0661de9091d4c8f12141b9`.
  This is the controller's separately approved lease-guidance documentation,
  not a Task 9 product checkpoint.
- Source commit: **`e96e0f1b43e7498c80d2db06bfcba6426bf77584`**,
  `feat: plan and settle timed expeditions`.
- New generated migration M06:
  **`supabase/migrations/20261013125213_expeditions.sql`**.
- This report is a separate documentation commit. Its resolved SHA is returned
  to the controller and recorded in the ignored scratch report after commit.

The prior implementation worker was unavailable after interruption. This worker
read the full brief/recovery/current instructions and producer reports/reviews,
preserved the saved product work and generated migration draft, and continued
verification. It did not restart the feature, reset/stash Git, re-import source,
change branches, alter M01–M05, spawn helpers, push, or touch visual/scanner/package
work. Three inherited patch scripts were inspected and moved by checked exact
paths into ignored task scratch; they are not product files.

## Planner and deterministic rules

`planExpedition(snapshot, seed, rules): ExpeditionPlan` is pure, recursively
frozen, retained-v1 code. Unknown rules/catalog integration fails closed. The
activity's stored build/choice/level/seed/rules remain authoritative through
retry; new acquisitions do not change a frozen trip.

Woodland/Outpost/Mountain use the existing catalog's level 1/5/10 locks,
100/250/500 XP, 20/60/120 money, salvage quantity 1/2/3, gear chances 20/30/40%,
and gear tiers 1/5/10. Enemy baselines are exactly 35/6/1100ms, 80/12/1100ms,
140/18/1000ms, with the specified attribute vectors, Balanced stance, no armor
and efficiency 1. Explicit `maxHealth`/`baseDamage` avoid adding player HP or
Strength damage formulas to these templates. The canonical combat engine
still determines hit/critical/stance/damage outcomes.

Every trip starts at full HP. Successful non-final encounters carry final HP
plus `floor(maxHP * .2)`, capped at max HP. Defeat ends encounter generation;
failure earns no XP/money/loot. A seeded simultaneous-defeat winner with zero
remaining HP does not continue. Inventory, points and stamina receive no
healing/refill/injury/gear-loss mutation from expedition settlement.

Encounter RNG streams are `${seed}:encounter:1`, `:2`, `:3`; loot has the separate
`${seed}:loot` stream. Loot draws are gear chance, then rarity (70/25/5), then
uniform equipment choice in stable catalog-ID order at the rolled rarity and
reward tier. Candidates are standard equipment with no renown price; salvage
and cosmetics are not in that equipment catalog. Battle draw counts cannot
shift loot draws. Rewards are persisted once, not rerolled on delivery or
inventory-preparation retry. A future weighting change needs a new retained
rules implementation.

NPC participant IDs match the accepted renderer:

| Expedition | Encounter IDs before stable numeric suffix |
| --- | --- |
| Woodland | `creature:dire-wolf`, `creature:timber-wolf`, `creature:dire-wolf` |
| Outpost | `creature:raider`, `creature:raider-archer`, `creature:raider` |
| Mountain | `creature:rock-troll`, `creature:frost-troll`, `creature:rock-troll` |

No Phaser/art-manifest import enters backend authority.

## Stage and read contracts for Tasks 10/15

The existing `RevealedStage` wire shape is unchanged. Stage IDs are
`activityId:ordinal`; battle IDs are `activityId:encounter:number`. Times are
absolute epoch milliseconds derived from the frozen cutoff. The sequence is:

- Depart at minute 0, ending at minute 20.
- Encounters at minutes 20, 40 and 60, each ending after its actual log duration.
- After non-final wins, exploration/recovery lasts until the next encounter.
- After the final win, travel lasts until minute 80.
- After a defeat, safe-return rest starts after the failed log and lasts until
  minute 80; no later encounters exist.
- A terminal `return` stage occurs at minute 80, including on failure.

`private.expedition_plans` keeps full immutable plans. `private.job_dependencies`
links simulation → first reveal → subsequent reveals; settlement depends on
simulation and every reveal. Claims and dispatcher counts require prerequisites
to be completed. Each reveal selects the persisted stage by ordinal; the
worker cannot supply a public payload. Simulation/plan replay is idempotent.

`public.activity_stages` has authenticated SELECT only and RLS checking
`reveal_at_ms <= clock_timestamp()` in the database, even for the activity owner
or a guessed ID. Anonymous reads and player mutations are denied. Stage output
whitelists stage fields, every participant/attribute field and every log event;
private extensions on nested objects do not become public. There is no seed,
inventory baseline, reward proposal, wallet, or overflow detail in stage rows.

The owner reads completed `activities.summary` and operation receipts through
existing owner RLS. Spectators cannot read those owner summaries, including
after completion. The additive `CreditedRewards.overflow?` array contains only
`catalogId`, `catalogVersion`, `quantity`, `unitValue`, `money`; instance IDs,
reservations and preparation details are excluded. Canonical NPC values come
from the retained Task 8 grant planner; SQL validates finite safe integer
entries, products and agreement with `overflowMoney` before publication.

Task 10 still owns the general public projection/revision/timeline adapter,
including safe public completion identity/result and due-stage revision bumps.
It must retain the owner/spectator reward split. Task 15 consumes the staged
logs; it must not recompute combat or expose future stages. This task adds no
world endpoint, general timeline adapter or UI implementation.

## Settlement, hooks and worker behavior

`createWorkerDatabase.settle` reads the backend-only
`expedition_settlement_input(activity_id, lease_token)` under the live token,
prepares grants from current `OwnerState` and XP via `applyXp`, renews the job,
and calls `settle_expedition(activity_id, lease_token, prepared)`. Up to three
stale preparations reread inventory without changing the immutable proposal.
Non-expedition or completed replay paths retain `settle_activity` behavior.

The common `private.settle_activity_core` holds account advisory, character,
wallet, sorted-item, activity and job locks. It checks live lease status/token/
post-lock expiry, end time, published slot, previous activity barrier and all
dependencies. It combines the Task 8 grant primitive, progression, money plus
overflow, ledger, receipt, activity completion, job completion and permanent
`settled_slots` checkpoint atomically. A stale baseline rolls back the tentative
guard in the wrapper subtransaction. Reserved salvage is rechecked before
top-up; held fees stay reserved. A no-op inventory plan is not a replay guard.
Already committed same-token results return the same receipt and zero new
grants even after expiry. A stolen token cannot replay a receipt.

`private.safe_settlement` projects an explicit outer and nested whitelist for
all activity kinds. It validates reward counts, item entries, signed rating
delta and both replay-expiry variants. Malformed hooks roll back their writes
and checkpoint; the worker records a sanitized execution failure. Training and
Rest retain their original reward hooks and behavior.

Changed existing SQL functions: `claim_jobs`, `complete_job`, `renew_job`,
`settle_activity`, `accept_job_result`, `activity_executor_ready`,
`dispatch_workers`, `prepare_activity_jobs`. Ten new functions support
expedition commits, input/grants, dependencies, safe JSON/log/summary projection
and common settlement. New RPCs are backend-only, security invoker with empty
search paths. Existing dispatcher permissions remain operator-only.

The inherited pre-lock time defect in `complete_job` and `renew_job` is corrected
in M06 only: lock the current row, then sample `private.planning_now_ms()` (the
existing `clock_timestamp` helper) and validate status/token/expiry. The plan
RPC delegates to that corrected completion fence. Settlement already samples
after all its guard locks. The accepted exhausted-lease sweep lock-order
exception is documented in the new source header: no reverse coordinator wait
was introduced. Third-expired leases still enter operator state without a
fourth claim.

Workers retain the simple20/combat5 per-invocation limits, explicit retained
executors and global chronology. They consume the database's renewed expiry,
check renewal again after execution, and stop starting executors after the
two-second measured compute budget. Claimed-but-unexecuted leases are counted
as `deferred` and remain reclaimable. The default elapsed timer around an
executor is a conservative wall-duration measurement, not a hosted CPU profiler;
one indivisible executor cannot be preempted. Hosted load/CPU validation remains
Task 23, and this is not a performance certification.

## RED/GREEN evidence and continuation corrections

Inherited observations from the recovery record, not newly claimed runs:
missing-module domain RED then eight GREEN, later 26 focused units; unsupported
expedition executor two-DB RED; two then fourteen owning DB GREEN; 48 affected
DB GREEN before the last additions; real Edge planning/reveal/settlement/replay;
and earlier typechecks. The previous worker left unfinished lease regression
and migration-only artifact proof.

Newly observed here:

1. The inherited timing test merely slept and did not prove the contender had
   begun before expiry. It was strengthened to reserve a real PostgreSQL
   connection, observe `pg_blocking_pids`, assert database time is still below
   expiry while blocked, and release only after database time passes expiry.
2. Temporarily reinstating pre-lock time in local `complete_job` and `renew_job`
   made all three renewal/generic-completion/plan-completion cases **accept**
   expired work: three meaningful failures. Correct definitions were restored
   in a `finally` block and the final cases pass. `settle_expedition` separately
   passed the same blocked-wait check; it was not claimed as a newly reproduced
   defect. Tests assert no plan/guard/grant/lease-extension side effects.
3. Two scratch-harness mistakes were corrected before that evidence: CRLF
   replacement initially left the post-lock assignment intact, and generic
   unsafe JSON binding initially produced an invalid plan. Neither is counted
   as the meaningful RED above; final RED used valid plans accepted by old code.
4. Token and status regressions now commit a replacement token or pending
   status while the contender is proven blocked, then confirm it rejects the
   newly current row. Owner-completed overflow privacy and every new public
   RPC/player-stage-mutation denial received explicit assertions.
5. The old Task 7 expedition integration-wait assertion now expects the available
   expedition backend/historical processing DTO. Arena remains unsupported.

Sandbox-denied Docker/CLI telemetry/Deno operations were rerun with authorized
local escalation; these are environment failures, not product RED. A scratch
parity script variable shadowing error was fixed before the successful comparison.

## Migration-only proof and final commands

CLI 2.120.0/version/current query/pull/reset/lint/advisor help were checked.
Official CLI reset and PostgreSQL current-time docs were inspected; the markdown
changelog fetch was unsupported by the web tool, so the HTML changelog was used.
The local container's `com.supabase.cli.project` label was verified `Cloudiator`.
No hosted database, raw status, gateway configuration, credential-bearing file
or key value was printed.

The prior worker's CLI-generated M06 draft was retained. It was completed with
all 18 current source function definitions and explicit source-equivalent ACLs.
There are eight changed existing functions, ten new functions, and zero
unchanged function re-emissions. Its new triggers use the already existing
`guard_frozen`; no source DML initialization/backfill or invoker-view change was
needed. M01–M05 have no changes.

| Command/check | Newly observed result |
| --- | --- |
| Owning `test:db -- tests/db/expeditions.test.ts` after lease correction | 20/20 passed, including real private Edge worker HTTP. |
| `npm test -- tests/domain tests/backend` | 297 passed in 11 files. |
| `npm run typecheck` | TypeScript, both frozen Deno entrypoints, 2 Deno runtime tests passed; final rerun after test changes also passed. |
| Verified local psql source iteration, lint, advisors | Source applied successfully; lint empty; six INFO unused indexes only. |
| `db reset --local --no-seed --yes` | Clean M01–M06 replay succeeded, captured in ignored log. No source reapplied afterward. |
| Source/replay schema comparison | All 258 entries identical: function bodies/definitions/search paths/security/ACLs; relation ACL/RLS/options and view definitions; policies, triggers, constraints. |
| `npm run test:db` against migration-only database | 103/103 across all five DB/Auth/Edge suites. |
| Focused final privacy/current-token additions | 4 passed, 16 skipped in owning file; no further source changes. |
| Post-test schema comparison | 258 identical entries again, proving temporary hook/clock teardown restored the replayed schema. |
| `migration list --local` | All six local/applied versions match. |
| Post-replay lint / advisors | No lint issues; six INFO unused-index notices, no warning/error. |
| `CLOUDIATOR_BROWSER_TEST=true; npm run build` | Fresh isolated static export succeeded. |
| `npm run verify:static -- .next/browser-test` | Four fixed routes, 81 assets, no forbidden backend material. |
| `git diff --check` and staged check | No whitespace errors; only configured LF/CRLF notices. |

Six retained INFO indexes: operation receipts gladiator, boundary members
gladiator, jobs activity, jobs gladiator, dependency prerequisite, stage reveal.
They are retained for their intended access/retention paths; unused on this
local fixture workload does not prove uselessness.

DB fixtures exercise minute79/80 via rollback-only database clock control,
full and failed trips, stale inventory and reservation replan, full inventory
overflow/held fees, ledger-insertion rollback, malformed-hook rollback and
worker failure, current/stolen/expired/exhausted leases, dependency dispatch,
due/future RLS and replay whitelist. Clock controls are trusted test SQL,
never a player endpoint. Final HTTP tests exercise both command/auth behavior
and the private worker endpoint through running local containers.

Edge/Auth/REST/Kong/DB remain running after replay. Port3000 was already refusing
connections at continuation entry and the controller was notified; this worker
did not stop or alter that preview. Static build used isolated output. No broad
browser suite was run for this backend-only change.

## Remaining gates and handoff

- Controller: independent full-base review, report/review integration, guidance
  evidence status, HANDOFF and push. Its existing HANDOFF working change was
  intentionally left unstaged and untouched by this worker.
- Tasks 10/13/15: public projection/revision and timeline reads, safe completion
  identity/result with owner-only rewards, presentation and expired/non-replay
  UX. Stage wire type is unchanged; additive overflow remains private.
- Task 16: combined league/progression index and historical gear integration;
  this task grants XP without free points/stamina and preserves frozen history.
- Task 19: consume dependency/lease primitives for tournament graphs without
  simulating an entire bracket in one job.
- Task 22: prune details after seven days and activity/financial summaries after
  90 days while keeping permanent settled-slot guards. New plan/dependency/stage
  FK relationships require an explicit pruning order; retention is not added here.
- Tasks 23/24: hosted CPU/load/FPS/budget measurements, configured Vault/Cron/
  pg_net/worker secret/deployment and exact-origin checks. Local verification is
  not hosted launch proof. Arena and season hooks retain their existing later
  integration gates.

The approved persistent migration/lease guidance already covers the observed
issues; no further substantive skill update is proposed. Vendor caches,
AGENTS, job-leases guide, other task reports, UI/art/scenes, fixture gateway,
static scanner and package versions were not changed by this worker.
