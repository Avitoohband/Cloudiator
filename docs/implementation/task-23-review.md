# Task 23 independent reviews: release security, accessibility and measured capacity

Plan: [Task 23 plan](../superpowers/plans/2026-10-19-task-23-release-readiness.md) (Tasks 23.7–23.9 appended in `51875a7`). Spec: [game design §10–§13](../superpowers/specs/2026-10-11-gladiator-arena-design.md) and, for 23.7–23.9, the [database budget design](../superpowers/specs/2026-10-19-database-budget-design.md). Each checkpoint has a fresh implementer and an independent reviewer; reviewers may run read-only catalog queries against the local stack "Cloudiator". Reviewers: Opus for the task reviews of 23.1–23.9, Sonnet for the scoped re-reviews of fix rounds, the builder check of the database design and the small Task 23.10, and the most capable model (Fable) for the final whole-branch review. 23.4, 23.5, 23.9 and 23.10 also had a visual review.

At Avi's request for parallel agents (2026-10-19), the task ran in two lanes. Lane A (database and backend: 23.1, 23.2, 23.3, 23.6, 23.7, 23.8) ran serially in `Cloudiator-claude` on `claude/task-23`, because there is one local stack and database runs cannot overlap. Lane B (UI only, no database or Edge: 23.5, 23.4, 23.9, 23.10) ran in `Cloudiator-replay` on port 3300, on `claude/task-23-ui`, `claude/task-23-ui2` and `claude/task-23-time`. Every lane-B checkpoint was moved onto `claude/task-23` and the full gate, database tests included, ran on the combined tree (see "Parallel lanes and integration"). The task grew twice: Avi's database budget decision after 23.3 added 23.7–23.9, and Avi's approval of shorter slot times after 23.9 added 23.10.

The work was interrupted twice. Both lanes stopped once mid-work on an API usage limit and resumed from their uncommitted state with the runtime unchanged. Avi then paused the work on 2026-10-19 ("take a break") after the 23.7 review was dispatched; the review result was recorded during the pause. On Avi's "continue" (2026-10-20) the host had restarted: Docker Desktop was launched hidden and started Engine 29.9.1 in 5 s with no `backend.error.json` (no Secrets Engine recovery needed), `supabase start` failed once and passed on retry (transient, as before; output suppressed), the Edge serve was restarted in the background from `Cloudiator-claude`, and Avi's preview dev server was restarted on port 3400 (`Cloudiator-arena`).

## 23.1: Access matrix and hardening (M17)

Range `8e04214..7869303`: `9316d51` (feature, with M17 `20261019075634_release`), `aabb810` (self-review fix: name which cases probe the audit), `441b988` (report), `f7e6534` (fix round 1), `b93caf2` (its report), `68f7511` (fix round 2) and `7869303` (its report). [Implementer report](task-23.1-report.md), including both fix rounds.

**Implementer evidence:**
- One NEEDS_CONTEXT round after RED (4 failed, 9 passed; Edge stable `07:35:42Z`). Beyond the two named items (C1's anon MAINTAIN on the eight M01 tables and M01's default sequence UPDATE), the matrix found: A, authenticated MAINTAIN on the same eight tables; B, authenticated MAINTAIN, REFERENCES, TRIGGER and TRUNCATE on `owner_state`; C, postgres default privileges in `public` giving anon and authenticated TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on future tables; D, service_role's non-DML privileges and defaults; E, platform defaults outside postgres's reach.
- After the rulings, the audit diff between the M16 replay and the source is exactly 30 rows, all revoked by M17. Matrix and visitor tests 14/14; `test:db` 265/265 on the source and on a clean M01–M17 replay with Edge stable (one run discarded for an Edge recreation); unit tests 1102; the 1127-line fingerprint identical; lint empty; advisors 4 INFO.
- `db pull` reported "No schema changes found" for this privilege-only source, so M17 was created with `migration new` and completed verbatim from `15-release.sql`.
- One full source run hit a transient `MultiXactId … apparent wraparound` on a TRUNCATE (the local database after the unclean host reboot). It did not recur in three later full runs, `amcheck` was clean, and the clean replay recreated the database. The separate connection in `auditAfter` is an untested precaution.

**Verdicts:** first review spec ❌ (a Review Focus 1 gap) and quality Needs fixes, with one Important. The scoped re-review of fix round 1 found I1 addressed and one new Important (N1); the re-review of fix round 2 found N1 addressed and nothing open. The checkpoint is clean after two fix rounds. Commit trailers were verified by the controller (1/1/1).

