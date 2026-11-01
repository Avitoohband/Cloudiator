# Patch 1.5 — Avi’s production review

**Release candidate; production remains 1.4. Full gate and fresh 1.5 production go pending.** Runtime fixes: `db386db`. This preparation changes documentation only.

## Exact patch-note draft

Kind: `patch-notes`. Action: none.

**Title:** Watch your Arena bouts more easily

**Preview:** My bouts lists your own Arena and tournament bouts. Watch them one after another, from the camp, Notifications or the Arena menu.

**Body:**

- p: What changed:
- li: My bouts: Results now opens on your own Arena and tournament bouts, by day, with your opponent, whether you won and how your rating moved. Show all of them, or only the ones you won or lost.
- li: A new replay bar, like the whole-trip replay’s: play and pause, a track you can drag, the time, a speed of 1×, 2× or 4× that this device remembers, and ⚑ Result.
- li: When a bout ends, its result shows on the arena with Watch again and Next bout, so you can watch your bouts one after another.
- li: Watch a bout from where it shows up: a button on the camp after your bout, ▶ Watch in Notifications, and your recent bouts in the Arena menu.
- li: Tournament bouts play full screen too, and Next bout steps through the bracket.
- li: The replay no longer shows who won above the fight before it plays.

## Exact patch-record draft

**Number:** 1.5

**Title:** Watch your Arena bouts more easily

**Features (word for word from CHANGELOG):**

- Results opens on My bouts: your Arena and tournament bouts by day, with All, Won and Lost filters, rating changes and a dot until watched on this device.
- The replay bar has play and pause, a track, the time, a remembered speed of 1×, 2× or 4×, and ⚑ Result.
- A bout's result appears on the arena after the victory poses, with Watch again and Next bout, or a button back at the end of your list.
- The replay header keeps the result hidden while the fight plays. On a phone, who won stays in view and Fighters and Combat log fold away.
- Back names where you opened the replay and returns there in one step.
- Next bout follows your list, with a counter and Up next.
- Notifications open your kept Arena and tournament replays with Watch, and expeditions with Watch the trip; Back returns to Notifications.
- The Arena menu shows your three latest bouts with Watch and a link to all your bouts in Results.
- After your Arena bout ends, a camp button names who won, shows rewards once credited and opens the replay; dismiss it for that bout on this device.
- Tournament brackets open the full-screen viewer, with each decided bout as a chapter.

Link the record to the actual new note ID returned by publication. The placeholder below is review-only and is not executable SQL. Generate the real statement with `scripts/patch-statement.mjs 1.5 --message <returned id>` only after the approved note succeeds.

```sql
select private.record_patch(
  '1.5',
  $t$Watch your Arena bouts more easily$t$,
  array[$f$Results opens on My bouts: your Arena and tournament bouts by day, with All, Won and Lost filters, rating changes and a dot until watched on this device.$f$, $f$The replay bar has play and pause, a track, the time, a remembered speed of 1×, 2× or 4×, and ⚑ Result.$f$, $f$A bout's result appears on the arena after the victory poses, with Watch again and Next bout, or a button back at the end of your list.$f$, $f$The replay header keeps the result hidden while the fight plays. On a phone, who won stays in view and Fighters and Combat log fold away.$f$, $f$Back names where you opened the replay and returns there in one step.$f$, $f$Next bout follows your list, with a counter and Up next.$f$, $f$Notifications open your kept Arena and tournament replays with Watch, and expeditions with Watch the trip; Back returns to Notifications.$f$, $f$The Arena menu shows your three latest bouts with Watch and a link to all your bouts in Results.$f$, $f$After your Arena bout ends, a camp button names who won, shows rewards once credited and opens the replay; dismiss it for that bout on this device.$f$, $f$Tournament brackets open the full-screen viewer, with each decided bout as a chapter.$f$],
  <new note id returned by post_message>
) as number;
```

## For Avi at the go

- Three proposed production writes: client release (including normal pinned CI dependency installs), the exact note below, then the linked 1.5 patch record. The 1.4 go is exhausted; this patch has no schema or Edge change.
- The full 12-step gate is PENDING. Runtime source db386db; scoped review found no Critical/Important issue. Unit 2,102/119 and TypeScript passed; affected union 488pass/5fail/3existing skips, then the 16-case covering run resolved all five failures. Real local PostgREST/owner/filter/RLS and cached-only Deno checks passed.
- Phone chapter bars use the recorded 118px exception; ordinary bars are at most 100px, buttons at least 44×44 and slider at most 32px. Final desktop and360 captures were inspected; see local final-scoped-2 evidence.
- Expedition encounter overlays omit reward chips; their lower Result retains whole-trip rewards. This is the recorded design carry for Avi’s disposition in the go.
- Two Minor residuals are parked: Up next uses plural Quarterfinals/Semifinals rather than the approved singular examples; the clock test helper observes periodic polls but does not attest overlapping manual-command refresh completion. No client runtime code is affected by the latter. All current helper callsites were inspected and their covering cases passed; a held direct-command case remains future work.
- Inherited Phaser texture warnings remain unexplained; original Task 9 RED raw traces were lost (logs and later traces retained). The separate 1.4 GitHub bed-image timeout decision remains pending. No warning/trace restoration/CI-green claim.
- At execution time recheck release window and open boundaries. After shipping, remind Avi about the 1.5 patch clip and feature posts.

All controller rulings and their costs: [rulings](PATCH-1.5-RULINGS-2026-11-01.md).
