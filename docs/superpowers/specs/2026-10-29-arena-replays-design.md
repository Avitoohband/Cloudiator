# Arena replays, more comfortable to watch (design)

Avi's idea 9 (2026-10-29, [next-patch ideas](2026-10-29-next-patch-ideas.md)): "there need to be more comfort way to see my
arena replays." A small client-only patch that ships right after [Patch A](2026-10-29-patch-a-design.md) and before Patch B
([party dungeons](2026-10-29-party-dungeons-design.md)).

Approval: Avi looked at the clickable mockup (a local page over real screenshots of the fixture build,
`.superpowers/design/2026-10-29-arena-replays/mockups.html`, with `design-draft.md` and `shots/` beside it; that folder is
ignored by git, so **this spec carries the approved copy word for word**) and made three choices (next-patch ideas, last
paragraph). The mockup is the approved UI: where this spec quotes copy, layout or behaviour, it is the mockup's. Decisions are
marked **Avi**, **Claude's call** (stated in the design draft's "Calls made without asking Avi" or in the mockup, and approved
with the direction) or **Planner's call** (made while writing this spec, for a case the mockup does not show; Avi can overrule
any of them).

## Intent

Watching your own bouts takes a search today. 📜 Results is everyone's feed of every kind (rests included), 50 rows a page with
no filter, so yesterday's bout is many "More" taps deep. Nothing on the camp, in Notifications or in the Arena menu offers a
bout's replay. The replay's four look-alike text buttons, its separate slider and its key line push who won below the fold on
a phone; each bout is a round trip back to the list; "Back to camp" really goes back to a menu; a live bout's stage label
("Bout: victory") shows the result above the fight before it plays; and tournament bouts play in a third, cramped viewer
inside the 378 px menu.

This patch makes finding, watching and moving between your bouts one tap each, in one full-screen viewer that looks like
Patch A's whole-trip replay. It is client only: **no migration, no Edge change, no RLS or grant change, no new command**.

## Goals

1. **My bouts, in 📜 Results:** your own Arena and tournament bouts, newest first, grouped by day, each with the opponent,
   Won or Lost, the renown and the rating change, a gold ▶ Watch and a dot until watched on this device. Filters All · Won ·
   Lost. Everyone's feed stays one tab away.
2. **One replay viewer with Patch A's bar:** ⏮ ▶ ⏭, a progress track, the time, a remembered speed (1× · 2× · 4×) and
   ⚑ Result; the result card on the arena with ↺ Watch again and ▶ Next bout; keys; a phone layout that shows who won
   without scrolling.
3. **Next bout:** ⏭ walks the list the replay came from (with its filter), a counter says where you are, "Up next" names the
   next bout, and Back returns to where you came from in one step.
