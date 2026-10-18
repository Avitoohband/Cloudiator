# Task 21: Seasons, Season Rewards and Prestige — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each 28-day season closes once, after its final slot has settled. The close freezes every league's standings into a public archive and pays the top three eligible gladiators in each league once, in their highest qualifying league. Their titles and badges then show in public.

**Architecture:**
- **Close.** The empty phase-2 boundary hook `private.boundary_close_season(target)` becomes a synchronous close. It runs inside `advance_boundary`'s transaction, under the coordinator lock. Phase 1 has already proved every earlier slot settled, including tournament entrants settling at minute 80.
- **Storage.** A public season table, a frozen public standings archive, private award records, and prestige projected into `public_profiles`.
- **Reads and UI.** Public reads, then the season picker in Arena standings and badges on profile cards, from the mockup Avi reviews.

**Tech Stack:** Next.js 16.4 static export, React 19, Supabase Postgres 17 (CLI 2.120.0), Deno Edge functions, Vitest, Playwright (Chrome channel).

**Spec:** [game design §8.3 "Seasons"](../specs/2026-10-11-gladiator-arena-design.md) (with §8.1 rating and §11 retention), and Review Focus 5 of the [24-task plan](2026-10-11-gladiator-arena-implementation.md). This plan refines that plan's Task 21.

## Global Constraints

- "A season lasts exactly 28 real-world days, or 504 activity slots. Its epoch is the first slot boundary chosen when the public launch is activated, persisted once. Assign fights to the season containing their activity start; settle the final slot before closing the season."
- "At season close, freeze league standings, award eligible placements once, archive the summary, and start new ratings at 1,000. Preserve characters, XP, attributes, inventory, money, renown, titles, and cosmetics. Rank by rating, then human wins, then fewer human losses, then stable character identifier."
- "At least five human bouts in that league during the season. A character receives end-of-season progression rewards in their highest league with qualifying participation … Select the top three from that league's eligible-reward subset … Archive full standings in every league and identify promoted/inactive entries."
- Rewards, from `RULES_V1.seasons.placements`:
  - first: 500 money, 100 renown, the champion title and a gold badge;
  - second: 300 money, 60 renown and a silver badge;
  - third: 200 money, 40 renown and a bronze badge.
  - "In a league with fewer eligible players, award only existing eligible placements."
- "Preserve … season archives, prestige … indefinitely" (spec §11).
- Wallet values stay within 0..9,007,199,254,740,991.
- Public projections are readable by anyone, including visitors; all commands require Google sign-in.
- Local tests use launch epoch 0 (`resetIdentity`). Production sets it in Task 24.
- No package or tool downloads.
- Read `node_modules/next/dist/docs/` before changing Next code.
- Gate order and the database-test rule: `docs/operations/verification-gates.md` and AGENTS.md. Stand-in functions follow the stand-in restore rule.
- Generated-migration completion: AGENTS.md.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A season ending while its last activity settles and a character promotes.** The results belong to the starting season, the close waits, and rewards pay once in the highest qualifying league. Test: 21.2.
- **A close that fails part-way, or a boundary that is retried or replayed.** No partial and no second award. Test: 21.2.
- **No character due across the season end.** `coordinate_work` skips boundary 504, but the next boundary it runs still closes the season. Test: 21.2.
- **A promoted gladiator who qualifies in the higher league but places fourth there.** They get no reward in either league, and the lower league's medals go to its next eligible gladiators. Test: 21.1.
- **A visitor opening a finished season.** It is read-only, shows frozen ranks with medals, and has no "Your standing". The current season shows its end in local time with UTC. Test: 21.4.

---

## Decisions (controller, binding)

1. **Names.**
   - SQL source `supabase/sql/13-seasons.sql`; generated migration M15.
   - The old plan's `09-tournaments-seasons.sql`, `M09b` and `close_season(season_id uuid, coordinator_token uuid)` are obsolete.
   - Season identity is Task 16's `private.season_index(slot)` (bigint), and `seasonId` is its text. Players see "Season N", where N = index + 1.
