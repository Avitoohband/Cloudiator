# Patch 1.7.1, Hand-Given Titles: Implementation Plan

> **For agentic workers:** subagent-driven (superpowers:subagent-driven-development); TDD; each production write needs Avi's go in chat.

**Goal:** Two titles nobody can earn by playing — **Game Master** (for Avi's gladiator "Indigo") and **High Ground** (for
the gladiator "Tommy") — given by an owner-only database step, shown only to whoever holds them, released quietly as 1.7.1.

**Decisions (Avi, 2026-11-06, question forms after 1.7 went live):** Tommy's title reads "High Ground" (two words); Indigo's
reads "Game Master"; hand-given titles appear in the title picker only for their holders (everyone else still sees
"All · 31"); built as described in chat: the grant gives the usual "New title" notice with Wear and puts the title on (the
player can switch back any time); no patch note. High Ground's play rule, so others can earn it, is decided later (idea 57).

**Architecture:** the frozen catalog TITLES_V1 gains two rows in the Special family with a new measure `award` that no
counter, trigger or back-fill ever produces (private.award_titles compares a missing measure as null, so it never awards
them). A new SQL source `supabase/sql/23-awards.sql` (migration M29) restates `private.title_rules()` with the two rows,
widens `public.gladiator_titles.source` to allow `'award'`, and adds the owner-only `private.give_title(gladiator_id uuid,
title_id text)`. The client hides `award` titles from the picker unless held and words their notices.

**Spec of record:** this plan plus the 1.7 spec `docs/superpowers/specs/2026-10-30-titles-1-7-design.md` for everything not
named here. Branch `claude/p171-awards` in `C:\Avi\Studies\Projects\Cloudiator\design`, from the released 1.7 line `634e8de`.

## Global constraints

- Copy, word for word: names `Game Master`, `High Ground`; ids `game-master`, `high-ground`; family Special, after
  Bannerman; rule lines — Game Master: `The game's Game Master`; High Ground: `Given by the Game Master`. A notice for a
  given title: the usual own-title notice ("New title: {name}", then its rule line), with Wear.
- `private.give_title(gladiator_id uuid, title_id text)`: owner only (revoked from public, anon, authenticated and
  service_role; SECURITY INVOKER; `search_path = ''`); accepts only a catalog id whose measure is `award`; takes the
  gladiator's account lock, then the gladiator (the existing account → gladiator order); inserts `gladiator_titles`
  (source `'award'`, `earned_at_ms` = database time, `detail` null) once — a second call for the same pair changes nothing
  and says so; sets `worn_title` to that title; refreshes the projection so the camp and profile show it and
  `titles_earned` stays equal to the held count; returns a small JSON result (`{ok, given, worn}`).
- `award` titles: never counted, never auto-awarded, never back-filled (the back-fill's singleton record already ran; a
  replay changes nothing), never wearable unless held (wear_title already checks holding).
- Picker: an `award` title shows only when held; "All · N" counts the titles shown (31 for most players). Earned tab
  unchanged. Unknown ids still show nothing (1.7 Review Focus 1).
- M29 follows AGENTS.md and docs/operations/migrations.md exactly (pg-delta generation, completion from the source, clean
  replay of migrations alone, fingerprint byte-equal to the source applied on M01–M28, access audit, never edit a committed
  migration) — the M28 record is the precedent.
- CHANGELOG.md opens `## 1.7.1 — Hand-given titles (in progress, not yet released)` with the bullet
  `The Game Master can now give special titles; a given title arrives in Notifications with Wear.`; `src/lib/patch.ts`
  PATCH = `'1.7.1'`. FEATURES.md gains a row for hand-given titles ("In 1.7.1").
- Gate of record: `node scripts/verify.mjs --config node_modules/.cache/pw-design-tcp.config.mjs --browser-shards 32
  --results <fresh dir> --json <file>` (Avi's native32 choice).

## Task 1: catalog, SQL source and M29

Catalog rows and the measure type (shared domain titles.ts, its test pinned to the table above); `23-awards.sql` (title
rules restated with the two rows and pinned by the existing catalog test, the source CHECK widened, `give_title`, ACLs);
DB tests: give once, give twice (no change), worn and projection updated, an unknown or non-award id refused, `award`
titles never auto-awarded by a real settlement or by the back-fill function, ACL/access-matrix updated; then M29 generated,
completed and replayed with its ship test, fingerprint and access audit.

## Task 2: client

Picker hides unheld `award` titles and counts what it shows; title-text rule lines for the two titles; notices for source
`award` use the own-title notice; fixture data gives the fixture owner one award title so the browser tests cover it;
browser tests for a holder (All · 32, the title listed, Wear) and a non-holder (All · 31, not listed), desktop and 360 px.

## Task 3: gate, review and release (Avi's go for each production write)

Final review of the branch, the gate of record, then: M29 (`db push --skip-vault`, 20–60 min after a slot cutoff,
pg_stat_activity first, one retry if a deadlock victim), the client release (`release` fast-forward; no Edge change unless
a task changed `supabase/functions`), the 1.7.1 record without a note (`node scripts/patch-statement.mjs 1.7.1`), then the
two grants (`select private.give_title(<Indigo's id>,'game-master')`, `select private.give_title(<Tommy's id>,
'high-ground')` — ids read by exact gladiator name, which Avi approved for these two rows), each read back. Record the
evidence and update HANDOFF.md.

## Status

**2026-11-06: released.** M29 live 21:59 UTC, game-command, client 8828d0a, record 1.7.1 (no note), Game Master → Indigo, High Ground → Tommy. High Ground's play rule waits for Avi (idea 57).
