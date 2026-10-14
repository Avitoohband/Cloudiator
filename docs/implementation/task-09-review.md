# Task 9 independent review

Date: 2026-10-13. Full reviewer: fresh GPT-6 Astra subagent, read-only.
Range: `05b1ea0f79a1d28d839727128b661ea374dfe6bb..5dbf34e0ce15f49f72710d7b062787723b5b4722`.

## Full review verdict

**Spec issues found; quality Needs fixes.** One Important planner defect blocks
approval. No Critical findings and no separate Minor findings.

Runtime results (103 DB/Auth/Edge tests, 297 units, compile/static checks and
258-entry replay parity) are documented implementation evidence, not independently
reproduced by this review. No suites were rerun.

## Strengths

- `supabase/sql/05-expeditions.sql:350`: Central settlement holds account, character, wallet, sorted-item, activity and job locks before current time/token/status/expiry checks. Completed-token replay adds no grant.
- `supabase/sql/05-expeditions.sql:82` and `:133`: Nested settlement/log fields are explicitly projected. Stage RLS at `:45` checks database time without owner bypass.
- `supabase/sql/05-expeditions.sql:51` and `:195`: Simulation/reveal/settlement dependencies gate claims and dispatch.
- `tests/db/expeditions.test.ts:212`: Confirmed blocked contenders test expiry after release, covering the original timing defect.
- `tests/db/expeditions.test.ts:118` and `:130`: Stale preparation, immutable rewards, overflow, fee holds and spectator privacy are exercised.
- `supabase/functions/_shared/domain/expedition.ts:20`: Separate loot randomness preserves canonical probabilities and stable catalog ordering.

## Important finding — canonical wins become defeats

`supabase/functions/_shared/domain/expedition.ts:58` adds a positive-final-HP
condition to the canonical winner check. A gladiator who wins the seeded
simultaneous-defeat tie-break is therefore labeled defeated, loses subsequent
encounters and receives no rewards. The log still declares that gladiator winner.

The binding combat rule resolves simultaneous defeat with a seeded winner;
expeditions heal after non-final wins and stop after defeat. The extra rule in
the report is not authorization to override that result. Use `winnerId` alone;
heal a non-final zero-HP winner by the existing floored20% formula, and grant
successful rewards after the third canonical win. Add deterministic regressions
for both positions and retain a true-loss case.

Controller disposition: accepted against the binding spec; fix round1 assigned
to the original continuation worker at FIX_BASE `5dbf34e`. Planner/tests/report
only; no SQL migration change or duplicate full database replay is required.
Task 9 remains unapproved/unpublished until scoped re-review.

## Focused checks and limits

- Read the complete supplied package in bounded passes and recovered truncated package output; no changed source was separately reread.
- Named risk: canonical winner semantics. Checked unchanged `combat.ts:46` and `:135`; Expedition context excludes Arena modifiers and zero-HP simultaneous defeat has an authoritative winner.
- Named risk: inventory locks after settlement's lease check. Checked unchanged `supabase/sql/04-inventory-shops.sql:54`; those locks are already held by the common settlement path.
- No Git commands, mutations, runtime changes, suite reruns or helper agents.

## Scoped fix review

Date: 2026-10-14. Fresh GPT-6 Sol reviewer, read-only scoped fix round1.
Range: `5dbf34e..545a82d`; no full-task review or suites repeated.

**Canonical wins become defeats — ADDRESSED.** `expedition.ts:58` now follows
`winnerId` alone. The new real-engine fixed-seed cases cover non-final zero-HP
healing and continuation, final zero-HP success rewards, and a true seeded loss
(`tests/domain/expedition.test.ts:28`). No new breakage or out-of-scope observations.

The correction report records two meaningful RED failures, then 75/75 focused
tests and passing TypeScript/Deno checks. The diff supports those cases; the
reviewer did not rerun tests.

**Final disposition: specification compliant; quality Approved after fix.**
All findings addressed, no new Critical or Important breakage. The full review's
original finding above remains recorded for provenance. SQL/M06 and stage wire
contracts were unchanged by the correction. Source `e96e0f1`, report `5dbf34e`,
fix and report correction `545a82d` form the completed Task 9 checkpoint.