2. **One authority.**
   - SQL selects the awards. There is no TypeScript `selectSeasonAwards`, so two implementations cannot drift.
   - `supabase/functions/_shared/domain/season.ts` holds only `seasonAt(slotIndex: number, epochSlot: number): SeasonWindow`:
     - `SeasonWindow = { index; firstSlot; endSlot /* exclusive */; startsAtMs; endsAtMs }`;
     - it throws `RangeError` when `slotIndex < epochSlot` or either value is not a safe non-negative integer;
     - fixtures use it, and a DB test checks the `public.seasons` rows against it.
3. **Storage** (all in `13-seasons.sql`):
   - **`public.seasons`**
     - Columns: `season_index bigint primary key check (>= 0)`, `starts_at_ms bigint not null`, `ends_at_ms bigint not null check (ends_at_ms = starts_at_ms + 2419200000)`, `closed_at_ms bigint null`.
     - Guard trigger: no delete; `starts_at_ms` and `ends_at_ms` immutable; `closed_at_ms` may change only from null to a value, once.
   - **`public.season_standings`** (the frozen archive)
     - Columns: `season_index`, `league`, `rank bigint`, `gladiator_id uuid`, `name`, `rating`, `human_wins`, `human_losses`, `promoted bool`, `inactive bool`, `reward_eligible bool`, `award_place smallint null check (1..3)`.
     - Primary key `(season_index, league, gladiator_id)`, unique `(season_index, league, rank)`.
     - No foreign key: archives outlive everything, as `private.settled_slots` does. `guard_frozen` refuses update and delete.
   - **`private.season_awards`**
     - Columns: `season_index`, `gladiator_id references public.gladiators(id)`, `league`, `place smallint check (1..3)`, `money bigint`, `renown bigint`, `title text null check (title = 'champion')`, `badge text check (badge in ('gold','silver','bronze'))`, `receipt_id uuid not null unique references public.operation_receipts(receipt_id)`, `awarded_at_ms`.
     - `money` and `renown` are the amounts actually credited.
     - Primary key `(season_index, gladiator_id)`, unique `(season_index, league, place)`. `guard_frozen`.
   - **Grants and RLS.** Revoke all from everyone first.
     - `seasons` and `season_standings`: SELECT to `anon` and `authenticated` with policy `player_read … using (true)`; DML to `service_role` only.
     - `season_awards`: `backend_only`, service_role SELECT only, like `arena_ratings`.
   - **Prestige.**
     - `private.project_character` sets `public_profiles.prestige` from `private.season_awards`: `jsonb_agg(jsonb_build_object('seasonIndex',…,'league',…,'place',…,'badge',…,'title',…) order by season_index)`, default `'[]'`.
     - A deferred `project_changed_character` trigger on `season_awards` republishes the character.
   - **View.** `public.arena_standing_reads` gains a last column, `reward_eligible`. It is true when the row has at least 5 human bouts and no higher league row of the same character and season also has at least 5.
     - Keep `security_invoker`.
     - Re-grant SELECT to `anon`, `authenticated` and `service_role` after the replace. Migra omits view grants.
   - **Frozen ratings.** `guard_arena_rating` also refuses any UPDATE of a row whose season has `closed_at_ms` set.
