# Task 13.1 report: visitor read access (M13)

- **Status:** DONE_WITH_CONCERNS (the concerns are scope notes, not failures).
- **Worktree and branch:** `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-13`.
- **Base:** `a8d59f9` (docs: record the second Docker Secrets Engine socket recovery).
- **Commit:** `43af136` feat: let visitors read the public projections.

## What was implemented

- **`supabase/sql/11-visitor-access.sql`**, a new reapplicable source. The `anon` role gets SELECT on:
  - the 8 base tables: `world_revision_state`, `world_actors`, `public_profiles`, `recent_results`, `activity_stages`, `arena_standings`, `tournament_bout_results` and `tournament_placements`;
  - the 5 invoker views: `visible_events`, `world_revision`, `world_actor_reads`, `public_profile_reads` and `arena_standing_reads`.

  The source revokes before it grants, and it was applied twice with identical results.
- **`tournament_views`** is now granted column by column to both `anon` and `authenticated`: `id`, `slot_index`, `league`, `starts_at_ms`, `ends_at_ms`, `status`, `entrants`, `bracket`, `bouts` and `reveal_at_ms`. The table-level SELECT from `authenticated` is revoked, so no client can read `pairing_job_id` or `published_at_ms`.
- **Policies:** the 9 existing select policies (`player_read` ×8, `due_read` on `activity_stages`) are changed to `to anon, authenticated` with `alter policy`. Their USING expressions are unchanged, and no second policy was added. Each change is guarded: the DO block raises an error unless the policy already exists as a permissive SELECT policy.
- **Header:** documents the column-grant exception (Task 19 M1), why the base tables under the `security_invoker` views must be opened, and the owner-view revoke described next.
- **Owner-view revoke (a scope addition, see Concerns):** `revoke all on public.owner_state from anon`. On the replayed database anon held TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on that view (relacl `anon=Dxtm`). The brief's own `anonWritable()` check (TRUNCATE via `has_table_privilege`) returned `['owner_state']` before this change. anon never had SELECT on it.
- **`tests/db/visitor-access.test.ts`** has the brief's four tests, plus:
  - Data API insert refusal on every opened object;
  - `published_at_ms` and `select('*')` refusal on `tournament_views`;
  - due-row positive controls in the guessed-id test (a grant without a policy would return no rows there too);
  - `activity_stages` checked by id as well as `visible_events`;
  - private-schema refusals and the `anon` USAGE check on `private`.
- **Flipped assertions:** the existing "anon denied" assertions on the opened objects now expect reads to succeed. Owner-only and write denials are unchanged.

## TDD evidence

**RED:** `npm run test:db -- tests/db/visitor-access.test.ts`, before the source was applied. The Edge start time was `2026-10-16T14:03:46.021829833Z` before and after the run.

```
❯ tests/db/visitor-access.test.ts (4 tests | 3 failed)
  × lets visitors select exactly the public projections, read-only
    AssertionError: expected [] to deeply equal [ 'activity_stages', …(13) ]   (+ [])
  × never exposes the tournament pairing job to any client
    { code: '42501', message: 'permission denied for table tournament_views' }  (public-column read)
  × hides future-dated rows from visitors even by guessed id
    Error: recent_results: permission denied for table recent_results
  ✓ keeps owner management and private schemas denied to visitors
Tests  3 failed | 1 passed (4)
```

Before the source, a catalog query also showed `anonWritable` = `[owner_state]` (TRUNCATE) and `anonExecutable` = `[]`.

**GREEN:**
- After applying the source: `npm run test:db -- tests/db/visitor-access.test.ts` passed 4/4, with the Edge start time unchanged.
- After the flips, the full `npm run test:db` on the source-applied database passed **176/176** in 9 files, with the Edge start time unchanged.
- The fingerprint was identical before and after that run.

## Migration evidence (M13)

- **Generated with:** `npx supabase db pull visitor_access --local --schema public,private --yes` (CLI 2.120.0, engine `migra`).
- **Path:** `supabase/migrations/20261016141628_visitor_access.sql`. The CLI recorded it as applied in the local history, and `migration list --local` showed M01–M13.
- **The draft contained:**
  - a drop and re-create of all 9 policies with `to anon, authenticated`;
  - `revoke select on tournament_views from authenticated`;
  - 8 table `grant select … to anon`.
- **Completions made** (the original draft is kept in my scratchpad):
  1. `revoke all … from anon` before the 8 generated table grants.
  2. The anon revoke/grant on the 5 invoker views. The draft had no view privileges.
  3. The `tournament_views` column grants to anon and authenticated, plus the matching revoke from both. The draft had only the authenticated table revoke.
  4. The anon revoke on `owner_state`.
  5. The draft's drop/create of the 9 policies replaced with in-place `alter policy … to anon, authenticated`, so the USING text is never re-created.
  6. A provenance header and `notify pgrst,'reload schema'`.

  No functions were emitted, so there was no unchanged-function check to do. No triggers, backfill or initialization are involved.