**What the reviewer confirmed:**
- **One source of truth:** one read-only SELECT (`scripts/access-audit.sql`) drives both the local matrix and the hosted runbook comparison; only OPEN and the service_role snapshot are hand-listed.
- **The privilege model is correct:** effective privileges come from `has_*_privilege`, so PUBLIC grants and role membership surface under each role; raw PUBLIC rows use `acldefault` for a null ACL; default ACLs are combined as PostgreSQL combines them; overloads are named by input types.
- **Coverage:** relation kinds r/p/v/m/f/S, column-only grants (PUBLIC's `attacl` included), procedures and aggregates; extension members excluded via `pg_depend`; an unknown role name raises an error.
- **The assertions are not vacuous:** anon and PUBLIC are checked by exact equality, each catalog probe plants a violation inside its assertion's filter, and the new-object case anchors on service_role's default rows.
- **Data API checks are realistic:** 42501 against 55000 is decided per command with `pg_relation_is_updatable`; four real owner-targeted writes, a forged `create_gladiator` among them; a whole-database content hash before and after (not flaky: both cron ticks return early while the scheduler is off).
- **M17 is complete and ordered** for the local replay, and no app path needs a revoked privilege (`src` and the Edge backend only SELECT `owner_state`; TRUNCATE appears only in test fixtures that run as postgres).

**Important finding I1 (fixed in two rounds):** the matrix could not see one player reading another player's private state. Case 2 proved only that every readable table has some SELECT policy, which `using (true)` on owner data would satisfy, and the audit's policy rows carried no expression, so the hosted comparison was blind to policy bodies.
- **Fix round 1 (`f7e6534`):** a catalog-driven cross-account read loop (a second account with its own gladiator reads every authenticated-readable relation outside OPEN and never sees the owner's ids); policy rows gain an md5 of their USING and WITH CHECK expressions and the permissive flag; a catalog assertion that every such SELECT policy names `auth.uid()`. RED with a planted `using (true)` on `wallets` (both new checks failed) and with `using ((select auth.uid()) is not null)` (only the loop failed). 16/16; `test:db` 267/267 with Edge stable. No leak was found and no schema changed.
- **N1 (re-review of round 1):** the loop was vacuous for `owned_cosmetics`, `reservations` and `pending_build_items`, which had no rows in the test world, and nothing asserted a per-relation anchor.
- **Fix round 2 (`68f7511`):** each gladiator now gets a held fee reservation, a pending build item and a bought banner, and every non-OPEN relation must hold one of its reader's own ids. RED with a non-filtering policy on `reservations` and a restrictive `using (false)` on `owned_cosmetics`, each planted under a shell trap that removes it; 16/16; `test:db` 267/267 with Edge stable.

**Controller rulings (see the appendix):**
- Revoke A, B and C in `15-release.sql` and M17; keep D pinned in the snapshot and documented; accept E as documented platform exceptions, to be confirmed read-only on the hosted project in Task 24.
- I1 is in scope (Review Focus 1 is 23.1's) and is fixed as described above.
- postgres's own defaults in the `storage` schema (which the implementer added to E) are accepted explicitly as harmless, because nothing is created in `storage`; no schema change.

**Minors:**
- **Closed by ruling:** M1 (exception E widened to `storage` without a ruling).
- **Deferred:** M2 (no probe plants a membership grant, a schema privilege or database CREATE), M3 (extension members are invisible to the hosted comparison), M4 (finding rows export raw `proconfig` and `reloptions` values: print setting names only, before Task 24 uses the export), M5 (a source comment overclaims about global defaults), M6 (the runbook CSV comparison should use `Import-Csv` and a temp folder), M7 (the seeds case checks static rows; paging has no order), M8 (noise: the MultiXactId error, one `tsc` segfault, one Edge recreation).
- **Fix-round minors (deferred):** the round 1 plants were a manual committed-then-dropped procedure with no wrapper (round 2 used a shell trap); the md5 and `search_path` wording overstates; the seed-realism wording overstates (fee 10, the equipment reservation JSON); the relation set is not pinned (the safe direction).

**Reviewer notes:** the hosted PostgreSQL major version (M17's MAINTAIN and the audit need PostgreSQL 17) and the hosted Data API's exposed schemas (`private` must not be exposed) are Task 24 checks. The hosted policy-hash comparison needs the same `search_path` on both sides.

## 23.2: Timing correctness (M18)

Range `7869303..656cdd0`: `27a9e62` (fix, with M18 `20261019102324_timing`) and `656cdd0` (report). [Implementer report](task-23.2-report.md). `27a9e62` was also cherry-picked into lane B as `659618b` for 23.4's published-slot consumer (C5) and skipped at integration.

**Implementer evidence:**
- A new static check, `tests/stable-slot-waits.test.ts`, found the two named over-budget waits and two more (the market and shops hooks); each timeout is now written as the longest sleep plus the default allowance.
- RED: 7 unit failures; dispatch gave `[5, 0, 0, 5, 0, 5]` for `[5, 0, 5, 0, 5, 0]`; the held arena tick dispatched 2 of the 3 invocations it needed (held publication 121,345 ms).
- Unit tests 1110; typecheck; `test:db` 269/269 on the source and on two clean M01–M18 replay runs with Edge stable; the 1134-line fingerprint identical; lint empty; advisors 1 INFO.
- Held-window publication fell from 121.3 s to 61.4 s; every run after the change published in 61.3–61.7 s (arena and tournament, cleared and held windows).
- migra's `create or replace view` in the M18 draft named no options and would have dropped `security_invoker`; the source's statement replaced it, and the draft also gained both function ACLs, the backfill and `notify pgrst`.
- Two refinements of Decision 4, each from an observed false deferral in the real cadence test (retries in lockstep): the opening coordination is asked once, and each wait adds up to 250 ms of jitter.

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings. Trailers verified (1/1).

**What the reviewer confirmed:**
- **Decision 3:** all four over-budget waits are fixed with summed timeouts (arena 121 s + 60 s, tournaments 61 s + 20 s, market hook 181 s + 30 s, shops hook 121 s + 30 s); the remaining callers were checked by hand, and the reviewer ran the static check (2/2).
- **Decision 4 as ruled:** at most 3 retries, 250–499 ms apart; the opening coordination asked once; `deferred` also counts a coordination still busy after its retries, and the report shape is unchanged.
- **Decision 5:** each scheduled minute is the window `[now − now % 60000, +60000)`, with `clock_timestamp()` sampled after the advisory lock as AGENTS.md requires; no path exceeds 5 dispatches per calendar minute (216,000 in a 30-day month, 223,200 in a 31-day month); the held arena tick now dispatches its full need.
- **Decision 6:** `publishedSlotIndex?: number | null` is additive and optional; OPEN is unchanged.
- **The copy is consistent by construction:** the deferred constraint trigger fires inside the coordinator's transaction, concurrent publishers serialize on its row lock, and commit and rollback are both tested.
- **M18 is complete** (the view body is 06-projections' plus one column), and the static check is not vacuous: it parses with the TypeScript compiler and refuses unknown shapes, non-constant margins and orphan waits.

**Controller rulings (see the appendix):**
- Decision 4 as implemented (3 retries 250 ms apart plus up to 250 ms jitter, no retry of the opening coordination) is accepted, and `deferred` keeps its broader, documented meaning.
- Carried to Task 24: deploy M18 and the worker before or with the client, because `readRevision` hard-selects `published_slot_index`.
- Carried to 23.4: `publishedSlotIndex` is null before the first coordination; lane B adds it to the browser mocks and treats null as "not yet published".
- The 23.2 upkeep proposal (check view options) is dropped: AGENTS.md already lists invoker-view settings in its compare and inspect steps.

**Minors (deferred):** M1 (`15-release.sql:106-107` and `migrations.md:28` say `create or replace` keeps `security_invoker`; it keeps the grants, and the WITH clause must restate the option; taken by the final fix wave as final Minor 3), M2 (the access-matrix delete probe `.is(col, null)` now matches the `world_revision` singleton: use a contradictory filter), M3 (the static check proves timeout ≥ sleep + default rather than sleep + work, scans only the top level of `tests/db` and recognizes one helper name), M4 (the zero-deferral cadence assertions are now probabilistic, about 0.15 % a herd), M5 (an operator's external lease makes post-work coordinations retry and count as deferred), M6 (report accuracy: about 7.5 s wall bound per invocation; retries can sleep with leased unrun jobs; 223,200 in a 31-day month), M7 (noise: Edge recreations after test edits, three pre-jitter failed runs, the tournament cadence test not run RED).

**Reviewer notes:** hosted `dispatch_log` spacing and CPU are C4 (Task 24). Neither 23.1 nor 23.2 was pushed: 23.2 changed `src` (reads and contracts), so the browser gates had to run on the integrated tree first.

## 23.3: Capacity measurement (and M19, M20)

Range `656cdd0..5e4e2e8`: `a167ab9` (the harness, with `CAPACITY_GATE`), `caf8ec0` (report), `119f36b` (the latency fix, M19 `20261019124532_dispatch_released`), `a857b9c` (its report), then fix round 1: `76449e6` (M20 `20261019132814_shared_reveal`), `91f3a94` (the cadence case pinned to 50 characters; sections printed only in report runs), `7ad457f` (a missing measurement reported as missing), `7dc24fd` (the zero-headroom risk named) and `5e4e2e8` (report). [Implementer report](task-23.3-report.md); the measured numbers are in [release-evidence.md](../operations/release-evidence.md), "Lane A: capacity".

**Implementer evidence:**
- **BLOCKED first** (uncommitted harness; units 1117; `test:db` 271/272, only the capacity budget case failing, Edge stable). The database at 50 always-scheduled characters reached 150.6 % (new-character schedule) and 178.1 % (mixed) of 250 MB at 90 days, 227.8 % and 274.0 % after a year, and 118 % at 90 days even with no commands. Boundary latency was 121.6 s (101.3 % of 120 s) after any slot with expeditions: settlements waited on the "Arrive at camp" reveal due at the cutoff, and dispatch counted only ready jobs. Raw egress was 81.6–83.7 % (risk; gzip about 19–20 %), 117–121 % with the backend's own traffic (a blocker only if hosted is uncompressed and bills Edge-to-API traffic); invocations 13.9–14.3 % (82–85 % at the dispatch ceiling, risk); worker CPU at most 9.5 %, season close at most 0.1 %, standings at most 0.9 %.
- **After M19:** boundary publication 61.6 s in the worst of 7 windows (51.3 %; was 121.6 s); `test:db` 274/274 on the source and on a clean M01–M19 replay (one source run discarded for an Edge recreation 5 s in); M19's fingerprint matches the source; lint empty; advisors INFO only. The database stayed at 150.5–178.1 % at 90 days, pending Avi. Raw egress 77.1/79.0 % (risk), gzip 18.6/19.0 %, raw with backend traffic 113.0/115.9 % (a Task 24 question); invocations unchanged.
- `test:db` now takes about 6 minutes, and the access-matrix service_role snapshot gained one line for the new helper.

**Verdicts (first review, range `656cdd0..a857b9c`):** spec ❌ and quality Needs fixes, with two Important. After fix round 1 the scoped re-review found I1, I2, M3, M5, M7 and M8 addressed and nothing open: `claim_jobs` byte-identical to the source, only the new migration added, trailers present. All four first-review commits carry the trailer.

**What the reviewer confirmed:**
- **M19 is complete:** the three function bodies are byte-identical in the migration and the source, the ACLs are complete, the helper is created before its callers, all three are invoker with `search_path=''`, and none is SECURITY DEFINER; M01–M18 are untouched.
- **Dispatch counting is sound:** each job row is counted once, `releasedSettlements` is informational, and the cap per scheduled minute and the time-after-lock order are unchanged from M18.
- **Claims:** non-settlement claims behave as before; the settlement claim never waits (SKIP LOCKED), re-checks the settlement and its reveals under the lock, and checks the cap before locking, so a group is never split.
- **The harness measures real behaviour:** real creation, the real `cron_tick`, the real Edge worker through pg_net, the app's read adapters and zlib on real bodies; the clock stand-in and Vault secrets are restored and checked. `CAPACITY_GATE` is the only switch on case 1's budgets.
- **`resource-report.mjs` is careful with secrets:** in-memory discovery, loopback only, `CLOUDIATOR_DB_URL` removed from the child environment, and no raw failure text printed.

**Important findings (both handled in fix round 1):**
- **I1:** the fix had zero headroom, and the evidence called it "ok". At 50 all-expedition characters the cutoff tick is exactly full (5 invocations × 20 simple jobs = 100 jobs); a 51st character steps back to about 121.6 s (derived, not measured). The cadence test also read `CAPACITY.players`, so any `--players` other than 50 failed the suite. Handled by ruling as a named risk: the evidence states the cliff in four places, the cadence case is pinned to `TARGET_CHARACTERS = 50`, and case 1's boundary check applies up to 50 characters only. `--players 60` now passes the suites and reports slot 302 at 121,811 ms.
- **I2:** "reveals first" was not guaranteed when settlements share a reveal (a tournament final): the shared reveal was listed once per settlement, counted against the cap each time, and under a hash-join plan could be leased after a settlement. Fixed in the new migration M20 (`and p.id<>all(picked)`). RED on M19: cap 3 took `[R, S1]`, and a forced hash join leased `[S1, R, S2]`. GREEN 4/4; the M01–M20 replay fingerprint equals the source's; unit tests 1122; `test:db` 275/275 on the source and on the replay (one replay run discarded: Edge recreated 4 s in).

**Controller rulings (see the appendix):**
- Boundary latency is a technical fix the controller owns: dispatch counts the jobs that due reveals release in the same tick (M19), with a cadence test.
- The capacity case's budget assertions run only with `CAPACITY_GATE=1`; the normal `test:db` stays green, and 23.6's gate enforces the budgets.
- The database budget is Avi's decision (see "Database budget decisions").
- I1 is named as a risk, not mitigated now. I2 is fixed in a new migration because committed migrations are immutable, which moves the database budget work to M21.
- The fix round also takes Minors 3, 5, 7 and 8, and the active-character count (the ruled watch for I1) joins 23.7.

**Minors:**
- **Fixed in fix round 1:** M3 (a missing measurement printed "ok"; it is now `missing`, with five new tests), M5 (measurement dumps kept out of normal `npm test` and `test:db` output), M7 (a stale report line), M8 (the failed-reveal coupling recorded in `migrations.md`).
- **Deferred:** M1 (`tests/fixtures/capacity.ts` has at least five concerns and a fourth copy of the clock and Vault pattern), M2 (no real concurrent row-lock test on a reveal), M4 (`monthsToBudget` returns 3 when already over budget), M6 (the worker section depends on module state shared across two tests), FR1 (the report's status block lacks the zero-headroom caveat), FR2 (a JSON excerpt in the evidence reads "ok" without a note), and a shared-reveal case with an extra unfit reveal.
- **Out of scope, closed by 23.6:** the console JSON dumps in the arena, tournaments, recovery and restore-world DB tests now print only with `CLOUDIATOR_MEASUREMENTS=1` (C23).

## 23.5: Accessibility and the release browser spec (lane B)

Range `b6bd8c7..f238eda` on `claude/task-23-ui`: `3d119f2` (feature), `28cd329` (report), `c63a060` (fix round 1) and `f238eda` (its report); on `claude/task-23` they are `4e778da`, `00a0051`, `ad0a316` and `73309de`. [Implementer report](task-23.5-report.md). Built in `Cloudiator-replay` with no database or Edge, in parallel with 23.1.

**Implementer evidence:**
- RED: 32 browser failures across `release.spec.ts`, `market.spec.ts` and `full-screen.spec.ts`, each for missing behaviour (the first Tab skipped the skip link, the focus fell to `<body>`, a receipt was not focused, `aria-invalid` was missing, contrast was 1.83:1, 1.67:1 and 3.28:1, there was no `aria-valuetext`, a double open pushed two history entries, a remount read the timeline three times).
- Unit tests 1105; typecheck; assets; build; `verify:static`; development suite 489 passed, 27 skipped on port 3300; production gate 20 passed, 496 skipped on port 4173; `git diff --check` clean.
- Concerns: one "bout ended" definition (the logged end) changed a Task 17 test's edge case; the stale-closure fix after a session refresh cannot be ordered in a browser test; contrast is measured against the camp's base colour because the panels are translucent; four visible changes for Avi (screenshots sent 2026-10-19).

**Verdicts:** first review spec ❌ and quality Needs fixes, with three Important; the Task 17 test change was accepted (it matches the server's `boutEndMs`). After fix round 1 the scoped re-review found all four items (I1–I3 and the Minor 1 ruling) addressed and nothing open.

**What the reviewer confirmed:**
- **Keyboard and links:** the skip link is the first Tab stop on every route, the production build included; `aria-invalid` and `aria-describedby` are in Build, Schedule, Shop, Market and Create, and every `aria-describedby` target is rendered under the same condition that sets the reference.
- **C17–C20:** the progress bar's `aria-valuetext` and the standings snapshot; the focus after a trade and all four `task-18-review.md` gaps; the skip link, the focus rescue, one bout-end definition, the double-open race, the remount and the stale closure; a test for every C20 gap. R2 is pinned, reduced motion stays OS-driven and "last known camp" stays.
- **The focus rescue** acts only when the focus is on `<body>` and the control it remembers is unusable; a pointer press clears that memory; its order is documented. No case was found where it takes the focus from another panel or from the camp.
- **The Task 17 test change hides no regression:** the server publishes a bout's end as its start plus `durationMs` (`08-arena-bouts.sql:239`), and the ring and the card read the same `boutEndMs`.
- **Contrast is not vacuous** at today's colours: at worst, 86 % glass over pure white, body ink is about 10.8:1, `--ink-dim` about 5.8:1 and `--field-line` about 3.3:1.
- **Visual:** the skip link (a gold pill with the gold ring, clear of the chip), the field edges `#7a86a0`, the chosen merchant (gold on dark brown) and the 360 px sheets and scenes (nothing clipped); the focused receipt shows Chrome's default white ring (Minor 2).

**Important findings (all fixed in round 1, `c63a060`):**
- **I1:** Build's `invalid-input` message (a fractional, negative or over-cap attribute) was linked to no field. Each attribute that is not a whole number from 0 to the cap is now marked invalid and described; a browser case fills `1.5` and `-1`.
- **I2:** dismissing the auto-opened creation dialog by keyboard (Escape, or Enter on Not now) left the focus on `<body>` (found by code reading). The dialog now closes itself and hands the focus to the chip's "Create your gladiator"; both keys are tested, and a negative control proves the focus watcher records a drop.
- **I3 (plan-mandated):** Decision 8's accessibility snapshots were missing for the rail, a menu frame, the scene, the creation dialog, the purchase confirmation and the profile card. All are pinned; the menu frame's title stays a paragraph, as it is.

**Fix-round evidence:** RED 10 failed, 8 passed (the snapshots and the negative control pin existing behaviour); covering specs 199 passed, 19 skipped; unit tests 1105; development suite 503 passed, 27 skipped; production gate 20 passed; `git diff --cached --check` clean. Two tests timed out once under parallel load and passed alone and in later runs.

**Controller rulings (see the appendix):**
- Minor 1 (focusing a trade's outcome scrolls the menu for pointer users too, and overrides a focus moved during a pending command) joins the fix round: the outcome takes the focus only after a keyboard command or when the focus was lost. Build and Schedule follow the same rule.
- A Retry or Reload for a failed log or replay belongs to 23.4, with the camp Reload (R13) and the failed-log retry (C9).

**Minors (deferred):** M2 (inconsistent focus rings: Chrome's default white ring on the outcome paragraphs and the Inventory and shop fields), M3 (`boutEndMs`'s comment overclaims for expeditions), M4 (latent gaps in the contrast helper), M5 (coverage: the live forms are not walked by Tab; outcome focus is untested for Inventory, Build and Schedule; `role="application"` is in no scope), M6 (more unlinked messages: Build's server refusals, Inventory's quantity), M7 (the production export logs 404s for the App Router's `__next.*.txt` prefetches; Task 24). Fix-round minors: no outcome-focus test for Build, Schedule and Inventory; `wholePoints` mirrors the domain rule; modality is inferred from `:focus-visible`; the receipt can be below the fold for pointer users; a creation dialog unmounted while open may drop the focus; raw reason codes in copy ("invalid-input").

**Visible changes awaiting Avi:** the skip link on the first Tab, the lighter field edges (`#7a86a0`), the chosen merchant's dark fill and the receipt's focus ring (screenshots sent 2026-10-19).

## 23.4: Read volume and render cost (lane B)

Range `f238eda..6a98476` on `claude/task-23-ui`: `fc99367` (everything except C5), `659618b` (the cherry-pick of 23.2's `27a9e62`), `38e0a74` (a copy of 23.1's access fixture, which the cherry-picked matrix imports), `59036a8` (C5), `1271b39` (report), `598e749` (fix round 1) and `6a98476` (its report). The two lane-A copies were skipped at integration; the other five are `f16c8cf`, `54e8aa2`, `5139e5f`, `199b86e` and `a2ed84a` on `claude/task-23`. [Implementer report](task-23.4-report.md). The task started on everything but C5 while 23.2 ran and finished C5 after the controller sent 23.2's contract commit.

**Implementer evidence:**
- **What it built:** C7 (a 64-entry least-recently-used tournament log cache); C8 (the camp pauses under an opaque scene: 7,852 WebGL draw calls a second on desktop under the replay scene before, none after); R13 (a camp Reload, and Try again on an unavailable replay and a failed tournament log); C9 (ring order independent of arrival order; failed ring logs retried after 2, 4, 8 and 16 s, then every 30 s, by real time); C11 ("being prepared" re-reads back off after three minutes); C5 (the published slot replaces the five-minute grace); C6/C25 (owner, `/replay/` and Arena reads de-duplicated: 8 Arena timeline reads instead of 13); the opt-in `?perf=1` overlay and the FPS harness.
- RED: 8 unit and 20 browser failures (both projects), each for missing behaviour; C5 had 2 unit and 2 browser failures after the cherry-pick.
- Unit tests 1124; development suite 525 passed, 25 skipped on port 3300; production gate 24 passed on port 4173.
- FPS (headed Chrome 155, RTX 4090 through ANGLE D3D11, a 170 Hz display): desktop at about 170 fps (the vsync ceiling) with 0 % of frames over 16.7 ms in every camp phase; the Pixel 7 project with 4× CPU throttling (indicative only) 123.2 fps mean in the scene cycles.
- Behaviour changes for review: no owner refresh before a "being prepared" re-read once a slot is published; a tab return reads the owner after the revision; Arena timelines load two at a time. C24 unchanged.

**Verdicts (first review, two packages: `f238eda..fc99367` and `38e0a74..1271b39`):** spec ❌ (one Important) and quality Needs fixes. After fix round 1 the scoped re-review found I1 addressed and nothing open.

**What the reviewer confirmed:**
- **Each risk has a test of the behaviour, not a proxy:** real draw calls for C8; a fake clock with the per-tick read pattern for C11; swapped arrival order of two 24-entrant leagues for C9; owner-read cases for a revision change, a tab return with and without a change, creation and `/replay/`; Reload and Try again recovering once the failing read is served again.
- **The pause is sound:** it applies only to a ready camp; Phaser 4.2.1's `step` checks `pendingDestroy` before `isPaused`, so an unmount while paused still destroys the game; a hidden tab's resume restores only the loop; camp positions are clock-driven.
- **C5 is conservative:** the published slot is captured at read start, so the 30 s sync lag can only extend "being prepared"; the re-read on publication is bounded; the null path keeps the old rule.
- **The LRU is safe** while a replay is open; **de-duplication drops no needed refresh** (a tab return still reads the owner when the revision did not change; command paths still refresh explicitly); **Arena partner skips** are safe.
- **The overlay is opt-in** (`aria-hidden`, no focusable content, no pointer events), and the harness is unreachable from both gates.
- **Visual:** Reload matches the camera buttons; Try again uses each surface's button style; the overlay is a small developer readout clear of the chip and the notices.

**Important finding I1 (fixed in round 1, `598e749`):** inserting the Try again rules split an existing selector list in `TournamentPanel.module.css`, so the round tabs, Watch replay and the sample buttons lost the panel's 3 px gold ring at a 2 px offset and fell back to the global ring at 5 px, which the round-tab strip clips. The original rule is restored with `.retry:focus-visible` beside it, and a new test requires the gold outline at 2 px (RED on both projects with `"offset": "5px"`). Covering specs 129 passed, 3 skipped; unit tests 1124; development suite 527 passed, 25 skipped; production gate 24 passed; 360×740 screenshots added.

**Controller rulings (see the appendix):**
- Start 23.4 on everything except the published-slot consumer, and hand it 23.2's contract commit later.
- C24 (diagonal speed, atlas split) stays deferred: the harness shows desktop at the vsync ceiling with 0 % long frames.
- C6's remaining standings and profile re-reads stay: compressed egress measured about 20 % of the budget; revisit with Task 24's hosted measurement.

**Minors (deferred):** M1 (the camp fallback's live region is remounted), M2 (the C9 batch can hold a landed view longer than 5 s), M3 (overlay measurement quality: a 200,000-interval sort every second, statistics from mount, a truncated renderer line; fix before the Task 24 device measurement), M4 (the overlay-over-scene test proves little), M5 (the unproven "no lost WebGL context" claim), M6 (a `console.log` in a gate spec; moved behind `CLOUDIATOR_MEASUREMENTS=1` by 23.6, C23), M7 (a fixed sleep in an Arena read-count test), M8 (the camp's missing-view tournament re-read every 30 s is not backed off).

**Reviewer notes:** every mobile screenshot was the Pixel 7 project (412 CSS px) until the fix round added 360 px shots; mobile 30 fps is unmeasured and stays a Task 24 blocker; the timing of `published_slot_index` is proven by lane A's database tests. Out of scope, the re-review noted that the inline tournament replay text touches the card border at 360 px (a pre-existing `.replay` margin; Avi's call, cosmetic).

**Visible changes awaiting Avi:** the camp Reload, Try again on a failed replay and tournament log, and the `?perf=1` overlay and its placement (screenshots sent 2026-10-19).

## 23.6: The release gate

Range `a2ed84a..6d1802c`: `c9dc6f4` (the gate and its evidence), `62c4137` (report), `6bb7380` (fix round 1) and `6d1802c` (its report). [Implementer report](task-23.6-report.md); evidence in [release-evidence.md](../operations/release-evidence.md), "Release gate (Task 23.6)". Dispatched with the controller's amendments: no push (the controller pushes after the final review and records the first Actions run), no migration (M21 reserved for 23.7), the capacity blocker expected and named, the C22 pre-read and a stable Edge start time in `verify.mjs`, `market.spec.ts:463` in the flake triage, C23 covering the DB-test console dumps, CSP violations failing the production gate, and private ports and configs.

**Implementer evidence:**
- **What it built:** `npm run verify` (`scripts/verify.mjs`) runs every gate of `verification-gates.md` in order, skips only the dependents of a failed step, and exits 0, 2 (known blockers only) or 1. Decision 7's `_headers` is written after `next build`, which also removes `assets/gallery.html`; `serve-static.mjs` applies it; the scanner requires it byte for byte and refuses any JWT and base64-encoded `service_role`; every browser spec goes through a CSP listener; `.github/workflows/checks.yml` runs the gate on a fresh stack; R6 rule-retention tests; C23 output cleanup.
- **Four runs:** run 1 exit 1 (a host fault, `net::ERR_NO_BUFFER_SPACE` on a framework chunk); run 2 exit 1 (Docker Desktop failed at about 15:36 and the Edge serve exited with it; the implementer restarted the serve in the background once the stack was healthy); runs 3 and 4 exit 2. Run 4 (16:17–16:33Z): units 1204; typecheck, assets, build and `verify:static` (91 assets); the Edge step refreshed 735 entries and settled in 34 s; `test:db` 276 passed plus the capacity budget blocker (150.6–178.6 % at 90 days); development 527/0/31; production 30/0/528; `git diff --check` clean.
- **Findings:** for C22, a read refreshes only an access time older than an hour, so the gate now sets the access times explicitly (`SetFileTime` through an attribute-write handle, modification times unchanged), with 0 detections afterwards. C21 was not reproduced in 55 runs and `market.spec.ts:463` not in 56. CSP: 0 violations, and the listener proven. `npm audit`: 0 vulnerabilities in 152 dependencies. The actions were pinned to major tags at first.

**Verdicts:** first review spec ❌ (three Important plus one doc-coupled) and quality Needs fixes. After fix round 1 the scoped re-review found I1–I4 and the five round Minors addressed and nothing open; the SHA pins were verified with `gh api`; `verification-gates.md` differs from `a2ed84a` only inside the approved Edge section. Both first-review commits carry the trailer.

**What the reviewer confirmed:**
- `runGate`, `classifyDb`, `classifyBrowser` and `summarize` are pure and tested with a fake runner; the summary names the blocker, its owner and its evidence and never counts it as a pass; another capacity budget failing beside the blocker fails the run.
- Decision 7 is pinned literally; `verify-static.mjs` requires `_headers` byte-equal to the generated file; the origin check rejects lookalike hosts, embedded credentials and plain-http hosted URLs; the base64 needles are correct at offsets 0, 1 and 2.
- `serve-static.mjs` applies the headers to 200, 403 and 404 responses, never serves `_headers` and refuses an export without it.
- The 22 specs changed only their imports (plus `console.*` to `recordMeasurement` in two); only `csp.spec.ts` sets `allowCspViolations`; the C23 moves keep every assertion.
- The workflow holds no secret, has read-only permissions, writes the `supabase start` output to a file, generates a random worker secret and uses the pinned supabase 2.120.0 and deno 2.9.6.

**Important findings (all fixed in round 1, `6bb7380`):**
- **I1:** exit 2 could hide describe-hook failures (their tests are only skipped) and unhandled errors beside the known blocker. `blocked` now needs every failed test to be a named budget check and every failed suite to enclose one with no error of its own; module and unhandled errors come from a new reporter (`scripts/vitest-gate-reporter.mjs`).
- **I2:** the access-time refresh followed junctions out of `supabase/functions` (reproduced on a scratch junction), and a failed refresh passed silently. It now opens a link itself (`FILE_FLAG_OPEN_REPARSE_POINT`), skips links and never descends into them, checks that every entry is under the resolved root, and fails the Edge step as an infrastructure fault with its reason.
- **I3:** the host-fault rerun was decided by co-occurrence, so a real assertion failure could be rerun and pass, and its traces were deleted. The automatic browser rerun is removed: a failure beside a host fault is labelled "probable host fault" with its own first error and still fails (exit 1); the database step keeps exactly one rerun on a changed Edge start time.
- **I4:** `verify.test.ts` depended on unapproved `verification-gates.md` edits. The guide is back to the `a2ed84a` text except the Edge section Avi approved, and the test checks the approved order (`npm run verify` matched only with its backticks, so `verify:static` cannot satisfy it).

**Fix-round evidence:** RED then GREEN per finding. Run 5 (16:58–17:15Z) exited 2 on the budget only: units 1216; the Edge step refreshed 714 entries and skipped 21 junctions; `test:db` 276 plus the blocker with Edge unchanged; development 527/0/33; production 32/0/528, including the committed `test.fail()` CSP case; the actions pinned to SHAs matching v4.

**Controller rulings (see the appendix):**
- A generated `_headers` with the CSP is pulled forward from Task 24 into 23.6 (a pre-flight ruling).
- `verify.mjs` pre-reads `supabase/functions` and waits for a stable Edge start time before `test:db`, with no system setting changed; the explicit last-access refresh is then kept, because it changes only the last-access metadata of this worktree's Edge source.
- The once-only host-fault rerun was allowed only for named signatures, named in the summary, with a second failure failing; after I3 it is removed.
- The `verification-gates.md` edits are reverted to the approved text, because a substantive change needs Avi's approval; Avi then approved the Edge-section extension (see "Edge recreations (C22): cause found").
- Workflow actions are pinned to full commit SHAs resolved with read-only `gh api` lookups.
- I1–I4 are fixed as proposed, and the round also takes four Minors: a finite share of at least 1 for the blocker pattern, a stale comment in `capacity.test.ts`, a committed `test.fail()` CSP case, and the JWT lookbehind after `%20` and escaped newlines.

**Minors (deferred):** `release-evidence.md:575`'s "735 entries, then counting the contents of 21 junctions" is imprecise (735 includes the 21 links); `task-23.6-report.md` describes the removed rerun and the tag pins without a superseded mark; the `test.fail()` CSP case also passes if its body throws earlier; build-headers env loading (a missing URL gives `'self'`, and `.env` files are not read) goes to Task 24; the R6 static-checker gaps (`drop function … cascade`, `drop constraint`, replica triggers) and the config-level `allowCspViolations` switch went to the final review. The `--db-retries` option, which also set browser reruns, was removed in the fix round. `AGENTS.md:185-189` restated the database rule; the controller reconciled it in `51875a7`.

## 23.7: Settled jobs' payloads and the 500 MB budget (M21)

Range `51875a7..51441fa`: `694fe7b` (feature, with M21 `20261019180659_job_payloads`) and `51441fa` (report). The controller's docs commit `51875a7` before it holds the database budget design, the 23.7–23.9 plan section and the AGENTS.md mirror of the Edge refresh rule. [Implementer report](task-23.7-report.md).

**Implementer evidence:**
- RED: 11 DB and 3 unit tests, each for the expected reason.
- Unit tests 1218; `test:db` with `CAPACITY_GATE=1` 284/284 on the source and on the replay, Edge unchanged; the 1138-line fingerprint equals the source's; lint clean; advisors INFO only; `npm run verify` exit 0 with all 12 steps (development 527/0/33, production 32/0/528).
- Against 500 MB at 90 days: mixed schedules 409.8 MiB (82.0 %), new-character schedule 346.1 MiB (69.2 %); after one year 129.9 % and 107.9 %, reported as risk. After `VACUUM FULL`, 829 B a row on disk against 943 B modeled.
- Concerns: `verify.mjs` still listed the database budget as a known blocker; the mixed worst case passes the 400 MB warning before day 90; the resource report exits 1 on the egress-with-backend line (Task 24).
- The verify run ran with the 23.7 changes uncommitted at `51875a7`; the next full run on a committed head (23.8's) covers it.

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings.

**What the reviewer confirmed:** M21's function bodies are identical to the source; the job guard covers all 21 columns; there is no race; every reader of a job's payloads was checked.

**Controller rulings (see the appendix):**
- Retire the database-budget known blocker in `verify.mjs` now that it is cleared, keeping the mechanism with an empty list and its tests; this became Step 0 of 23.8.
- The mixed worst case reaching the 400 MB warning before day 90 is the expected trigger for the after-launch compactions, and the evidence states it.

**Minors (deferred):** M1 (the guard lists columns by name; `to_jsonb(new)-'input'-'result' = to_jsonb(old)-…` would cover future columns; the final fix wave records in the M21 notes of `migrations.md` that the next `private.jobs` schema change must switch to it), M2 (the health report shows no `jobs_compacted_through_slot` or trim-blocked state), M3 (`health.test.ts:340`'s index-scan regex should name `activities_slot_status_idx`), M4 (`retention.test.ts:550` lacks an unfinished-activity blocking case), M5 (`release-evidence.md:75`'s Gate bullet still says "the database … budgets", now 90-day only; part of final Important 1).

## 23.8: Idle characters rest at home (M22)

Range `51441fa..fa24471`: `8db6700` (Step 0: the cleared budget blocker retired), `f1cf073` (the resting and presence contracts, committed first and announced so that lane B could start 23.9), `46f176e` (feature, with M22 `20261020075858_idle_rest`) and `fa24471` (report). [Implementer report](task-23.8-report.md). Dispatched after Avi's "continue" on 2026-10-20.

**Implementer evidence:**
- RED: 16 DB, 2 unit and 3 verify cases.
- Unit tests 1222; `test:db` 299, including the 13 cases of `tests/db/idle.test.ts`; the two phase-4 season cases of `recovery.test.ts` at slot 3000 now give the owners a signal; the capacity model classifies the two new tables.
- The M01–M21 reset fingerprint equals 23.7's 1138 lines, and the M01–M22 replay equals the source's 1160 lines, also after the tests; lint empty; advisors 36 INFO.
- `npm run verify` run 2 exited 0 (units 1222; `test:db` 299 with the capacity gate; development 527/0/33; production 32/0/528). Run 1 failed on `[mobile] release.spec.ts:517`, a contrast read during the expedition scene's "Returned to camp" fade-in (it passes 12/12 alone).
- Spec §4.3 :139, :79 and :428 updated, each marked "Avi's decision, 2026-10-19".
- Concerns: presence carries an `operationId` (a deviation from the brief's literal shape, so that it stays in the command union); `restingUntilSlot` can be `+2` when the owner signals during the next boundary's processing (clients display it, never compute it); creation counts as a signal; a `git checkout` of `15-release.sql` produced CRLF and changed six function fingerprints (fixed; recorded in `migrations.md`).

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings.

**What the reviewer confirmed:** one fixed cohort per boundary; the slot advance is guarded; lock ordering follows AGENTS.md; M22's function bodies are byte-identical to the source; the hourly throttle cannot drop a waking signal.

**Controller rulings (see the appendix):** the verify blocker is retired as Step 0 of this task; 23.7 was split into 23.7, 23.8 and 23.9 because the idle rule touches every boundary phase plus Edge and the client; the idle semantics come from the design rulings (see "Database budget decisions").

**Minors:**
- **Fixed by the controller (`81a57d7`):** M4 (spec §4.3 :139 had a double "until" and :428 lacked the "Avi's decision, 2026-10-19" marker), and with it M3 (the hourly throttle shortens the idle window by up to an hour; §4.3 now says so).
- **Taken by the final fix wave:** M2 (no one-tick multi-boundary catch-up test across the 14-day line; final Minor 5).
- **Deferred:** M1 (the `+2` `restingUntilSlot` case is not carried through boundary S+2), M5 (a no-op `Promise.resolve(boundary)` in the lock-wait test).

## 23.9: The owner's presence and the resting gladiator screens (lane B)

Range `f1cf073..0d0e414` on `claude/task-23-ui2`: `6072d3e` (feature), `b494e17` (report), `9375a46` (fix round 1) and `0d0e414` (its report); rebased cleanly onto `fa24471` as `8e3ce98`, `730ade0`, `dffec51` and `2b18b52`. [Implementer report](task-23.9-report.md). Built in `Cloudiator-replay` from 23.8's contract commit, in parallel with 23.8, with no database, SQL or Edge change.

**Implementer evidence:**
- Unit tests 1230, plus 3 failures in `tests/workflow.test.ts` that also fail at `f1cf073` (`core.autocrlf=true` checks `checks.yml` out with CRLF, and the test expects LF); typecheck, assets, build and `verify:static` pass; development 539/0/35 on port 3300; production 34/0/540 on port 4173 with no CSP violation.
- Screenshots at 360×740; fixture previews `/game/?mode=fixture` (Otho resting) and `?as=resting` (the owner's own gladiator).
- Concerns: the owner is re-read after an answered presence only while resting without a signal; presence is sent only once a gladiator is shown; the owner's own profile card and row showed the public wording; fixture counts changed (15 actors; the camp draws 43, not 44).

**Verdicts:** first review (spec, quality and visual) Needs fixes, with one Important. After fix round 1 the scoped re-review found I1, M1 and M2 addressed and nothing open; both development-suite failures of the fix round were judged unrelated to the diff. Trailers OK.

**What the reviewer confirmed:**
- **Presence transport:** a fresh `randomUUID` operation id per send; `{ok: true}` accepted without a receipt; typed refusals; it never throws. `command()` keeps its allow-list and its receipt requirement.
- **The presence timer:** once when the gladiator is first shown, every 6 hours while visible, a presence due while hidden sent at the next visible moment, never for visitors or accounts without a gladiator, restarted on an account change, stopped on sign-out, no duplicates, no re-read after a stop.
- **Copy and camp:** the owner line uses the shared `slotTimeText` (the Schedule panel now uses it too); the public copy is exact; `layoutCamp` and the roster exclude resting actors, and following stops; the production export refuses `?as=resting`.
- **Visual:** the owner time "10/10/2026, 4:20:00 AM" matched the Schedule panel's existing format (not a finding; a shorter format was Avi's call); the see-through profile card is pre-existing and its contrast passes (grey labels about 5.1:1 at worst, main text about 11:1); the disabled Find and Follow on a resting row are intentional and described.

**Important finding I1 (fixed in round 1, `9375a46`):** the returning owner saw the public "back when …'s owner returns." on their own card and "(you)" row, and "Your gladiator is away from the camp.", while My gladiator said "back on your schedule at …". This contradicted the design ("The owner sees nothing different"). `CampShell` now computes the owner's own line and passes it to the "(you)" row, the find and follow reason and the own card's Now ("Resting at home." until the slot is known).

**Fix-round evidence:** RED first per finding; units 1236 plus the 3 known CRLF failures; typecheck, both builds and the static scan pass; development 537 passed with 2 failures that pass alone (a host `net::ERR_NO_BUFFER_SPACE` fault, and the expedition scene's "Returned to camp" read mid-fade); production 34/0; `git diff --check` clean; screenshots refreshed, with the own row and the own card added.

**Controller rulings (see the appendix):**
- I1 is fixed as the reviewer proposed.
- The round also takes M1 (while resting without a signal, a failed presence is retried once after `retryAfterMs`, or 60 s; the owner line reads "Resting at home." instead of "Preparing your next activity") and M2 (the card's Follow checks `actor.resting`).
- The implementer's extra `!behind` clause on the "Resting at home." line is accepted.
- The `workflow.test.ts` CRLF failure is a 23.6 defect, fixed in lane A after 23.8 (`7d36068`; see "Parallel lanes and integration").

**Minors (deferred):** the retry's state gate applies at scheduling, so a re-read within 60 s can still send one extra presence; no test pins the retry's cancellation on `stop()` or an account change; `ownResting` omits the `!isAway` guard (unreachable by contract); M3 (the card's Follow reason differs from the row's; a resting gladiator vanishes at once while a waking one walks in); the see-through profile card (pre-existing); the slot-time format (answered by Avi in 23.10).

**After the review:** the screenshots went to Avi on 2026-10-20 with a question on the wording and the long slot-time format. Avi kept the wording and asked for shorter slot times (Task 23.10).

## 23.10: Shorter slot times (lane B)

Range `81a57d7..d75e3fc` on `claude/task-23-time` (the same commits on `claude/task-23`): `4a8b670` (feature), `aac3992` (report) and `d75e3fc` (follow-up: keep a slot time on one line). [Implementer report](task-23.10-report.md). Avi's decision of 2026-10-20: keep the resting wording, and shorten slot times to 'h:mm AM' today, 'tomorrow h:mm AM' and a short weekday within the week, through the shared `slotTimeText`, so that Schedule and Build use it too. There is no separate review file; this section comes from the ledger and the report.

**Implementer evidence:**
- `slotTimeText(ms, nowMs)` compares local calendar days, so whole days stay exact through a daylight-saving change. Schedule (:73, :102), Build (:88, with a new clock prop), the resting lines and `CampShell`'s own line use it; `useMinuteNow` re-renders each minute; the saved Schedule message stores `effectiveAtMs` and builds its words at each render.
- Left as they were: the market amount, and the fixed-format ends-at, replay, tournament and season texts.
- RED: 6 of 11 browser cases. Units 1249; development 541/0/35; production 34/0/542; 16 screenshots.
- Concern: a lone "AM" could wrap at 360 px.
- **Follow-up `d75e3fc`** (a controller ruling, before the review): `formatToParts`, with the hour, minute and day period joined by U+00A0 (U+202F normalised; the ko-KR order kept); 10 unit cases; `expectTimeOnOneLine` at 360 px (the owner line failed with 2 lines before the fix); units 1251; development 541/0/35; production 34/0/542; the 16 screenshots refreshed.

**Verdicts (Sonnet; spec, quality and visual, on `81a57d7..d75e3fc`):** spec compliant; quality Approved.

**What the reviewer confirmed:** calendar days are DST-safe; the source has no literal invisible characters; the tests are independent of zone and locale, confirmed under two extra host zones; the screenshots are correct.

**Controller ruling (see the appendix):** the 360 px wrap of '4:20' / 'AM' is fixed before the review (no-break spaces in the time part; a break may still fall before the time), with a unit and a 360 px browser assertion.

**Minors (deferred to the final review):** M1 (`slotTimeText(NaN)` throws during render, where the old `toLocaleString` returned "Invalid Date"; final Minor 4, taken by the fix wave), M2 (`ownRestingText`'s `nowMs = 0` default), M3 (duplicated tick hooks), M4 (hour padding differs in 24-hour locales, from ICU), M5 ("· ends 04:20 AM" on My gladiator and Arena, `CharacterPanel.tsx:21` and `ArenaPanel.tsx:50`, keeps the old fixed 'en' 2-digit form and can wrap: a question for Avi), M6 (`role=status` lines re-announce at midnight), M7 (a browser-oracle midnight race and a fixed `waitForTimeout(500)`).

## Parallel lanes and integration

The pre-flight rulings set the lane rules: lane B runs in the replay worktree in parallel with lane A at Avi's request, and every lane-B checkpoint is cherry-picked onto `claude/task-23`, where the full gate including `test:db` runs on the combined tree before 23.6 and before the final review. This is the Task 22 lesson: a lane without a database cannot see the DB tests that import client reads. Within lane B, 23.5 ran first. 23.4 was planned to wait for 23.2's contract commit; by a later ruling it started on everything except the published-slot consumer while 23.2 ran, and cherry-picked that commit for C5.

**Dry run.** Branch `claude/task-23-int` in `Cloudiator-replay`: `a857b9c` plus lane B's nine commits, skipping `659618b` and `38e0a74`. One conflict, in `docs/operations/release-evidence.md`, was resolved by keeping both lane sections. Units 1131/1131; typecheck, assets, build and `verify:static` clean; development 526 passed, 25 skipped and 1 failed: `[mobile] market.spec.ts:463` (the purchased row still listed 5 s after "Purchase confirmed"), with `src` and `tests/browser` identical to lane B. It passed 12/12 alone (`--repeat-each=6`, both projects), so it went to 23.6's flake triage as a load flake. The isolated production gate passed 24, skipped 528 on port 4173; `git diff --check` clean. A first production attempt wrongly exported the test publishable key; `next.config` refused it as designed, and the rerun used the documented environment.

**Final candidate.** `claude/task-23-int` rebased onto `5e4e2e8` (23.3's fix round) as `a2ed84a`, with the same conflict resolution and lane A's new risk 5 kept. `src` and `tests/browser` were identical to lane B, so the browser evidence carried; units 1136/1136, typecheck and `git diff --check` clean.

**Integration gate on `claude/task-23` = `a2ed84a`.** `test:db` runs 1–3 had Edge recreated (14:06:22, 275 passed; 14:10:10, 1 failed in the capacity file; 14:23:02, 275 passed) and were discarded; run 4 passed 275/275 with the Edge start time unchanged. With units 1136, typecheck, assets, build and `verify:static`, development 526/25 (plus the load flake that passes alone), production 24 and `git diff --check`, the full gate was green on the integrated tree. These recreations led to the C22 cause (next section).

**23.9 and the LF rule.** On `claude/task-23-int2`, 23.9's four commits rebased cleanly onto `fa24471` (`8e3ce98`, `730ade0`, `dffec51`, `2b18b52`), followed by the controller fix `7d36068` (`.gitattributes`: `* text=auto eol=lf`). The index was already all LF (535 text files, 85 binary), so `--renormalize` changed nothing, and the working tree was refreshed. RED: `tests/workflow.test.ts` failed 3 cases with `checks.yml` checked out with CRLF; GREEN: units 1241/1241 with every text file LF; typecheck and `git diff --check` clean. `81a57d7` (23.8 M4) followed.

**Lane A's working tree.** `claude/task-23` was fast-forwarded to `81a57d7`. Its working tree still held 250 CRLF files and 3 mixed ones from its original `core.autocrlf` checkout (git status was clean); they were rewritten from HEAD, so all 536 text files are LF, keeping `.env.edge.local`, `.superpowers` and `node_modules/.cache`. The private static host `node_modules/.cache/serve-static-3200.mjs`, which the private config references, was missing, and was recreated from `scripts/serve-static.mjs` with default port 3200.

**Integration gate on `81a57d7`** (`verify` with the private config): 11 of 12 steps passed (unit, typecheck, assets, build, static, the Edge step with 714 entries refreshed and one recreation while settling before the run, `test:db` 299 with `CAPACITY_GATE=1` and Edge unchanged, the production build, its scan, production 34 and diff). The browser step had one failure beside a probable host fault (`net::ERR_NO_BUFFER_SPACE`): `[desktop] retention.spec.ts:157` "keeps offering a replay until its expiry by server time", which passes 3/3 alone. Lane B's 23.10 browser suite ran at the same time, which likely raised socket pressure, so the evidence of record was taken on the final head with no other browser run active.

**23.10 and the gate of record.** 23.10 was built on `claude/task-23-time` from `81a57d7`, and `claude/task-23` moved to the same head, `d75e3fc`. On 2026-10-20, with no other browser run active, `npm run verify` with the private config passed (exit 0, all 12 steps): units 1251; the Edge step refreshed 714 entries and settled through one recreation before the run; `test:db` 299 with `CAPACITY_GATE=1` and Edge unchanged; development 541/0/35; production 34/0/542.

**Flakes and host faults observed** (none shown to be a product defect):
- `[mobile] market.spec.ts:463` (the dry run): not reproduced in 56 runs; reading `MarketPanel.tsx` found no stale-read path; its trace was not kept.
- C21, `[mobile] shell.spec.ts:42`: not reproduced in 55 runs; likely the same host network fault as 23.6's run 1, not proven.
- `net::ERR_NO_BUFFER_SPACE`: in 23.6's run 1 (production), in 23.9's fix round (`identity.spec.ts:152`) and in the `81a57d7` gate (`retention.spec.ts:157`). The cause is unknown; port exhaustion is not supported (at most 1,488 `TIME_WAIT` sockets against 16,384 dynamic ports).
- The expedition scene's "Returned to camp" fade read mid-way by the contrast check (`release.spec.ts:517` in 23.8's run 1, `:518` in 23.9's fix round): `settled()` waits only for animations already running. Carried to the final review's flake triage.

## Edge recreations (C22): cause found

The local Edge container had been recreated during DB runs since Task 16, with no Edge file changed; every counted run had to keep an unchanged start time, and 23.1 and 23.3 each discarded runs for it. Task 23 found the cause.

- **The lead (controller, 2026-10-19, untested at first):** during the integration `test:db` run, Edge was recreated at 14:06:22Z after the serve log reported "File change detected … supabase/functions/_shared/backend/{auth,commands,http}.ts (WRITE)" for files git showed unmodified (modification times 2026-10-12 and 2026-10-17). Five DB test files import the Edge source; that session's serve log held 198 such detections and 48 runtime setups. `supabase functions serve` (CLI 2.120.0) has no no-watch flag.
- **Observed cause:** NTFS last-access updates are enabled on the host (`fsutil` DisableLastAccess = 2, system managed; NTFS updates an access time at most about once an hour). A run that reads Edge source not read within the last hour updates its access time, and the CLI watcher logs "File change detected … (WRITE)" for the unmodified file and recreates the container (`projections.ts` last access 14:22:59Z, Edge recreated 14:23:02Z).
- **Reproduced on demand:** reading every file under `supabase/functions` raised 5 detections and a recreation within 20 s. An earlier single-file experiment was negative because those files had been read within the hour.
- **Tested once:** pre-read `supabase/functions`, wait for Edge to serve again, then `test:db`: 275/275 with the start time unchanged. A single run is not proof.
- **Ruling:** 23.6's `verify.mjs` pre-reads `supabase/functions` and waits for a stable start time before `test:db`; the start-time discard rule stays; no system setting changes (disabling last-access is Avi's machine setting, not ours).
- **A read alone is not enough (23.6):** a read or a folder listing refreshes only an access time over an hour old, so entries read within the hour were left to change mid-run. The gate now sets the last-access time of `supabase/functions` and everything under it explicitly (`SetFileTime` through an attribute-write handle, modification times checked unchanged, links skipped since the fix round). Tested: 37 and then 34 detections and one recreation during the refresh, none afterwards. Ruled: keep it. In every later gate run the start time was unchanged across `test:db`; the refresh itself recreates the container once while the gate settles, by design.
- **Avi's approval (2026-10-19, in chat, "yes"):** extend `verification-gates.md` "Database tests and the local Edge runtime" so the gate resets the Edge files' last-access times before each database run; the rest of 23.6's guide edits stayed reverted. The section now begins "Extended with Avi's approval on 2026-10-19 (Task 23.6)", and `51875a7` mirrors the rule in AGENTS.md ("Build and browser output separation"): refresh the last-access times of the Edge source and wait for a settled runtime (`npm run verify` does this), and never change the host's last-access setting.
- 23.3's report had linked the recreations to `tsc` runs and proposed an upkeep note on that basis; the same report later corrected the correlation, and the cause above replaces it.

## Database budget decisions

- **The measurement (23.3):** at 50 always-scheduled characters the database reached 150.6–178.1 % of the 250 MB internal budget at 90 days and 227.8–274.0 % after a year, and was over budget even with no commands. The spec makes an overrun Avi's decision, never an automatic upgrade, so the controller asked Avi on 2026-10-19 with options: raise the internal budget toward the free plan's 500 MB, shorten the results history to 30 days, pause scheduling for characters whose owner has been away N days, and technical trims (empty completed jobs' payloads after settlement, a single recent-results copy, settled slots folded into ranges later).
- **Avi's decision (2026-10-19): "A + C + D".** A, technical trims; C, pause automatic activities for characters whose owner has not signed in for 14 days; D, raise the internal database budget from 250 MB to 500 MB with an alert at 400 MB. The design was written as `docs/superpowers/specs/2026-10-19-database-budget-design.md`.
- **The builder check (Sonnet)** found the trims overstated (A.1 about 35–40 MiB, not 60; A.2 about 10–15 MiB, on a wrong premise), that C cannot lower the always-active projection, an undefined gate horizon, open idle-cohort and standings semantics, the owner notice's storage, and modeled against physical size. The rulings that followed: A.2 is dropped; idle characters leave the boundary cohort (no member row, prepare job, snapshot, activity or settled-slot row), a season rating row exists only when the character plays in that season, and there is no separate notice (the owner line says "Resting at home: back on your schedule at <next boundary>"); the 400 MB warning and the 500 MB alert read the physical `pg_database_size`; the capacity gate requires both scenarios under 100 % at 90 days, with the one-year figures reported as risk.
- **The corrected design** gave, at the worst case with A + D, 355 MB / 557 MB (new-character schedule) and 427 MB / 679 MB (mixed) at 90 days / one year, and left one question: build the structural compactions (settled-slot ranges; command receipts older than 90 days reduced to a fingerprint) now or after launch.
- **Avi's decision (2026-10-19, "do what u recommend"):** the structural compactions are built after launch, when the 400 MB warning appears; Task 23 builds A.1, C and D only.
- **The plan:** 23.7 (the trim, the 500 MB budget and the health cohort count; M21), 23.8 (idle rest after 14 days; M22, contract types first) and 23.9 (presence and resting copy in lane B, in parallel after 23.8's contract commit). The survey found that the 500 MiB budget alone makes the 90-day gate pass (89 % / 75 %), that the trim must keep `result` an object with `ok: true` for settlement replay, that a resting character's processed slot must still advance, and that no durable activity signal existed, so the signal is a per-owner `last_signal_ms` written in `consume_command_rate` at most hourly.
- **Result:** 82.0 % (mixed) and 69.2 % (new-character schedule) of 500 MB at 90 days; 129.9 % and 107.9 % after a year, a named risk. The mixed worst case reaches the 400 MB warning before day 90, which is the expected trigger for the after-launch compactions.
- **Spec changes, each marked "Avi's decision, 2026-10-19":** the budget sentence (spec :410, the implementation plan :27 and :541, the Task 23 plan :27 and :41; 23.7); §4.3 :139 (the schedule continues offline while the owner has signalled within 14 days), :79 (a resting character is not drawn) and :428 (the three-day check holds up to 14 days without a signal), by 23.8; the controller's tidy `81a57d7` (the double "until", the throttle hour and the :428 marker).

## Final whole-branch review and fix wave

Range `b6bd8c7..d75e3fc` (48 commits, 191 files), reviewed by the most capable reviewer (Fable). **Verdict: ready to push, with fixes.** No Critical findings and no Important code defect; one Important (documentation currency) and four Minor.

**What it confirmed across checkpoints:** the interactions of M18 with M19 and M20, M21 and M22 are sound; the migrations are completed and ordered for the hosted apply; the access matrix, the scanner and the CSP cover every added object; the gate's verdicts are trustworthy; the presence and resting client is correct by inspection.

**Findings:**
- **Important 1 (documentation only):** `docs/operations/release-evidence.md` was stale after 23.7–23.10 (:449 "Task 23.8 … not built yet"; :714 "stays red until Task 23.7 (exit 2 …)"; :725 lists 23.8 and 23.9 as open; :75-78 and :87 say the capacity gate "fails until every blocker below is resolved"; :527 names gate run 2 on `46f176e` as the latest). It had no entry for the gate of record on `d75e3fc` and no lane-B section for 23.9 (the resting screens, shots awaiting Avi) or 23.10 (the slot-time format, Avi 2026-10-20), and the comment at `.github/workflows/checks.yml:5` still read "Exit 2 … (today the database budget, Task 23.7)".
- **Minor 2:** existing Windows clones stay CRLF after the merge (the root checkout: 116 files LF in the index and CRLF in the working tree, 8 mixed). Add the renormalization step to `migrations.md` "Fresh checkout" (from a clean tree, `git rm -r --cached . -q && git reset --hard`, or re-clone), and do Task 24's `db push` from an LF worktree.
- **Minor 3:** the comments at `15-release.sql:110-111` and `:997-998` say `create or replace` keeps `security_invoker`; it is kept because `WITH (security_invoker=true)` restates it (comment only; 23.2 M1).
- **Minor 4:** `src/features/schedule/slot-time.ts` `slotTimeText(NaN)` throws a `formatToParts` RangeError during render; guard non-finite input and add a unit case (a `src` change, so the browser gates run; 23.10 M1).
- **Minor 5:** `tests/db/idle.test.ts` lacks a one-tick multi-boundary catch-up across the 14-day line (about 30 lines; 23.8 M2).

**Declined to judge (13 items):** a late signal counting as not idle (documented); the hourly throttle (spec); a resting gladiator vanishing against a waking one walking in (Avi); the Follow reason copy (Avi); the Task 24 blockers (by plan); `'unsafe-inline'` (Decision 7); zero headroom at 50 characters (the risk 5 ruling); the one-year database over 500 MB (Avi); no season row when resting all season (ruling); the deferred counter counting busy coordinations (ruling); unthrottled visitor reads (Decision 2); the first Actions run (on push); deep links sending presence (consistent).

**Controller ruling (see the appendix):** the fix wave takes Important 1 and Minors 2–5, plus the M21 `guard_job` note in `migrations.md`; everything else stays deferred per the triage below; the "ends 04:20 AM" consistency waits for Avi. The fix wave was dispatched (Opus, lane A, base `d75e3fc`); it changes `src` and DB tests, so a full `npm run verify` follows it.

**Final fix wave:** `d88a27c` (`slotTimeText` returns an empty string for a non-finite time; the resting line falls back to "Resting at home.", the Build panel drops its "Effective" line and the saved Schedule message reads "Saved for {phase} and future occurrences."), `753af22` (one coordinated catch-up run across a character's 14-day line in `tests/db/idle.test.ts`; it fails with the cohort predicate's `>=` changed to `>`, restored), `ba07e5a` (the two `security_invoker` comments in `15-release.sql`, outside every body), `e4fb389` (`migrations.md`: renormalizing an old Windows clone, LF-only `db push`, and the M21 `guard_job` follow-up), `7260b59` (`release-evidence.md` brought up to the gate of record, a Lane B section for 23.9 and 23.10, the `checks.yml` comment) and `b87949a` ([fix-wave report](task-23-fix-wave.md)). No migration was added or changed.

**Fix-wave evidence:** unit tests 1254; typecheck. Gate run 1 exited 1: the Edge refresh's modified-time guard tripped on `supabase/functions`' `node_modules/.deno` (a concurrent writer, unidentified), so the database step was skipped as designed, and one development failure, `[mobile] market.spec.ts:464`, had no host fault and passed 6/6 alone. Gate run 2 at `7260b59` passed 12/12: `test:db` 300 with the Edge start time unchanged, development 541/0/35, production 34/0/542.

**Scoped re-review (Sonnet):** all six items ADDRESSED, no new breakage; `git diff --stat d75e3fc..b87949a -- supabase/migrations` is empty; the `15-release.sql` change is four comment lines outside every body; the guard covers NaN, ±Infinity, undefined, null and strings and every caller reads sensibly without a time; the catch-up test asserts membership and `processed_slot_index` at each step. Out of scope, taken with the records: `release-evidence.md` now points to the fix wave's own passing gate.

**Controller ruling (see the appendix):** two gate items are carried to Task 24 preparation and do not block the push: the refresh's modified-time guard should exclude dependency caches or retry once, and `market.spec.ts:463/464` [mobile] has failed three times under full-suite load (never alone) and needs a root cause before CI relies on it.

## Deferred Minor items and the final triage

**Triage result:** the final review's "fix now" list is 23.10 M1 (= Minor 4), 23.2 M1 (= Minor 3), 23.8 M2 (= Minor 5, if time allows) and 23.7 M5 (inside Important 1). It keeps every other deferred Minor deferred, names three as Task 24 prerequisites (23.1 M4, 23.4 M3, 23.5 M7) and one as Task 24 work (23.6's build-headers env loading), and leaves the visible items on Avi's list.

| Item | Ruling | Where it goes |
|---|---|---|
| 23.1 M1 (exception E widened to `storage`) | Accepted by ruling: harmless, nothing is created in `storage` | closed |
| 23.1 M2, M3, M5, M7 (unplanted sections, extension members, an overclaiming comment, the static seeds case) | Stay deferred | later |
| 23.1 M4 (finding rows export raw `proconfig` and `reloptions`) | Stays deferred; a prerequisite of the hosted comparison | Task 24, before the hosted audit |
| 23.1 M6 (runbook CSV comparison: `Import-Csv`, a temp folder) | Stays deferred; it matters when the hosted comparison runs | later (Task 24 runs the comparison) |
| 23.1 M8 (MultiXactId error, `tsc` segfault, Edge recreation) | The MultiXactId error did not recur and its precaution is untested; the Edge recreation is explained (C22) | later (keep PostgreSQL 17.11 with the record) |
| 23.1 fix-round minors (manual plants, md5 and `search_path` wording, seed wording, relation set not pinned) | Stay deferred | later |
| 23.2 M1 (`security_invoker` comments) | Final Minor 3 | final fix wave |
| 23.2 M2–M7 (probe filter, static-check limits, probabilistic cadence assertions, lease-busy retries, report accuracy, noise) | Stay deferred | later |
| 23.3 M3, M5, M7, M8 | Fixed in 23.3's fix round 1 | closed |
| 23.3 M1, M2, M4, M6, FR1, FR2, the extra unfit-reveal case | Stay deferred | later |
| 23.3 out-of-scope console JSON dumps in DB tests | Moved behind `CLOUDIATOR_MEASUREMENTS=1` by 23.6 (C23) | closed |
| 23.4 M3 (overlay measurement quality) | Stays deferred; fix before the phone measurement | Task 24, before the device measurement |
| 23.4 M6 (`console.log` in a gate spec) | Moved by 23.6 (C23) | closed |
| 23.4 M1, M2, M4, M5, M7, M8 | Stay deferred | later |
| 23.4 re-review: inline tournament replay text touches the card border at 360 px | Cosmetic and pre-existing | Avi |
| 23.5 Minor 1 (outcome focus for pointer users) | Fixed in fix round 1 by ruling | closed |
| 23.5 M7 (`__next.*.txt` 404s in the production export) | Stays deferred | Task 24 |
| 23.5 M2–M6 and the fix-round minors | Stay deferred | later |
| 23.6 round Minors (finite blocker share, stale comment, committed `test.fail()` case, JWT lookbehind) and `--db-retries` | Fixed in fix round 1 | closed |
| 23.6 build-headers env loading (a missing URL gives `'self'`; `.env` files) | Stays deferred (an optional `verify-static` warning) | Task 24 |
| 23.6 R6 static-checker gaps; the config-level `allowCspViolations` switch | Deferred to the final review, which keeps them deferred | later |
| 23.6 other minors (`release-evidence.md:575` wording, unmarked superseded report lines, the `test.fail()` case passing on an earlier throw) | Stay deferred | later |
| 23.7 M1 (`guard_job` lists columns by name) | Stays deferred; the fix wave records in the M21 notes that the next `private.jobs` schema change must switch to the `to_jsonb` comparison | the next `private.jobs` change |
| 23.7 M5 (`release-evidence.md:75`) | Inside final Important 1 | final fix wave |
| 23.7 M2–M4 | Stay deferred | later |
| 23.8 M2 (multi-boundary catch-up across the 14-day line) | Final Minor 5, if time allows | final fix wave |
| 23.8 M3, M4 (spec §4.3 wording, the throttle hour, the :428 marker) | Fixed by the controller in `81a57d7` | closed |
| 23.8 M1, M5 | Stay deferred | later |
| 23.9 M1, M2 | Fixed in fix round 1 | closed |
| 23.9 retry-cancellation test gap, the extra presence within 60 s, the `ownResting` guard | Stay deferred | later |
| 23.9 M3 (Follow reason; vanish against walk-in) and the see-through profile card | Avi's list | Avi |
| 23.10 M1 (`slotTimeText(NaN)`) | Final Minor 4 | final fix wave |
| 23.10 M5 ("· ends 04:20 AM" consistency) | Ask Avi | Avi |
| 23.10 M2–M4, M6, M7 | Stay deferred | later |
| The expedition fade read mid-way by the contrast check (`release.spec.ts:517`/`:518`) | Load-timing flake, recorded; no rerun rule changed | later |
| Final review Minor 2 (CRLF clones; LF worktree for `db push`) | Taken by the fix wave | final fix wave; Task 24 pushes from an LF worktree |

## Carried items

**Task 24:**
- **The five named launch blockers** (`release-evidence.md`, "Before the public release"):
  - mobile 30 fps on Avi's phone, measured with `?perf=1` on the deployed production build after the Task 24 deploy (fix 23.4 M3 first);
  - hosted CPU and dispatch spacing (C4), including the cutoff tick's five invocations;
  - hosted egress and compression: whether hosted responses are compressed and whether Edge-to-API traffic is billed (raw with backend traffic is 113.0/115.9 %; compressed about 26 %);
  - CORS parity: the hosted `GAME_ALLOWED_ORIGINS` and the Auth redirects for the exact Pages origin;
  - the remote export rehearsal (`scripts/export-db.ps1 -Remote`, then the restore check).
- **Deploy order:** M18 and the worker before or with the client (`readRevision` selects `published_slot_index`); M22 before the Edge function, and M22 with the Edge function and the client that sends `presence` (the previous Edge function refuses `presence` as `invalid`, which the client tolerates); push the migrations from an LF worktree (final Minor 2). Task 22's "Deploy M16 and the 22.5 client together" still applies.
- **The hosted access audit:** fix 23.1 M4 (print setting names only) before the hosted comparison; confirm the hosted PostgreSQL major version is 17 (MAINTAIN), that `private` is not an exposed schema, the exception E rows, and the same `search_path` on both sides for the policy hashes.
- **The hosted `connect-src` origin and build-headers env loading:** the production build sets `NEXT_PUBLIC_SUPABASE_URL`, and the scanner then names that origin; `build-headers.mjs` reads it only from the process environment (a missing URL gives `'self'`, `.env` files are not read).
- **23.5 M7:** the production export's 404s for `__next.*.txt` prefetches.
- **C6:** revisit the standings and profile re-reads with the hosted egress measurement.
- **The first GitHub Actions run** of `checks.yml`, after the controller's push.
- Task 22's Task 24 list (`task-22-report.md`, "Handoff to Task 24") also still applies: Task 23 ran nothing hosted.

**Later / after launch:**
- **The structural compactions** (settled slots as per-character ranges; command receipts older than 90 days reduced to a fingerprint), built when the 400 MB warning appears (Avi's decision, 2026-10-19). The mixed worst case reaches it before day 90; the one-year figures are 129.9 % and 107.9 % of 500 MB.
- **Zero-headroom boundary latency at 50 characters (risk 5):** watch `cohort.activeCharacters` in the health report, with its `boundaries` section and `jobs.overdue` as the symptoms. When active characters approach 50, choose a mitigation (make the final reveal fall due before the cutoff, fold it into the settlement, or raise the cutoff tick's capacity); none is built. The idle rest shrinks the active cohort.
- **Other named risks:** the dispatch ceiling (82.0/84.7 %), raw client egress at the risk line (77.1/79.0 % in 23.3's run, 80.7–82.7 % in 23.7's), and only about 3 always-on visitors fitting raw.
- **Standings:** no rank cache now; revisit when one league-season passes about 10,000 rows or the plan's execution passes 100 ms.
- **C24** (diagonal speed, atlas split) only if the phone measurement calls for it.
- **The MultiXactId observation** (23.1 M8): it did not recur; keep it with the PostgreSQL 17.11 version if it does.
- **The deferred Minors** marked "later" in the triage above.
- **Not traced:** Task 22 carried a coverage bundle (22.1 M6, 22.3 M4, 22.5 M3) and the 22.5 polish (M1, M2, M5–M7) to Task 23; the Task 23 plan and ledger do not record them, so their status is open (see `task-22-review.md`, "Carried items"). Task 22's command-receipt growth was measured (about 11 MiB a month at 10 commands a player a day), its two flaky tests were fixed by 23.2 (Decision 3), and its Edge recreations were explained (C22).

**Pending Avi:**
- **Seven visible changes** from 23.5 (the skip link on the first Tab, the lighter field edges `#7a86a0`, the chosen merchant's dark fill, the receipt's focus ring) and 23.4 (the camp Reload, Try again on a failed replay and tournament log, the `?perf=1` overlay and its placement); screenshots sent 2026-10-19.
- **Copy and visual questions:** "· ends 04:20 AM" on My gladiator and Arena keeps the old fixed 2-digit form (23.10 M5; the 23.10 report also asks whether the ends-at, replay, tournament and season texts should follow the new rule); the see-through profile card on narrow and touch layouts (pre-existing; contrast passes); a resting gladiator vanishes at once while a waking one walks in; the card's Follow reason wording differs from the row's (23.9 M3); the inline tournament replay text touching the card border at 360 px (cosmetic).
- **The plan's defaults for Avi's open choices** stand until Avi answers: the `?perf=1` overlay measured on Avi's phone after Task 24, OS reduced motion only, the GitHub Actions workflow pushed, `npm audit` allowed, the gallery excluded, visitor reads accepted and monitored, "last known camp" kept.
- **Lane B's next work,** the all-menus side pane, waits for Avi to confirm the table and approve its design.
- **Skill-upkeep proposals pending in the ledger:** 23.1, AGENTS.md "Generated migration completion": when `db pull` reports no changes for a privilege-only source, create the file with `migration new` and complete it verbatim, and run the access audit after every migration (the `migration new` completion is tested here; the general rule is not). 23.5, `verification-gates.md`: do not edit source files while the browser suite runs. 23.2's proposal was dropped by ruling, and 23.6's AGENTS.md proposal is covered by Avi's 2026-10-19 approval and the `51875a7` mirror. The status of Task 22's two proposals is not recorded in the Task 23 ledger.

## Pre-push gates

Code tree `b87949a`; the records commit that follows changes only documentation.

- `npm test` 1254/1254; `npm run typecheck` clean; `npm run build` and `npm run verify:static` pass (5 fixed routes, `_headers` as generated, no art gallery, 91 assets, no forbidden backend material, no fixture preview data); `git diff --check b6bd8c7..HEAD` clean.
- The full gate's last run is the fix wave's run 2 at `7260b59` (12/12; `b87949a` adds only the fix-wave report): units 1254, `test:db` 300 with `CAPACITY_GATE=1` and the Edge start time unchanged, development 541/0/35, production 34/0/542.

**Gate of record before the final fix wave:** `d75e3fc`, 2026-10-20, `npm run verify` with the private Playwright config and no other browser run active: exit 0, 12/12 steps. Unit tests 1251; typecheck, assets, build and `verify:static` passed; the Edge step refreshed 714 entries and settled through one recreation before the run; `test:db` 299 with `CAPACITY_GATE=1`, the Edge start time unchanged; development browser suite 541 passed, 0 failed, 35 skipped; production gate 34 passed, 0 failed, 542 skipped; `git diff --check` clean. The last clean replay is M01–M22 at 23.8 (299/299, an identical 1160-line fingerprint).

## Appendix: every controller ruling (from the execution ledger)

Each line gives what was decided, why, and what it costs if wrong. They are copied verbatim from the ledger (`.superpowers/sdd/2026-10-19-task-23-release-readiness/progress.md`), in ledger order: every line that begins with "Ruling", including the two "Ruling (carried to …)" lines. There are 48 lines.


- Ruling: Avi's four Task 23 choices use the plan's defaults until Avi answers (opt-in ?perf=1 overlay measured on Avi's phone after Task 24; OS reduced motion only; GitHub Actions workflow pushed; npm audit allowed), plus gallery.html excluded, visitor reads accepted and monitored, "last known camp" kept — costs rework of the affected step if Avi answers differently.
- Ruling: lane B (UI) runs in the replay worktree in parallel with lane A at Avi's request; every lane-B checkpoint is cherry-picked onto claude/task-23 and the FULL gate including test:db runs on the combined tree before 23.6 and before the final review (the Task 22 lesson: a DB-less lane cannot see DB tests that import client reads) — costs one integration gate per merge.
- Ruling: a generated _headers with CSP is pulled forward from Task 24 into 23.6 (it is testable locally through serve-static) — costs nothing if Task 24 keeps the same file.
- Ruling: revoke A, B and C in 15-release.sql and M17 (clients need SELECT only; the audit then shows no client privilege beyond SELECT and schema USAGE) — costs nothing for the app; any future table must grant explicitly (already the pattern).
- Ruling: keep D (service_role's non-DML privileges and defaults) pinned as-is in the snapshot — service_role is the trusted backend role and later migrations rely on explicit grants plus Supabase's defaults; revoking risks breaking a future migration — costs broader-than-needed backend privileges, documented.
- Ruling: accept E as documented platform exceptions (postgres cannot change supabase_admin's defaults; PUBLIC CONNECT/TEMP is standard); the exported audit runs read-only on the hosted project in Task 24 to confirm — costs a Task 24 follow-up if hosted defaults differ.
- Ruling: I1 is in scope (Review Focus 1 is 23.1's) — fix with (a) a catalog-driven cross-account read loop: a second account with its own gladiator reads every non-OPEN relation authenticated can read and never sees the owner's gid or activity id; (b) policy rows gain md5 of USING/WITH CHECK expressions and the permissive flag; (c) a catalog assertion that every authenticated/PUBLIC SELECT policy on a non-OPEN table references auth.uid(), proven by a rolled-back using(true) probe — costs one fix round.
- Ruling: postgres's own defaults in the storage schema (implementer added them to exception E) are accepted explicitly as harmless (we create nothing in storage); no schema change — costs a later revoke if storage is ever used.
- Ruling: 23.5 Minor 1 (focusing a trade's outcome scrolls the menu for pointer users too, and overrides focus moved during a pending command) joins the fix round — it is a visible behaviour change Avi has not approved; keep the outcome focus move for keyboard and focus-lost cases only — costs one more fix item.
- Ruling: a Retry/Reload for a failed log or replay (the unavailable-replay state) belongs to 23.4 with the camp Reload (R13) and the failed-log retry (C9) — costs nothing here.
- Ruling: start 23.4 in lane B now on everything except the published-slot consumer (C5); the implementer cherry-picks 23.2's RevisionState contract commit and finishes C5 when the controller sends it — keeps lane B busy while 23.2 runs — costs one mid-task hand-off.
- Ruling: Decision 4 as implemented — up to 3 retries 250 ms apart plus up to 250 ms random jitter per wait, and no retry of the opening coordination — accepted: the literal fixed spacing retried in lockstep and produced false deferrals at production cadence — costs non-deterministic retry spacing (bounded ≤ 1.5 s).
- Ruling: `deferred` counts deferred jobs plus coordinations still busy after retries (report shape unchanged) — accepted — costs a slightly broader meaning of the counter, documented.
- Ruling (carried to Task 24): deploy M18 and the worker before or with the client (the revision read selects published_slot_index) — costs a failed revision read if the client ships first.
- Ruling (carried to 23.4): publishedSlotIndex is optional and null before the first coordination; lane B adds it to the browser mocks (tests/browser/live-routes.ts) and treats null as "not yet published".
- Ruling: drop the 23.2 upkeep proposal (check view options) — AGENTS.md already lists invoker-view settings in its compare and inspect steps; per the upkeep policy, do not ask when the guidance already says it.
- Ruling: boundary latency is a technical fix the controller owns — dispatch counts the jobs that due reveals release in the same tick (SQL in 15-release.sql, new migration M19), with a cadence test proving ≤ 120 s after an expedition slot — costs one migration.
- Ruling: the capacity case's budget assertions are gated behind CAPACITY_GATE=1 (documented); the normal test:db stays green and 23.6's release gate enforces the budgets — costs nothing; blockers remain visible in release-evidence.md.
- Ruling: C24 (diagonal speed, atlas split) stays deferred — the FPS harness shows desktop at the vsync ceiling with 0 % frames >16.7 ms, so measurement shows no need (Decision: only if measurements call for it) — costs nothing unless the phone measurement in Task 24 says otherwise.
- Ruling: C6's remaining standings/profile re-reads stay as they are — compressed egress measured ~20 % of budget; revisit with Task 24's hosted measurement — costs some avoidable egress.
- Ruling: A.2 (recent-results trim) dropped — saves ~10-15 MiB across many read paths; not worth the risk — costs ~12 MiB.
- Ruling: idle characters leave the boundary cohort (no member row, prepare job, snapshot, activity or settled-slot row); a season rating row is created only when the character plays in that season (a whole-season idle character is absent from that season's standings); no separate "rested" notice — owner_state carries a resting flag and the My gladiator line reads "Resting at home: back on your schedule at <next boundary>" until the next boundary — costs one small visible copy line.
- Ruling: the 400 MB warning and 500 MB alert read physical pg_database_size; the capacity gate (23.6) requires both scenarios under 100 % at 90 days, one-year figures reported as risk with the compaction plan; modeled size cross-checked after VACUUM FULL in the test only — costs nothing.
- Ruling: I1 is named as a risk, not mitigated now — the spec target is 50 characters, 23.7's idle pause shrinks the active cohort, and exceeding costs ~1.6 s over the 120 s budget, not lost results; release-evidence and the report state the cliff (exactly full at 50, ~121.6 s at 51+, derived), the health-report watch, and the mitigation options; the cadence test pins 50 characters independent of --players — costs nothing now; a mitigation becomes work if active characters approach 50.
- Ruling: I2 is fixed in a NEW migration (M19 is committed; committed migrations are immutable): append only reveal ids not already picked, count only new ids against the cap, test two settlements sharing one reveal (reveal leased first, one lease per job, cap counted once) — costs one migration; the database budget work moves to M21.
- Ruling: fix round 1 also takes Minors 3 (missing measurements must not print "ok"), 5 (measurement dumps out of normal npm test / test:db output), 7 (stale report line) and 8 (record the failed-reveal coupling in migrations.md) — cheap, they touch the fix's files and keep gate output pristine; Minors 1, 2, 4, 6 deferred to the final review.
- Ruling: the active-character count joins Task 23.7 (it already changes owner_state/health for the idle pause) — costs one health-report field there.
- Ruling: 23.6's verify.mjs pre-reads supabase/functions and waits for a stable Edge StartedAt before test:db; the StartedAt discard rule stays; no system setting changes (disabling last-access is Avi's machine setting, not ours) — costs ~30 s per gate run.
- Ruling: keep the explicit last-access refresh — tested (37 and 34 detections then one recreation before the run, 0 after; runs 3–4 no recreation during test:db); it changes only last-access metadata of this worktree's Edge source, never system settings — costs ~35 s per gate run.
- Ruling: keep the once-only rerun on host faults only if it is limited to named host-fault signatures, the rerun is named in the summary (never a silent pass) and a second failure fails — the reviewer verifies; otherwise remove it — costs nothing.
- Ruling: revert the docs/operations/verification-gates.md edits to the approved a2ed84a text — it is Avi's approved override of verification-before-completion and a substantive change needs Avi's approval; move the proposed text verbatim into task-23.6-report.md as "Proposed update (awaiting Avi)"; apply it only if Avi approves — costs one approval question.
- Ruling: pin workflow actions to full commit SHAs with a version comment, resolved by read-only `gh api` lookups; if a SHA cannot be verified, keep the tag and record it as a Task 24 hardening item — costs nothing.
- Ruling: I1 fixed as proposed — blocked only when every failed test is a named budget check and every failed suite is an ancestor of one, unhandled errors detected by a second signal; tests for describe-hook + blocker and unhandled error + blocker — costs nothing.
- Ruling: I2 fixed — FILE_FLAG_OPEN_REPARSE_POINT, skip and never descend into reparse points, assert every entry is under the resolved root, and on Windows a failed refresh fails the Edge step as an infrastructure fault with its reason — costs nothing.
- Ruling: I3 — remove the automatic browser rerun; a failure in a context that saw a named host fault is labelled "probable host fault" with its original first error, keeps its traces and still fails the gate (exit 1); the database step keeps the approved single rerun on a changed Edge StartedAt, capped at 1 — costs one manual rerun when a host fault occurs (once in four runs so far).
- Ruling: I4 — revert verification-gates.md to the a2ed84a text (earlier ruling) and make the doc test check the approved text (or drop it if it would only restate the doc); `npm run verify` must not be matched by `verify:static` — costs nothing.
- Ruling: fix round also takes Minors: blocker pattern requires a finite share ≥ 1; capacity.test.ts:21-22 stale comment; a committed test.fail() case proving the CSP teardown check fails a test; the JWT lookbehind misses tokens after `%20`/escaped newlines. Deferred: build-headers env loading (missing URL → 'self'; .env files) to Task 24 hosting; R6 static-checker gaps (drop function … cascade, drop constraint, replica triggers) to the final review; `allowCspViolations` config-level switch to the final review.
- Ruling: 23.7 is split into 23.7 / 23.8 / 23.9 — the idle rule touches every boundary phase plus Edge and client, too large for one reviewed checkpoint; Lane B builds the client part in parallel (Avi's parallel-agents request) — costs two extra reviews.
- Ruling: retire the database-budget known blocker in verify.mjs now that it is cleared (a 90-day budget failure must be "failed", exit 1; keep the mechanism with an empty list and its tests) — in 23.7's fix round, or as a one-line follow-up if the review is clean — costs nothing.
- Ruling: the mixed worst case reaching the 400 MB warning before day 90 is the expected trigger for the after-launch compactions (Avi's decision); release-evidence states it — costs nothing.
- Ruling: the verify.mjs database-budget known blocker is retired as Step 0 of Task 23.8 (same lane, reviewed with 23.8) — costs nothing.
- Ruling: the workflow.test.ts CRLF failure is a 23.6 defect (units go red on any fresh Windows checkout) — fixed in Lane A after 23.8 (normalize line endings in the test and/or a .gitattributes eol=lf rule for workflow YAML), with RED shown on a CRLF checkout — costs nothing.
- Ruling: I1 fixed as the reviewer proposes — the design says the owner sees nothing different and the owner line is the owner's wording; own card Now, (you) row and find/follow-my-gladiator reason use the owner line when restingUntilSlot is set, else "Resting at home." — costs nothing; visible in the screenshots for Avi.
- Ruling: fix round also takes M1 (in the resting-without-signal state retry a failed presence once after retryAfterMs, or 60 s when absent; the owner line reads "Resting at home." instead of "Preparing your next activity" while its own actor rests with restingUntilSlot null) and M2 (card Follow checks actor.resting) — a returning player must not stay resting for hours over one transient failure; M3 polish deferred; the see-through card (pre-existing) and the long slot-time format go to Avi's visual list.
- Ruling: accept the implementer's extra `!behind` clause on the "Resting at home." owner line (after a boundary and before the owner re-read it shows "Preparing your next activity"; only visible when presence keeps failing across a boundary; documented and tested) — costs nothing.
- Ruling: the 360 px owner line wraps '4:20' / 'AM' — fixed before review (the time part joined with no-break spaces; a break may still fall before the time), unit + 360 px browser assertion; the review then covers 81a57d7..follow-up head — costs one short round.
- Ruling: the fix wave takes Important 1 and Minors 2–5 plus the M21 guard_job note in migrations.md; everything else stays deferred per the triage; the "ends 04:20 AM" consistency waits for Avi — costs one fix dispatch and a full verify (src and DB tests change).
- Ruling: carry two gate items to Task 24 prep, not blocking the push — (a) the refresh's modified-time guard should exclude dependency caches (node_modules/.deno) or retry once, since a concurrent Deno write fails the gate closed; (b) market.spec.ts:463/464 [mobile] "leaves the focus and the scroll where they are after a pointer trade" has now failed three times under full-suite load (never alone) — root-cause it before CI relies on it — costs one known flaky test until then.

### Avi's decisions

Copied verbatim from the ledger, in ledger order: every line that begins with "Avi decision". There are 4 lines.

- Avi decision (2026-10-19): database budget "A + C + D" — A technical trims (empty completed jobs' payloads after settlement ≈ −60 MiB; reduce the duplicate recent-results copy ≈ −35 MiB without changing what players see); C pause automatic activities for characters whose owner has not signed in for 14 days; D raise the internal database budget from 250 MB to 500 MB (the free plan) with an alert at 400 MB. Design for C written as docs/superpowers/specs/2026-10-19-database-budget-design.md for Avi's approval; implementation becomes Task 23.7 (lane A, migration M20) before the 23.6 release gate.
- Avi decision (2026-10-19, chat): "yes" — approve updating verification-gates.md "Database tests and the local Edge runtime" so the gate resets the Edge files' last-access times before each database run (the rest of the 23.6 doc edits stay reverted); the 23.6 implementer was told to apply the approved section text instead of reverting it.
- Avi decision (2026-10-19, chat): "do what u recommend" — the structural compactions (settled-slot ranges; command receipts older than 90 days reduced to a fingerprint) are built AFTER launch, when the 400 MB warning appears; Task 23.7 builds A.1 + C + D only.
- Avi decision (2026-10-20, chat): "yes" — keep the resting wording; shorten slot times to 'h:mm AM' today, 'tomorrow h:mm AM', a short weekday within the week (e.g. 'Sat 4:20 AM'), via the shared slotTimeText so Schedule and Build use it too. Built as Task 23.10 in Lane B (Cloudiator-replay branch claude/task-23-time from 81a57d7).
