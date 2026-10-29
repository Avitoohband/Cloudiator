# Patch A: arrivals, watching an expedition, class bonuses, the phone bar, rest stamina, the clock and the players count (design)

Avi's list after the game-messages release (2026-10-29, [next-patch ideas](2026-10-29-next-patch-ideas.md), items 2-8) plus
the open Task 10 of the [game-messages plan](../plans/2026-10-28-game-messages.md) (expedition replays that show the whole
trip), designed together because item 3 and Task 10 both watch an expedition. Item 1 (party dungeons) is Patch B, a separate
spec and plan.

Approval: Avi looked at the clickable mockups (a local page over 37 real screenshots of the game,
`.superpowers/design/2026-10-29-next-patch/mockups.html`, with `design-draft.md` and `code-map.md` beside it; that folder is
ignored by git, so **this spec carries the approved copy word for word**) and answered "yes, and your recommendations, go".
The mockups are the approved UI: where this spec quotes copy, layout or behaviour, it is the mockup's. Decisions are marked
**Avi**, **Claude's call** (stated in the design draft or the mockup notes and approved with them) or **Planner's call**
(made while writing this spec, for a case the mockups do not show; Avi can overrule any of them).

## Intent

Small gaps Avi noticed while playing, and one bigger one. A new gladiator arrives unnoticed; a player whose gladiator is
away has no way back to the expedition from the camp, and the replay of a finished trip shows only its fights; the class
bonuses vanish after creation; a phone hides stamina and gold behind nothing; a Rest does not say what it gives; the game
mixes "12:40 PM" (My gladiator, Schedule) with "Sat 10 Oct, 03:00" (Results) in one session; and the Gladiators menu does not
say how many players there are. Patch A fixes all of these in the client only: **no migration, no Edge change, no new
command**.

## Goals

1. **Item 2, a new player is announced.** Everyone in the camp (players and visitors) sees a banner when a gladiator arrives;
   Find takes the camera to the gate; the Gladiators list shows newcomers first with a NEW tag; the camp shows a NEW tag over
   a newcomer at the gate.
2. **Item 3 + Task 10, watch your expedition.** While my gladiator is away, a button at the bottom of the camp shows where it
   is and opens the live view. The live view gets a LIVE badge and named marks on its timeline. A replay plays the whole
   trip in about 1¼ minutes: leaving camp, the trail, the fights at their real speed, heading home, coming back through the
   gate and resting. During a trip the player can rewind to what they missed, but never past now.
3. **Item 4, class bonuses on My gladiator**, with the class's suggested split; "Suggested for {Class}" in Plan a build.
4. **Item 5, phone: tap your name for the bar** (stamina with its bar, gold, renown, the next slot), then the clock setting
   and Sign out.
5. **Item 6, a Rest says how much stamina it gives**, in the Schedule and on My gladiator while it runs.
6. **Item 7, a 12-hour / 24-hour clock**, one setting per device that every time of day in the client follows.
7. **Item 8, the number of players** on top of the Gladiators list.
8. **The replay identity fix** (found in the design pass, fixture Woodland sample at minute 1): a replay watched after the
   trip names the gladiator "Gladiator" and draws the legacy look until the first fight. The view must take the gladiator
   from the whole timeline.

## Non-goals

- Party dungeons, summoners, a bot-gladiator team (Patch B and later).
- A 24-hour "new" window for arrivals, or the clock saved to the account (each would need M26; Avi chose neither).
- An inbox message per arrival; new camp art (the camp's NEW tag is a text tag like the existing "NPC" tag).
- Any change to rules, rewards, stamina, the boundary, the timeline read's reveal rule or replay retention (7 days).
- Changing durations (the chip's ⏱ countdown, the market's "45 min left"): they are not times of day.
- Translating the UI; dates keep today's English wording.

## Anti-goals

- A replay or a mark that shows a stage after now (the server returns only revealed stages; the client never extrapolates a
  result).
- Owner-only data shown to anyone else: rewards in the "back" button and the stamina in the Resting chapter are the owner's.
- A banner that keeps coming back on the same device after it was seen, or that hides the camp's controls.
- A time of day formatted outside the one shared formatter.
- A "Suggested" button that lowers a field, spends points not left, or saves anything before Queue build.
- A crash or a lost setting when browser storage is unavailable (private mode, blocked site data).

## Approved behaviour and copy

### Item 2 — a new player is announced

- **Who is new:** a gladiator whose public actor's `location` is `orientation` (from its creation until its first boundary,
  at most one 80-minute slot) and who is not resting at home. The world read already carries this (**Avi**: first slot
  only, no database change).
