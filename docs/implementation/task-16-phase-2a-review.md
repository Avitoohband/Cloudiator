# Task 16 phase 2a independent specification and quality review

Date: 2026-10-14. Reviewer: a fresh Claude reviewer subagent, read-only on the worktree, using the local Supabase stack "Cloudiator" for a clean replay and the DB suites. Scope: phase 2a — Arena schema, season identity, league placement, rating rows with the visible combat strength, and pairing inside the boundary (`cd73b1e..430aec3`; source `6e8fd57` with migration M09 `20261014113448_arena.sql`, report `430aec3`).

## Verdict

**Specification Pass; code quality Pass; ready to merge.** There were no Critical or Important findings. The Minor findings were corrections to the documents and handoff notes, applied by the controller in the commit that adds this record. One code item (a fail-closed assertion on the history window) is carried into phase 2b.

## Reviewer evidence

- **Unit and type checks:** `npm test` 872 passed; `npm run typecheck` clean.
- **Clean replay:** `db reset --local --no-seed --yes` replayed M01–M09. A read-only inspection of the replayed database found:
  - 12/12 function bodies byte-identical to `07-arena.sql`;
  - security invoker, empty `search_path`, function ACLs `{postgres, service_role}`;
  - RLS and `backend_only` policies on the 4 new tables, with no client grants;
  - `jobs.gladiator_id` nullable;
  - no epoch row after the reset;
  - M09 re-emits no unchanged function.
- **Lint and advisors:** `db lint` clean; the advisors gave 22 INFO unused-index notices only.
- **DB suites:** `npm run test:db` gave 123/124 on the first run, because of the Edge recreation fault described below, and **124/124** on the serialized rerun with the Edge container stable.
- **Pairing at 50 entrants:** 50 sides and 25 battles, 76 ms from insert to adoption (the implementer measured 69 ms). Local only; hosted load is Task 23.
- **Build and browser:** build and static scan gave 5 routes and 91 assets; dev Playwright 258 passed, 8 skipped; `git diff --check` clean.
- **Malformed pairing results:** probed in a rolled-back transaction (scalar side, wrong side count, empty array, scalar assignment). All were rejected without an exception.

## Strengths named

- All five controller decisions are implemented:
  - SQL restates no domain formula;
  - placement is max(cached, frozen), with a `guard_league` trigger;
  - league-season rows start at 1000 and keep the old ones;
  - the cache is refreshed before phase 5 freezes `starting.rating`;
  - `combatStrength` is published additively.
- The pairing lifecycle follows Task 7's phase-4 pattern.
- Acceptance is strict: exact key whitelists, deep equality against frozen values, and nothing is written before every check passes.
- Battle seeds are deterministic and private.
- `guard_job` now uses `IS DISTINCT FROM` for the nullable `gladiator_id`.
- The lock order is documented and sound, including exception 3.
- The tests are real: real Auth, boundary RPCs, fenced claims and pg_net dispatch.

## Minor findings and resolutions

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | The deployment note's "worker before M09" half was wrong. | Corrected in the report (item 12): apply M09 and deploy the worker in one release step, then check for operator-state `prepare` jobs (Task 24). |
| 2 | The epoch launch guidance was too loose. | Corrected in the report and in `migrations.md`: the epoch must be no later than the first boundary with members the coordinator will process, with a verification query; the row is immutable. |
| 3 | The 2b list dropped plan item 12's gear-history and respec cases, the Task 19 tournament-history note, and the order of retention pruning. | Added to the report's 2b list (items 8, 10, 11). |
| 4 | The history window (18) and the season length (504) are restated in SQL. | Carried into 2b (item 9): a fail-closed executor assertion on the history lower bound, and a header note about 504. |
| 5 | The mutation table skipped M2, and the access-denial list omitted `pairing_input`. | The gap is noted in the table; `pairing_input` was added to the 2b test list (its ACL was verified as service_role only). |

## Rulings on the implementer's concerns

1. **Edge container recreation:** an infrastructure fault, not product evidence. The reviewer reproduced it.
   - The CLI killed and recreated the Edge container during a DB run, and also at other times, some coinciding with a build export or the dev server.
   - The cause is unconfirmed.
   - Run `test:db` only while no build, browser run or file edit happens in the serving worktree. Rerun when the container's `StartedAt` changes.
2. **Never rebuild fighters from stored snapshots:** binding for 2b. JSONB reorders equipment keys and so changes the order of `equipmentSilhouettes`. Simulate only from the assignment's frozen fighters and NPC template.
3. **Worker and M09 ordering:** real. Deploy them together (Minor 1).
4. **Season epoch:** accepted, with Minor 2's constraint.
5. **Bounded history:** accepted for 2a, with Minor 4's assertion in 2b.

## Declined to judge

- The pairing balance: Avi chose option A.
- The phase 1 domain internals.
- Hosted latency.
- The 2b design: not built yet.
- Several pre-existing Task 7–10 patterns: the mid-transaction revision update, catch-up locking, the exhausted-lease sweep, and re-applying old sources.
- `runWorker`'s lack of per-kind claim isolation.
- Retention mechanics (Task 22) and `combatStrength` rendering (Task 17).
- The root cause of the Edge recreation.
- Re-running the SQL mutations: that is outside read-only scope.
