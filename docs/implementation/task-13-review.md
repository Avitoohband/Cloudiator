# Task 13 independent reviews: full-screen camp and visitor viewing

Plan: [Task 13 plan](../superpowers/plans/2026-10-16-task-13-full-screen-camp.md). Spec: [full-screen camp design](../superpowers/specs/2026-10-14-full-screen-camp-design.md). Each checkpoint has a fresh implementer and an independent reviewer, read-only on the worktree; the reviewers may run read-only catalog queries against the local stack "Cloudiator".

Controller rulings made before execution (plan pre-flight scan):
1. `tests/browser/live-routes.ts` (13.3) serves both a signed-out visitor and a seeded signed-in session.
2. The 13.5 Tab test also asserts the focus order: rail icons, then the corner chip.
3. The 13.8 leave-pose and encounter-count Minors are fixed wherever the logic actually lives.
4. Marketplace stays hidden until Task 18 builds it.

## 13.1: Visitor read access (M13)

Range `a8d59f9..43af136` on `claude/task-13`: `43af136` adds the source `supabase/sql/11-visitor-access.sql`, migration M13 `20261016141628_visitor_access.sql` and `tests/db/visitor-access.test.ts`. [Implementer report](task-13.1-report.md).

**Implementer evidence:**
- `test:db` 176/176 on the source and again on a clean M01–M13 replay, with the Edge start time unchanged.
- The 900-line parity fingerprint matched; `npm test` 922/922; typecheck and `git diff --check` clean.
- Lint empty; advisors INFO only.

**Reviewer evidence** (live catalog, label `com.supabase.cli.project=Cloudiator`):
- `anon` can SELECT exactly the 14 sanitized projections and has no write or execute privilege on any public or private object.
- `tournament_views.pairing_job_id` and `published_at_ms` are readable by no client (column SELECT for `service_role` only); its other 10 columns are granted to `anon` and `authenticated`.
- All 9 `player_read` and `due_read` policies are `{anon,authenticated}`, with their due-time predicates unchanged; no second policy exists; the 12 `owner_read` policies remain `{authenticated}`.
- JSON-path reads of `tournament_bout_results.result` keep working (table-level grant).

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings.

**Accepted beyond the brief:** `revoke all on public.owner_state from anon`. It only removes privileges; without it, `anon` kept TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on that view from M01.

**Deferred Minors:**
- **Denial assertions:** some check only `error !== null`. Assert `42501` on the column reads.
- **Column list:** the 10-column `tournament_views` list is repeated; export it from `reads.ts` for the tests.
- **`anonWritable`:** it omits REFERENCES, TRIGGER and MAINTAIN. `anon` still holds the pre-existing MAINTAIN on the 8 M01 owner tables, which is not reachable through the Data API; hardening for Task 23 or 24.
- **M13:** a redundant generated revoke precedes the completion's revoke (harmless).
- **Tournament catalog check:** `has_any_column_privilege` slightly weakens the table-level check there.

**Carried to 13.2:** the visitor timeline read (`readTimeline` still queries owner-only `activities`) and a visitor `readProfile` DB test.

## 13.2: Public reads without a session

Range `abb5376..6fed6b0`: `f8d6fc3` (feature) and `6fed6b0` (review fixes). [Implementer report](task-13.2-report.md).

**Implementer evidence:**
- Unit tests 933/933; typecheck clean.
- `test:db` 177/177 with the Edge start time unchanged in each counted run.
- Build and `verify:static` clean; the live-gateway browser specs passed 36/36 on port 3200.

**Round 1 (full review).** Verdicts: spec ❌ for two deviations, quality Approved, no Critical or Important findings.
- **What it confirmed:**
  - All eight public reads use `publicRead`, which retries once on an account change and throws `unavailable` on a second change.
  - `owner()` and commands still require a session.
  - A visitor timeline never queries `activities`.
  - The shared log cache is cleared on an account change.
  - The fixture results carry only the six public summary fields.
  - The DB test reads world, profile, standings, tournament and a timeline as `anon`, with spectator parity.
- **Deviation 1:** `readTimeline`'s owner-summary option had a default instead of being required.
- **Deviation 2:** the fixture `recent()` cursor diverged from `readRecent` (malformed and empty cursors).

**Round 2 (scoped re-review of `6fed6b0`):** both findings ADDRESSED, no new breakage.
- The option is required at all 20 call sites.
- A shared `parseResultsCursor` gives identical cursor semantics, and `readRecent`'s behaviour is unchanged.

**Deferred Minors:**
- **Fixture rows:** the synthesized Training and Rest fixture rows share slots with existing fixture bouts, so the preview feed can show overlapping results.
- **Untested paths:** a `getSession` error read as a visitor, and an epoch-only account change.
- **Wording and noise:** two stale test names, an inaccurate cursor-format comment, and LF line endings in `tests/fixtures/results.ts`.

**Ruling carried to 13.3:** a public read can fail `unauthenticated` when the server rejects a stale stored token. `useGameState` maps that, while signed in, to a local sign-out, after which reads run as a visitor.

## 13.3: One shared game state, sync clock and live camp

Range `22ad713..46fd8c3`: `5bb3452` (feature) and `46fd8c3`, a pre-review test fix. That fix routes the live expedition and replay reads, which 13.2's sign-in-free reads had left reaching the local stack in two specs. [Implementer report](task-13.3-report.md).

**Implementer evidence:**
- Unit tests 939/939; `test:db` 177/177 with the Edge start time unchanged.
- Typecheck, build and `verify:static` clean.
- Development browser suite green after `46fd8c3` (expedition 46 passed, replay 36 passed); production gate 14 passed.

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings.

**What the reviewer confirmed:**
- **Sync offset:** it comes only from a timed `revision()` round trip. The Task 10 bias test is RED at 1 950 ms off and GREEN under 50 ms.
- **`useGameState`:**
  - It owns the sync controller, the shared clock and account-scoped owner reads.
  - Live mode never uses fixture state.
  - While the session says signed in, a server-rejected stale token signs out locally (mutation-checked).
- **`GameViewport`:** it reports its scene status and no longer re-anchors a shared clock.
- **The page:** it mounts the camp live, keeping its layout.
- **`tests/browser/live-routes.ts`:** it serves visitors and seeded sessions, fails loudly on unknown traffic and refuses anon on private tables.

**Deferred Minors carried to later checkpoints:**
- **To 13.5:**
  - retry a failed local sign-out;
  - pin `scope=local` in its test;
  - make `activityStatus` robust to a slot index up to 30 s old (`max(slotIndex, slot of now)`);
  - surface sync, scene and owner-refresh failures in the shell.
- **To 13.8:** rename the expedition test that now reads, and decide what an unknown live expedition shows.
- **To 13.9:** cover the camp's live timeline and tournament reads for a visitor.

**Other deferred Minors:**
- **Sync and clock:**
  - the first timed sample is lost when the first world load fails;
  - timeline reads still nudge the shared clock forward;
  - the world memo relies on the revision embedding the slot.
- **Test transport and specs:** unexercised transport helpers; two specs still seed sessions by hand.
- **Owner reads (Task 23 measurement):**
  - the owner is re-read on every revision change (plan-mandated);
  - one extra owner read follows creation.