4. **Rule literals.** `private.season_rules() returns jsonb` (immutable) returns `{minimumHumanBouts: 5, placements: [...]}`, exactly `RULES_V1.seasons`' values. A DB test compares the two.
5. **Close algorithm.** `private.close_season(season bigint, now_ms bigint) returns integer` returns the number of awards. Granted to nobody.
   - Lock the `public.seasons` row `FOR UPDATE`. If it is closed, return 0.
   - **Rank.** Rank the season's `private.arena_ratings` per league by rating desc, human wins desc, human losses asc, gladiator_id asc. This is exactly the view's order.
   - **Qualify.** A row qualifies with at least `minimumHumanBouts` human bouts (`human_wins + human_losses`; NPC bouts are never counted).
   - **Eligible.** A row is `reward_eligible` when it qualifies and its league is the character's highest qualifying league (`private.league_rank`).
   - **Places.** `award_place` is the row number among the eligible rows of the league, in the same order, kept only for 1–3.
   - **Flags.** `promoted` is true when a higher league row of the character exists in that season; `inactive` is true when it has 0 human bouts.
   - **Archive.** Insert every row into `season_standings`, with the name from `public.gladiators` at close.
   - **Pay.** For each award, in `gladiator_id` order:
     - take the account advisory lock as the boundary phases do;
     - credit the wallet with `least(rule amount, 9007199254740991 − balance)`, for money and renown separately;
     - insert an `operation_receipts` row: the owner's `owner_id`, `operation_id = gen_random_uuid()`, `request {kind: 'season-award', seasonIndex, league, place}`, `request_digest = digest('season:'||season||':'||gladiator_id, 'sha256')`, and result `{seasonIndex, league, place, money, renown, title, badge}`;
     - insert a `wallet_ledger` row with reason `'season'` and the credited deltas;
     - insert the `season_awards` row.
   - Set `closed_at_ms = now_ms`.
6. **Phase 2.** `private.boundary_close_season(target bigint) returns text` becomes `plpgsql volatile`.
   - Return null when `private.season_index(target)` is null. Phase 4 already waits with `'epoch'`.
   - Otherwise, close every `public.seasons` row with `closed_at_ms is null and season_index < season_index(target)`, in ascending order. The `now_ms` is `private.planning_now_ms()`, sampled after the coordinator lock.
   - Then insert the `public.seasons` row for `season_index(target)`. Its bounds are `epoch + 504 × index` slots, times 4,800,000 ms. Use `on conflict do nothing`.
   - It always returns null and never holds the phase.
   - **Invariant.** Phase 2 of a boundary creates its season row before phase 4 creates that season's rating rows. So every season with ratings has a row.
   - **Backfill.** M15 backfills rows for the distinct seasons already in `private.arena_ratings`, computing their bounds from the epoch.
   - **Errors.** Any error rolls back the boundary subtransaction. `coordinate_work` records only the SQLSTATE, and the next coordination retries.
7. **Reads.**
   - Contract types:
     - `SeasonView = { seasonId: string; startsAtMs: number; endsAtMs: number; closedAtMs: number | null }`
     - `PrestigeAward = { seasonId: string; league: LeagueId; place: 1 | 2 | 3; badge: 'gold' | 'silver' | 'bronze'; title: 'champion' | null }`
   - `PublicProfile.prestige` becomes `PrestigeAward[]`.
   - `StandingRow` gains `awardPlace: 1 | 2 | 3 | null`. It is always null for an open season.
   - `GameGateway.seasons(): Promise<SeasonView[]>` is a public read: newest first, at most 50.
   - `GameGateway.standings(league, cursor?, seasonId?)` picks the season in this order:
     - the cursor;
     - then `seasonId`;
     - then the latest `public.seasons` row;
     - then today's `arena_standings` maximum when `public.seasons` is empty.
   - A closed season reads `season_standings` with `archived: true`. Otherwise it reads `arena_standing_reads`, using its `reward_eligible`.
   - A malformed or unknown `seasonId` gives `unavailable`.