- **The banner:** every viewer whose world read shows a new gladiator not yet announced on this device sees one banner.
  Desktop: top-centre, about 560 px wide. Phone (the touch layout): under the chip, full width with 12 px gutters. It stays
  15 s, paused while hovered or while it holds the focus, then fades (no fade with reduced motion); × closes it. Live
  region: polite status. It is not shown while a scene covers the camp, and its 15 s start when it is shown (**Planner's
  call**).
- **Desktop copy:** an icon 📯, the eyebrow "NEW ARRIVAL", then "**Ursa**, a new Guardian, has arrived in the camp. Say hello
  at the gate!", a gold button "Find Ursa" and "×" (name "Dismiss").
- **Phone copy:** the eyebrow "📯 NEW ARRIVAL", then "**Ursa**, a new Guardian, has arrived. Say hello at the gate!", a gold
  button "Find" (name "Find Ursa") and "×" (name "Dismiss").
- **Several arrivals in one read share one banner:** two: "Ursa and Nero have arrived in the camp."; more: "Ursa and 2
  others have arrived in the camp." (the phone uses the same sentences). The first named is the newest arrival (latest
  `startsAtMs`, ties by name) and Find goes to them (**Planner's call**).
- **The newcomer's own player** sees the welcome instead: "Welcome to the camp, Ursa! Everyone here has been told you
  arrived." with "Find Ursa" and ×. When the player's own arrival and others are new together, the welcome comes first and
  the others' banner after it closes (**Planner's call**).
- **Find {name}** sends the existing `find-character` bridge event and hands the view back to the camp, as the Gladiators
  list's Find does (the open menu or sheet closes, the camp takes the keyboard). It is disabled, with the list's reason as
  its description, while the camp view is unavailable or still opening.
- **Device memory:** `cloudiator.arrivals-seen.v1`, the announced ids, the newest 200 kept. A banner's ids are remembered
  when it closes or fades. Every read and write is wrapped in try/catch; without storage the memory lasts the page's life.
  The banner does not come back on this device for Ursa; someone who opens the game later during Ursa's first slot still
  sees it.
- **Gladiators list:** while anyone is new, an eyebrow "NEW IN CAMP" lists the newcomers first, each name followed by a
  "NEW" pill, then the eyebrow "EVERYONE" and the list as today (eyebrows are capitals, as the game's eyebrow style shows them). A newcomer is listed once, under "New in camp" (**Planner's
  call**: a second row would repeat its buttons and ids). The filter applies to both parts.
