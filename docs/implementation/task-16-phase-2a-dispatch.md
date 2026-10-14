# Task 16 dispatch, phase 2a: Arena schema, league placement, ratings and pairing (controller: Claude)

Claude owns all remaining work since Codex's handover (2026-10-14). Phase 2 of Task 16 is split into two reviewable checkpoints:
- **2a (this dispatch):** schema, season identity, league placement, the rating rows with the visible combat strength, and pairing inside the boundary. Phase 2a stops before any bout is simulated or settled.
- **2b (later):** the per-battle simulation job, the worker executor branch, settlement, public Arena stages and standings.

## Read first (binding)

- `AGENTS.md`, every section. In particular:
  - the Supabase CLI override and the generated-migration completion check;
  - the Postgres concurrency override;
  - the new build and browser output separation override.
- `docs/operations/migrations.md`, `docs/operations/job-leases.md` and `docs/operations/verification-gates.md`.
- `docs/implementation/task-16-brief-base.md` (the binding plan and spec text plus the reviewed producer notes).
- `docs/implementation/task-16-phase-1-report.md`: its **"Phase 2 must do"** list is the agreed design. Items 1–6 and their DB tests (item 12) are this dispatch.
- `docs/implementation/task-16-phase-1-review.md`, and Avi's balance decision: keep the spec's strongest-first pairing.
- The reports and reviews of Tasks 7, 8, 9 and 10, for the real hooks, lock order, job graph and projections.
- `docs/implementation/HANDOFF.md`.

## Where and how

- **Work only in** `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-16-p2`, base `839423d` (the pushed integration head). Record the base in your report.
- The local Supabase stack "Cloudiator" is Claude's now. Its Edge functions are served from this worktree by a background `supabase functions serve --env-file .env.edge.local`, which hot-reloads source changes.
  - If you must restart it, do so from this worktree in the background, then check real HTTP.
  - Never print `supabase status`, keys or the contents of `.env.edge.local`. Send credential-bearing output only to ignored logs.
- Never write to, run commands in, or open `C:\Avi\Studies\Projects\Cloudiator` (Codex's finished root checkout), `C:\Avi\Studies\Projects\Cloudiator-replay` or `C:\Avi\Studies\Projects\Cloudiator-arena`.
- **Do not download any package or tool.** No `npx` of anything not already in `node_modules`, and no installs.
- Playwright, if needed, only through `node_modules/.cache/pw-claude.config.mjs` (port 3200).
- Do not push, merge, edit `HANDOFF.md`, or dispatch subagents.

## Controller decisions for the plan's open points (binding)

1. **Comparison target.** SQL must not restate `makeFighter` or `makeFallback`, so the TypeScript phase-4 preparation result gains, additively:
   - the frozen arena fighter `makeFighter(build, 'arena', rules)`;
   - its NPC template `makeFallback(arenaFighter)`;
   - the strength `estimateArenaStrength(arenaFighter)`;
   - the league from `leagueFor(level, earnedPoints, peakStrength)`.

   `complete_job` validates the preparation as today. Pairing acceptance compares each assignment's fighters and NPC template with these frozen values.
2. **Season identity (minimal; Task 21 builds on it).**
   - Add a backend-only single-row epoch, holding the slot index of the first launch boundary, set once and immutable afterwards, plus a helper `season_index = floor((slot − epoch) / 504)`.
   - Local and test databases set the epoch explicitly in their setup.
   - No season close, archive or rewards; those belong to Task 21.
3. **Ratings model.**
   - Add a private rating table, one row per (character, league, season): rating 1000, floor 0, plus human wins and human losses.
   - `public.gladiators.rating` and `.league` become a cache of the current league-season row and placement, so existing readers, snapshots (`starting.rating`) and projections keep working.
   - Placement never decreases. Entering a new league creates that league-season row at 1000 and keeps the old record.
   - Publish the current combat strength through the existing `PublicProfile.combatStrength` projection, from the frozen phase-4 strength. It stays null where none exists yet. Change Task 10's projection only additively.
4. **Pairing job kind.** `'pair'` counts as simple work, claimed with the simple jobs. One job runs per slot and league, under the dedupe key `pair:<slot>:<league>` and its own private job seed.
   - It is anchored to no gladiator. Relax `jobs.gladiator_id NOT NULL` with a check that only `'pair'` jobs may omit it.
   - Do every schema item listed under item 6 of the plan: kind checks, claim whitelist, the `complete_job` branch, `runWorker` order, the wait-reason check, and the registry entry.
5. **Battle seeds.** A pairing writes immutable `private.arena_assignments` rows. Each holds a per-battle seed `encode(extensions.digest(<pairing job seed> || ':' || battleId, 'sha256'), 'hex')`, computed in SQL when the row is written, so a retry reproduces it.
   - No simulation job is created in 2a.
   - Arena activities still stall truthfully after pairing, exactly as Task 7 left them, until 2b.

## Tests (TDD: write each first, watch it fail for the right reason)

From the plan's item 12, those that 2a can prove, in `tests/db/arena.test.ts`, plus worker unit tests where the worker changes:
- **Placement:** league placement at phase 4 never decreases; a new league starts at 1000 and keeps the old row; banked points count; a weak current loadout stays in its historical league.
- **Pairing:** the job waits, then reaches operator on failure, then adopts the result. Acceptance rejects a result that omits, duplicates or alters an entrant, fighter or NPC template.
- **Assignments:** rows are immutable, have no client access, and keep a stable battle seed across a retry.
- **Pairing behavior on real snapshots:**
  - no cross-league pairs;
  - the exact 2× boundary;
  - the 18-slot history;
  - an odd count gives the weakest an NPC;
  - 0, 1 and 50 entrants.
- **Access denial** for assignments, seeds, rating rows and the epoch.
- **Timing:** measure the pairing round trip (insert, dispatch, claim, complete, adopt) at 50 entrants and record it against the 2-minute boundary target.
- **Contracts:** keep every existing suite green.

## Migration

- Write the SQL source as `supabase/sql/07-arena.sql`. Its header documents every accepted exception.
- Generate the migration with the CLI after M08, never by hand.
- Complete the draft per AGENTS.md: ACLs, revokes, invoker views, ordering, backfills and initialization.
- Prove it:
  - clean `db reset --local --no-seed --yes`;
  - compare the replayed database with the source;
  - run all DB suites, `db lint` and the advisors;
  - record the migration in `docs/operations/migrations.md`.
- M01–M08 are immutable.

## Gate before committing (in the order of `verification-gates.md`)

1. `npm test`.
2. `npm run typecheck`.
3. `npm run test:db`.
4. `npm run build` and `npm run verify:static`.
5. The development browser suite (`pw-claude.config.mjs`).
6. `git diff --check`.

## Commit and report

- Commit `feat: place leagues and pair Arena entrants at the boundary` with a detailed body, and the migration with it.
- Then commit `docs/implementation/task-16-phase-2a-report.md` separately. Cover interfaces, decisions, RED/GREEN, migration evidence, the timing result, and exactly what 2b must do.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Return

Status (DONE / DONE_WITH_CONCERNS / BLOCKED), commit SHAs, a one-line test summary, concerns.