4. **One tap from where a bout shows up:** the camp (Patch A's away button, extended to an Arena slot), Notifications, the
   Arena menu and the tournament brackets.
5. **No spoiler in the viewer:** the server's stage label ("Bout: victory", "Final: defeat") is never shown; the server is
   unchanged.

## Non-goals

- Expeditions in My bouts. They keep Everyone, Notifications (with ▶ Watch the trip), Patch A's camp button and its
  whole-trip replay (**Claude's call**).
- Hiding Won/Lost or the rating change until a bout is watched (**Avi**: no spoiler hiding in the rows).
- Playing on into the next bout by itself (**Avi**: no autoplay).
- Watched marks on the server or across devices; a server change of any kind, including the server's stage label.
- A queue through other players' bouts, a camp button for a tournament slot, changing the Everyone list, replay retention
  (7 days), rewards or bout rules. Translating the UI.

## Anti-goals

- A bout's result shown in the viewer before its fight ends or ⚑ Result is pressed: no stage label in the eyebrow, the
  chapter names, a title or an accessible name; the result card only at the end.
- Owner-only data (the My bouts list, renown, rating changes, the camp button) for anyone but the signed-in owner, or kept
  after the account signs out or changes.
- ⏭, ⏮, a chapter or ▶ Next bout adding history entries: Back (the button, Escape or the browser's) leaves the viewer in one
  step.
- A slower earlier read replacing a newer one (a filter changed, a list reopened, a page read by ⏭).
- A crash or a lost mark or speed when browser storage is unavailable (private mode, blocked site data).
- A time of day written outside Patch A's shared formatter (`src/lib/time-format.ts`).

## Approved behaviour and copy

### 1. My bouts, in 📜 Results

- **Tabs.** For a player, Results opens on the tab "My bouts". The tab "Everyone" is today's list, unchanged. A visitor, or a
  player without a gladiator, sees only Everyone, as today, with no tabs (**Claude's call**).
- **The count.** "My bouts" carries a red count of bouts not yet watched on this device: the kept replays of the All list's
  loaded rows that have no watched mark ("9+" above 9, as the messages badge; none at 0). Its accessible name is "My bouts, 5
  not watched" (**Planner's call** for the name and what is counted).
- **Chips:** "All" · "Won" · "Lost" (pressed buttons). The replay's ⏭ follows the chip, so "Lost" plus ⏭ walks through your
  losses.
- **Line:** "Replays are kept 7 days · ● not watched yet" (the ● gold, as the row's dot).
- **Day groups:** "TODAY · SAT 10 OCT", "FRI 9 OCT", … (dates in the viewer's own time zone; "TODAY · " when the bout's day is
  the display clock's day).
- **Row:**
  - a W or L badge (green or red; accessible text "Won" / "Lost");
  - "vs Varro", with a gold dot when not watched (accessible "Not watched yet");
  - the sub-line "Arena · 3:00 AM · +10 renown · Rating +14" (zero parts left out; a negative change reads "Rating −13" with
    U+2212). On a phone the sub-line leaves out a leading kind word, "Arena" or "Tournament" (the mockup's phone rows);
  - a gold "▶ Watch" button.

  Tags: "NPC" after the name for an NPC fallback opponent and "TOURNAMENT" for a tournament bout. A tie-break win reads "won on
  a tie-break" (a tie-break loss "lost on a tie-break", **Planner's call**), placed after the time.
- **The time** a bout shows (rows, day groups, the viewer's eyebrow, "Up next") is when it was fought: an Arena bout's minute 60
  (its reveal), a tournament's start (the time the Tournaments panel announces) (**Planner's call**: the mockup gives the same
  time in the row, the eyebrow and Up next; settlement comes 20 minutes later).
- **A tournament row** names the opponent of the run's last bout (the one that knocked you out, or the final) and starts its
  sub-line with that bout's round instead of the kind: "Final · 9:40 PM · +60 renown · Rating +16"; without a known round,
  "Tournament · …" (**Planner's call**; the mockup's tournament row was a sample).
- **Expired rows** (replay older than 7 days, by the server's time) stay listed, dimmed: "Arena bout" (or "Tournament bout") ·
  "7:00 PM · replay no longer kept", with a "Result" button that opens the saved outcome (`SavedOutcome`, as today). Their W/L
  badge stays; the opponent's name goes with the replay, so an expired row never names one, even before the cleanup removes
  its stages (**Planner's call**). A kept row whose bout cannot be read shows "Arena bout" / "Tournament bout" with ▶ Watch.
- **The server's time** decides kept or expired, as Everyone does today: until the shared display clock has it, rows show
  without a button; a row turns into an expired row when the clock passes its expiry (**Planner's call**).
- **Paging:** 20 a page, then "More". Loading "Loading your bouts…"; a failed first page "Your bouts could not be loaded right
  now." with "Try again"; a failed More "More bouts could not be loaded. Please try again." (**Planner's call**, Everyone's
  wording).
- **Empty state:** "No bouts yet. Your Arena and tournament bouts show here with their replays." With a chip and no rows: "No
  won bouts yet." / "No lost bouts yet." (**Planner's call**).
- **Watched marks** are kept on this device in `cloudiator.bouts-watched.v1`, guarded like the other keys, pruned after 7 days
  (and the newest 200 kept, **Planner's call**). Opening a replay marks it.
- **Accessible names:** ▶ Watch is named "Watch: vs Varro, Sat 10 Oct, 3:00 AM"; Result "Result: Arena bout, Wed 30 Sep, 4:00
  AM" (**Planner's call**: unique within the list).

### 2. The replay viewer

The full-screen scene over the camp stays; the replay page `/replay/` gets the same viewer without a queue.

- **Back names its origin** (see 5): "← My bouts", "← Arena", "← Notifications", "← Tournaments" or "← Camp". On a phone the
  scene's header is solid, so nothing floats over the content once you scroll.
- **Eyebrow:** "ARENA · SAT 10 OCT, 3:00 AM" (phone "ARENA · SAT 3:00 AM"); against an NPC "ARENA · FRI 9 OCT, 11:00 PM · NPC
  OPPONENT" (phone "ARENA · FRI 11:00 PM · NPC"); a tournament bracket's bout "TOURNAMENT · BRONZE · FINAL". The stage label
  is never shown. A tournament run opened from My bouts reads "TOURNAMENT · FINAL": its timeline does not carry the league
  (**Planner's call**). An expedition's encounter keeps today's "Expedition · Encounter 1: Dire Wolf" (no result in it).
- **The title** stays "Aster vs Varro".
- **The replay bar** uses the look of Patch A's `TripBar` (one shared bar), so the two viewers feel the same:
  - ⏮ "Previous bout", ▶/⏸ "Play"/"Pause" (gold) and ⏭ "Next bout" (names as quoted; icons visible);
  - a progress track you can click or drag (accessible name "Replay position");
  - the time, "0:07 / 0:23";
  - the speed, "1×" → "2×" → "4×" (name "Speed 1×"), remembered on this device in `cloudiator.replay-speed.v1`;
  - "⚑ Result" (name "Skip to the result").

  ⏮ and ⏭ are hidden when there is nothing to step to: a single bout without a queue (someone else's bout outside a bracket,
  or any single bout on the replay page, which has no queue). When an
  activity has several bouts (a tournament run, an expedition's encounters) its bouts are chapter buttons on the bar, as
  Patch A's trip shows its fights (a tournament run's chapters are named by round, "Quarterfinal", "Final"; an expedition's by
  today's encounter labels). On a phone the bar shows "2 / 3 · Semifinal" instead of the chapter buttons, as Patch A's does.
- **Phone layout:** the bar takes two rows (the track and the time, then ⏮ ▶ ⏭, the speed and ⚑): 100 px instead of 170 px.
  Fighters and Combat log fold into "▸ Fighters at the start" and "▸ Combat log" (closed). The Result card's line becomes "The
  result appears when the fight ends, or now with ⚑ Result." (on every width).
- **Keys:** Space or K play/pause · ← → 5 s · N/P next/previous bout · F speed · R restart · End result. The keys appear in the
  buttons' titles ("Pause (K)") and `aria-keyshortcuts`; the line "Keys: K play or pause…" is gone, including on touch
  screens. Space acts only when the focus is not on a button, link, summary or form control (there it presses that control);
  ← and → also replace the track's own small arrow steps (**Planner's call**).
- **Opening:** a bout keeps playing when opened (as today), at the remembered speed, and the focus moves to ⏸ once it has
  loaded, when the focus is still on the scene's back button (**Claude's call**; the "still on back" guard is the **Planner's
  call**).
- **The result card on the arena.** When the replay reaches its end (after the victory poses) or on ⚑ Result, a card shows over
  the arena:
  - the eyebrow "RESULT" (desktop), the verdict "Aster wins" and the reason: "Varro is defeated."; a simultaneous tie-break
    "Both fell at the same moment; a seeded tie-break chose Aster." (phone "A tie-break chose Aster."). **Planner's call** for
    the other two endings: "Time ran out and Aster kept more health." and "Time ran out with equal health; a seeded tie-break
    chose Aster." (phone "A tie-break chose Aster.");
  - your credited rewards as chips: "+10 renown", "Rating +14", and "NPC: no rating change" for an NPC bout; a tournament run
    adds its gold ("+100 gold") between renown and rating (**Planner's call**). Before settlement a fighter sees "Rewards are
    credited when the bout settles" ("…when the tournament settles" for a run, **Planner's call**); a spectator sees no chip.
    A tournament run's chips show on its last chapter only; a bracket's bouts show none (**Planner's call**);
  - "↺ Watch again" (phone "↺ Again") and "▶ Next bout · vs Cassia" (phone "▶ Next · vs Cassia"; "▶ Next bout" when the next
    bout has no known opponent). At the end of the queue it shows the back button instead ("← My bouts", or whichever origin).
    On the replay page it shows ↺ Watch again only (**Planner's call**).

  The card never moves on by itself (**Avi**). ↺ Watch again (or R) plays from the start; any seek before the end, or Play,
  hides the card. The Result, Fighters and Combat log cards stay below.

### 3. Next bout: the queue

- **The queue** is the list the replay opened from:
  - My bouts, with its chip;
  - the Arena menu's recent bouts, a notification, the camp button, Everyone or a link to your own bout: My bouts (All), read
    when needed;
  - someone else's bout: no queue, so ⏮ and ⏭ are hidden (**Claude's call**);
  - a tournament bracket: the bracket's decided bouts as chapters (see 4).

  **Planner's calls:** "your own bout" means its timeline carries your settled summary, or it is your current activity; the
  queue holds kept replays only (an expired row opens its result and is skipped); your own bout that is not in the list yet (not
  settled, opened from the camp) leads it; ⏭ on the last loaded bout reads the next page first.
- **⏮ ⏭ and N/P** step through the activity's chapters first, then to the previous or next bout in the list (newest first, so
  ⏭ goes to the older bout), opening each at its first chapter. Each step replaces the scene's history entry (**Planner's
  call**), so Back still leaves in one step, and a reload reopens the bout being watched.
- **Counter:** "Bout 1 of 6 in My bouts" (phone "1 / 6"); while more pages exist "Bout 20 of 20+ in My bouts" (phone "20 /
  20+", **Planner's call**). Shown only with a queue.
- **Up next:** "UP NEXT · Aster vs Cassia · Arena · Sat 10 Oct, 12:20 AM" with "⏭ Next bout" (desktop); phone "UP NEXT" over
  "Aster vs Cassia · Sat 12:20 AM", without the button. For a next chapter: "UP NEXT · Aster vs Varro · Semifinal". None at the
  end of the queue.

### 4. One tap from where a bout shows up

**The camp.** This extends Patch A's away button (Task 11) to an Arena slot (**Claude's call**):

- From the end of the bout: icon ⚔, "**Aster** beat Varro in the Arena" (or "**Aster** lost to Cassia in the Arena"), "Rewards
  are credited at minute 80" and "▶ Watch the bout".
- Once credited, the second line becomes "+10 renown · Rating +14" (the owner's own result; zero parts left out; "No rewards"
  when every part is zero, **Planner's call**).
- It stays until the next slot ends, or until × ("Dismiss"), closed per activity on this device in Patch A's
  `cloudiator.trip-closed.v1` (**Planner's call**: the key already holds closed activity ids).
- Phone: "**Aster** beat Varro" · "Rating +14" · "▶ Watch". **Planner's calls:** the phone's second line is the rating part,
  else the renown part, else "No rewards"; before credit "Rewards at minute 80".
- The bout is revealed at minute 60 and lasts 12–23 s; the camp's ring plays it live, so the button adds nothing before it
  ends.
- A bout's button replaces a trip's "back" button from the slot before (the newer activity wins, **Planner's call**).
- Reads: the owner's own timeline of that Arena activity (its bout, its opponent and, once settled, its summary), found from the
  owner's current activity or, in the next slot, from the notifications read Patch A's button already makes.

**Notifications.**

- Arena and tournament cards with a kept replay get "▶ Watch". Expedition cards with a kept replay get "▶ Watch the trip"
  (phone "▶ The trip"), which opens Patch A's whole-trip replay.
- The panel closes and the scene opens; "← Notifications" reopens the panel on that tab, with the focus on the tab.
- The data is already in `GameNotification.summary` (its `replayExpiry`, decided by the server's time).
- Accessible names: "Watch: Arena victory", "Watch the trip: Expedition victory: Ruined Outpost" (**Planner's call**).

**The Arena menu.** "YOUR RECENT BOUTS" lists the three latest bouts (the first page of My bouts), then "All my bouts in
Results →" (phone "All my bouts →"), which opens Results on My bouts (All). The current bout's card stays as it is.

- A row has the badge, "vs Varro" with its dot and tag, the sub-line "Today, 3:00 AM · Rating +14", "Today, 12:20 AM · won on a
  tie-break" (phone "· tie-break") or "Fri, 11:00 PM · +3 renown", and ▶ Watch.
- **Planner's calls:** the sub-line holds one detail: the rating change, else the tie-break, else the renown, else none; the day
  reads "Today", a weekday within the last 6 days, else "Sat 3 Oct"; the section sits under "Your arena bout" and above the
  fixture's sample list, and is absent while the list loads, fails or is empty.

**Tournament brackets.**

- "Watch replay" opens the same full-screen viewer, not the inline one (the inline replay, its status line and "Close replay"
  go).
- The bracket's decided bouts are its chapters, in bracket order, and ⏭ goes through the bracket. "← Tournaments" returns.
- It uses a client-only scene address for a bout without an activity id: `?view=bout&tournament=<id>&bout=<boutId>`, read
  through the existing `tournament` and `tournamentLog` reads (the gateway's log cache).
- **Planner's calls:** chapter names "QF 1" … "QF 4", "SF 1", "SF 2", "Final" (earlier rounds "R1 · 5"); no counter and no
  rewards; a chapter step replaces the address's `bout`, so a reload reopens that bout; while a log loads "Loading the
  replay…", on failure "This replay cannot be loaded right now. Try again shortly." with "Try again"; a bracket whose replays
  are no longer kept says "This replay is no longer kept"; the fixture preview shows a sample bracket at its projection time,
  as the panel does.

### 5. Back names its origin

- A `from` parameter on the scene address keeps the origin across a reload: `bouts`, `bouts-won`, `bouts-lost`, `arena`,
  `notifications`, `tournaments`; none means the camp (**Claude's call**).
- **Planner's call:** two more origins so the label is never wrong: `results` ("← Results", a row of Everyone) and
  `gladiators` ("← Gladiators", the Gladiators list's Watch expedition). The Arena card's Watch replay opens from `arena`.
  Patch A's camp button and this patch's open with no origin ("← Camp").
- Back still returns to the menu you came from, which stays open under the scene. When a scene with an origin closes (the
  button, Escape or the browser's Back) and that menu is not open (after a reload, or the Notifications panel), the shell
  opens it: Results on My bouts with the chip (`bouts-won` → Won) or on Everyone, the Arena or Tournaments menu, the Gladiators
  list, or the Notifications tab (**Planner's call**).
- The button's accessible name is "Back to My bouts" (… "Back to Camp"); the arrow is hidden from screen readers.

## Data, with no server change

Every read uses tables, views and policies the client already reads (**Claude's call**, checked against
`supabase/sql/03-activities-jobs.sql` and `06-projections.sql` while writing this spec):

- **My bouts:** the owner's own `activities` (RLS `owner_read`: a signed-in reader sees its own gladiator's rows; `anon` has no
  grant), read as `readNotifications` reads them: columns `id, gladiator_id, slot_index, starts_at_ms, resolved_kind,
  settled_at_ms, summary`; `status = completed`, `resolved_kind in (arena, tournament)`, `summary is not null`, `settled_at_ms ≤`
  the server's now (from `world_revision`); Won `summary->>result = victory`, Lost `summary->>result = defeat`; newest first by
  `slot_index`, 20 a page, the cursor the last row's slot index (`slot_index <` cursor). The unique index `(gladiator_id,
  slot_index)` serves it. The summary carries the owner's renown and rating change.
- **Opponents' names:** one `visible_events` read per page (public, due rows only), for the page's rows whose replay is kept at
  the read's server time: `activity_id in (…)`, `stage->>kind = bout`, `reveal_at_ms ≤` now, ordered by activity and ordinal and
  paged by 50. Only the stage's label, the log's tie-break reason and each participant's id, gladiator id and name cross. The
  run's last bout names the opponent (the participant whose gladiator id is not the row's; a null gladiator id is an NPC).
- **The viewer:** the existing timeline read; the bracket viewer the existing tournament view and log reads.
- **The camp button:** the owner's timeline read and Patch A's notifications read.
- **Device storage:** `cloudiator.bouts-watched.v1`, `cloudiator.replay-speed.v1`, and Patch A's `cloudiator.trip-closed.v1`.

## Decisions

| Decision | Who |
| --- | --- |
| My bouts rows show Won/Lost and the rating change; no spoiler hiding | Avi |
| A replay ends on the result card with Watch again / Next bout / Back; no autoplay | Avi |
| A small patch right after Patch A, reusing Patch A's replay bar, before Patch B | Avi |
| Results opens on My bouts for a player; Everyone one tab away; visitors see Everyone only | Claude's call |
| My bouts is Arena and tournament bouts; expeditions keep Patch A's ways in | Claude's call |
| Rows: opponent, W/L, renown and rating; chips All / Won / Lost; 20 a page; day groups | Claude's call |
| Expired rows stay listed, dimmed, with "Result"; no opponent name once the replay is gone | Claude's call |
| "Not watched" marks per device | Claude's call |
| One full-screen viewer for every bout, with Patch A's bar look; tournament bouts leave the menu | Claude's call |
| Speed 1× / 2× / 4×, remembered on the device | Claude's call |
| A bout opens playing, focus on ⏸ | Claude's call |
| The result card on the arena; it never moves on by itself | Claude's call |
| ⏭ follows the list the replay came from, with its chip | Claude's call |
| Back names its origin; a `from` parameter keeps it across a reload | Claude's call |
| The eyebrow shows the kind and time, never the stage label | Claude's call |
| The camp button covers an Arena slot from the bout's end until the next slot ends | Claude's call |
| No server change or migration | Claude's call |
| A bout's time is when it was fought (Arena minute 60, a tournament's start) | Planner's call |
| A tournament row names its last bout's opponent and round | Planner's call |
| Expired rows never name the opponent; rows wait for the server's time | Planner's call |
| Empty-filter, loading and failure wording; the tab count and its name; marks kept 200 | Planner's call |
| Origins `results` and `gladiators`; the shell reopens the origin when a scene closes | Planner's call |
| Chapters first, then the list; steps replace the history entry | Planner's call |
| The queue: kept replays only, own unsettled bout first, next page on ⏭, "20+" | Planner's call |
| "Own bout" = own settled summary or own current activity | Planner's call |
| Space and arrow-key rules; focus to ⏸ only from the back button | Planner's call |
| End-card wording for the time-out endings, tournament chips and pending line; replay page end card | Planner's call |
| Tournament-run eyebrow without league | Planner's call |
| Arena menu row detail, day words and placement | Planner's call |
| Camp button: "No rewards", phone lines, the trip key, newer activity wins | Planner's call |
| Bracket chapter names, no counter or rewards, chapter in the address, load and expiry wording, fixture time | Planner's call |
| Notifications buttons' accessible names | Planner's call |

## Mockup details not turned into requirements

- Only three fixture bouts were recorded for the mockup (vs Varro, vs Cassia tie-break, vs Iron Warden); the rows after them
  (vs Cassia "Rating −11", vs Bellator, vs Severus "Bronze · 9:40 PM · out in round 1") are samples. Their names, numbers and
  times ("3:00 AM", "12:20 AM"), the "6" in "Bout 1 of 6" and the red count "2" are illustrative.
- The "15–18 More taps" figure is an estimate from the read's rules.
- The Arena menu mockup is drawn over the fixture-only "Sample arena bouts" list; the tournament proposal is a note, not a
  full-screen picture.
- The mockup's notes paragraphs ("Try: …") are guidance for reviewing the page, not copy.

## Constraints

- Next.js 16.4.3 static client; read the relevant guide in `node_modules/next/dist/docs/` before writing code (AGENTS.md).
  `history.pushState` and `replaceState` integrate with `useSearchParams` (`01-app/01-getting-started/04-linking-and-
  navigating.md`, "Native History API").
- Patch A ships first; this patch binds to its merged code (`TripBar`, `clockText`, the scene address's `play`, the away
  button, the time formatter and clock setting) and never re-implements it.
- No migration, no change under `supabase/`, no Edge change, no new command, no package download.
- localStorage only for these per-device conveniences, every access in try/catch, the page correct without it.
- React async state (AGENTS.md): only the latest read lands; a slower earlier read never replaces a newer one.
- Tests first (TDD); browser tests with the private config `node_modules/.cache/pw-claude.config.mjs`; the gate of record
  `node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs`, never a build during a browser run.
- Production is live; production writes need Avi's go in chat; deploy outside Wed/Sat 17:20-20:00 UTC with no open boundary.

## Release

Client only: the gate of record, a whole-branch review, then (Avi's go) the `release` fast-forward; `functions deploy` only if
the branch changed `supabase/functions` since the last release (this patch should not). After the client is live, post the
patch note with `private.post_message` (runbook "Posting a game message"); Avi approves its wording at release.

**Patch note draft** (credits nobody: this was Avi's own idea; Avi may change any word). Kind `patch-notes`, no action.

- Title: **Watch your Arena bouts more easily**
- Preview: "My bouts lists your own Arena and tournament bouts. Watch them one after another, from the camp, Notifications or
  the Arena menu."
- Body: the paragraph "What changed:" and the bullets
  - "My bouts: Results now opens on your own Arena and tournament bouts, by day, with your opponent, whether you won and how
    your rating moved. Show all of them, or only the ones you won or lost."
  - "A new replay bar, like the whole-trip replay’s: play and pause, a track you can drag, the time, a speed of 1×, 2× or 4×
    that this device remembers, and ⚑ Result."
  - "When a bout ends, its result shows on the arena with Watch again and Next bout, so you can watch your bouts one after
    another."
  - "Watch a bout from where it shows up: a button on the camp after your bout, ▶ Watch in Notifications, and your recent bouts
    in the Arena menu."
  - "Tournament bouts play full screen too, and Next bout steps through the bracket."
  - "The replay no longer shows who won above the fight before it plays."

(34-character title, 129-character preview, 7 blocks, 777 characters.)

**Players' clip, after the release:** a short clip of the new ways to watch, from the real game (HyperFrames), narrated in the
concept film's voice (local Kokoro `bm_george`), the music bed low (about 0.1 under narration, per the HyperFrames sound
override), closing on the game and the update with no URL and no "Coming soon"; a 16:9 cut for the Indigo Labs channel and
9:16 cuts for Instagram and WhatsApp stories; uploads and posts only on Avi's go.

## Left to the builder

Component structure and CSS beyond the sizes quoted; where exactly the counter sits in the header; the end card's placement
over the arena within the canvas; test layout; screen-reader-only text not quoted here.