- **Clean replay:** label `com.supabase.cli.project=Cloudiator` checked, then `npx supabase db reset --local --no-seed --yes` replayed M01–M13 (exit 0). No source was applied afterwards.
- **Parity:** a 900-line fingerprint covering:
  - functions: md5 of the definition, security, volatility, search_path and ACL;
  - relations: ACL, RLS, options and view-definition md5;
  - columns, including column ACLs;
  - policies, triggers, constraints and indexes;
  - schema and default ACLs;
  - the cron job and the seed rows.

  The replay fingerprint was **identical** to the source-applied fingerprint, and identical again after the replay test run.
- **Tests on the replay:** `npm run test:db` passed **176/176** in 9 files, with the Edge start time unchanged.
- **Lint and advisors:**
  - `db lint --local --schema public,private --fail-on warning`: empty on both the source-applied database and the replay.
  - `db advisors --local --type all --level info --fail-on warn`: 4 INFO unused-index notices only, on both. The replay notices are on `operation_receipts_gladiator_idx`, `boundary_members_gladiator_idx`, `jobs_gladiator_idx` and `recent_results_gladiator_idx`. No WARN or ERROR, and no `multiple_permissive_policies`.

## Edge start times (`supabase_edge_runtime_Cloudiator`)

| Run | Before | After |
| --- | --- | --- |
| RED, `visitor-access` only | 2026-10-16T14:03:46.021829833Z | same |
| GREEN, `visitor-access` only (source) | 2026-10-16T14:03:46.021829833Z | same |
| Full `test:db` on the source, 176/176 (counted) | 2026-10-16T14:03:46.021829833Z | same |
| Full `test:db` on the M01–M13 replay, 176/176 (counted) | 2026-10-16T14:03:46.021829833Z | same |

It was also unchanged across `db pull`, `db reset` and the typecheck.

## Other gates

- `npm test`: 922/922 in 37 files.
- `npm run typecheck`: passed (tsc, deno check, and 2 deno tests).
- `git diff --check`: clean.

## Files changed

- Added: `supabase/sql/11-visitor-access.sql`, `supabase/migrations/20261016141628_visitor_access.sql`, `tests/db/visitor-access.test.ts`.
- Flipped:
  - `tests/db/expeditions.test.ts`: anon joins the due/hidden-stage loop.
  - `tests/db/projections.test.ts`: anon reads the 6 projections and passes `safe()`.
  - `tests/db/arena.test.ts`: catalog `anon: true`; anon added to the standings write-denial loop; the anon `arena_standing_reads` read succeeds; `readStandings(anonymous)` equals the spectator's for bronze, silver and champion.
  - `tests/db/tournaments.test.ts`:
    - `readTournament(anonymous)` equals the spectator's `done`;
    - anon joins the future-bout hidden loop and gets `not-found` from the log read;
    - the catalog check uses `has_any_column_privilege`, and the anon read is expected to succeed;
    - explicit `PUBLIC_TOURNAMENT_COLUMNS` replace `select('*')` on `tournament_views`.
- Docs:
  - `docs/operations/migrations.md`: a new M13 section at the top, and the line-476 statement replaced.
  - `docs/superpowers/specs/2026-10-11-gladiator-arena-design.md`: §10.5, §10.6 and §13 item 11.
  - `docs/superpowers/plans/2026-10-11-gladiator-arena-implementation.md`: line 23.

## Concerns

1. **The `owner_state` anon revoke is outside the brief's object list.** It was needed for the brief's `anonWritable()` (TRUNCATE) to be `[]`, and it only removes privileges. TRUNCATE on that view fails anyway ("is not a table"), so this was a latent catalog issue, not an exploit.
2. **Leftover privileges I saw but did not change.** None is reachable through the Data API, and none is a read or a row write. All are recorded in `migrations.md`.
   - anon keeps MAINTAIN on the 8 M01 owner tables.
   - `authenticated` and `service_role` keep TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on `owner_state`.
   - The replayed default privileges for new `public` tables still grant anon, authenticated and service_role TRUNCATE, REFERENCES, TRIGGER and MAINTAIN.
   - The existing identity test's mutation check covers only `relkind='r'`, which is why it missed the view.
   - A follow-up could revoke these in a later migration.
3. **The M13 draft's policy statements were replaced, not appended to.** The generated drop/create pairs became `alter policy` statements, to match the brief ("altered … USING unchanged"). The end state is identical (parity proves it).
4. **One spec edit goes beyond the approved wording.** In §10.5 I also changed the next sentence from "readable by signed-in players" to "readable by visitors and signed-in players", so it no longer contradicts the new sentence. This follows the full-screen spec's Decision 1. I also added a short "(Amended 2026-10-16 by …)" pointer in §10.5 and in the plan's line 23.
5. **Small strengthenings beyond pure flips:** anon was added to the arena standings write-denial loop, and the parity comparisons with the spectator's reads were added.
6. **Marketplace listings are not opened.** Task 18 has not built them (Task 13 plan, Decision 2).
7. **Skill-upkeep proposal for the controller to relay** (not made):
   > Avi, shall I update the Supabase project override in AGENTS.md, section "Generated migration completion", to record that with CLI 2.120.0 (Task 13.1) `migra` emitted no view or column-level grants, and dropped and re-created every policy whose role list alone changed, so drafts must add those grants and may use `alter policy` instead?
