# Task15 integration checkpoint

Date: 2026-10-14. Codex integrated Claude's reviewed expedition scenes as a
bounded item after Task10 approval, following Avi's five-hour-session guidance.

## Provenance and review

- Incoming branch `claude/task-15`, exact head
  `59e0db7055f4144035a5a8e897e764597441c307`, base `05b1ea0`.
- Root prerequisite `54beafb8c74037efd068ad36d0ade5775278f6ea` is the reviewed
  Task10 checkpoint, including immutable M07/M08 and safe read contracts.
- Conflict-free normal merge `930c2c74811c77c9b7bd681c2eb049478161846a` preserves
  contributor WIP/source/report/review history and Task14 fixes `708688b`.
- All53 incoming paths match the declared scene/fixture/evidence and approved
  shared route/gateway/scanner/static-test scope. No partial16/17/19/20 code
  was imported; no Claude checkout was changed.
- Existing independent full and scoped specification/quality/visual reviews
  approve the source. Read [task-15-review.md](task-15-review.md) and
  [task-15-report.md](task-15-report.md). Codex did not duplicate the full review
  or all153 development browser checks.

## Fresh combined verification

After merging, in this checkout:

| Check | Observed result |
| --- | --- |
| `npm run typecheck` | TypeScript, both frozen Deno entrypoints and2/2 Deno runtime tests passed. |
| `npm test -- tests/api/fixture-gateway.test.ts tests/static.test.ts tests/domain/expedition-fixtures.test.ts tests/domain/phaser-game.test.ts tests/domain/battle-stage.test.ts` | 74/74 passed in5 files. Covers merged fixtures, fifth route/security cases and the two lifecycle/fallback-warning corrections. |
| `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build` | Fresh production static export succeeded; fixture enablement is compiled false in production. |
| `npm run verify:static -- .next/browser-test` | Five fixed routes,90 assets, no forbidden backend material. |
| `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test --config=playwright.config.ts tests/browser/shell.spec.ts tests/browser/camp.spec.ts tests/browser/replay.spec.ts tests/browser/expedition.spec.ts` | **8 passed,118 expected development-only skips,4.7s**. Uses the repository configuration and its own4173 static server, as Claude requested. |

Build completed before the browser server started; no shared-output build/dev
collision occurred. The retained NO_COLOR/FORCE_COLOR warning is the known
release-harness Minor, not a new failure. Root also inspected the committed
360px expedition screenshot; that visual evidence is Claude's fixture capture,
not a physical-device or hosted-performance measurement.

The production checks verify configuration messaging, fixture/minute-clock
denial and safe canceled-OAuth handling. They do not claim configured Google
login or playable hosted multiplayer. No database replay was repeated for this
scene-only merge; Task10's109 DB/Auth/Edge checks and303-entry parity remain its
own separately recorded evidence.

## Remaining integration gates

- Claude13 mounts Task10's sync/shared display clock in management and camp,
  consumes spectator `timeline.completion`, replaces15's interim poll, and
  links expeditions from the roster. Existing replay in-progress labels need
  the shared display clock. Do not silently count those gates as implemented.
- Owner reward/overflow detail remains separate from public completion.
  Task15 currently presents its existing owner summary; later UI refinement
  can show the new per-item overflow lines without leaking them to spectators.
- Deferred15 Minors: preserve the safe-point rest pose while fading at return,
  use a named encounter-count constant, and update the cadence test title.
- Task14's early-destroy window handler restoration and unknown-creature-prefix
  warning are resolved by708688b and the independent15 review; see the appended
  resolution in [task-14-final-delta-review.md](task-14-final-delta-review.md).
- Hosted OAuth/CORS/scheduling, marketplace, competition backends, retention,
  budgets and measured desktop/mobile performance remain later tasks.

This checkpoint completes Tasks1–10/11/12/14/15: **14 of24 full tasks**. Claude's
16/19 domain phases and reviewed17/unreviewed20 checkpoints remain separate
paused lanes. The controller updates HANDOFF and verifies the pushed remote SHA.
