# Task 23: Release Security, Accessibility and Measured Capacity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove locally, with repeatable harnesses, that the release is closed to unauthorized access, usable by keyboard and assistive technology, and within its performance and free-tier budgets. Close every item earlier tasks carried to Task 23. Anything only the hosted project or a physical device can prove is named as a Task 24 blocker.

**Architecture:** Two lanes.
- **Lane A** (database and backend) runs serially in `Cloudiator-claude`, because there is one local stack and the database-test rule forbids parallel DB runs.
  - 23.1: access matrix and hardening (M17).
  - 23.2: timing correctness (M18).
  - 23.3: capacity measurement.
  - 23.6: release gate.
- **Lane B** (UI only, no database) runs in parallel in `Cloudiator-replay` on port 3300.
  - 23.4: read volume and render cost.
  - 23.5: accessibility and the release browser spec.
- Lane B branches are cherry-picked onto the Task 23 branch before 23.6.

**Tech Stack:** Next.js 16.4 static export, React 19, Phaser 4.2.1, Supabase Postgres 17 (CLI 2.120.0), Deno Edge functions, Vitest, Playwright 1.64 (Chrome channel), Node scripts, GitHub Actions.

**Spec:** [game design](../specs/2026-10-11-gladiator-arena-design.md) §10–§13 (security :384, failure handling :399, budgets :406–:414, rules :418, release tests :436–:437; 60/30 fps and reduced motion :83). This plan refines Task 23 of the [24-task plan](2026-10-11-gladiator-arena-implementation.md) (:526–:542, global constraints :24–:28, acceptance rows :570, :576–:578). It also closes the items carried by earlier review records; the requirement IDs R1–R14 and C1–C27 below come from the Task 23 research ledger entry.

## Global Constraints

- "Public projections are readable by anyone, including visitors who have not signed in. Private reads and all commands require Google sign-in, and the acting character is bound to the verified account."
- "Backend credentials, worker authentication material, seeds, and unrevealed plans remain server-side."
- "Target 60 fps desktop and at least 30 fps on the mobile test device, verified before release rather than assumed."
- "Below 250 MB database usage, below 3 GB monthly Supabase egress, and below 300,000 monthly function invocations at the initial expected usage."
- The usage model is 50 active players × 30 visible minutes per day, plus a separate 50-concurrent-viewer model (visitors).
- Worker budget: `cpuMs 2_000` per invocation, at most 25 simulations per tick; boundary latency at most 120 s at 50 characters.
- No package or tool downloads (no new npm packages, Docker images or CLIs). `npm audit` (a registry query, no download) is allowed by default (Avi decision 4).
- Never print `supabase status`, keys, JWTs or `.env*` contents.
- Read `node_modules/next/dist/docs/` before changing Next code.
- Gate order and the database-test rule: `docs/operations/verification-gates.md`.
- Generated-migration completion, psql fallback and stand-in restore rule: AGENTS.md.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **An unexpected privilege.** A visitor, another account, or the owner must not be able to write to any table or run any function they should not, or read any private seed, plan, snapshot or another owner's private state. The check covers every role and every privilege kind, MAINTAIN, REFERENCES and TRIGGER included. Test: 23.1.
- **A slot that starts in the last minutes of its 80 minutes.** Timing tests, the coordinator and the dispatch window behave the same at every offset in the slot. Test: 23.2.
- **The target load.** 50 players and 50 visitors stay under 250 MB, 3 GB a month and 300,000 invocations a month, with the arithmetic shown. Test: 23.3.
- **A keyboard-only or screen-reader player.** Every control has a name, focus never drops to `body`, and validation messages are linked to their fields. Test: 23.5.
- **A failure while playing.** Missing art, a failed log or an unavailable camp shows a clear state with a working Reload, never a blank or frozen camp. Test: 23.4 and 23.5.

---

## Decisions (controller, binding; Avi's open choices use the defaults below until Avi answers)

1. **Names.** SQL source `supabase/sql/15-release.sql`; migrations M17 (23.1, access hardening) and M18 (23.2, timing). The old plan's file names stay where they still fit (`tests/db/access-matrix.test.ts`, `tests/browser/release.spec.ts`, `scripts/resource-report.mjs`, `docs/operations/release-evidence.md`).
2. **Avi's open choices, with defaults.**
   - **Mobile device.** An opt-in frame-rate overlay (`?perf=1`) on the production build, measured on Avi's phone after the Task 24 deployment. Until then, mobile 30 fps is a named launch blocker.
   - **Reduced motion.** The OS setting is enough; no in-app toggle.
   - **CI.** A GitHub Actions workflow is added and pushed.
   - **Dependency audit.** `npm audit` is allowed.
   - **Art gallery.** `/assets/gallery.html` is excluded from the production export.
   - **Visitor reads.** Unthrottled visitor reads are accepted and monitored through the health report and the hosting dashboard.
   - **Copy.** "Last known camp" stays.
