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