8. **UI** (21.4). Build only after Avi approves the mockup, `scratchpad/mock21/seasons-mockup.html`, sent on 2026-10-18.
   - **No new menu.** Arena standings gain:
     - a Season picker ("Season 2 · current", "Season 1 · ended Sat 18 Oct");
     - for the current season, a card showing the countdown, the end in local time with the UTC time, the three prizes and the rule;
     - "Your standing", which adds Season rank and "Human bouts 3 of 5" with a progress bar and "N more human bouts to qualify…";
     - Notes pills: You, Promoted, Inactive, ✓ Eligible (current season only), and 🥇 1st · Champion / 🥈 2nd / 🥉 3rd (archived seasons);
     - an archived season shows "Season N final standings", hides "Your standing", and explains the promotion rule in its footnote.
   - **Profile card.** The champion title line ("Champion · Season 1 Silver") and badge chips ("🥇 Season 1 · Silver"), or nothing when there is no prestige.

## Execution

- Branch `claude/task-21` in `C:\Avi\Studies\Projects\Cloudiator-claude`, from `69ed674`.
- One reviewed checkpoint per task: a fresh implementer, an independent spec and quality reviewer (plus visual review for 21.4), a review record, then a push. 21.4 waits for Avi's approval of the mockup.

---

### Task 21.1: Close a season in the database

