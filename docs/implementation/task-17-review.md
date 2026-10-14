# Task 17 independent specification, quality and visual review

Date: 2026-10-14. Reviewers: three fresh Claude reviewer subagents, read-only on the worktree, with no database.

## Verdict

**Specification compliant; code quality Pass; visual Pass; ready to merge.**
- Range: `95eb764..` the head of `claude/task-17`.
  - `98284aa`: feature.
  - `88e2e58`: report.
  - `1f01531`: shared edits applied under Avi's authorization (board, 07:36 IDT).
  - `e3392fb` and `ff01dba`: review fix pass.
  - `6df1b78` and `f429c83`: follow-up.
  - Then this record.

## Round 1: full review (`95eb764..1f01531`)

**Reviewer evidence:**
- 440 unit tests passed; typecheck clean; assets up to date.
- Build and `verify:static` clean, with no fixture strings or test hooks in `out/`. The isolated fixture-enabled build was clean too.
- Dev browser suite on port 3300: 149 passed, 0 failed.
- A probe of the select-a-fight flow, plus the reviewer's own desktop, Pixel 7 and 360 px captures.

**Verdicts:** spec Pass (on condition that I2 and I3 are fixed), quality Pass, visual Pass, ready **with fixes**.

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| I1 | `forbidRemote` hard-coded port 3300, so 6 tests fail under the repo config. | Important | `e3392fb`: the origin is taken from the test's base URL; a pure test covers 3100, 3300 and 4173. |
| I2 | A card opened from the camp rendered off screen, with no feedback. | Important | `e3392fb`: the card scrolls into view and its heading takes focus, without smooth scrolling under reduced motion. `6df1b78` changed this to `block: 'nearest'`. |
| I3 | The card showed the result while the ring was still fighting. | Important | `e3392fb`: ring playback follows the real bout time. `6df1b78`: a jog walk-in at 3 tiles/s (`ARENA_ENTRY_MS` 4000) and one shared end time (`endsAtMs`). The camp now shows about 83% of a bout (median), up from about 54%. |
| I4 | Standings were re-read before settlement, then not for 80 minutes. | Important | `e3392fb`: a bounded 30 s refresh window after the boundary. Gate: "Your standing" reads `OwnerState` (Task 13). |
| M1–M13 | Fight-button strip over the canvas; unbounded maps; per-frame debug allocations; test-only label parsing; inconsistent fixture ratings; damage labels over nameplates; one message for "not available" and "failed"; preparing text; literals; NPC as participant 0; More rows lost on reload; stale report header. | Minor | `e3392fb` and `6df1b78`, except M7 (two reads per human pair). M7 is deferred: dedupe once a pairing hint exists. |

**Rulings on the implementer's concerns:**
- One log per pair: accepted; the entrant is found by `gladiatorId`.
- Standings cursor gap: accepted; a contract question for Codex.
- Reading Codex's uncommitted SQL: a disclosed, read-only process exception. Its conclusion must be confirmed when Task 10 lands.
- Late queued pairs: accepted, superseded by the I3 fix.
- Click-target fix: accepted.
- Panel tests written after the draft: recorded as a TDD deviation.
- Replay flake: not reproduced.
- `PW_REPLAY_ROOT`: accepted.
- Production gate: the build was checked; the browser part goes to integration.

## Round 2: scoped re-review of the fix pass (`1f01531..ff01dba`)

**Reviewer evidence:**
- 451 unit tests passed; typecheck clean; build and static scan clean.
- Dev browser suite: 165 passed, 0 failed. `arena.spec.ts` and `camp.spec.ts` with `--repeat-each 2`: 182 passed, no flakes.
- Walk-distance estimates from `map.json`.

**Verdicts:** spec Pass, quality Pass, visual Pass, ready **with fixes**. The fixes:
- Important follow-up 1: the camp showed only about half of each bout.
- Minors 1–5: the scroll position, one end time, a stale walk, label height, and live-mode wording.

All of these were fixed in `6df1b78`; the report records them in "Follow-up fix pass" with an integration checklist.

**I3 recommendation adopted:** keep real-time ring playback (ring, card and replay share one clock), make the walk-in a jog, and never hold the card for the ring.

## Round 3: scoped review of the follow-up (`ff01dba..f429c83`)

**Reviewer evidence:**
- 453 unit tests passed; typecheck clean; build and static scan clean.
- Dev browser suite: 172 passed, 6 skipped, 0 failed.
- A probe found no label crossing a nameplate or tag, and no label overlapping another label, in all six fights.
- A fighter jumping from mid-jog into the result window lands on its ring spot.
- Every card fits inside the view.

**Verdicts:** spec Pass, quality Pass, visual Pass, ready to merge. Only optional Minors remain, deferred as follows:

| # | Minor | Disposition |
| --- | --- | --- |
| 1 | On a fighter whose label rise is clamped, two labels less than 800 ms apart could stack. No fixture triggers it. | Deferred until real Task 16 logs exist: show only the newest label for a clamped target. |
| 2 | The partner's card assumes both entrants' timelines carry the same bout `endsAtMs`. | Task 16 integration check: take the smaller `endsAtMs` across a pair, or assert they match. |
| 3 | Item 6 tests only the message text; nothing fails if `page.tsx` is not flipped to the live reader. | Integration checklist: whoever flips `page.tsx` (Arena card and Standings) adds a test that the live panels get a reader. |

## Gates carried forward

- **Task 10:**
  - live `timeline`, `profile` and `standings` reads, with `cursor?` on `standings`;
  - confirm whether the projection carries `battleLog`;
  - flip `page.tsx` to the live reader for the Arena card and Standings, with a test.
- **Task 13:** "Your standing" refresh from shared owner state; selection from roster and profile cards.
- **Task 16:**
  - one shared log versus a copy per entrant;
  - matching `endsAtMs` across a pair;
  - `makeFallback` replaces the fixture approximation;
  - NPC id format.
- **Integration:** run the isolated production browser gate with the repo's `playwright.config.ts`.
