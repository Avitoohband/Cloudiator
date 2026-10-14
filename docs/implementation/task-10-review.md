# Task 10 independent review

Date: 2026-10-14. Full reviewer: fresh GPT-6 Astra subagent, read-only.
Range: `62f24ccfc62ce73615819dfad341be20d948ed82..7f413e50e1f121db99fbdcbb97e71d7f8040fc74`.

## Full review verdict

**Spec issues found; quality Needs fixes.** One Important delayed-boundary
transition blocks approval; no Critical findings. One Minor is deferred.
Runtime counts and 302-entry schema parity are reported implementer evidence;
the reviewer did not repeat those checks.

## Strengths

- Explicit projection fields and separate owner-summary reads preserve privacy
  (`supabase/sql/06-projections.sql:60`, `src/lib/api/reads.ts:53`).
- Database-clock reveal filtering, invoker views and explicit ACLs protect
  guessed IDs (`supabase/sql/06-projections.sql:110`).
- Revision checks bracket paginated world assembly; sync guards stale generations
  and preserves synchronized data during outages (`reads.ts:26`, `sync.ts:29`).
- Real authenticated/spectator reads cover safe completion and equal-time paging
  (`tests/db/projections.test.ts:25`, `:73`).

## Important — delayed next-slot preparation appears complete

After the previous slot settles, a coordinator can pause waiting for next-slot
preparation. The projector excludes preparing activities and selects the prior
completed activity; the view only marks overdue active activities as processing.
The actor therefore stays completed and `SyncState.processing` becomes false
throughout the delay (`06-projections.sql:47`, `:62`, `:122`, `sync.ts:36`).

The unchanged producer can pause at `03-activities-jobs.sql:462` and only advances
the character checkpoint at publication (`:414`). Derive a safe waiting state
from authoritative publication/checkpoint state and database time, withholding
the unpublished choice/snapshot. Keep the previous completed result available
separately. Add settled previous slot → delayed preparation → published next
activity coverage; the existing test at `projections.test.ts:105` only covers
overdue active → completed.

Controller disposition: accepted. Fix round1 assigned to the same implementer,
FIX_BASE `7f413e5`. M07 is committed and immutable; use a new corrective migration
and migration-only replay. No unrelated UI/scene or offset fix enters this round.

## Minor — initial world-load duration biases clock offset

`reads.ts:35` returns server time from the final revision request, while
`sync.ts:35` compares it with the midpoint of the entire multi-request world
load. Pagination/retries bias the displayed offset forward until another poll.
Anchor estimation to the request that sampled time; test delayed pagination.

Deferred to Task13/UI integration and final triage. It does not enter the
Important fix loop and is not silently discarded.

## Checks and limits

The reviewer read the complete brief/report/package in bounded passes, checked
unchanged boundary/publication/orientation producers for the named temporal
risk, and job/reveal lock context for projection concurrency. No mutations,
Git commands, test suites or helper agents. Deferred UI integration, combat
strength, hosted operation and measured release performance remain later gates.

## Scoped fix review

Date: 2026-10-14. Fresh GPT-6 Sol reviewer, read-only.
Range: `7f413e5..8b4464e` (source fix `a699384`, report correction `8b4464e`).

**Important finding — ADDRESSED.** The published checkpoint and database time
produce a generic camp/processing actor during the wait, with no unpublished
activity ID, choice, times or stage (`06-projections.sql:125`). The regression
covers settlement, preparation pause, publication and previous-result retention
(`tests/db/projections.test.ts:30`). New M08 includes existing-actor backfill and
invoker/ACL restoration (`20261014100253_projection_preparation_status.sql:69`).

No new breakage found. The original clock-offset Minor remains deferred.
The reviewer inspected fix coverage and reported RED → 6/6 owning tests,
109/109 replay DB tests, 303/303 parity and compile/lint/advisor evidence; no
suites were repeated by the reviewer.

**Final disposition: specification compliant; quality Approved after fix.**
All findings addressed; no new Critical or Important breakage. Original full
review and the Minor remain above for provenance. M01–M08 are immutable.
Task15 integration follows this reviewed checkpoint; broader release/UI gates
remain explicit in the report and handoff.