3. **Root causes already found.**
   - `arena.test.ts:1193` waits `stableRealSlot(120_000)`, which can sleep up to 121 s, inside a 60 s test timeout (`:1250`).
   - `tournaments.test.ts:169` waits `stableRealSlot(60_000)` under the 20 s default.
   - Both fail whenever a run starts late in a slot (the 60 s arena flake, C16). The fix is to give each such test a timeout of at least the wait plus its own work, and to check every other `stableRealSlot` margin.
4. **The coordinator busy race (C2).** `runWorker` retries coordination at most 3 times, 250 ms apart, when the coordinator answers `busy`, then reports `deferred`. This fixes `arena.test.ts:642`.
5. **Held dispatch window (C3).** Count the dispatch budget per scheduled minute, not per rolling 60 s. This keeps the ceiling at 5 per minute (about 216,000 a month) and removes the 121 s held-window publication. Tested with realistic tick offsets (+300 ms and +60,250 ms).
6. **Published-slot signal (C5).** Add `published_slot_index` to the public revision state (an additive `RevisionState` field). The client uses it instead of the 5-minute "being prepared" grace.
7. **Security headers.** A generated `out/_headers` for Cloudflare Pages, built from the production Supabase URL, containing:
   - `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://<project>.supabase.co; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`;
   - `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a minimal `Permissions-Policy`;
   - immutable caching for `/_next/static/*`.

   `scripts/serve-static.mjs` applies the same headers, so the production gate fails on any CSP violation. `'unsafe-inline'` scripts are unavoidable for a static export (Next docs, content-security-policy guide); this is a recorded exception. The `_headers` file is pulled forward from Task 24.
8. **Accessibility method.** No new packages. Use:
   - Playwright `toMatchAriaSnapshot` for the rail, panels and dialogs;
   - role and name queries with `toBeFocused` along a keyboard-only journey;
   - a page check that every focusable element has an accessible name;
   - a WCAG contrast-ratio check from computed styles on key text;
   - `emulateMedia({ reducedMotion: 'reduce' })`.
9. **FPS method.**
   - A `requestAnimationFrame` sampler injected with `addInitScript` reports mean fps, 5th-percentile fps, and the share of frames over 16.7 ms and over 33.3 ms.
   - The path: `createDemoWorld(now, 50, 6)` (50 actors and 6 NPCs), pan, maximum zoom, six Arena fights, tournament spectators, then 20 open/close cycles of the replay and expedition scenes.
   - It runs in headed Chrome on the development fixture build and records the WebGL renderer string. Pixel 7 emulation with 4× CPU throttling is indicative only.
   - The production `?perf=1` overlay feeds the device measurement in Task 24.

## Execution

- Branch `claude/task-23` from the Task 22 tip, in `C:\Avi\Studies\Projects\Cloudiator-claude` (Lane A). Lane B uses `claude/task-23-ui` in `C:\Avi\Studies\Projects\Cloudiator-replay`, from the same tip.
- One reviewed checkpoint per task, with visual review for 23.4 and 23.5.
- **Order.** 23.1 → 23.2 → 23.3 serially in Lane A, while 23.4 (after 23.2's `RevisionState` contract is committed) and 23.5 run in Lane B. Then cherry-pick Lane B, run 23.6, and do the final whole-branch review.

---

### Task 23.1: Access matrix and hardening (Lane A, M17)

**Files:**
- Create: `tests/db/access-matrix.test.ts`, `supabase/sql/15-release.sql`
- Generate: M17
- Modify: `tests/db/visitor-access.test.ts:31-37` (`anonWritable` covers REFERENCES, TRIGGER and MAINTAIN), `docs/operations/migrations.md` (M17 section)

**Interfaces:**
- Produces:
  - `15-release.sql`, which revokes:
    - `anon`'s leftover MAINTAIN, REFERENCES, TRIGGER and TRUNCATE on the 8 M01 owner tables (C1);
    - M01's default `GRANT UPDATE ON SEQUENCES` to `anon` and `authenticated`.
  - **The access matrix**, one test file. It checks, from the catalog, for `anon`, `authenticated` and `PUBLIC`:
    - every relation and column privilege in `public` and `private`;
    - RLS on every public table, and `security_invoker = true` on every view;
    - for every function in `public` and `private`: not SECURITY DEFINER, `search_path=''`, no EXECUTE;
    - `pg_default_acl`.
  - It also pins a snapshot of `service_role`'s EXECUTE and DML set, so drift fails.
  - It checks real denied writes and RPCs through the Data API as owner, other account and visitor, and that private seeds, plans and snapshots are unreadable, even by their owner.
  - The catalog query is exported for reuse as a read-only operator audit against the hosted project (Task 24).

- [ ] **Step 1: Write the failing tests.**

```ts
test('grants visitors SELECT on the open projections only and nothing else on any relation', ...)
test('grants authenticated users no write on any table and no execute on any function', ...)
test('enables RLS on every public table and security_invoker on every view', ...)
test('defines no SECURITY DEFINER function and pins search_path on every function', ...)
test('leaves no default privileges to anon or authenticated', ...)
test('matches the pinned service_role privilege set', ...)
test('denies direct writes and private RPCs through the Data API as owner, other account and visitor', ...)
test('keeps seeds, plans and snapshots unreadable even by their owner', ...)
```

- [ ] **Step 2: Run** `npm run test:db -- tests/db/access-matrix.test.ts tests/db/visitor-access.test.ts`, under the Edge start-time rule. Expected: FAIL on MAINTAIN and on the default ACL.
- [ ] **Step 3: Implement** `15-release.sql`.
- [ ] **Step 4: Run** `npm run test:db`, then generate and complete M17:
  - clean replay;
  - parity fingerprint;
  - `npm run test:db` on the replay;
  - lint empty, and advisors with no WARN.
- [ ] **Step 5: Commit** `feat: lock every privilege behind a release access matrix (M17)`.

### Task 23.2: Timing correctness (Lane A, M18)

**Files:**
- Modify:
  - `tests/db/arena.test.ts:1193,1250`, `tests/db/tournaments.test.ts:169` (Decision 3), and every other `stableRealSlot` caller
  - `supabase/functions/_shared/backend/jobs.ts:316-347` (Decision 4)
  - `supabase/sql/15-release.sql` (dispatch accounting, Decision 5; published slot, Decision 6)
  - `supabase/functions/_shared/contracts/reads.ts` (`RevisionState.publishedSlotIndex`), `src/lib/api/reads.ts`
- Generate: M18
- Test: `tests/backend/worker.test.ts`, `tests/db/arena.test.ts` (production-cadence timing), `tests/db/activities.test.ts` (dispatch offsets)

- [ ] **Step 1: Write the failing tests:**

```ts
test('retries coordination three times when busy, then reports deferred', ...)       // worker.test.ts
test('spends the dispatch budget per scheduled minute at offsets +300 ms and +60,250 ms', ...)
test('publishes a cleared and a held window within 120 s at production cadence', ...)
test('exposes the published slot in the public revision state', ...)
test('gives every stableRealSlot wait a timeout longer than its longest sleep', ...)   // static check over the test files
```

- [ ] **Step 2: Run** the named files. Expected: FAIL.
- [ ] **Step 3: Implement** Decisions 3–6.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run test:db`. Then generate and complete M18, with a clean replay and the DB suite on the replay.
- [ ] **Step 5: Commit** `fix: make slot timing independent of when a run starts (M18)`.

### Task 23.3: Capacity measurement (Lane A)

**Files:**
- Create: `scripts/resource-report.mjs` (reusing `scripts/operator-db.mjs`), `tests/performance/simulation.test.ts`, `tests/db/capacity.test.ts`
- Modify: `docs/operations/release-evidence.md` (create)

**Interfaces:**
- `node scripts/resource-report.mjs [--players 50] [--viewers 50] [--slots K]` seeds a measurement world on the local stack, runs K accelerated boundaries with the real worker, and prints JSON:
  - `{database: {bytesPerSlot, steadyStateBytes, budgetBytes}, invocations: {perSlot, perMonth, budget}, egress: {perRead: {kind: {raw, gzip, brotli}}, perMonthPlayers, perMonthViewers, budget}, worker: {worstCombatMs, batch5Ms, bracket50Ms}, seasonClose: {ms50, ms500}, standings: {pageMs, oneRowMs}}`.
  - The steady state uses the retention windows: 7-day detail is 126 slots, 90-day summaries 1,620 slots, and receipts, checkpoints and archives are permanent.
  - Egress uses real local Data API response sizes, compressed with node zlib, multiplied by the revision changes per slot counted in the run.

- [ ] **Step 1: Write the failing tests:**

```ts
test('simulates the worst-case 120 s fight within the 2,000 ms worker budget with a 25 % margin', ...)
test('builds the 50-entrant bracket and its jobs within budget', ...)
test('closes a season of four 50-player leagues within one boundary budget', ...)   // capacity.test.ts
test('reads a standings page and one standing row within their budgets at 1,000 rows', ...)
```

- [ ] **Step 2: Run** the tests. Expected: FAIL (absent harnesses).
- [ ] **Step 3: Implement** the harnesses and the report script.
- [ ] **Step 4: Run** the report and record its JSON and the arithmetic in `release-evidence.md`. Any budget over 80 % is a named risk with a mitigation; any over 100 % is a blocker for Avi.
- [ ] **Step 5: Commit** `test: measure capacity against the free-tier budgets`.

### Task 23.4: Read volume and render cost (Lane B, after 23.2's RevisionState commit)

**Files:**
- Modify:
  - `src/lib/api/gateway.ts:149-156` (bounded LRU log cache, C7)
  - `src/features/shell/SceneOverlay.tsx` (pause the camp loop under an opaque scene, C8)
  - the "being prepared" reads (back-off on both reads, C11; use `publishedSlotIndex` and drop the grace, C5)
  - the ring order and failed-log retry (C9)
  - de-duplicated owner and `/replay/` re-reads where safe (C6, C25)
  - `src/game/GameViewport.tsx` (camp failure Reload, R13)
  - a `?perf=1` overlay (Decision 2)
- Create: `tests/performance/fps.spec.ts` with its own Playwright config `tests/performance/playwright.perf.config.ts` (Decision 9)

- [ ] **Step 1: Write the failing tests** (unit and browser):

```ts
test('keeps at most N tournament logs in the cache', ...)
test('pauses the camp loop while an opaque scene is open and resumes after', ...)
test('backs off both preparing reads after three minutes', ...)
test('uses the published slot instead of the five-minute grace', ...)
test('retries a failed ring log and keeps multi-league arrival order', ...)
test('offers Reload when the camp cannot load and recovers after it', ...)
test('reads the owner once per revision change', ...)
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gate on port 3300 and the production gate. Then run the FPS harness and record its numbers, plus the renderer string, in `release-evidence.md` (Lane B writes its section; the controller merges it). Save `perf-` screenshots.
- [ ] **Step 5: Commit** `perf: bound reads and rendering for the release`.

### Task 23.5: Accessibility and the release browser spec (Lane B)

**Files:**
- Create: `tests/browser/release.spec.ts`
- Modify:
  - `src/app/layout.tsx` and `src/app/globals.css` (skip link reachable on the first Tab)
  - focus management after unmounts and after a trade
  - `aria-invalid` and `aria-describedby` in the Build, Schedule, Shop, Market and Create forms
  - the season picker, progress bar and medal-pill names
  - the remaining Task 13 items (C19)
  - the test gaps (C20)

- [ ] **Step 1: Write the failing tests:**

```ts
test('keeps Schedule enabled and named "Schedule" when actor art fails', ...)          // R2
test('completes a keyboard-only journey through every menu with focus never on body', ...)
test('names every focusable control and links each validation message to its field', ...)
test('meets 4.5:1 contrast on panel text and 3:1 on controls', ...)
test('respects reduced motion in the rail, panels and scenes', ...)
test('fits every sheet at 360 px with no horizontal scroll', ...)
test('shows an unavailable replay in the production build', ...)
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gate on port 3300 and the production gate. Save `a11y-` screenshots.
- [ ] **Step 5: Commit** `feat: make the release accessible by keyboard and screen reader`.

### Task 23.6: Release gate (Lane A, after 23.1–23.5)

**Files:**
- Create:
  - `scripts/verify.mjs` (behind `npm run verify`, in the `verification-gates.md` order, with the Edge start-time check)
  - `.github/workflows/checks.yml` (fresh migrations, a local backend and the gates)
  - `scripts/build-headers.mjs` (Decision 7)
- Modify:
  - `scripts/verify-static.mjs` (base64 `service_role`, `eyJ…` JWTs, `_headers` presence and content, `/assets/gallery.html` excluded)
  - `scripts/serve-static.mjs` (applies the headers; the production gate records CSP violations)
  - harness noise (C23)
  - `docs/operations/release-evidence.md`
- Also covers:
  - the triage of `shell.spec.ts:42` (C21) and the Edge recreations (C22);
  - `npm audit` and `npm ls --all` with a lockfile and pin review;
  - the rule-retention test for in-progress snapshots across migrations (R6).

- [ ] **Step 1: Write the failing tests** for the scanner (headers, JWT patterns, gallery exclusion), `verify.mjs` ordering, and a CSP-violation listener in the production gate. Expected: FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npm run verify` end to end. Then push the workflow and record its first run (Avi decision 3).
- [ ] **Step 4: Complete** `release-evidence.md`:
  - environment, commands and results;
  - device metrics;
  - the budget arithmetic;
  - named Task 24 blockers: mobile 30 fps on the device, hosted CPU and dispatch spacing, hosted egress and compression, CORS parity, the remote export rehearsal.
- [ ] **Step 5: Commit** `ops: add the release gate and its evidence`. Then commit `docs: report Task 23` with `docs/implementation/task-23-report.md`.
