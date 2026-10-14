# Task 19 dispatch, phase 1: pure tournament domain (controller: Claude)

The binding plan and spec text, plus Codex's reviewed producer notes, are in `docs/implementation/task-19-brief-base.md`. Read it fully first.

Avi moved Task 19 to Claude on 2026-10-14 (board entry 05:55 IDT). This dispatch covers **phase 1 only: the pure TypeScript tournament domain and its unit tests, with no database.** Phase 2 (SQL source, generated migration, eligibility at the boundary, the per-bout job graph, settlement, `set_tournament_opt_in`, projections, DB tests) follows Task 16's phase 2.

## Where and with whom

- **Work only in** `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-19`. Base: `61b3e7b`, the head of `claude/task-16` (Task 16 phase 1: the pure Arena domain in `supabase/functions/_shared/domain/arena.ts`, currently under independent review; reviewed base below it `62f24cc`). If the Task 16 review changes `arena.ts`, the controller will tell you how to rebase.
- Other lanes run in parallel. Never write to, run commands in, reset or commit in `C:\Avi\Studies\Projects\Cloudiator` (Codex), `C:\Avi\Studies\Projects\Cloudiator-replay` (Task 17) or `C:\Avi\Studies\Projects\Cloudiator-arena` (Task 16).
- **No Supabase or Docker commands**, no `npm run test:db`, no browser tests or dev servers.
- Do not push, merge, edit `HANDOFF.md`, or dispatch subagents. Never print secrets.

## Read first

- `AGENTS.md`; `docs/implementation/HANDOFF.md`; `task-02-report.md` (rules, clock), `task-03-report.md` (combat), `task-07-report.md` (boundaries, cutoff, job hooks; note them for phase 2), `task-09-report.md` and `task-09-review.md` (the job dependency graph and the 0-HP winner rule), and `docs/implementation/task-16-phase-1-report.md` plus `arena.ts` (the regular matcher, `ArenaEntrant`, Elo).
- Code: `supabase/functions/_shared/domain/{types,rules-v1,clock,combat,arena,random}.ts`, `contracts/reads.ts` (`TournamentView`, `TournamentBout`, `TournamentEntrant`).

## Scope of phase 1

Create `supabase/functions/_shared/domain/tournament.ts` and `tests/domain/tournament.test.ts`, with additive rule constants in `rules-v1.ts` only where spec values belong in the versioned rules (tournament days and time, placement bonuses, reveal formula). Reuse `arena.ts` (`ArenaEntrant`, `ratingDelta`, `applyRatingDelta`), `clock.ts` and `random.ts`; never a second rating or clock implementation.

Exports, as the plan names them:
- `isTournamentSlot(slot: SlotWindow): boolean`: Wednesday and Saturday at 17:20 UTC, one 80-minute afternoon slot, from UTC slot math only (no local time or daylight saving).
- An eligibility helper: opted in, Arena scheduled for that phase, sufficient stamina at the slot cutoff (cutoff inclusive/exclusive as the Task 7 report defines it), partitioned per league; a league with at least two eligible entrants gets a bracket, otherwise those entrants go to regular Arena exactly once.
- `buildBracket(entries: ArenaEntrant[], seed: Seed): TournamentGraph`: seeded single elimination at the next power of two with byes, only when there are at least two entrants; stable bout ids and parent ids; frozen entry snapshots; full health at every bout; no fabricated NPC entrants. Reveal round `r` of `R` at `80 × r / (R + 1)` minutes after start; settle at minute 80.
- `readyBouts(graph: TournamentGraph): BoutJob[]`: only bouts whose parents are resolved (byes resolve at once), so phase 2 can run one bounded job per bout.
- `placementGrants(graph: TournamentGraph): RewardGrant[]`: winner 100 money and 50 renown, runner-up 60 and 30, semifinal losers 30 and 15, other entrants 5 renown, additional to fight renown; a two-player bracket awards only winner and runner-up; byes give no win renown or rating change; each grant has one stable identity.
- A pure helper that applies bout rating changes in round order using the ratings updated by earlier rounds (same-round bouts involve distinct players).
- The winner of a bout is its log's `winnerId`, even at 0 HP.

Define `SlotWindow`, `TournamentGraph`, `BoutJob` and `RewardGrant` beside the functions. Keep the private graph (results, snapshots, seeds) separate from what a public `TournamentView` may show; note in the report how phase 2 projects it without leaking future opponents or results.

## Tests (TDD: write each first, watch it fail for the right reason)

- The plan's Step 1 table for 0, 1, 2, 3, 5 and 50 entrants: charges per participant, bracket winners, rated bouts `n − 1` when `n ≥ 2`, bye renown 0.
- Step 4 cases that need no database: eligibility at the cutoff ±1 ms, opt-out, insufficient stamina, per-league partitions, bye paths, full health per bout, placement counts and amounts, a two-person bracket, frozen builds, stable ids across rebuilds with the same seed, reveal times for R = 1..6, Wednesday and Saturday 17:20 UTC detection across a daylight-saving date, round-ordered rating updates, and the 0-HP winner rule.
- Before committing: `npm test`, `npm run typecheck`, `git diff --check`.

## Commit and report

- Commit `feat: add pure tournament bracket and reward rules` with a detailed body; exact paths only.
- Write `docs/implementation/task-19-phase-1-report.md` (interfaces, decisions, RED/GREEN, commands and results, and the complete phase 2 list) in a separate commit.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Return

Status (DONE / DONE_WITH_CONCERNS / BLOCKED), commit SHAs, a one-line test summary, concerns.
