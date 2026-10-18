# Gladiator Arena Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved public gladiator game, beginning with persistent Google login and character creation and completing the living world, activities, trading, tournaments, and seasons.

**Architecture:** A static Next.js application presents management panels and browser-only Phaser scenes. Supabase owns authentication, transactional game state, chronological slot processing, and private deterministic simulations. Pure TypeScript rules are shared between previews and backend workers; rendering consumes safe projections and revealed logs.

**Tech Stack:** Next.js App Router, React, TypeScript, Phaser, CSS, Supabase Auth/PostgreSQL/Edge Functions/Cron/pg_net/Vault, Cloudflare Pages; Vitest, Playwright, and PostgreSQL integration tests.

**Spec:** [Approved design](../specs/2026-10-11-gladiator-arena-design.md), approved 2026-10-11, including its proposed defaults. Those defaults are implementation requirements, not playtested balance.

## Global Constraints

- Public game, English interface, responsive desktop/mobile browsers, Google sign-in only.
- One gladiator per account; initial class selection; class changes and attribute respecs cost game money with no additional cooldown.
- Colorful fantasy pixel art, weapon-based fighters and fantasy creatures, no spellcasting classes.
- Shared four-hour game day; three 80-minute slots: morning, afternoon, evening.
- Define `slot_index = floor(UTC epoch milliseconds / 4,800,000)` and `phase = slot_index mod 3`.
- Wednesday and Saturday, 17:20 UTC, lasting one 80-minute afternoon slot.
- Allocating previously unspent points is free. A respec fee is required when any already-allocated attribute decreases.
- Changing Endurance preserves absolute current stamina, clamping it to a reduced maximum if needed. Raising capacity does not refill stamina.
- Public projections are readable by anyone, including visitors who have not signed in. Private reads and all commands require Google sign-in, and the acting character is bound to the verified account. (Amended 2026-10-16 by the [full-screen camp spec](../specs/2026-10-14-full-screen-camp-design.md#visitor-access-backend); Task 13.1, M13.)
- Backend credentials, worker authentication material, seeds, and unrevealed plans remain server-side.
- Runtime package versions are pinned and lockfiles committed when implementation begins.
- Target 60 fps desktop and at least 30 fps on the mobile test device, verified before release rather than assumed.
- Below 250 MB database usage, below 3 GB monthly Supabase egress, and below 300,000 monthly function invocations at the initial expected usage.
- Retain detailed battle/expedition replay events seven days. Retain activity and financial summaries 90 days, with checkpointed balances and progression.
- Preserve account state, item ownership, season archives, prestige, and unique settled-slot checkpoints indefinitely.

## Review Focus

1. A command races the slot cutoff: the database cutoff wins, and the edit cannot alter a started slot; Task 6 integration test.
2. A worker loses its lease or its response after committing: stale completion is rejected and the committed receipt prevents a second reward; Task 7 integration test.
3. Purchase, cancellation, and item reservation race: one terminal result, one owner, and conserved currency; Tasks 8 and 18 integration tests.
4. A signed-in owner guesses a future event ID: no future opponent, outcome, seed, or loot can be read; Task 10 access test.
5. A season ends while its last activity settles and a character promotes: results belong to the starting season, closure waits, and seasonal rewards pay once in the highest qualifying league; Task 21 integration test.

---

## Delivery order and review points

| Milestone | Tasks | Reviewable result |
| --- | --- | --- |
| A — Persistent character | 1–6 | Static app, Google session, one saved character, schedule and pending-build forms |
| B — Authoritative progression | 7–10 | Training/rest, equipment/shops, expeditions, recovery, and safe read models |
| C — Visible world | 11–15 | Production pixel assets, living camp, management panels, battle replay, expedition scenes |
| D — Competition and trading | 16–21 | Arena/rating, marketplace, tournaments, seasons and prestige |
| E — Public launch | 22–24 | Recovery/retention, security and performance evidence, real deployed flows |

Milestone A is the earliest useful account-and-character preview. A public preview can be deployed using Task 24's account/origin setup after A; label unavailable systems clearly. The complete first release requires all milestones. This is one cohesive release plan because every subsystem shares the same character, clock, economy, and activity snapshots.

Execution is not authorized by this document's creation. Avi reviews this plan and selects an execution method before product code, dependencies, production assets, or external project setup begin. No time estimate is promised before the first tested slice; report completed milestones and remaining work during execution.

## File map

The repository currently contains only the approved spec and its two reference images. Create the following responsibility boundaries during their owning tasks:

| Area | Files and responsibility |
| --- | --- |
| App shell | `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/game/page.tsx`, `src/app/auth/callback/page.tsx`, `src/app/globals.css` — fixed static routes and responsive shell |
| Pure rules | `supabase/functions/_shared/domain/` — `types.ts`, `clock.ts`, `rules-v1.ts`, `catalog-v1.ts`, `stats.ts`, `build.ts`, `combat.ts`, `random.ts`, `inventory.ts`, `expedition.ts`, `arena.ts`, `tournament.ts`, `season.ts` |
| Serializable contracts | `supabase/functions/_shared/contracts/` — `commands.ts`, `reads.ts`, `events.ts`; never expose private job types |
| Backend adapters | `supabase/functions/_shared/backend/` — `auth.ts`, `database.ts`, `commands.ts`, `jobs.ts`, `projections.ts`, `http.ts`; Edge entry points in `game-command/index.ts` and `game-worker/index.ts` |
| Schema source | `supabase/sql/01-identity.sql` through `10-operations.sql` — reviewed SQL by subsystem; deployable migration files generated by the CLI |
| Frontend data | `src/lib/api/` — `client.ts`, `gateway.ts`, `session.ts`, `sync.ts`, `fixture-gateway.ts`; private owner data distinct from public projections |
| Management | `src/features/auth/`, `character/`, `schedule/`, `build/`, `inventory/`, `shops/`, `market/`, `arena/`, `tournaments/`, `seasons/`, `results/` — focused panels and hooks |
| Rendering | `src/game/` — `GameViewport.tsx`, `bridge.ts`, `assets.ts`, `iso.ts`, `camera.ts`, `actors.ts`, `paths.ts`, `camp-scene.ts`, `replay.ts`, `battle-scene.ts`, `expedition-scene.ts`, `lighting.ts` |
| Production art | `public/assets/` — `manifest.json`, `camp/`, `expeditions/`, `actors/`, `effects/`, `ui/`; `assets/source/` originals and license/provenance records |
| Verification | `tests/domain/`, `tests/db/`, `tests/backend/`, `tests/browser/`, `tests/assets/`, `tests/performance/`; deterministic fixtures in `tests/fixtures/` |
| Operations | `scripts/` — SQL integration runner, fixture seed, resource report, retention/recovery checks, static secret scan, export/restore; `docs/operations/` runbooks and recorded evidence |

### Shared types and API decisions

Task 1 defines the public wire types; Task 2 defines domain snapshots. Integers use finite safe integers; IDs are UUID strings; timestamps are UTC epoch milliseconds; currencies and points are nonnegative integers. Types serialize as plain JSON, not Dates, Maps, or class instances.

```ts
type GladiatorId = string;
type ActivityId = string;
type OperationId = string; // client-created UUID, scoped to verified account
type Seed = string;        // private backend input, never a public DTO property
type Phase = 'morning' | 'afternoon' | 'evening';
type ClassId = 'berserker' | 'guardian' | 'duelist';
type Stance = 'offensive' | 'balanced' | 'defensive';
type LeagueId = 'bronze' | 'silver' | 'gold' | 'champion';
type Attributes = { strength: number; agility: number; vitality: number; endurance: number; precision: number };
type ActivityChoice = { kind: 'training' | 'rest' | 'arena' } | { kind: 'expedition'; expeditionId: 'woodland' | 'outpost' | 'mountain' };
type Schedule = Record<Phase, ActivityChoice>;
type ApiErrorCode = 'unauthenticated' | 'invalid' | 'conflict' | 'processing' | 'insufficient-funds' | 'inventory-full' | 'sold' | 'expired' | 'not-found' | 'rate-limited' | 'unavailable';
type CommandResult<T> = { ok: true; receiptId: string; value: T } | { ok: false; code: ApiErrorCode; retryAfterMs?: number };
```

`GameCommand` is a discriminated union of create-character, edit-schedule, queue-build, cancel-build, buy-shop, sell-item, discard-item, create-listing, cancel-listing, buy-listing, and set-tournament-opt-in. Every command carries `operationId`; actor identity comes from the verified session, never from a request owner ID. Creation contains name/class/allocation; builds contain expected version plus class/stance/allocation/equipment; item commands contain instance/catalog IDs and quantity; market commands contain listing ID or item ID/price; schedule commands contain phase/choice and expected version.

`GameGateway` provides `command<T>(input: GameCommand): Promise<CommandResult<T>>`, `owner(): Promise<OwnerState>`, `world(): Promise<WorldSnapshot>`, `revision(): Promise<RevisionState>`, `timeline(id: ActivityId): Promise<RevealedTimeline>`, `profile(id: GladiatorId): Promise<PublicProfile>`, `market(cursor?: string): Promise<MarketPage>`, `standings(league: LeagueId): Promise<StandingsPage>`, `tournament(id: string): Promise<TournamentView>`, and `recent(cursor?: string): Promise<ResultsPage>`. Cursor pages have at most 50 rows.

`OwnerState` contains the owner's current and pending builds, schedule/version, wallets and reserved fees, inventory, progression, stamina, opt-in flag, processed slot, and current activity summary. `PublicActor` contains character ID/name/class, visible equipment silhouettes, current league/level, phase/location, activity ID/status/timestamps, and visible stage; it excludes owner identity, wallet, inventory, future schedule, private snapshots, and seeds. `WorldSnapshot` contains `{ revision: string, serverNowMs: number, slotIndex: number, actors: PublicActor[] }`; `RevisionState` is the first three fields only. `RevealedTimeline` contains `{ activityId, serverNowMs, visibleThroughMs, stages: RevealedStage[], summary?: ActivitySummary }`; stages can include an already revealed `BattleLog`. A summary carries resolved kind, success/result, credited rewards, receipt ID, and replay-expiry state. Competition DTOs expose archived standings and revealed bracket results, with no future opponent snapshot or outcome.

Task 1 declares the complete serializable wire shapes, including the battle-log shape in `contracts/events.ts`, so its typecheck does not depend on later files. Task 2's domain types reuse those primitive/wire types and add private inputs; Task 3 implements the engine without redefining the log. Other task-owned return types are defined beside the named producing function. `ItemInstance` includes ID/owner/catalog version/tier/rarity/immutable stats/origin/binding/reservation; `Rules` and `Catalog` are typed versions of the exact spec tables. `BuildInput` contains class/stance/allocations/item IDs; validation returns either a frozen legal build or a typed reason. Inventory plans distinguish retained items, stacked salvage and overflow-money receipts; job leases include ID/token/expiry/immutable snapshot/seed/rules version. No later task should introduce a competing definition.

Live reads use the protected Supabase Data API tables/views and RLS, avoiding an Edge invocation for every poll. Commands go through `game-command`; worker requests go through `game-worker` with private authentication. `OwnerState` is available after Task 4, before the world projection exists; unimplemented read methods explicitly return unavailable. Public read rows contain only safe DTO columns. Backend projection code writes those rows; frontend `src/lib/api/reads.ts` maps protected read queries to DTOs.

### Common execution and test protocol

- Read the spec and applicable skills before each implementation area. At execution start inspect the local runtime/tool inventory and current official Next/Phaser/Supabase docs/changelog; select compatible stable packages, pin exact versions, and commit lockfiles. No package installs are part of plan writing.
- Use npm scripts established in Task 1: `test` = Vitest domain/backend/assets; `test:db` = Vitest PostgreSQL integration config; `test:e2e` = Playwright; `typecheck` = TypeScript plus Deno checks; `build` = static Next build; `verify:static` = output/secret scanner. Edge modules use explicit relative `.ts` imports; Next/Vitest alias `@domain` and `@contracts` to the canonical `_shared` directories. Pure shared code imports neither Deno APIs nor React/Phaser/database adapters.
- `tests/fixtures/domain.ts` supplies typed minimal snapshots/catalog fixtures; `tests/fixtures/db.ts` supplies independent-account clients and trusted operator SQL access against the local test database, with a reset per suite. Never use production data for destructive tests. Test-only clock controls are local fixtures/operator harness inputs, never authenticated player endpoints.
- Test snippets are assertions inside named tests in the listed owning test file. Fixture variables and convenience helpers such as `db.raceCreate` or `arenaFlow.openAtMinute` are defined in that test file or extended in the named fixture module as part of Step 1; they are test setup, not unspecified production APIs. They must exercise actual SQL/handlers/renderers rather than fabricate a passing result. Name each test after the behavior in its Step 1 and add the extra table cases in Step 4.
- PostgreSQL changes: implement in the named `supabase/sql/NN-*.sql`, iterate locally using SQL queries, run the owning tests and advisors, then generate a deployable migration with the current CLI's documented `db pull <name> --local --yes` and inspect `migration list --local`. Discover flags with `--help`. If a new empty migration is needed, use `migration new <name>`; never invent its timestamp filename. Record the generated path in `docs/operations/migrations.md`, and stage that exact path along with the SQL source. In task commit commands, `Mnn` means that newly generated exact path, resolved before running Git.
- SQL source files support controlled local reapplication with guarded DDL and `CREATE OR REPLACE` where appropriate; generated committed migrations remain immutable. Schema iteration and migration replay are separate checks.
- Each task has a red/green cycle. A missing import, table, route, or assertion is the expected initial failure. Do not count configuration mistakes as a meaningful red result. Run only the owning tests plus affected existing suites; the final release runs the complete suite.
- Commit commands below use PowerShell-compatible Git calls on separate lines. Local commits are reviewable checkpoints; pushes, account creation, and deployment follow the approved execution scope and account availability.
- Every Step 5 means run `git add -- <exact paths in that task's Files list and any explicitly modified earlier files>`, inspect `git diff --cached --check`, then `git commit -m "<the task's quoted message>"`. Resolve generated migration aliases to their actual paths first. Stage no other work or ignored credentials; record actual paths if implementation needs a file-map adjustment.

## Task 1: A static game shell with explicit fixture mode

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `.gitignore`, `.env.example`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/game/page.tsx`, `src/app/auth/callback/page.tsx`, `src/app/globals.css`, `src/lib/api/gateway.ts`, `src/lib/api/fixture-gateway.ts`, `supabase/functions/_shared/contracts/commands.ts`, `reads.ts`, `events.ts`, `scripts/verify-static.mjs`, `tests/browser/shell.spec.ts`, `tests/fixtures/domain.ts`.

**Interfaces:** Consumes the wire decisions above. Produces `GameGateway`, all command/read DTOs, `createFixtureGateway(): GameGateway`, fixed `/`, `/game/`, `/auth/callback/` routes, and the common test/build scripts. Fixture commands cannot reach a real backend.

- [ ] **Step 1:** Add a browser test for the management shell and labeled fixture mode.
  ```ts
  await page.goto('/game/?mode=fixture');
  await expect(page.getByText('Fixture mode — progress is not saved online')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Schedule' })).toBeVisible();
  ```
- [ ] **Step 2:** Pin the compatible toolchain and install the harness; run `npm run test:e2e -- tests/browser/shell.spec.ts`. Expect the shell assertion to fail.
- [ ] **Step 3:** Implement the shell and typed fixture gateway. Use `output: 'export'`, `trailingSlash: true`, static local fonts/assets, query identifiers, and a Suspense boundary for client search parameters. Establish script configs, deny production fixture mode, and ignore local credentials, exports, test artifacts, and generated builds. The scanner must reject backend key names/private fixture plans in exported assets.
- [ ] **Step 4:** Run the owning browser test, `npm run typecheck`, `npm run build`, and `npm run verify:static`. Expect all fixed route HTML files, no request-time server requirement, and no backend credentials.
- [ ] **Step 5:** Stage the files listed above and commit `chore: add testable static game shell`.

## Task 2: Versioned clock, catalog, build rules, and derived stats

**Files:** Create `supabase/functions/_shared/domain/types.ts`, `clock.ts`, `rules-v1.ts`, `catalog-v1.ts`, `stats.ts`, `build.ts`, `tests/domain/rules.test.ts`, `tests/domain/clock.test.ts`; extend `tests/fixtures/domain.ts`.

**Interfaces:** Produces `slotAt(nowMs: number): SlotWindow`, `nextPhaseStart(phase: Phase, nowMs: number): number`, `deriveStats(build: BuildSnapshot, rules: Rules): DerivedStats`, `validateBuild(input: BuildInput, owned: ItemInstance[], earnedPoints: number, level: number): BuildValidation`, `activityCost(base: number, overload: number): number`, `RULES_V1`, `CATALOG_V1`. `SlotWindow` has index/phase/startMs/endMs; `DerivedStats` has effective attributes, maxHp/maxStamina/loadCapacity/load/overload/efficiency, armor and weapon values. `BuildSnapshot` has immutable item stats, class, stance, allocations, and rules version.

- [ ] **Step 1:** Pin shared time, Endurance, overload, and legal-equipment behavior.
  ```ts
  expect(slotAt(Date.UTC(2026, 9, 14, 17, 20)).phase).toBe('afternoon');
  expect(slotAt(4_800_000).index).toBe(1);
  expect(deriveStats(baseFiveBuild, RULES_V1).maxStamina).toBe(100);
  expect(deriveStats(baseFiveBuild, RULES_V1).loadCapacity).toBe(20);
  expect(activityCost(30, 0.5)).toBe(45);
  expect(validateBuild(twoHandedWithShield, ownedItems, 10, 1).ok).toBe(false);
  ```
- [ ] **Step 2:** Run `npm test -- tests/domain/rules.test.ts tests/domain/clock.test.ts`; expect missing rule implementations.
- [ ] **Step 3:** Implement the signatures with exact spec sections 4–9 values. Encode every weapon/armor price/stat, tier/rarity multiplier, class bonus, expedition enemy/reward, fee and stamina cost in versioned data. Round effective attributes to two decimals, retain absolute stamina when previewing changes, enforce 10 creation points/base five, and reject nonfinite, fractional, negative, or oversized input. No per-level attribute rewards.
- [ ] **Step 4:** Run the owning tests with table cases for all catalog rows, all three class bonuses, phase boundaries ±1 ms, level locks, stance values, legal slots, and minimum 0.5 efficiency. Expect PASS.
- [ ] **Step 5:** `git add supabase/functions/_shared/domain tests/domain/rules.test.ts tests/domain/clock.test.ts tests/fixtures/domain.ts`; commit `feat: define versioned gladiator rules`.

## Task 3: Deterministic automatic combat

**Files:** Create `supabase/functions/_shared/domain/random.ts`, `combat.ts`, `tests/domain/combat.test.ts`; extend `types.ts` and `contracts/events.ts`.

**Interfaces:** Consumes `BuildSnapshot`, `DerivedStats`, `Rules`. Produces `simulateBattle(input: BattleInput, seed: Seed): BattleLog`, `makeFighter(build: BuildSnapshot, context: 'arena' | 'expedition', rules: Rules): FighterSnapshot`. `BattleInput` has two frozen fighters/rules version; `BattleLog` has sanitized fighter display snapshots (opponent identity, stance, effective combat stats/equipment), ordered events, final HP, winner ID, durationMs, and tie-break reason. Events specify timestamp, sequence, attacker/target, hit/critical/defend/evade flags, and HP before/after; no seeds, provider identity, wallets or pending builds.

- [ ] **Step 1:** Test retry determinism, equal-time attacks, and rules clamps.
  ```ts
  expect(simulateBattle(equalFighters, 'seed-a')).toEqual(simulateBattle(equalFighters, 'seed-a'));
  expect(simulateBattle(mutualLethalFighters, 'seed-a').finalHp).toEqual([0, 0]);
  expect(simulateBattle(mutualLethalFighters, 'seed-a').tieBreakReason).toBe('simultaneous-defeat');
  expect(simulateBattle(durableFighters, 'seed-a').durationMs).toBeLessThanOrEqual(120_000);
  ```
- [ ] **Step 2:** Run `npm test -- tests/domain/combat.test.ts`; expect missing combat functions.
- [ ] **Step 3:** Implement a timestamp-priority attack queue, seeded PRNG with fixed algorithm/version, simultaneous damage groups, and exact spec formulas. Apply overload, stance, crit and armor once in defined order; enforce attack interval ≥250 ms and damage ≥1 on hit. A 120-second limit resolves remaining HP fractions, then seeded ties. Preserve earlier rule versions for in-progress jobs.
- [ ] **Step 4:** Run the owning tests and `npm run typecheck`; verify damage/crit/armor rounding, seeded win variation, arena-only bound bonuses, no exp bonus, and event reduction reproducing final HP.
- [ ] **Step 5:** Stage the named files; commit `feat: simulate deterministic gladiator combat`.

## Task 4: Persistent identity and a protected command boundary

**Files:** Create `supabase/config.toml`, `supabase/sql/01-identity.sql`, `supabase/functions/game-command/index.ts`, `_shared/backend/auth.ts`, `database.ts`, `commands.ts`, `http.ts`, `tests/backend/commands.test.ts`, `tests/db/identity.test.ts`, `tests/fixtures/db.ts`, `scripts/test-db.mjs`, `docs/operations/migrations.md`; generate `M01`.

**Interfaces:** Consumes `GameCommand`, creation validation/catalog. Produces `handleCommand(request: Request, deps: CommandDependencies): Promise<Response>`, `verifyActor(request: Request): Promise<Actor>`, backend-only SQL `create_gladiator(actor_id uuid, operation_id uuid, input jsonb) returns jsonb`. `Actor` has verified user ID; `CommandDependencies` wraps verified auth and transaction calls. Creation, private builds/schedules, wallets/ledger, item instances, reservations, and account-scoped operation receipts are durable.

- [ ] **Step 1:** Test uniqueness, initial state, and direct-access denial.
  ```ts
  expect(await db.raceCreate(sameAccount, 'Avi Fighter')).toMatchObject({ gladiators: 1, starterItems: 2, money: 100, renown: 0 });
  expect(await db.readPrivate(otherAccount, gladiatorId)).toEqual([]);
  expect(await db.directWalletUpdate(ownerAccount, 999)).toBeDenied();
  expect(await db.create('AVI FIGHTER', secondAccount)).toHaveCode('conflict');
  ```
- [ ] **Step 2:** Start/reset the local test backend after CLI discovery; run `npm run test:db -- tests/db/identity.test.ts` and the command unit suite. Expect absent schema/handler failures.
- [ ] **Step 3:** Implement verified Google-account commands, strict discriminants, bounded payloads and per-account rate limiting (60 commands/minute; 5 creation attempts/minute), origin-specific CORS, and no owner ID authority. Store seeds/private work in an unexposed `private` schema. RLS on every exposed table; owner-only private reads, no player writes; revoke PUBLIC RPC execution, backend-only security-invoker mutation grants. Creation atomically grants initial inventory/state, normalized-name uniqueness and orientation until next full boundary.
- [ ] **Step 4:** Run the two suites, local advisors, generate/inspect `M01`, and reset/reapply migrations to reproduce the tests. Test missing/expired tokens, spoofed IDs/user metadata, repeated operation ID with changed payload, invalid numeric input, and unauthenticated reads.
- [ ] **Step 5:** Stage named files plus exact `M01`; commit `feat: persist one protected gladiator per account`.

## Task 5: Google sign-in and character creation UI

**Files:** Create `src/lib/api/client.ts`, `session.ts`, `src/features/auth/SignIn.tsx`, `AuthCallback.tsx`, `src/features/character/CreateCharacter.tsx`, `tests/browser/identity.spec.ts`; modify app routes and gateway.

**Interfaces:** Consumes `GameGateway.command`, creation previews, `OwnerState`. Produces `createLiveGateway(): GameGateway`, `useSession(): SessionState`, `<CreateCharacter gateway={gateway} />`; live gateway methods not yet enabled must return an explicit unavailable response, never fixture data.

- [ ] **Step 1:** Test a retained draft and creation retry.
  ```ts
  await identityFlow.cancelGoogleAndReturn(page);
  await expect(page.getByLabel('Gladiator name')).toHaveValue('Avi Fighter');
  await identityFlow.submitTwice(page);
  expect(await identityFlow.characterCount()).toBe(1);
  ```
- [ ] **Step 2:** Run `npm run test:e2e -- tests/browser/identity.spec.ts`; expect missing forms/session handling.
- [ ] **Step 3:** Implement Google PKCE browser callback, session expiry/sign-out, class/point form and derived preview, normalized-name errors, safe operation-ID retries, and owner reload after creation. Preserve only the creation draft locally; private game authority stays online. Expose only project URL/publishable key in client config. Use mock identity transport for local browser automation; real Google validation belongs to Task 24.
- [ ] **Step 4:** Run the browser suite, typecheck, and static build; test two tabs, back/reload/callback routing, invalid allocation/name, canceled OAuth, keyboard creation, and mobile layout.
- [ ] **Step 5:** Stage named files; commit `feat: add Google login and character creation`.

## Task 6: Schedule revisions and reserved pending builds

**Files:** Create `supabase/sql/02-build-schedule.sql`, `src/features/schedule/SchedulePanel.tsx`, `src/features/build/BuildPanel.tsx`, `tests/db/build-schedule.test.ts`, `tests/browser/planning.spec.ts`; extend command adapter/domain build validation; generate `M02`.

**Interfaces:** Consumes owner state, `nextPhaseStart`, `validateBuild`. Produces backend-only SQL `edit_schedule(actor_id, operation_id, input jsonb)`, `queue_build(actor_id, operation_id, input jsonb)`, `cancel_build(actor_id, operation_id)`, all returning JSON receipts. Historical revisions retain received/effective timestamps and versions; `BuildDraft` carries effective slot, fee reservation and item reservations.

- [ ] **Step 1:** Pin cutoff racing and conservation, using a 300-money fixture for the combined 200-money reservation.
  ```ts
  expect(await db.editAtCutoff('morning', cutoffMs)).toHaveEffectiveAt(nextMorningMs);
  expect(await db.queueCombinedChange()).toMatchObject({ reservedMoney: 200 });
  await db.cancelPendingTwice();
  expect(await db.wallet()).toMatchObject({ money: 300, reservedMoney: 0 });
  expect(await db.allocateEarnedPointsThenRetry()).toMatchObject({ allocatedTotal: 11, earnedTotal: 11 });
  ```
- [ ] **Step 2:** Run `npm run test:db -- tests/db/build-schedule.test.ts`; expect absent RPCs.
- [ ] **Step 3:** Implement edits under character/cutoff locks using database time. Queue class/stance/equipment/allocation for the next boundary; compare against active allocation to charge a decrease, reserve 100 per class/respec, and replace/cancel reservations atomically. Deny dependent commands while behind the latest boundary. UI shows Current/Pending/effective time and editable future phases, not an immediate optimistic build replacement.
- [ ] **Step 4:** Run DB and `tests/browser/planning.spec.ts`; include simultaneous boundary/edit transactions, version conflicts, pending item sale denial, class/no-class fee cases, cancellation/replacement retries, and increased Endurance preserving current stamina.
- [ ] **Step 5:** Stage named files plus `M02`; commit `feat: queue safe schedule and build changes`.

## Task 7: Ordered boundaries, Training/Rest, and fenced job recovery

**Files:** Create `supabase/sql/03-activities-jobs.sql`, `supabase/functions/game-worker/index.ts`, `_shared/backend/jobs.ts`, `tests/db/activities.test.ts`, `tests/backend/worker.test.ts`; generate `M03`.

**Interfaces:** Consumes clock, immutable builds, commands and catalog. Produces SQL `advance_boundary(target_slot bigint, coordinator_token uuid) returns jsonb`, `claim_jobs(worker_id uuid, kind text, batch_limit integer) returns jsonb`, `complete_job(job_id uuid, lease_token uuid, result jsonb) returns jsonb`, and `settle_activity(activity_id uuid, lease_token uuid) returns jsonb`; TS `runWorker(deps: WorkerDependencies): Promise<WorkerReport>`. Domain/types defines `JobLease`, `WorkerReport`, and frozen `ActivitySnapshot`; backend database defines `WorkerDependencies` RPC port. Jobs distinguish simulation, reveal and settlement.

- [ ] **Step 1:** Test offline chronology, automatic Rest and duplicate fencing.
  ```ts
  expect(await db.advanceTrainingRestSchedule(9)).toMatchObject({ completedSlots: 9, trainingPoints: 6 });
  expect(await db.startTrainingWithStamina(19)).toMatchObject({ resolvedKind: 'rest', staminaDebit: 0 });
  await db.commitThenLoseResponse();
  expect(await db.retrySameSettlement()).toMatchObject({ newGrants: 0 });
  expect(await db.completeWithStolenLease()).toHaveCode('conflict');
  ```
- [ ] **Step 2:** Run `npm run test:db -- tests/db/activities.test.ts` and `npm test -- tests/backend/worker.test.ts`; expect missing lifecycle transactions.
- [ ] **Step 3:** Implement persisted boundary phases matching the spec's eight-step order. Use a cohort barrier: previous settlement and season close finish globally before next snapshots; build application/snapshotting can batch but use one historical cutoff. Charge once with unique `(gladiator, slot)` and permanent settled checkpoints. Training grants one point; Rest refills at completion. Jobs claim via `SKIP LOCKED`, 120-second renewable leases, token fencing, and immutable seed/version. Process ≤5 combat or ≤20 simple jobs; dispatch ≤5 workers/minute only with work. Worker auth is an explicit server secret from Vault/backend secrets. Three failures preserve the job for operator action.
- [ ] **Step 4:** Run suites and migration replay. Include partial-boundary crash, stale worker after lease renewal/reclaim, three-failure stop, old rule version, edited historical schedule, new character orientation, and catch-up blocking commands. Test the repeating Training/Training/Rest fixture produces exactly six points in nine slots; browser closure does not affect advancement.
- [ ] **Step 5:** Stage named files plus `M03`; commit `feat: process recoverable authoritative activity slots`.

## Task 8: Inventory, loot grants, and the two NPC shops

**Files:** Create `supabase/functions/_shared/domain/inventory.ts`, `supabase/sql/04-inventory-shops.sql`, `src/features/inventory/InventoryPanel.tsx`, `src/features/shops/ShopPanel.tsx`, `tests/domain/inventory.test.ts`, `tests/db/shops.test.ts`; generate `M04`.

**Interfaces:** Consumes catalog/build rules, item reservations, wallets and receipts. Produces `planInventoryGrant(inventory: ItemInstance[], rewards: LootGrant[], catalog: Catalog): InventoryGrantPlan`, `applyXp(level: number, xp: number, award: number): Progression`, `historicalGearScore(items: ItemInstance[], previousMax: number): number`; backend SQL `buy_shop`, `sell_item`, `discard_item` with `(actor_id, operation_id, input jsonb)` receipts. Acquisition always updates historical strength; no transaction can mutate an item's original stats/bound origin.

- [ ] **Step 1:** Test capacity, stacking, pricing and binding.
  ```ts
  expect(planInventoryGrant(fullInventory, commonSwordLoot, CATALOG_V1).overflowMoney).toBe(10);
  expect(applyXp(1, 0, 100)).toEqual({ level: 2, xp: 0 });
  expect(await db.buyRenownSword()).toMatchObject({ renownDebit: 50, bound: true });
  expect(await db.sellBoundItem()).toHaveCode('invalid');
  expect(await db.raceSellAndReserve()).toMatchObject({ terminalTransitions: 1 });
  ```
- [ ] **Step 2:** Run inventory unit tests and `npm run test:db -- tests/db/shops.test.ts`; expect absent grant/shop behavior.
- [ ] **Step 3:** Implement 60 inventory slots including equipped/listed items, salvage stacks ≤999, exact catalog prices/tier/rarity rules, and logged expedition overflow NPC conversion. Purchases reject full inventory; renown equipment never converts to money. Shop, build, and later market transactions use the same lock order: character IDs, wallet IDs, item IDs, listing IDs, each sorted. Discard requires confirmation and only unequipped/unreserved owned items, with no cash or historical-strength reduction. XP consumes `100 × current level` per level-up, without points/stamina refill.
- [ ] **Step 4:** Run suites; test insufficient funds, same-operation retry, quantity/price overflow, level locks, inventory boundary 59/60/61, partial salvage stacks, bound discard, combined equip/sale race, monotonic legal-loadout score including two-hand rules, and all shop prices against versioned catalog.
- [ ] **Step 5:** Stage named files plus `M04`; commit `feat: add authoritative inventory and shops`.

## Task 9: Private expedition planning and end-of-slot rewards

**Files:** Create `supabase/functions/_shared/domain/expedition.ts`, `supabase/sql/05-expeditions.sql`, `tests/domain/expedition.test.ts`, `tests/db/expeditions.test.ts`; extend jobs adapter and domain/types; generate `M05`.

**Interfaces:** Consumes combat, catalog, inventory grants and XP. Produces `planExpedition(snapshot: ActivitySnapshot, seed: Seed, rules: Rules): ExpeditionPlan`; private plan contains three encounter dependencies, timed stages and terminal reward proposal. SQL `commit_expedition_plan(job_id, lease_token, plan jsonb)` stores private results; worker publishes only due stages and settles once through Task 7.

- [ ] **Step 1:** Pin success, carried HP, failure and reward timing.
  ```ts
  expect(successPlan.encounters.map(e => e.revealOffsetMs)).toEqual([1_200_000, 2_400_000, 3_600_000]);
  expect(successPlan.encounters[1].playerStartingHp).toBe(Math.min(maxHp, firstFinalHp + Math.floor(maxHp * 0.2)));
  expect(failedPlan.rewards).toEqual({ xp: 0, money: 0, loot: [] });
  expect(await db.walletAtMinute(79)).toEqual(startWallet);
  expect(await db.settleWoodlandSuccess()).toMatchObject({ xpAward: 100, moneyAward: 20, salvageAward: 1 });
  ```
- [ ] **Step 2:** Run `npm test -- tests/domain/expedition.test.ts` and DB expedition suite; expect missing plan/settlement integration.
- [ ] **Step 3:** Implement all three expeditions exactly from spec §6, initial full HP, 20% floored non-final healing capped at max HP, no future encounters after defeat, rarity 70/25/5 and catalog gear chances. Store immutable private encounter plans/reward proposal; log successful stages and failed safe-point return. Retried plans use retained seed/rules/catalog; only minute-80 settlement applies XP/money/items/overflow and permanent grant guard.
- [ ] **Step 4:** Run suites with tier1/5/10 locks, deterministic loot roll boundaries, multi-level XP, repeated worker delivery, minute80 delayed settlement, and failure after each encounter. Confirm no lasting injury/gear loss and only full success receives rewards.
- [ ] **Step 5:** Stage named files plus `M05`; commit `feat: plan and settle timed expeditions`.

## Task 10: Safe projections, reveal authorization, and revision polling

**Files:** Create `supabase/sql/06-projections.sql`, `supabase/functions/_shared/backend/projections.ts`, `src/lib/api/reads.ts`, `src/lib/api/sync.ts`, `tests/db/projections.test.ts`, `tests/browser/sync.spec.ts`; extend live gateway; generate `M06`.

**Interfaces:** Consumes authoritative activity/job state and read DTOs. Frontend reads produces `readOwner(client: SupabaseClient): Promise<OwnerState>`, `readWorld(client: SupabaseClient): Promise<WorldSnapshot>`, `readTimeline(client: SupabaseClient, id: ActivityId): Promise<RevealedTimeline>`, plus gateway profile/revision/recent mappings; identity enforcement is database RLS. Produces `createSync(gateway: GameGateway, listener: (state: SyncState) => void): SyncController`. `SyncController` exposes `start`, `stop`, `refresh`; `SyncState` contains safe data, offset, last-sync time and processing/error state. Backend projection writer consumes trusted activity rows and emits safe DTO rows.

- [ ] **Step 1:** Test guessed future IDs and minimal reads.
  ```ts
  expect(await db.readEventAs(ownerAccount, futureEventId)).toEqual([]);
  expect(await db.readEventAs(otherAccount, futureEventId)).toEqual([]);
  expect(await db.publicPayload()).not.toContainKeys(['seed', 'email', 'wallet', 'inventory', 'futureSchedule']);
  expect(await syncHarness.pollUnchanged(3)).toMatchObject({ revisionReads: 3, projectionReads: 0 });
  ```
- [ ] **Step 2:** Run the projections DB suite and sync browser suite; expect missing public read authorization and sync controller.
- [ ] **Step 3:** Implement owner reads over owner-only rows and separate sanitized public projection tables (`world_actors`, `public_profiles`, `visible_events`, `world_revision`), not broad read policies over private inventory/wallet rows. Authenticated public reads enforce `reveal_at <= database time` even for guessed IDs; private plans have no client grants. Views use `security_invoker`; projection writers cannot export private snapshots. Poll revision/server clock every 30 seconds, fetch changed projection once, pause hidden tabs and refresh on focus. Load details/logs/listings only on demand with ≤50-row cursor pages. Never turn a countdown into credited rewards.
- [ ] **Step 4:** Run suites for owner/other/unauthenticated/backend roles, seeds/provider fields, equipped versus unequipped gear, clock skew ±24 hours, worker delay, network outage, focus recovery, and server-time reveal boundaries ±1 ms. Generate and replay `M06`.
- [ ] **Step 5:** Stage named files plus `M06`; commit `feat: expose safe synchronized world projections`.

## Task 11: Production pixel art and a validated animation package

**Files:** Create `assets/source/README.md`, `assets/source/provenance.json`, `public/assets/manifest.json`, `public/assets/camp/tiles.png`, `props.png`, `map.json`, `public/assets/actors/gladiators.png`, `gladiators.json`, `npcs.png`, `npcs.json`, `public/assets/expeditions/woodland.png`, `outpost.png`, `mountain.png`, `woodland.json`, `outpost.json`, `mountain.json`, `public/assets/effects/combat.png`, `public/assets/ui/icons.png`, `tests/assets/manifest.test.ts`, `src/game/assets.ts`, `docs/operations/art-review.md`.

**Interfaces:** Produces `loadAssetManifest(): AssetManifest`; manifest records file paths, atlas keys, frame rectangles, ground-contact anchors, animations/frame durations/loop flags, palette, tiles, walkability, foreground occlusion and provenance. Use 64×32 isometric ground tiles and 64×64 actor frame bounds, transparent padding and nearest-neighbor scaling; layer equipment silhouettes over a reusable body to avoid full combinatorial sheets.

- [ ] **Step 1:** Test complete asset contracts.
  ```ts
  expect(manifest.maps.map(m => m.id)).toEqual(['camp', 'woodland', 'outpost', 'mountain']);
  expect(manifest.actions).toEqual(expect.arrayContaining(['idle','walk','weights','practice','spar','sit','eat','sleep','search','attack','hit','defend','evade','defeat','victory']));
  expect(validateFrameBounds(manifest)).toEqual([]);
  expect(validateProvenance(manifest)).toEqual([]);
  ```
- [ ] **Step 2:** Run `npm test -- tests/assets/manifest.test.ts`; expect the absent/incomplete manifest to fail.
- [ ] **Step 3:** Produce original art with the image-generation skill/tool plus frame assembly, or use free licensed source assets with recorded permissions; no paid asset purchase is assumed. Preserve source outputs and license URLs. Deliver actual directional walk/action frames, four weapon silhouettes plus shield, light/heavy armor, six distinct NPC appearances, camp zones and three environments consistent with approved reference A. Author reusable multi-frame loops and effects; concept boards do not substitute for runtime frames. Implement manifest validators and an asset gallery for inspection.
- [ ] **Step 4:** Run asset tests; visually inspect every loop at intended scale, movement anchors, weapon alignment, transparent edges, environment palette, readable nameplates and foreground layering. Record screenshots and pass/fix observations in art review. Static boards or emoji fail this deliverable.
- [ ] **Step 5:** Stage named art/source/manifest/test files; commit `art: add licensed production world and animation assets`.

## Task 12: Living isometric camp and camera controls

**Files:** Create `src/game/GameViewport.tsx`, `bridge.ts`, `iso.ts`, `camera.ts`, `actors.ts`, `paths.ts`, `camp-scene.ts`, `lighting.ts`, `tests/browser/camp.spec.ts`, `tests/domain/scene-layout.test.ts`.

**Interfaces:** Consumes `WorldSnapshot`, `AssetManifest`, sync time. Produces `<GameViewport world={world} bridge={bridge} />`, `createSceneBridge(): SceneBridge`, `worldToScreen(x: number, y: number): Point`, `screenToWorld(x: number, y: number): Point`, `planActorRoutine(actor: PublicActor, slotIndex: number): ActorRoutine`. Bridge events: select-character, open-merchant, view-expedition, view-replay, return-camp, follow-character; listeners return unsubscribe callbacks.

- [ ] **Step 1:** Test correct population and camera bounds.
  ```ts
  expect(await campHarness.visiblePopulation()).toMatchObject({ players: 50, ambientNpcs: 6 });
  expect(await campHarness.activityZones()).toEqual(expectedZones);
  await campHarness.panBeyondMap();
  expect(await campHarness.cameraInsideBounds()).toBe(true);
  ```
- [ ] **Step 2:** Run camp browser and scene-layout unit suites; expect no functional scene.
- [ ] **Step 3:** Load Phaser only in a browser client component. Implement deterministic slot/actor routine offsets, walkable paths, unique activity positions, NPC conversations/merchant routines, phase tint/torches, offline actor presence and expedition-away roster. Depth-sort ground-contact anchors with separate foreground layers around buildings. Support drag/wheel, touch drag/pinch, zoom buttons, select/find/follow, and input exclusion over management panels. Cull offscreen actors; hidden tabs pause rendering; unmount destroys game and bridge listeners.
- [ ] **Step 4:** Run owning suites; inspect walk-behind-building screenshots, different unsynchronized routines, arrivals/departures, scene re-entry without duplicate canvases/listeners, simultaneous Arena staging capacity, and missing WebGL/asset fallback. Save visual evidence; fps acceptance is Task 23 on real devices.
- [ ] **Step 5:** Stage named files; commit `feat: render the living isometric gladiator camp`.

## Task 13: Complete owner management over the animated world

**Files:** Create `src/features/character/CharacterPanel.tsx`, `src/features/results/ResultsPanel.tsx`, `src/features/character/RosterPanel.tsx`, `src/features/character/useGameState.ts`, `tests/browser/management.spec.ts`; integrate existing schedule/build/inventory/shop panels and app styles.

**Interfaces:** Consumes live gateway, owner state, sync, scene bridge and rule previews. Produces `useGameState(gateway: GameGateway): GameUiState`, accessible panel navigation and Current/Pending comparisons; it does not maintain a second authoritative wallet/progression state.

- [ ] **Step 1:** Test pending changes and delayed rewards visibly.
  ```ts
  await managementFlow.queueEnduranceIncrease(page);
  await expect(page.getByText('Pending — applies at next slot')).toBeVisible();
  await managementFlow.moveDisplayClockPastEnd(page);
  await expect(page.getByText('Processing results')).toBeVisible();
  expect(await managementFlow.displayedMoney(page)).toBe(100);
  ```
- [ ] **Step 2:** Run `npm run test:e2e -- tests/browser/management.spec.ts`; expect incomplete panel wiring/status copy.
- [ ] **Step 3:** Connect real commands, reserved/available balances, point allocation, load/overweight previews, schedule choice, class/respec confirmations, purchase/sale/discard and pagination. Selecting a two-handed weapon removes the shield from the pending draft while the active build remains locked. Show Scheduled/Preparing/In progress/Processing results/Completed with timestamps, last synchronized state during failure, retryable processing responses and replay-expiry summaries. Mobile uses tabs/dismissible sheets; all world clicks have equivalent keyboard buttons. Escape names through normal React text rendering; honor reduced motion.
- [ ] **Step 4:** Run browser tests for keyboard-only management, mobile sheets/touch scrolling, failed command retaining input, item reservation labels, full inventory, affordability/load matching server, and panels usable without the canvas.
- [ ] **Step 5:** Stage named/modified feature files; commit `feat: connect accessible gladiator management panels`.

## Task 14: Battle-log replay with consistent controls

**Files:** Create `src/game/replay.ts`, `battle-scene.ts`, `src/features/arena/BattleReplay.tsx`, `tests/domain/replay.test.ts`, `tests/browser/replay.spec.ts`.

**Interfaces:** Consumes revealed `BattleLog` and actor/effect assets. Produces `reduceReplay(log: BattleLog, throughMs: number): ReplayFrame`, `createReplayController(log: BattleLog): ReplayController`; controller exposes play/pause/restart/seek/setSpeed and read-only frame state. `ReplayFrame` contains fighter HP, current grouped events and result, never rewards mutations.

- [ ] **Step 1:** Test identical final state regardless of viewing.
  ```ts
  expect(reduceReplay(log, log.durationMs).hp).toEqual(log.finalHp);
  expect(replayHarness.playAt(1).final).toEqual(replayHarness.playAt(4).final);
  expect(replayHarness.restartThenSkip().winnerId).toBe(log.winnerId);
  expect(replayHarness.commandCalls).toBe(0);
  ```
- [ ] **Step 2:** Run replay unit/browser suites; expect missing controller/scene.
- [ ] **Step 3:** Render event-driven attack/hit/crit/defend/evade/defeat/victory, HP bars, opponent/stance/combat-build comparisons, result and readable log. Controls are normal/fast, pause, restart and skip; preserve equal-time groups. Never run combat simulation in the renderer to decide outcomes. A missing/expired log shows saved outcome and credited rewards with expiry explanation.
- [ ] **Step 4:** Run suites against player/NPC/expedition/tie logs; inspect motion at both speeds and reduced-motion mode, pause while hidden, reload and repeated mount without duplicate playback.
- [ ] **Step 5:** Stage named files; commit `feat: animate authoritative battle replays`.

## Task 15: Followable expedition scenes using only revealed stages

**Files:** Create `src/game/expedition-scene.ts`, `src/features/character/ExpeditionView.tsx`, `tests/browser/expedition.spec.ts`; extend bridge and fixture gateway timelines.

**Interfaces:** Consumes `RevealedTimeline`, replay controller, camera/paths and expedition manifests. Produces `renderExpeditionStage(timeline: RevealedTimeline, displayNowMs: number): ExpeditionSceneState`; no private plan input. State has visible travel/search/encounter/safe-return phase and replay availability.

- [ ] **Step 1:** Test mid-slot entry and failure presentation.
  ```ts
  await expeditionFlow.openAtMinute(page, 39);
  await expect(page.getByText('Encounter 1')).toBeVisible();
  await expect(page.getByText('Encounter 2')).toHaveCount(0);
  await expeditionFlow.openFailedAtMinute(page, 65);
  await expect(page.getByText('Returning without rewards')).toBeVisible();
  ```
- [ ] **Step 2:** Run `npm run test:e2e -- tests/browser/expedition.spec.ts`; expect no journey scene/current-stage rendering.
- [ ] **Step 3:** Implement three environments with automatic path travel, exploration/search pauses, revealed encounter playback, progress strip/log, safe-point rest after failure, follow/free camera and Camp button. A delayed reveal displays Preparing, never a fabricated encounter. Owner and spectators see only gateway-published stages; new navigation/reload jumps to current visible progress. Scene clocks cannot reveal missing stages, advance jobs, or settle rewards.
- [ ] **Step 4:** Run minute19/20/39/40/59/60/79/80 table cases, reload/replay/leave/return and other-character viewing; inspect network payloads for future enemy/loot/outcome leakage and assert no mutation call from replay or camera controls.
- [ ] **Step 5:** Stage named files; commit `feat: follow automatic isometric expeditions`.

## Task 16: League placement, regular Arena pairing, and rating settlement

**Files:** Create `supabase/functions/_shared/domain/arena.ts`, `supabase/sql/07-arena.sql`, `tests/domain/arena.test.ts`, `tests/db/arena.test.ts`; extend jobs, projections and catalog registry; generate `M07`.

**Interfaces:** Consumes frozen fighters, historical gear strength and earned points. Produces `leagueFor(level: number, earnedPoints: number, gearHistory: number): LeagueId`, `estimateArenaStrength(fighter: FighterSnapshot): number`, `matchArena(entrants: ArenaEntrant[], recent: PairingHistory[], seed: Seed): ArenaAssignment[]`, `makeFallback(fighter: FighterSnapshot): FighterSnapshot`, `ratingDelta(winnerRating: number, loserRating: number): RatingDelta`. `LeagueId` is bronze/silver/gold/champion; assignments reference frozen builds and one season/league/slot.

- [ ] **Step 1:** Test pairing and monotonic placement.
  ```ts
  expect(leagueFor(1, 10, 0)).toBe('bronze');
  expect(leagueFor(5, 25, 100)).toBe('silver');
  expect(matchArena(twoEntrantsWithStrengthRatio(2.01), [], 's').every(a => a.kind === 'npc')).toBe(true);
  expect(ratingDelta(1000, 1000)).toEqual({ winner: 12, loser: -12 });
  expect(await db.settleNpcWin()).toMatchObject({ renown: 3, ratingDelta: 0 });
  ```
- [ ] **Step 2:** Run Arena unit and DB suites; expect missing matchmaking/rating lifecycle.
- [ ] **Step 3:** Implement exact progression thresholds, banked-point inclusion, acquisition-based legal-loadout history and promotion at boundaries. Pair within league by spec sort/ties, preceding 18-slot pairing counts, and max2× strength. Prepare one frozen regular bout; reveal minute60 and settle minute80 with human win/loss renown10/2, NPC3/0, no XP/money. Fallback mirrors effective stats/armor/interval, Balanced stance, 85% maxHP/pre-stance damage, overload once. Apply Elo K24 with floor0 and distinct league/season records starting1000. Expose warm-up without training reward.
- [ ] **Step 4:** Run suites for no entrants/one/odd count/50, exact2× boundary, repeat pairing ties, sold/unequipped/renown gear, respec/banked points, bound modifiers, simultaneous settlement retry, and no cross-league match. Verify a weak current loadout stays in its historical league.
- [ ] **Step 5:** Stage named files plus `M07`; commit `feat: add league-aware Arena battles and ratings`.

## Task 17: Shared Arena staging, selection, and standings

**Files:** Create `src/features/arena/ArenaPanel.tsx`, `StandingsPanel.tsx`, `tests/browser/arena.spec.ts`; extend camp scene, gateway standings and replay navigation.

**Interfaces:** Consumes `ArenaAssignment` public summaries, revealed logs and `StandingsPage`; produces expanded Arena replay selection and paginated league standings with separate rating/renown/current-strength displays.

- [ ] **Step 1:** Test presentation timing and fallback disclosure.
  ```ts
  await arenaFlow.openAtMinute(page, 59);
  await expect(page.getByText('Warming up')).toBeVisible();
  await arenaFlow.openAtMinute(page, 60);
  await expect(page.getByRole('button', { name: 'Watch replay' })).toBeEnabled();
  await expect(page.getByText('NPC opponent — reduced renown, no rating change')).toBeVisible();
  ```
- [ ] **Step 2:** Run `npm run test:e2e -- tests/browser/arena.spec.ts`; expect missing stage/standings UI.
- [ ] **Step 3:** Add bounded simultaneous sparring/staging positions, selected close-up replay, result summaries, visible opponent/current rating and league explanation. At the boundary, refresh standings from credited results; don't pre-credit simulated wins. NPCs are distinguishable from player characters. Panels work on mobile and through keyboard buttons.
- [ ] **Step 4:** Run staged/preparing/revealed/completed cases, multiple simultaneous fights, NPC and human losses without lasting injury, selected replay after return, and no-result worker delay.
- [ ] **Step 5:** Stage named/modified files; commit `feat: present Arena activity and standings`.

## Task 18: Fixed-price marketplace with atomic ownership transfer

**Files:** Create `supabase/sql/08-market.sql`, `src/features/market/MarketPanel.tsx`, `tests/db/market.test.ts`, `tests/browser/market.spec.ts`; extend commands and read gateway; generate `M08`.

**Interfaces:** Consumes shared item/wallet locks, reservations, operation receipts and inventory capacity. Produces backend-only `create_listing`, `cancel_listing`, `buy_listing` with `(actor_id, operation_id, input jsonb)` receipts, and `expire_listings(database_now timestamptz) returns integer`. `MarketPage` contains public item stats, seller character, whole price, expiry/status/cursor; successful purchase returns the durable receipt/ownership result.

- [ ] **Step 1:** Test competing buyers and cancellation.
  ```ts
  const race = await db.raceTwoBuyersAndCancel({ price: 101 });
  expect(race.terminalTransitions).toBe(1);
  expect(race.itemOwners).toHaveLength(1);
  expect(race.moneyLost).toBe(race.sold ? 5 : 0);
  expect(await db.retrySuccessfulBuy()).toMatchObject({ newDebits: 0, newItems: 0 });
  ```
- [ ] **Step 2:** Run DB market suite; expect absent atomic listing transactions.
- [ ] **Step 3:** Implement five active listings, seven-day expiry, no creation fee and floored5% sale fee. Reject own purchases, bound/equipped/pending-reserved items, insufficient money/capacity, expired/sold listings, and nonfinite/noninteger prices; cap price at1,000,000,000 and wallet arithmetic below JS safe-integer range. Validate listing again after acquiring Task8 lock order. Transfer item/money/fee/receipt atomically; cancel/expiry return the same item once. Build mobile paginated buy/sell/list/cancel UI and result/error handling.
- [ ] **Step 4:** Run DB and browser suites for buy-versus-expiry/cancel, list-versus-equip/NPC-sale, six listings, capacityfull, selfbuy, renown gear, price1/19/20/101 fee flooring, duplicate key changed payload, and no stuck reservation after cancel. Assert total currency changes only by the explicit fee.
- [ ] **Step 5:** Stage named files plus `M08`; commit `feat: trade equipment through an atomic marketplace`.

## Task 19: Tournament eligibility, bounded bout graph, and rewards

**Files:** Create `supabase/functions/_shared/domain/tournament.ts`, `supabase/sql/09-tournaments-seasons.sql` (tournament portion), `tests/domain/tournament.test.ts`, `tests/db/tournaments.test.ts`; extend boundary/jobs/commands/projections; generate `M09a`.

**Interfaces:** Consumes frozen league entrants, regular matcher, combat and rating. Produces `isTournamentSlot(slot: SlotWindow): boolean`, `buildBracket(entries: ArenaEntrant[], seed: Seed): TournamentGraph`, `readyBouts(graph: TournamentGraph): BoutJob[]`, `placementGrants(graph: TournamentGraph): RewardGrant[]`. Graph stores stable bout/parent IDs, byes, frozen entry snapshots, reveal times and private results. SQL `set_tournament_opt_in(actor_id, operation_id, input jsonb)` returns receipt; graph completion is fenced through job RPCs.

- [ ] **Step 1:** Test the approved participant counts and debit invariants.
  ```ts
  for (const n of [0,1,2,3,5,50]) {
    const run = await tournamentHarness.run(n);
    expect(run.chargesPerParticipant).toEqual(Array(n).fill(1));
    expect(run.bracketWinners).toBe(n >= 2 ? 1 : 0);
    expect(run.ratedBouts).toBe(n >= 2 ? n - 1 : 0);
    expect(run.byeRenown).toBe(0);
  }
  ```
- [ ] **Step 2:** Run tournament unit/DB suites; expect absent eligibility/bracket processing.
- [ ] **Step 3:** Partition cutoff-eligible opted-in Arena entrants with sufficient stamina per league. At Wed/Sat17:20UTC create seeded single-elimination power-of-two brackets with byes only when≥2; otherwise put those entrants into regular Arena exactly once. One stamina debit for the slot; frozen builds and fullHP each bout; separate parent-dependent job per bout and round-ordered rating updates. Reveal round `r` at80×r/(R+1)minutes; minute80 settles bout renown plus exact placement money/renown once. Byes do not grant wins. Elimination never opens another activity in the same slot.
- [ ] **Step 4:** Run eligibility cutoff±1ms, opt-out/insufficientstamina, 0/1/2/3/5/50 entrants in each league, bye paths, stalled child job, lease retry, fullHP per bout, placement counts/amounts and frozen-build tests. A two-person run has one bout and only winner/runner-up placement awards.
- [ ] **Step 5:** Stage named files plus `M09a`; commit `feat: run automatic league tournaments`.

## Task 20: Tournament countdown, brackets, and visible camp roles

**Files:** Create `src/features/tournaments/TournamentPanel.tsx`, `tests/browser/tournament.spec.ts`; extend camp scene, bridge and gateway.

**Interfaces:** Consumes `TournamentView`, opt-in command and revealed logs. Produces registration controls, locally formatted UTC countdown, public bracket shape and waiting/fighting/spectating actor roles.

- [ ] **Step 1:** Test future results remain hidden.
  ```ts
  await tournamentFlow.openBeforeRound(page, 1);
  await expect(page.getByText('Result preparing')).toBeVisible();
  expect(await tournamentFlow.visibleWinnerIds(page)).toEqual([]);
  await expect(page.getByLabel('Automatically enter tournaments')).not.toBeChecked();
  ```
- [ ] **Step 2:** Run tournament browser suite; expect missing registration/bracket presentation.
- [ ] **Step 3:** Explain opt-in plus scheduledArena and stamina requirements; preserve normal Arena participation when opted out. Show entrants/byes at start, reveal results only from server stages, and link completed bouts to replays. Waiting/eliminated actors remain in tournament activity and spectate within the scene's population budget. Display tournament times in the viewer's timezone with UTC reference.
- [ ] **Step 4:** Run mobile bracket navigation, DST/local timezone formatting, late-toggle behavior, 1-person fallback explanation, unavailable round preparation, own loss and selected spectator replay cases.
- [ ] **Step 5:** Stage named files; commit `feat: show tournament participation and brackets`.

## Task 21: Season ordering, filtered rewards, and lasting prestige

**Files:** Create `supabase/functions/_shared/domain/season.ts`, `tests/domain/season.test.ts`, `tests/db/seasons.test.ts`, `src/features/seasons/SeasonPanel.tsx`, `tests/browser/seasons.spec.ts`; complete `supabase/sql/09-tournaments-seasons.sql` season portion and boundary hook; generate `M09b`.

**Interfaces:** Consumes starting-slot assignment, league ratings/participation and reward receipts. Produces `seasonAt(slotIndex: number, launchSlot: number): SeasonWindow`, `selectSeasonAwards(records: SeasonRecord[]): SeasonAward[]`, backend SQL `close_season(season_id uuid, coordinator_token uuid) returns jsonb`. SeasonWindow has start/end-exclusive slots; launch epoch is persisted once, not recomputed from deploy time.

- [ ] **Step 1:** Test final-slot ordering and promotion rewards.
  ```ts
  expect(seasonAt(launchSlot + 503, launchSlot).index).toBe(0);
  expect(seasonAt(launchSlot + 504, launchSlot).index).toBe(1);
  expect(await db.closeBeforeFinalSettlement()).toHaveCode('processing');
  expect(selectSeasonAwards(promotedQualifiers).filter(a => a.gladiatorId === promotedId)).toHaveLength(1);
  expect(await db.retrySeasonClose()).toMatchObject({ newAwards: 0 });
  ```
- [ ] **Step 2:** Run season unit/DB suites; expect missing close barrier/award selection.
- [ ] **Step 3:** Implement exact504-slot/28-day seasons, assign human bouts by activity start, settle lastslot first, and archive full standings by rating/wins/fewerlosses/stableID. Qualify≥5humanbouts; assign each character only to its highest qualifying league, then select that league's top3 eligible subset. Pay500/100,300/60,200/40 plus persistent title/badges once; retain progression/inventory/currencies, begin new ratings1000. Add season/history/prestige UI and promoted/inactive indicators. Local tests seed launch epoch; production activation occurs Task24.
- [ ] **Step 4:** Run boundary crash/recovery across seasonclose, tournament lastslot, exact4/5bouts, bankedpoints/promotion, tie-breaks, fewerthan3qualifiers, lowerleague prize-slot filtering, duplicategrant and cosmetic persistence tests plus browser standings/history flow.
- [ ] **Step 5:** Stage named files plus `M09b`; commit `feat: close seasons with durable rewards and prestige`.

## Task 22: Retention, health reporting, and recoverable exports

**Files:** Create `supabase/sql/10-operations.sql`, `scripts/health.mjs`, `scripts/export-db.ps1`, `scripts/restore-check.ps1`, `tests/db/retention.test.ts`, `tests/db/recovery.test.ts`, `docs/operations/runbook.md`, `docs/operations/environment.md`; generate `M10`.

**Interfaces:** Consumes job/checkpoint/receipt/ledger state. Produces `health` script JSON with overdue jobs, stalled boundaries, attempt counts and resource metrics; backend `cleanup_history(database_now timestamptz) returns jsonb`. Export/restore scripts require explicit local targets and private operator credentials; neither exposes a player admin endpoint.

- [ ] **Step 1:** Test permanent retry protection after pruning.
  ```ts
  await db.ageAndCleanup({ replayDays: 8, summaryDays: 91 });
  expect(await db.replayCount()).toBe(0);
  expect(await db.retryOldGrantedOperation()).toMatchObject({ newGrants: 0 });
  expect(await db.unfinishedRecoveryRowsIntact()).toBe(true);
  expect(await db.restoreAndResume()).toMatchObject({ duplicateGrants: 0, lostItems: 0 });
  ```
- [ ] **Step 2:** Run retention/recovery DB suites; expect absent cleanup/export recovery behavior.
- [ ] **Step 3:** Add daily listing expiry and safe7-day replay/90-day summary cleanup; retain compact terminal operation IDs/payload digests/receipts, grant guards, settled-slot checkpoints, ownership, season prestige and necessary revisions forever. Never prune unfinished jobs/reservations or history required before a catch-up checkpoint. Record secret-free durations/CPU/attempts and an owner health report; alert through operator output on overdue work and budget thresholds. Document manual recovery after three failures, retained-rule deployments, scheduler pauses, secret rotation, weekly offline exports and restore procedure. Weekly operation is documented here; don't create an account automation unless requested.
- [ ] **Step 4:** Run cleanup twice, expired listing recovery, paused-service multi-day replay, oldoperation retries after90days, database export into an ignored directory and restore into a separate local test database. Check checksums/counts and resumed boundary invariants. Run advisors and migration replay.
- [ ] **Step 5:** Stage named files plus `M10`; commit `ops: add retention and database recovery procedures`.

## Task 23: Release security, accessibility, and measured capacity

**Files:** Create `tests/db/access-matrix.test.ts`, `tests/browser/release.spec.ts`, `tests/performance/simulation.test.ts`, `scripts/resource-report.mjs`, `.github/workflows/checks.yml`, `docs/operations/release-evidence.md`; extend static scanner/config and visual failure fallbacks as needed.

**Interfaces:** Consumes all product paths and test harnesses. Produces `npm run verify` (typecheck, unit/backend/assets, DB integration, browser, build/static scan) and a release-evidence record of actual environment, command results, device metrics, resource estimates and remaining blockers. Resource report projects50activeplayers×30visibleminutes/day and separately50concurrentviewers.

- [ ] **Step 1:** Add focused negative access and frontend failure tests.
  ```ts
  expect(await accessMatrix.directMutations()).toEqual({ owner: 'denied', other: 'denied', unauthenticated: 'denied' });
  expect(await accessMatrix.privateSeedReads()).toEqual({ owner: [], other: [], unauthenticated: [] });
  await page.route('**/assets/actors/**', route => route.abort());
  await expect(page.getByRole('button', { name: 'Schedule' })).toBeEnabled();
  ```
- [ ] **Step 2:** Run owning access and releasebrowser suites; any newly exposed access/failure gap must fail before fixing it.
- [ ] **Step 3:** Close proven access/failure gaps, wire CI to fresh migrations/local backend, and implement resource measurement. Test retained rules against migrations/static releases. Build benchmarks for worst-case 120-second combat and the largest 50-entry tournament graph; tune batches locally without changing semantics. Profile real assets with 50 actors/six NPCs, culling, hidden pause and lazy scenes. Hosted measurements run in Task 24 after infrastructure exists.
- [ ] **Step 4:** Run `npm run verify`. Record desktop/browser and a physical mobile device or connected device lab: target 60 desktop/≥30 mobile fps under a repeatable scene path; touch drag/pinch, panel scroll, keyboard equivalent controls, reduced motion, and repeated scene navigation. Record local timing and projected DB<250 MB, monthly egress<3 GB, functions<300,000, including reveals/polling/full projection size/retention. Simulated mobile viewport and local worker timing are not hosted/device evidence; leave the actual hosted CPU/boundary checks pending for Task 24. Unavailable real-device measurements remain a launch blocker.
- [ ] **Step 5:** Stage named/changed files; commit `test: verify public game security and capacity`.

## Task 24: Provision free infrastructure and verify the public origin

**Files:** Create `public/_headers`, `docs/operations/deployment.md`, `tests/browser/deployed.spec.ts`; update environment/runbook/release evidence and production config. No secrets are committed.

**Interfaces:** Consumes verified static export, migrations, Edge handlers and runbooks. Produces a CloudflarePages public URL backed by Google OAuth/Supabase and a once-persisted season launch slot. Production frontend contains only projectURL/publishablekey; backend/Vault stores worker/Google credentials.

- [ ] **Step 1:** Establish the deployed acceptance checklist/test with real account transport.
  ```ts
  expect(await deployedChecks.fixedRoutesReload()).toBe(true);
  expect(await deployedChecks.persistedCharactersForNewGoogleAccount()).toBe(1);
  expect(await deployedChecks.completedRealBoundary()).toMatchObject({ duplicateGrants: 0 });
  expect(await deployedChecks.twoAccountTrade()).toMatchObject({ owners: 1, feeCorrect: true });
  ```
- [ ] **Step 2:** Run the deployed check against the selected preview origin before setup; expect missing backend/configuration, with no guessed credentials. Account availability is a human prerequisite: if missing, request only the needed sign-in/choice while completing local deliverables.
- [ ] **Step 3:** Inspect available accounts/projects first. Create/connect one free Supabase project, CloudflarePages project and Git source repository within approved execution/deployment scope; never enable a paid upgrade. Apply audited migrations, deploy functions, configureGoogle identity-only scopes with Google's Supabase callback and exact appredirects, install minuteCron/Vault/pg_net dispatch and daily cleanup, and set freePages subdomain. Set appropriate staticsecurity/cache headers, exact CORS origins and public env variables. Choose the next fullslot as launch epoch and persist it once only after launch activation. Set the season epoch before any boundary with members exists (there are no gladiators before launch), never in the past; a boundary already waiting at phase 4 `'epoch'` must not be the last slot of a season under the chosen epoch (see `docs/operations/migrations.md`, M15, known limit). Preview deployments use isolated test data, not fixture claims of persistence.
- [ ] **Step 4:** Run all local checks and the deployed journey with real Google login, fresh creation/reload, schedule edit, one real 80-minute boundary, and a real two-account trade. Run Task 23's benchmark against the hosted backend: 50-character boundary completion≤2 minutes and each worker<2 CPU seconds, with worst-case combat/batches and projected free-plan budgets confirmed. The real boundary check can complete across turns with an explicitly approved follow-up; do not block silently for 80 minutes or claim completion from an accelerated clock. Inspect shipped JS/assets for secret credentials and verify direct callback/game reload, unauthorized RPC denial, real Cron/job logs, export/restore readiness and usage metrics. Record actual URL and evidence; fixes repeat only affected checks.
- [ ] **Step 5:** Stage only safeconfig/tests/docs; commit `deploy: verify the public gladiator game`. Share the verified URL and any material launch limitation. Full release completion requires all acceptance items below.

## Spec coverage and final acceptance map

| Approved acceptance item (§13) | Owning tasks |
| --- | --- |
| 1 — Real Google login, one persistent character, schedule | 4–6,24 |
| 2 — Phase/repeats/cutoff/build/fees/point conservation | 2,6,7 |
| 3 — Three offline game days, historical recovery, no duplicate slot | 7,9,22 |
| 4 — Stamina fallback, Endurance, overload and no refill | 2,6–8,13 |
| 5 — 50-character living camp, animation, depth/camera/lighting | 11,12,23 |
| 6 — Revealed expeditions, HP, fail/success, stable reload result | 9,10,15 |
| 7 — Deterministic combat/replay, parallel fights, NPC fallback | 3,7,14,16,17 |
| 8 — Tournament counts/byes/cutoff/graph/HP/debit/rewards | 19,20 |
| 9 — Historical league placement/season ordering/rating/qualification | 8,16,21 |
| 10 — Purchase/cancel/sale/reservation races and binding | 6,8,18 |
| 11 — Four-role access matrix, future events, seeds/provider privacy | 4,10,23 |
| 12 — Desktop/mobile, touch/keyboard/reducedmotion/fallback/fps | 5,12–15,17,20,23 |
| 13 — HostedCPU/resourcebudget/OAuth/real scheduled deployment | 22–24 |

Root self-review completed on 2026-10-11: all spec sections and 13 acceptance flows have owning tasks; all five Review Focus cases have targeted tests; task order and shared types were checked. The review corrected the hosted-benchmark prerequisite, the combined-fee fixture, public/private read separation, two-handed shield handling and the four-weapon asset count. The plan is comparable in length to the spec and contains assertions/signatures rather than implementation bodies. During execution, replace proposed acceptance evidence with actual results; this plan does not claim any game code or tests already exist.

## Execution choice

Recommended: **Subagent-driven** execution, with a fresh implementer and reviewer per task plus final whole-branch review. The24tasks share consequential clock, inventory, and currency contracts; independent checks at each boundary can catch mistakes before later systems depend on them.

Alternative: **Native** execution in the current session, with one fresh whole-branch reviewer at the end. It uses fewer agent contexts; implementation and intermediate checks remain with the primary agent.

Approve the plan and choose an execution method before implementation starts. Proposed technical details added by this plan—file/API names,64×32tiles/64×64actorbounds,120-second jobleases, endpoint rate limits and the marketplace price cap—are reviewable implementation choices; they do not alter the approved gameplay rewards/timing.

## Current official references checked during planning

- [Next.js static export](https://nextjs.org/docs/app/guides/static-exports) — fixed exported routes and no request-time server dependency.
- [Cloudflare Pages static Next.js guide](https://developers.cloudflare.com/pages/framework-guides/nextjs/deploy-a-static-nextjs-site/) — hosting the static build.
- [Phaser's Next.js template](https://github.com/phaserjs/template-nextjs) — browser integration reference; verify compatible package versions at execution instead of copying its older pinned combination blindly.
- [Supabase HTML changelog](https://supabase.com/changelog) — accessible fallback for the earlier markdown fetch limitation; inspect relevant changes before implementing each Supabase area.
- The approved spec §15 contains the remaining primary references for cameras, schedules, Google login, limits and pricing.
