# Task 8 dispatch addendum (controller: Claude)

The full task brief is Codex's saved brief: `C:\Avi\Studies\Projects\Cloudiator\.superpowers\sdd\2026-10-11-gladiator-arena-implementation\task-8-brief.md`. Read it completely first: the plan's Task 8 text, the global constraints, the binding spec sections 5, 6 and 9, and the Task 6 reconciliation. Where this addendum differs from its "Controller context" and "Reviewed producer reconciliation" sections, this addendum wins.

## Where to work

- **Work only in** `C:\Avi\Studies\Projects\Cloudiator-claude` (branch `claude/visual-track`). Base: the HEAD at dispatch time; record it in your report. It contains reviewed Tasks 1–7, 11, 12 and 14.
- **Never write to, reset, commit in or run tools inside** `C:\Avi\Studies\Projects\Cloudiator` (Codex's frozen checkout; the brief is read from there) or `C:\Avi\Studies\Projects\Cloudiator-replay`.
- You may change shared files that Task 8 needs (route, gateway, fixtures, contracts if additive). Keep each change minimal and list every file outside the plan's Files list in your report.
- Leave alone: `src/game/**`, `assets/**`, `public/assets/**`, the camp/replay tests, the art docs, `docs/implementation/HANDOFF.md`, other tasks' reports.

## Reviewed producers you build on

- **Task 6** (`docs/implementation/task-06-report.md`, `task-06-review.md`): item reservations, fee holds, operation-receipt replay, the processing contract. Lock order for every account mutation: advisory `hashtextextended(actor_id::text, 0)`, then the character row `FOR UPDATE`, then dependent wallet/build/inventory rows in sorted id order; `clock_timestamp()` read after the locks. Do not omit the account lock.
- **Task 7** (`docs/implementation/task-07-report.md`, "Interfaces for later consumers", plus the fix pass recorded in the same report): activities, settlement, `settle_rewards`, `private.settled_slots`, the processing/retry contract for commands while the world is behind. Acquisition never mutates an active `activity_snapshots` row. `historicalGearScore` output feeds frozen boundary inputs; Task 16 supplies the league formula. Do not introduce a competing one.
- Spendable money = wallet money minus held fees. Reject sale/discard/listing of equipped or pending-reserved items under the same locks.
- M01–M03 and any Task 7 fix migration are committed and immutable. Generate your own migration (the plan calls it M04; the real file is timestamped and may sort after the Task 7 fix migration) with the verified CLI workflow, compare it with the SQL source and append what the generator dropped, then prove it with a clean reset/replay (`npx supabase db reset --local --no-seed --yes`) plus all DB suites, `db lint` and advisors. Record the path in `docs/operations/migrations.md`.

## Controller decisions

1. **Commands.** `buy-shop`, `sell-item`, `discard-item` go through the existing `game-command` handler and parser (`_shared/backend/commands.ts`), with account-scoped operation receipts and the same replay/conflict semantics as creation and build commands. Backend-only RPCs `buy_shop`, `sell_item`, `discard_item` with `(actor_id uuid, operation_id uuid, input jsonb)`, `SECURITY INVOKER`, empty `search_path`, PUBLIC execute revoked, `service_role` only.
2. **Domain** (`_shared/domain/inventory.ts`): pure. `planInventoryGrant`, `applyXp`, `historicalGearScore` exactly as the brief's interfaces; reuse `CATALOG_V1`, `RULES_V1`, `validateBuild` (two-hand rules) and the Task 2 types. Never a second stats or price table.
3. **Loot overflow.** The expedition overflow-to-money rule lives in `planInventoryGrant` now; Task 9's settlement calls it. Renown-bought equipment never converts to money.
4. **UI.**
   - `src/features/inventory/InventoryPanel.tsx` replaces the "Inventory" placeholder tab in `src/app/game/page.tsx`, following the Task 6 pattern for `SchedulePanel`/`BuildPanel` (live mode: `visibleOwner` plus `gateway`, with `refresh`). In fixture mode it renders the fixture owner's inventory read-only, and actions show the "unavailable in this preview" note, like the other panels.
   - `src/features/shops/ShopPanel.tsx` (weapon smith and armorer, exact versioned catalog prices, money or renown, level locks, full-inventory rejection) is reachable from the Inventory tab as a "Shops" section with the two merchants as sub-tabs, in both modes (fixture read-only). Task 13 later wires the camp's `open-merchant` bridge event to it; do not touch the camp.
   - Discard requires an explicit confirmation step. Names and item text render as React text. Keyboard and mobile usable; no new dependencies.
5. **Fixtures.** Extend `tests/fixtures/domain.ts` and the fixture gateway only as needed for the read-only preview. Keep `tests/api/fixture-gateway.test.ts` and Codex's browser suites green.
6. **Creature ids (for your encounter/loot factories, if any).** Any non-gladiator combatant you produce must carry an id of the form `creature:<manifest creature id>`; the replay draws anything else as an NPC fallback.

## Tests (TDD: write first, watch each fail for the right reason)

- `tests/domain/inventory.test.ts`: the brief's Step 1 unit assertions plus the Step 4 table: inventory boundary 59/60/61, partial salvage stacks, monotonic legal-loadout score with two-hand rules, XP consumption `100 × level` per level-up with no point or stamina refill, quantity/price overflow.
- `tests/db/shops.test.ts`: real SQL through the real handler/Edge where the existing suites do; insufficient funds, same-operation retry, bound-item discard/sale rejection, equip-versus-sale race with exactly one terminal transition, level locks, all shop prices against the versioned catalog, processing/retry while the world is behind.
- A browser test for the panels: `tests/browser/inventory.spec.ts` (new; the test-only identity transport from Task 5 is the model for live flows; `planning.spec.ts` shows how).
- Before committing, run: `npm test`, `npm run typecheck`, `npm run test:db`, `npm run build`, `npm run verify:static`, the dev browser suite (`npx playwright test -c node_modules/.cache/pw-claude.config.mjs`, port 3200; never 3000, 3100 or 3300), `git diff --check`. Also the isolated production gate from `task-05-report.md` if you touched the route.

## Local stack

Shared with no one else while you run. The Edge runtime serves this worktree's functions from a background `functions serve --env-file .env.edge.local` (ignored file; contains `GAME_ALLOWED_ORIGINS` and `GAME_WORKER_SECRET`). If you must restart it, do so from the worktree in the background and verify real HTTP afterwards. Never print secrets or `supabase status`. Preview port 3000 belongs to Codex's checkout.

## Commit and report

- `feat: add authoritative inventory and shops`, exact paths, detailed body. Then `docs/implementation/task-08-report.md` (task-06/07 style: interfaces, commands/results, RED/GREEN, migration/advisors, concerns and gates) in a separate commit. End every commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Do not push, merge, or dispatch subagents.

## Return

Status (DONE / DONE_WITH_CONCERNS / BLOCKED), SHAs, one-line test summary, concerns.
