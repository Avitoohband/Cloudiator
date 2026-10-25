# Launch feedback: creation points, schedule, gear and market fee (design)

Avi tested the live game on 2026-10-25 (production, soft launch) and gave ten notes; he approved the clickable mockup
(https://claude.ai/artifact/2C4pRBxSP9SYj1PH77zQ89) the same day with "approved, build it". This document is what a builder
plans from. Decisions marked **Avi** are his; those marked **Claude's call** were stated to him and not objected to, or are
settled here for the builder and can be changed by Avi on review.

## Intent

New players reached screens that did not explain themselves: the creation points said "-10 points remaining" when they
were over; the schedule saved each part of the day separately and silently deferred a change to the running part; nothing
showed which gear is worn or how to swap a sword. Avi also set three game rules: Arena only in the evening, tournaments
moved with it, and a minimum market fee. Success: a first-time player creates a gladiator, plans a day and swaps gear
without guessing, and the economy has no free transfers.

## Goals

1. **Creation points** (notes 1–5; mockup screen 1).
   - A counter "N of 10 left" (and "All 10 spent") with ten pips; never a negative number.
   - Each attribute row: name, one-line effect, "5 +" then − / value / + then "= total".
     Effects (from the rules): Strength "More damage with every hit"; Agility "Faster attacks, harder to hit"; Vitality
     "+10 health per point"; Endurance "+2 stamina per point, carries more"; Precision "Hits more often, more critical
     hits".
   - Typing more than is left caps the value at what is left (Avi: 7 left, type 10 → 7), with a short status line saying so.
   - **Reset points** sets all five to 0. **Suggested for {class}** fills the class's split (Claude's call):
     Berserker STR 5 · AGI 1 · VIT 2 · END 1 · PRE 1; Guardian STR 2 · VIT 5 · END 2 · PRE 1; Duelist STR 2 · AGI 4 · PRE 4.
   - Points start at 0 (Claude's call; today 2 each). Create is enabled only when all 10 are spent, with a hint saying how
     many are left otherwise. Server validation is unchanged (exactly 10, whole, 0–10 each).
2. **Arena only in the evening** (**Avi**, "for now"). The server refuses Arena for the morning and the afternoon; the
   schedule offers Arena only in the evening and says "Arena runs in the evening only" under the other two.
3. **Tournaments move to the evening** (**Avi**): Wednesday and Saturday, the evening slot that starts at 18:40 UTC
   (the slot right after today's 17:20 UTC afternoon slot), with registration requiring Arena in that evening. All times
   and texts follow.
4. **One Save for the whole day** (**Avi**; all-or-nothing is **Claude's call**): the schedule edits all three parts as a
   draft and saves them together in one command that applies all changed parts or none. Undo restores the saved day. One
   confirmation names each changed part and when it starts.
5. **Running part notice** (note 8): when the part of the day that is running now is shown, the screen says it is running,
   when it ends, and that a change to it starts with the next occurrence.
6. **Gear** (note 9; mockup screen 3): a "Wearing now" row of the five slots (weapon, off-hand, head, body, feet), and per
   inventory item a **Wear** action that queues the swap for the next slot like builds today, with badges "Wearing",
   "Wears from HH:MM" and "Off at HH:MM", an Undo per queued item and a "Cancel changes". Two-handed weapons free the
   off-hand ("Needs a free hand").
7. **Market minimum fee** (**Avi**): the fee is 5 % floored, but at least 1 gold. The lowest listing price is 2 gold so the
   seller always receives something (Claude's call). The sell form shows buyer pays / fee / you receive as the price is
   typed.

## Non-goals

- No change to how attributes affect combat, to the 10-point total, or to the class bonuses.
- No new activities, expeditions or schedule parts; slot length and phase rotation stay as they are.
- No change to how and when a pending build applies (the next boundary) beyond making equipment-only swaps reachable
  from the gear view.
- Google OAuth publishing and a privacy page are separate work.

## Anti-goals

- A schedule save that leaves the day half saved.
- A rule enforced only in the client: every rule here is refused by the server too.
- A tournament that can no longer get entrants (the reason the tournament moves with the Arena).
- Editing a committed migration: SQL changes go in a new migration (M23).

## Constraints

- Live production and bench databases: a new migration must replay cleanly on both (no live schedule uses Arena today;
  no open listing exists; checked 2026-10-25). If any schedule still holds Arena outside the evening when the migration
  runs, that part becomes Rest (Claude's call), never a failed deploy.
- The release gate of record (12 of 12, private two-worker config) before any hosted deploy; production writes need
  Avi's go (Task 24 checklist).
- Accessibility rules of Task 23.5 hold (real buttons, labels, 4.5:1 text, status messages announced).

## The change surface

The file-by-file map is `2026-10-25-launch-feedback-code-map.md` beside this document. The decisions it raised:

- **Rules are changed in place in v1 (Claude's call).** The runbook ships changed rules as a new version so jobs in flight
  keep theirs. Here the changed rules are the tournament hour, the market fee, the lowest price and which part may hold
  Arena; none is read by an executor of a job that can be in flight at deploy time, because no tournament has ever formed
  (no schedule has used Arena) and the fee is computed in SQL at purchase. The deploy therefore happens outside the
  tournament windows (not Wednesday or Saturday 17:20–20:00 UTC) with no open boundary, and the exception is recorded in
  the runbook. A v2 rules version is not introduced.
- **Arena evening-only is enforced at command time** (Edge `parseCommand` and SQL `planning_command`, for both
  `edit-schedule` and the new day command), like the expedition level. The boundary does not re-check the phase, so DB
  tests that write schedules directly keep working. M23 backfills inside a `do` block: for every gladiator, any morning
  or afternoon Arena that is current (effective at or before its processed slot + 1) or still to come becomes Rest, with one
  version bump per gladiator: a Rest revision at processed slot + 1 for a current Arena, and a Rest revision at the same
  effective slot (higher version) for each future Arena revision, so the boundary's pick (`effective desc, version desc`)
  sees Rest. None exists on production or the bench today.
- **Tournaments**: `RULES_V1.tournaments` 18:40 UTC; the domain's slot test is already generic; registration already reads
  the slot's own phase (`tournament.ts:123-126`), so the evening slot needs evening Arena with no code change. No SQL
  change. Tournament fixtures move from slot 301 to 302 (regenerated, with new seeds where a story needs them); every
  "17:20" and "afternoon" text follows.
- **One save for the day**: a new command kind `edit-day-schedule` `{operationId, expectedVersion, day: {morning,
  afternoon, evening}}` handled inside `planning_command` in the same transaction rules as `edit-schedule` (same locks,
  receipt replay, processing gate, `expectedVersion` against the schedule version, choice validation for all three). It
  bumps the version once, writes `jsonb_set` and one revision only for each part whose choice changes (each with its own
  `schedule_effective_slot`), and returns `{version, receivedAtMs, parts: {morning|afternoon|evening: {effectiveSlotIndex,
  effectiveAtMs} | null}}` (null = unchanged). A day with no change is `invalid` (the client disables Save then).
  `edit-schedule` stays (the bench seed and the deployed probes use it) and gains the evening-only check. A new
  `public.edit_day_schedule` wrapper with the same grants; the access matrix, rate limits and gateway allowlist follow.
- **Running part notice**: client only, from the shared clock (current slot and phase, the slot's end, the part's next
  start).
- **Gear**: client only, through the existing `queue-build` and `cancel-build`. Wear and Undo send `queue-build` with the
  whole build based on `pendingBuild ?? currentBuild` and that slot changed (a two-handed weapon clears the off-hand); if
  the result equals the current build entirely, `cancel-build` instead. "Cancel changes" resets only the equipment to the
  current build's (the same rule). Disabled states: preview mode, "Needs a free hand" (off-hand under a two-handed
  weapon), "Needs level N", "Listed for sale". Badges from `pendingBuild.effectiveSlotIndex`. It lives in the Inventory
  panel (the "Wearing now" row above the items, a Wear action per wearable item); the build panel is unchanged.
- **Market**: fee `max(1, floor(price × 5 / 100))` in SQL `market_command` and the TS mirror; the lowest price 2 in the Edge
  parser, SQL's price shape check and the client. The table CHECKs stay `>= 1` (no open low-price listing exists, and a
  price cannot change). `hosted-checks.sql` judges a sale by the fee stored in its receipt (old sales stay right).
- **Creation**: client only; server validation unchanged. Fields are not marked invalid until a create attempt; Create is
  disabled until all 10 are spent, and its hint says why. A saved draft keeps its values.
- **M23** holds the re-emitted `planning_command`, the new wrapper and grants, `market_command`, and the backfill;
  migration counts pinned by tests move from 22 to 23. The generated draft is completed and replayed per the project's
  migration rules (AGENTS.md, "Generated migration completion").

## Settled after the builder check (Claude's calls)

- The mockup decides what the prose leaves open: the schedule's confirmation is a status line after saving ("Saved.
  Morning: Training from 18:00. …"); a typed value caps at the field's current value plus the points left; "= total" is 5
  plus the points spent (class bonuses not included); each schedule part shows a one-line hint for its activity with its
  stamina cost; the fee label reads "5%, at least 1" and List is disabled below 2.
- Right before the production deploy, re-check that no schedule holds Arena outside the evening, no tournament has
  formed, no open listing is priced below 2 and no boundary is open; if any changed, stop and ask Avi (his pre-approval,
  2026-10-25, "approved for production once it passes", covers the deploy as designed).
- Backfill: a part with both a current and a future Arena revision gets a second version for the second Rest revision
  (the revision key `(gladiator_id, phase, version)` allows one row per part and version).
- Undo of a queued two-handed weapon restores the worn off-hand too (as the mockup does).

## Left to the builder

Component structure, exact wording beyond what is quoted here, test layout, and the migration's internal shape.