**Files:**
- Create: `supabase/sql/13-seasons.sql`, `tests/db/seasons.test.ts`
- Modify:
  - `tests/db/visitor-access.test.ts` (`OPEN` gains `seasons`, `season_standings`)
  - `tests/fixtures/db.ts` (`resetIdentity` also truncates the three season tables)
  - `tests/db/arena.test.ts:1282-1284` (the view's column list gains `reward_eligible`)

**Interfaces:**
- Produces:
  - the three tables, `private.season_rules()`, and `private.close_season(season bigint, now_ms bigint) returns integer`, per Decisions 3–5;
  - the view column and the prestige projection.
- No migration yet: 21.2 generates M15 for 21.1 and 21.2 together.

- [ ] **Step 1: Write the failing tests** in `tests/db/seasons.test.ts`.
  - Seed with direct SQL: `private.arena_ratings` rows for season 0 with chosen counters, a `public.seasons` row, and real characters from a `fighter()`-style helper. Call `private.close_season(0, now)` as the owner.

```ts
test('season_rules matches RULES_V1.seasons', ...)
test('archives every league ranked by rating, human wins, fewer losses, then gladiator id', ...)   // ties on rating and on wins
test('pays 500/100 + champion + gold, 300/60 + silver, 200/40 + bronze once, with receipts and season ledger rows', ...)
test('needs five human bouts: four never qualify, five do', ...)
test('rewards a promoted gladiator only in the highest qualifying league and moves the lower league medals down', ...)
test('gives nothing to a promoted gladiator placing fourth in the higher league', ...)          // Review Focus 4
test('awards only the existing places when fewer than three qualify', ...)
test('marks promoted and inactive rows in the archive', ...)
test('returns 0 on a second close with no new rows, receipts or credits', ...)
test('credits only up to the wallet cap and records the credited amount', ...)
test('keeps XP, items, money and renown other than the award unchanged', ...)
test('projects prestige into public_profiles and keeps earlier seasons when a later one adds a badge', ...)
test('refuses updates of a closed season rating row and of the archive and awards', ...)
test('marks reward_eligible in the live view with the highest-league rule', ...)
test('serves seasons and season_standings to visitors read-only and hides season_awards and close_season', ...)
```

- [ ] **Step 2: Run** `npm run test:db -- tests/db/seasons.test.ts`, under the Edge start-time rule. Expected: FAIL; `close_season` does not exist.
- [ ] **Step 3: Implement `supabase/sql/13-seasons.sql`.**
  - It must be reapplicable.
  - Its header documents:
    - the ranking and eligibility rules;
    - the lock order: the coordinator (held by the caller), then the season row, then account locks in gladiator order, then wallets;
    - why there is no foreign key on the archive.
  - Iterate with the tested local `psql` fallback.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run test:db` (all suites). Expected: PASS, with the Edge start time unchanged.
- [ ] **Step 5: Commit** `feat: close seasons into a frozen archive with one-time rewards`.

### Task 21.2: Close at the season boundary (M15)

**Files:**
- Modify:
  - `supabase/sql/13-seasons.sql` (phase 2, the backfill)
  - `tests/db/seasons.test.ts`
  - `docs/operations/migrations.md` (M15 section)
- Create: `supabase/functions/_shared/domain/season.ts`, `tests/domain/season.test.ts`
- Generate: `supabase/migrations/<timestamp>_seasons.sql` (M15)

**Interfaces:**
- Consumes: 21.1's `close_season`.
- Produces:
  - `private.boundary_close_season(target)` per Decision 6;
  - `seasonAt` per Decision 2;
  - M15.

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/domain/season.test.ts
expect(seasonAt(503, 0)).toMatchObject({ index: 0, firstSlot: 0, endSlot: 504 });
expect(seasonAt(504, 0)).toMatchObject({ index: 1, firstSlot: 504, endSlot: 1008, startsAtMs: 504 * 4_800_000 });
expect(seasonAt(700, 10).endsAtMs - seasonAt(700, 10).startsAtMs).toBe(RULES_V1.seasons.durationMs);
expect(() => seasonAt(5, 10)).toThrow(RangeError);
// tests/db/seasons.test.ts, with real boundaries (helpers in the style of arena.test.ts: resetWorld, fighter, advance, settleAll)
test('creates each season row at its first boundary with seasonAt bounds', ...)
test('counts a human bout started in slot 503 in season 0 and waits to close until it settles at 504', ...)  // wait 'settlement', no archive
test('closes season 0 at boundary 504 before phase 4 starts season 1 ratings at 1000', ...)
test('places a gladiator promoted at boundary 504 in the new league only in season 1', ...)
test('closes a season whose final slot held a tournament only after every entrant settled', ...)  // season_index stand-in ending season 0 at slot 301
test('closes the season at the next boundary run when coordinate_work skips boundary 504', ...)    // Review Focus 3
test('rolls back a failed close entirely and pays once on the retry', ...)                       // injected failing trigger, always dropped in finally
test('replays a completed boundary with no new awards', ...)
```

- [ ] **Step 2: Run** the two files. Expected: FAIL; phase 2 is still the stub.
- [ ] **Step 3: Implement** phase 2, the backfill and `seasonAt`.
  - The tournament test's `private.season_index` stand-in follows the stand-in restore rule.
- [ ] **Step 4: Run** `npm run test:db` (all suites). Expected: PASS.
- [ ] **Step 5: Generate and complete M15.** Run `db pull seasons`, then complete the draft per AGENTS.md, including:
  - revokes before grants;
  - function ACLs;
  - the view grants;
  - the backfill;
  - the `project_character`, `guard_arena_rating` and `boundary_close_season` replacements.

  Then:
  - clean replay with `db reset --local --no-seed --yes`;
  - parity fingerprint;
  - `npm run test:db`;
  - lint empty, and advisors INFO only.
- [ ] **Step 6: Commit** `feat: close each season at its boundary`. Include the source, M15, the tests, `season.ts` and `migrations.md`.

### Task 21.3: Season reads

**Files:**
- Modify:
  - `supabase/functions/_shared/contracts/reads.ts:44,57-61` (`PrestigeAward`, `SeasonView`, `awardPlace`)
  - `src/lib/api/reads.ts:45-47,132-166` (`readProfile` prestige, `readStandings` season choice and archive, `readSeasons`)
  - `src/lib/api/gateway.ts:22-30,128-130` (`seasons`, `standings(league, cursor?, seasonId?)`)
  - `src/lib/api/fixture-gateway.ts:44`
  - `tests/fixtures/arena-build.ts:144,188-203`
- Create: `tests/fixtures/seasons.ts`
- Test: `tests/reads.test.ts`, `tests/api/live-gateway.test.ts`, `tests/api/fixture-gateway.test.ts`, `tests/db/seasons.test.ts` (one live read through the anon client)

**Interfaces:**
- Consumes: 21.1–21.2's tables and view column.
- Produces:
  - `readSeasons(client): Promise<SeasonView[]>`;
  - `readStandings(client, league, cursor?, seasonId?)`;
  - `GameGateway.seasons()` and the extended `standings`, both public reads.
  - **`FIXTURE_SEASONS`**, built with `seasonAt`: the current season `'1'` and a closed season `'0'`.
    - The archived pages of `'0'` have medals and a promoted gladiator whose reward is in a higher league.
    - Aster holds a bronze badge from season `'0'`.
    - The existing fixture season id `'fixture-season-1'` becomes `'1'`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('reads seasons newest first, without a session', ...)
test('reads the latest season when no season is named, and the archive with awardPlace for a closed one', ...)
test('keeps a cursor inside its season and rejects an unknown or malformed season id', ...)
test('maps prestige into PrestigeAward with a string seasonId', ...)
test('serves the fixture seasons, archive and Aster prestige', ...)
```

- [ ] **Step 2: Run** the named files. Expected: FAIL.
- [ ] **Step 3: Implement** the reads, gateway and fixtures.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run test:db`, `npm run build`, `npm run verify:static`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: serve seasons, archived standings and prestige`.

### Task 21.4: Seasons in Arena standings and on profile cards

Starts only after Avi approves the mockup (Decision 8).

**Files:**
- Create: `src/features/seasons/season-text.ts`, `tests/domain/season-text.test.ts`, `tests/browser/seasons.spec.ts`
- Modify:
  - `src/features/arena/StandingsPanel.tsx` and `.module.css` (picker, season card, own progress, pills, archived view)
  - `src/features/arena/ArenaMenu.tsx` (pass `seasons` reads)
  - `src/features/character/ProfileCard.tsx` (title and badges)
  - `tests/browser/live-routes.ts` (`seasons`, `season_standings`)

**Interfaces:**
- Consumes: `gateway.seasons`, `gateway.standings(league, cursor?, seasonId?)`, `PublicProfile.prestige`.
- Produces:
  - `seasonName(seasonId: string): string` → "Season N";
  - `seasonEnds(endsAtMs: number, nowMs: number, timeZone?: string): { countdown: string; local: string; utc: string }`;
  - `badgeText(award: PrestigeAward): string` → "🥇 Season 1 · Silver";
  - `titleText(award: PrestigeAward): string | null` → "Champion · Season 1 Silver".

- [ ] **Step 1: Write the failing tests:**

```ts
// tests/domain/season-text.test.ts
expect(seasonName('0')).toBe('Season 1');
expect(seasonEnds(Date.UTC(2026, 10, 15, 17), Date.UTC(2026, 9, 18, 19), 'Asia/Jerusalem')).toEqual({ countdown: '27 days 22 h', local: 'Sat 15 Nov, 19:00', utc: '17:00 UTC' });
expect(badgeText({ seasonId: '0', league: 'silver', place: 1, badge: 'gold', title: 'champion' })).toBe('🥇 Season 1 · Silver');
// tests/browser/seasons.spec.ts
test('shows the current season countdown, prizes and own qualification progress', ...)
test('switches to a finished season with medals, no Your standing and the promotion footnote', ...)   // Review Focus 5, also as a visitor
test('shows the champion title and badges on a profile card, and nothing for a gladiator without prestige', ...)
test('fits the standings sheet at 360 px with no horizontal scroll', ...)
```

- [ ] **Step 2: Run** the named files. Expected: FAIL.
- [ ] **Step 3: Implement** per Decision 8 and the approved mockup.
- [ ] **Step 4: Run** the full gate in the order of `verification-gates.md`: the development browser suite, then the isolated production gate with the repo's `playwright.config.ts`. Save screenshots (`seasons-` prefix) for the visual review. Expected: PASS.
- [ ] **Step 5: Commit** `feat: show seasons, archives and prestige`. Then commit `docs: report Task 21` separately, with `docs/implementation/task-21-report.md`.