- **The camp:** a newcomer at the gate carries an always-visible "NEW" tag over its nameplate, drawn like the existing "NPC"
  tag (gold background), only while it is new (the mockup's "Find → the gate" step).

### Item 3 + Task 10 — watch your expedition live, and the whole trip afterwards

**The button on the camp** (the only new camp element; My gladiator keeps its activity text as today, **Claude's call**):

- Shown to a player whose own `currentActivity` is an expedition, on every screen of the camp; desktop bottom-centre (about
  540 px wide); on a phone beside ☰ (left 70 px, right 12 px, bottom as ☰), hidden while a sheet is open or the icon row is
  shown. Hidden while a scene is open.
- **While the trip runs** (`startsAtMs ≤ now < endsAtMs`): icon 🧭, "**Aster** is on the Woodland Path", under it "Minute 30 of
  80 · next fight at minute 40", a thin progress bar, and a gold "● Watch live". Phone: "**Aster** · Woodland Path", "Minute 20
  of 80", the bar and "● Live". The minute is whole (rounded down). From minute 60, or once the trip's timeline shows a
  revealed defeat, the sub-line reads "Minute 65 of 80 · back at minute 80" (**Planner's call**; the button reads the
  owner's own timeline when it appears and once after each fight's minute, since the public actor carries no stage). The destination comes from the owner's world actor (`expedition:<id>` → catalog name); without it, "is on an
  expedition". Watch live opens the existing expedition scene (`view-expedition`), so Back, history and Escape work as today.
- **After the trip:** icon 🏕, "**Aster** is back from the Woodland Path", "Success · +20 gold · +100 XP" (the owner's own
  settled result; parts that are zero are left out) and a gold "▶ Watch the whole trip". After a defeat: "**Aster** is back
  after a defeat on the Ruined Outpost" with "No rewards · all gear kept" (**Planner's call** for that sub-line). Before the
  result is settled: "Processing results…". Shown from minute 80 until the slot after the trip ends, or until the player
  closes it with "×" (name "Dismiss"; closed per activity id on this device, `cloudiator.trip-closed.v1`, guarded like the
  other keys). Watch the whole trip opens the scene in replay mode at chapter 1.

**The live view** (the existing scene, with additions):

- Header, while the trip runs: a red "● LIVE · minute 30" badge (phone: "LIVE") and "⏪ Watch from the start" (phone: an
  icon button "⏪" named "Watch from the start").
- The minute labels under the 0-80 strip become named marks: "Left camp · 12:20 AM", "▶ Fight 1 · won" (a revealed fight
  with a kept replay is a button into the replay at that fight), "Fight 2 · 1:00 AM" (not yet), "Fight 3 · 1:20 AM", "Back in
  camp · 1:40 AM". Times follow item 7. **Planner's calls** for cases the mockup does not show: a lost fight "▶ Fight 2 ·
  lost"; a fight being fought "Fight 2 · now"; a revealed fight without a kept replay "Fight 1 · won" as text; fights after a
  revealed defeat "Fight 3 · not fought".
- A finished trip opened in live mode shows "▶ Watch the whole trip" in the header instead of the LIVE badge (**Planner's
  call**).

**The whole-trip replay:**

- The same view, driven by a replay clock instead of the server clock. A gold-brown badge "▶ REPLAY · THE WHOLE TRIP"
  (phone: "▶ REPLAY").
- **Chapters:** "Leaving camp", "On the trail", "Fight 1", "Fight 2", "Fight 3", "Heading home", "Back in camp", "Resting".
  After a defeat: "… Fight N ✗", then "Safe point" in place of the fights left, "Back in camp", "Resting". "Resting" is a
  chapter only when the gladiator's next activity really was a Rest: the public `recent_results` row of the next slot
  (`resolvedKind: 'rest'`), or, for the owner, its current activity. Otherwise the replay ends at the gate.
- **Pace (Avi: about 1¼ minutes; walking sped up, fights at real speed):** each 20-minute stretch of the trail plays in about
  8 s (×150), each fight at its real speed (its log, 4-8 s) with its 2 s result poses, the two camp bookends 5 s each and
  the rest 6 s. Within each stretch the gladiator is seen walking between spots (a walk plays at ×8), and only the searching
  and waiting around it is compressed (**Planner's call**: at ×150 alone the gladiator would jump between spots).
- **Controls:** ⏮ (Previous chapter), ▶/⏸ (Play / Pause), ⏭ (Next chapter), one button per chapter, and the elapsed and total
  time ("0:37 / 1:02"). The replay starts paused on its first chapter (or the chapter its entry named) with ▶ focused
  (**Claude's call**: autoplay could surprise screen-reader users). Playing runs on through the chapters and stops at the end.
  Phone: the bar shows ⏮ ▶ ⏭, then "3 / 8 · Fight 1" (chapter number, count and name) and the times, without chapter buttons.
- **Camp bookends:** "Leaving camp" and "Back in camp" are short vignettes on the camp's own map at the gate (tile 41, 22):
  the gladiator walks out through the gate, and back in. "Resting": the gladiator walks to a bed in the rest zone and lies
  down (the existing `sleep` action). Banners over the scene: "Leaving camp", "Back in camp", "Resting until 3:00 AM ·
  stamina refills to 104" (phone: "Resting · stamina to 104"); the stamina part is the owner's only, and only while that
  rest is its current activity; others see "Resting until 3:00 AM" (phone: "Resting").
- **Phase text** under the scene: "Leaving camp" / "Through the gate and onto the Woodland Path."; "Back in camp" / "Home
  through the gate with the loot." (after a defeat "Home through the gate, with all gear kept.", **Planner's call**);
  "Resting in camp" / "Sleeps through the next slot." plus, for the owner while that rest runs, "Stamina refills to full when
  it ends: +30." The trail and fight chapters keep today's phase text.
- **During a running trip** (from LIVE, "⏪ Watch from the start" or a fight mark): chapters after now are locked (disabled,
  title "Not yet: plays when it happens"), the time reads "0:13 / now", and "● Back to live" returns to the live view. ⏭
  past the last allowed chapter, or playing up to now, returns to live too. The server returns only revealed stages, so this
  cannot leak a future fight.
- **The Result card** in replay mode shows the result once the replay reaches "Back in camp" (**Planner's call**: the
  settlement comes after minute 80, so a replay clock would never reach it, and a replay should not spoil its end).
- **Entry points:** the "back" button (chapter 1), Results' Replay on expedition rows (chapter 1), the live view's fight marks
  (that fight) and "Watch from the start" (chapter 1), and in live mode the Gladiators list's "Watch expedition". Replays
  stay 7 days; after that the existing "no longer kept" card shows.
- **Identity:** the view names and draws the gladiator from the whole timeline (the first battle log's participant 0) and
  the world, never from the stages revealed by the replay clock alone.

### Item 4 — class bonuses and the suggested split

- **My gladiator,** between the class line and the current activity, a card: the eyebrow "GUARDIAN BONUSES", chips "Vitality
  +5%" "Endurance +5%", the line "From points and gear alike: more health and more stamina.", the eyebrow "SUGGESTED SPLIT ·
  OF EVERY 10 POINTS" and one bar per attribute, largest share first (ties in attribute order): Vitality 5, Strength 2,
  Endurance 2, Precision 1, Agility 0. Phone: the chips, then "SUGGESTED SPLIT · OF EVERY 10" and one line "Vitality 5 ·
  Strength 2 · Endurance 2 · Precision 1" (zeros left out), without the meaning line.
- **Each class:** Berserker "Strength +10%", "From points and gear alike: every hit lands harder."; Guardian "Vitality +5%",
  "Endurance +5%", "From points and gear alike: more health and more stamina."; Duelist "Agility +5%", "Precision +5%",
  "From points and gear alike: faster, and hits more often." (chips from `RULES_V1.classes`, splits from
  `CLASS_SUGGESTIONS`, **Claude's call** for the meaning lines).
- **Plan a build:** the same chips beside "Class: Guardian"; while points are left, a button "Suggested for Guardian" beside
  the counter. It spends exactly the points left by the class's shares (largest remainder; ties by larger share, then
  attribute order), never lowers a field, and says "+1 Strength, +1 Vitality, +1 Endurance: the Guardian split." with an
  "Undo" button that puts the fields back. The counter then reads "All 13 spent". Nothing is saved until Queue build, as today.

### Item 5 — phone: tap your name for the bar

- In the touch layout the chip keeps "Aster | ⏱ 25:26". Tapping it opens the existing account popover (about 318 px wide at
  390 px), holding in order: one row "⚡ 74 / 104", "💰 240", "★ 35", "⏱ 25:26" (the PC bar's items, icons and order); the line
  "Stamina 74 of 104 · a Rest refills it" over a stamina bar; "Clock" with "12-hour" | "24-hour"; "Sign out". Tap the name
  again, Escape or a press elsewhere closes it (today's popover rules).
- Desktop: the bar is unchanged; its account menu gains the Clock row above Sign out.

### Item 6 — a Rest says how much stamina it gives

- The rule is the server's: a Rest refills stamina to the maximum when its slot ends.
- **Schedule,** under a Rest's select: "Refills stamina to full: +30 (74 → 104). Costs nothing." At full: "Stamina will
  already be full (104): this rest adds nothing. Costs nothing."
- **The number is projected** for that part's next occurrence: from the owner's current stamina (the running part is already
  paid; a running Rest refills at its end), walk the parts after the running one in time order up to that Rest, using the
  draft day, subtracting each part's stamina cost (`activityCost` of the base cost and the current build's overload, as the
  server's boundary does); a part that cannot be afforded becomes a Rest and refills.
- **No number** ("Refills stamina to full. Costs nothing.") when a pending build takes effect at or before that Rest, or the
  current build's costs cannot be derived (**Claude's call**: no "about").
- **My gladiator** while a Rest runs (also "Resting (not enough stamina)"): "Stamina refills to 104 when it ends: +30"; at full
  "Stamina is already full (104): this rest adds nothing"; with a pending build taking effect at its end, "Stamina refills to
  full when it ends." (**Planner's call** for that last line). Past rests show no number.

### Item 7 — the 12-hour / 24-hour clock

- "Clock" with "12-hour" | "24-hour" (pressed buttons) in the chip's account menu on desktop and in the phone bar. It starts
  on the device's own choice (`Intl.DateTimeFormat().resolvedOptions().hourCycle`: h11/h12 → 12-hour, h23/h24 → 24-hour)
  and is remembered on this device (`cloudiator.clock.v1`, guarded). Visitors use the device's choice (or a stored one) and
  have no menu. A change moves every time on the screen at once, without a reload.
- **Every time of day:** Schedule, My gladiator, the build's effective time, the resting line, the Arena card's reveal,
  Inventory, the expedition log and marks, Results, Tournaments, season ends, and the fixed tournament hour ("6:40 PM UTC"
  in 12-hour, "18:40 UTC" in 24-hour).
- **Forms:** 12-hour "2:00 PM", "tomorrow 1:20 AM" (upper-case AM/PM in every locale); 24-hour "14:00", "tomorrow 01:20"
  (two-digit hours). Results "Sat 10 Oct, 3:00 AM" / "Sat 10 Oct, 03:00". Tournaments and season ends keep today's day,
  zone and UTC wording; only their time parts follow the setting ("Wed 28 Oct, 7:40 PM GMT+1 (Wed 28 Oct, 6:40 PM UTC)").
  **Planner's call:** the mockup's table writes the tournament example shorter ("Wed 28 Oct, 7:40 PM (6:40 PM UTC)"); the
  table illustrated the hour forms, so the rest of today's tournament wording is kept.
- Dates only (message dates, replay dates) and durations are unchanged.

### Item 8 — players count

- On top of the Gladiators list: "**50 players** · 43 in camp · 6 on expeditions · 1 resting at home" (phone: "6 away").
  With a filter: "**4 of 50 players** match “ar”". Zero matches keeps today's line ("No gladiator matches “…”.").
- From `world.actors` (every gladiator; NPCs are not actors), refreshed with each world read. "In camp" counts everyone
  neither away nor resting at home. **Claude's call:** the word "players" while the menu keeps its name "Gladiators", and
  everyone counts, those resting at home included. **Planner's call:** singulars "1 player", "1 on an expedition", "1 away";
  a zero part other than the total is left out.

## Decisions

| Decision | Who |
| --- | --- |
| Announce a newcomer during their first slot only (no database change) | Avi |
| The whole-trip replay runs about 1¼ minutes, walking sped up, fights at real speed | Avi |
| The clock setting is per device | Avi |
| No migration; Patch A = items 2-8 + Task 10 | Avi |
| Banner, not an inbox message; visitors see it; the newcomer's own welcome | Claude's call |
| The camp button is the only new camp element; LIVE badge; named marks; locked future chapters; Back to live | Claude's call |
| Pace ×150 / real-speed fights / 5 s bookends / 6 s rest; starts paused with ▶ focused | Claude's call |
| Resting chapter only when the next activity really was a Rest; stamina owner-only | Claude's call |
| Rest projection with no "about"; past rests show no number | Claude's call |
| Clock starts on the device's hour cycle; durations unchanged | Claude's call |
| "players" wording; everyone counts | Claude's call |
| Banner hidden under a scene; newest first; welcome before others; newcomer listed once | Planner's call |
| Away sub-line from minute 60 or after a defeat; defeat sub-line "No rewards · all gear kept"; close per activity | Planner's call |
| Mark wording for lost, in-progress, unreplayable and unfought fights; Watch the whole trip on a finished live view | Planner's call |
| Walks at ×8 inside the ×150 budget; Result card shown from "Back in camp"; defeat phase text | Planner's call |
| No-number line on My gladiator; tournament wording kept apart from its time parts | Planner's call |
| Count singulars and zero parts | Planner's call |

## Mockup details not turned into requirements

- The phone replay bar's sample chapter list merges the fights into "The fights"; the note beside it says the phone shows one
  chapter name at a time and the desktop tab shows every chapter, so the phone uses the same chapters.
- The mockup's chapter start times ("0:05", "0:13", … "1:16") and the defeat's "0:37 / 1:02" are illustrative; the pace rule
  above decides the real ones.
- The players count's split (43 / 6 / 1) is illustrative; the fixture world's real total is 50.
- The tournament example in the clock table (see item 7).
- The 12-hour default in the mockup comes from the capture device; the setting starts on each device's own choice.

## Constraints

- Next.js 16.4.3 static client; read the relevant guide in `node_modules/next/dist/docs/` before writing code (AGENTS.md).
- No migration, no Edge function change, no new command, no package download. The new reads are public projections that
  exist today (`recent_results`) and the owner's notifications read.
- localStorage only for these per-device conveniences, every access in try/catch, the page correct without it.
- One formatter module for every time of day; a test fails on any other `hourCycle`, `hour12` or hour-bearing
  `Intl.DateTimeFormat` in `src/`.
- React async state (AGENTS.md): only the latest read lands; a slower earlier read never replaces a newer one.
- Tests first (TDD); browser tests with the private config `node_modules/.cache/pw-claude.config.mjs`; the gate of record
  `node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs`, never a build during a browser run.
- Production is live (8 gladiators, 9 accounts, `release` at `d996d59`). Production writes need Avi's go in chat; deploy
  outside Wed/Sat 17:20-20:00 UTC with no open boundary.

## Release

Client only: the gate of record, a whole-branch review, then (Avi's go) the `release` fast-forward; `functions deploy` only
if the branch changed `supabase/functions` since the last release (Patch A should not). After the client is live, post the
patch note with `private.post_message` (runbook "Posting a game message"); Avi approves its wording at release.

**Patch note draft** (credits nobody: these were Avi's own ideas, no player asked; Avi may change any word). Kind
`patch-notes`, no action.

- Title: **Watch your expedition, class bonuses and a clock setting**
- Preview: "Watch your gladiator's trip live or replay it whole, see your class's bonuses, and pick a 12- or 24-hour clock."
- Body: the paragraph "What changed:" and the bullets
  - "Watch your expedition: while your gladiator is away, a button at the bottom of the camp opens the live view.
    Afterwards, replay the whole trip in about a minute and a quarter: leaving camp, the fights, coming home and resting."
  - "New arrivals: when a new gladiator arrives, everyone in the camp sees a banner, and the Gladiators list shows newcomers
    first."
  - "My gladiator shows your class's bonuses and its suggested split of points. When you plan a build, the Suggested button
    spends the points left your class's way."
  - "A Rest now says how much stamina it will give back."
  - "Clock: choose a 12-hour or 24-hour clock in the menu under your name. Every time in the game follows it on this
    device."
  - "On a phone, tap your name to see your stamina, gold, renown and the time to the next slot."
  - "The Gladiators list shows how many players there are and where they are now."

(56-character title, 111-character preview, 8 blocks, 860 characters.)

**Players' clip, after the release:** a short clip of the new features from the real game (HyperFrames), narrated in the
concept film's voice (local Kokoro `bm_george`), music low (about 0.1 under narration, per the HyperFrames sound override),
closing on the game and the update with no URL and no "Coming soon"; a 16:9 cut for the Indigo Labs channel and 9:16 cuts
for Instagram and WhatsApp stories; uploads and posts only on Avi's go.

## Left to the builder

Component structure and CSS beyond the sizes quoted; how the camp scene draws the vignettes (within one Phaser game);
test layout; the exact fade timing; copy for screen-reader-only text not quoted here.
