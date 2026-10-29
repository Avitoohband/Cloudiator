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
command**. (Added 2026-10-29: Avi's patch numbers ship in Patch A too, with one small migration, M26; see the last section,
"Patch numbers and the changelog". Still no Edge change and no new command. Also added 2026-10-29: a richer profile card,
whose public data joins M26; see "A richer profile card", after it.)

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
| No migration; Patch A = items 2-8 + Task 10 (superseded for patch numbers only, next row) | Avi |
| Patch numbers (1.x, numbered back to the launch) ship in Patch A as 1.4, with migration M26 | Avi |
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
  exist today (`recent_results`) and the owner's notifications read. Exception (Avi, 2026-10-29): one migration, M26, for
  the patch list ("Patch numbers and the changelog"); still no Edge change and no new command. M26 also carries the richer
  profile card's public data (the last section, "A richer profile card"), once Avi approves that card.
- localStorage only for these per-device conveniences, every access in try/catch, the page correct without it.
- One formatter module for every time of day; a test fails on any other `hourCycle`, `hour12` or hour-bearing
  `Intl.DateTimeFormat` in `src/`.
- React async state (AGENTS.md): only the latest read lands; a slower earlier read never replaces a newer one.
- Tests first (TDD); browser tests with the private config `node_modules/.cache/pw-claude.config.mjs`; the gate of record
  `node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs`, never a build during a browser run.
- Production is live (8 gladiators, 9 accounts, `release` at `d996d59`). Production writes need Avi's go in chat; deploy
  outside Wed/Sat 17:20-20:00 UTC with no open boundary.

## Release

The gate of record, a whole-branch review, then (Avi's go) M26 (`db push`), the `release` fast-forward; `functions deploy`
only if the branch changed `supabase/functions` since the last release (Patch A should not). After the client is live, post
the patch note with `private.post_message` (runbook "Posting a game message"), then record patch 1.4 with
`private.record_patch` ("Patch numbers and the changelog", Release); Avi approves the wording of both at release.

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

## Patch numbers and the changelog (Avi, 2026-10-29)

Avi, after the game-messages release: "please also add patch numbers. it should be written somewhere at the server", "it
should be noted each feature you add and in which patch", "so the marketing agent will know which changes has been made
since last video, and he won't miss out anything".

**Avi chose** (a) 1.x numbers, applied back to the earlier releases (table below), Patch A = 1.4, Arena replays 1.5, Party
dungeons 1.6; (b) it ships **in Patch A**, so Patch A gains one small migration, **M26**, and Party dungeons' migration
becomes M27. **Avi approved the concept:** the server keeps the list of patches (number, name, date) and each patch's
features; players see the current patch in the account menu and on each patch note; an open game whose build is behind the
server's newest patch says "A new patch is out — reload".

Everything else in this section is **Claude's call** (design pass, 2026-10-29), shown in the clickable mockup
`.superpowers/design/2026-10-29-patch-numbers/mockups.html` (over real screenshots of the fixture preview at `28ed3ae`;
git-ignored). **Avi has not looked at that mockup yet.** By his rule, the UI copy and placement below are a draft until he
approves it in chat, and Task 11b's UI steps wait for that approval.

### The numbers

| Patch | Title (players see it) | Released (UTC) | What shipped | Patch note |
| --- | --- | --- | --- | --- |
| 1.0 | Public launch | 2026-10-25 09:20 (the first slot, epoch 373525) | `1b4fdbf`, M01–M22 | none |
| 1.1 | Evening Arena, waiting monsters, clearer menus | 2026-10-26 09:29 (deploy record `6d6290a`) | M23 with `1724a79`, then the waiting monsters `84f2d44` | id 1 |
| 1.2 | Choose your gladiator's look | 2026-10-27 10:07 (deploy record `35bbf56`) | M24 with `86af8c8` (Codex's polish included) | id 2 |
| 1.2.1 | Clearer busy buttons | 2026-10-27 15:30 (new CSS served) | `1b57ba5` | none |
| 1.3 | Messages, gold, fixed builds and bigger beds | 2026-10-29 08:44 (new client live) | M25 with `d996d59` | id 3 |
| 1.3.1 | Phone attribute points | 2026-10-29 about 17:40 (points-hotfix ledger) | `b1e9bb7` | id 4, "Attribute points: easier on a phone" |
| 1.4 | Patch A (title from its patch note) | at its release | M26 with Patch A | posted at its release |

- **The waiting monsters belong to 1.1** (Claude's call). Avi's list does not name that release. It went out the same
  morning as the launch feedback, and note 1 announced both. The keyboard-focus release is 1.2.1, as Avi listed it.
- **The times** come from the release records where they name one (1.2.1, 1.3), from the deploy record commit otherwise
  (1.1, 1.2), from the first slot for 1.0, and from the hotfix ledger's "about 17:40 UTC" for 1.3.1 (Claude's call). Players
  see the date only.
- **Numbering from now on** (Claude's call, from Avi's examples): a release with new features takes the next second number
  (1.5); a fix-only release from `release` takes the next third number (1.4.1). Every release gets a row, a fix too, with or
  without a patch note.
- **The titles** follow the patch notes where one exists (Claude's call). Two are shortened: 1.2 drops "New:", and 1.3.1
  uses Avi's own words, "Phone attribute points".

### `docs/CHANGELOG.md`

The repository's list of every patch and its features, newest first, for the marketing and video agents. A "Videos" table
says which patch each made video covered (`appearance-and-ui-update` 1.1 and 1.2, `messages-look-and-beds-update` 1.3), and
the top line says "Everything above the last video's patch is new since that video". The released sections are the
server's rows word for word: a test compares the M26 seed with them. The patch in progress has its own section with
"Built" and "Planned" lists. **Every task that builds a player-visible feature adds its line there in the same commit.**
The release finalizes the section and records it on the server. Bullets are plain text, one line, at most 240 characters,
with no Markdown: players read them as they are.

### Server: M26 from `supabase/sql/19-patches.sql`

- **`public.patches`**:
  - `number text primary key`, matching `^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})(\.[1-9][0-9]{0,2})?$` ("1.0" and
    "1.2.1", never "1.3.0");
  - `sort_key integer generated always as (major × 1,000,000 + minor × 1,000 + third) stored`, unique (1.2.1 is 1,002,001);
  - `title text`, 1–80 characters, not blank;
  - `released_at_ms bigint` ≥ 0;
  - `message_id bigint`: the patch note's id, null or unique. A fix may have no note. There is no foreign key (Claude's
    call): the database tests' reset truncates `game_messages` on its own, which a foreign key would refuse, and a message
    is never deleted, only hidden. `record_patch` checks the id instead.
- **`public.patch_features`**: `patch text` referencing `public.patches(number)`, `position smallint` 1–20, and `text text`,
  1–240 characters, not blank. The primary key is `(patch, position)`.
- **Access** (the access matrix's `OPEN` list, as `game_messages`): RLS on both tables; SELECT for `anon`, `authenticated`
  and `service_role`; the policy `player_read using (true)` for `anon` and `authenticated`. Nobody writes through the Data
  API. Patch numbers are public on purpose: they say nothing about any player.
- **The newest patch rides the revision poll** (Claude's call). `public.world_revision` (15-release.sql's view) is restated
  with one more column, `latest_patch`: the number of the patch with the highest `sort_key`, null with no row. Every client
  already reads that view every 30 s, on focus and on return to the tab. So the newest patch costs **no new request, no Edge
  change and no new command**. An older client asks for its named columns only, so the new column changes nothing for it. No
  `projection_changed` trigger is needed: the number comes with every revision read, whatever the revision.
- **Writes are the operator's only**, as with `private.post_message`. `private.record_patch(number text, title text,
  features text[], message_id bigint default null) returns text` inserts the patch and its features (positions 1…n) in one
  statement, stamped with the database time (`clock_timestamp()`, never back-dated). It refuses with SQLSTATE 23514:
  - an empty list, or one longer than 20;
  - a number not above every recorded one;
  - a message that is not a visible `patch-notes` message.

  A repeated number is 23505. No client role may execute it, and neither may `service_role`. A correction is a plain owner
  `update` after Avi's go.
- **The seed:** M26 inserts 1.0 to 1.3.1 with their features from CHANGELOG.md and the times above. It finds `message_id` by
  the posted note's kind and exact title (`patch-notes`, the four titles above). Production then links notes 1–4, and a
  local database (no notes) stores null.

### Client

- **`PATCH`** (`src/lib/patch.ts`, `export const PATCH = '1.4'`): the patch this build is.
  - The first commit of a patch's work sets it and opens the patch's CHANGELOG section. A unit test fails unless `PATCH`
    equals the number of CHANGELOG.md's top section. A fix release from `release` sets the next third number in its first
    commit the same way.
  - Beside it: `patchSortKey` (the generated column's arithmetic) and `isBehind(latest, build = PATCH)`.
- **Reads:**
  - The revision read asks for `latest_patch` too, through a client-side type, `RevisionRead`. The shared contracts under
    `supabase/functions/_shared` are not changed, so `game-command` needs no deploy.
  - The sync keeps `latestPatch` from every refresh. A missing or malformed value is null, which shows no notice.
  - `readPatches` reads 20 patches at a time, newest first, with their features.
  - After the messages read, one small read finds the patch numbers of the notes it holds
    (`patches?select=number,message_id&message_id=in.(…)`). When it fails, the notes show without numbers.
- **The account menu** (desktop and phone): a row "Patch **1.4**" with a button "Patch history ›", after the Clock row and
  before Sign out. When the server is ahead, "Patch 1.5 is out" and a gold "Reload" show under it. An account without a
  gladiator has no messages panel, so its row has no button. Visitors have no account menu.
- **Each patch note** shows "Patch 1.3" after its tag, in the list and in the opened note. The number is a button that opens
  Patch history at that patch. Admin messages and notes without a patch row show no number.
- **Patch history** opens inside the messages panel, from the account menu's button and from a note's number. It is not a
  new menu or a third tab: a 360 px panel has no room for one. It has "‹ Back to messages" and ×, then:
  - the heading "Patch history" and the line "You are playing Patch 1.4" (when behind, "· Patch 1.5 is out" and Reload);
  - the patches, newest first. Each is a disclosure button with the number, title and date ("1.3 · Messages, gold, fixed
    builds and bigger beds · 29 Oct"). The newest (or the one a note named) is open and the others are closed. An open
    patch lists its features and, when it has a visible note, "Read the patch note ›";
  - "Older patches", which reads the next 20.
- **"A new patch is out — reload"** shows when `isBehind(latestPatch)`. It is a status in the notice column under the chip
  (below the arrival banner where that stacks there), drawn like the sign-in notice.
  - Desktop: "**A new patch is out** — reload to play Patch 1.5." with a gold "Reload" and × (name "Later"). Phone:
    "**Patch 1.5 is out**" with "Reload" and ×.
  - It **never interrupts a fight or a dialog**. It is not shown while a scene is open (expedition, replay, Arena bout) or a
    modal dialog (creation, change look), and not on the `/expedition/` and `/replay/` pages. It waits and shows when they
    close. It never takes the focus, has no timer and never reloads by itself. Visitors see it too.
  - × hides it for this page's life, for that number; a newer number shows it again. Nothing is stored on the device: a
    reload fixes the cause. Reload reloads the current address.
- **Fixture:** the fixture gateway answers `latestPatch` = `PATCH`, and its history is the seed plus 1.4. Browser tests set
  a newer number through the live-routed fake.

### Release

- **Order** (Task 12):
  1. M26 (`db push`; the dry run lists exactly M26).
  2. The Edge functions, only if `supabase/functions` changed (Patch A: no).
  3. The client (`release` fast-forward).
  4. Once the new client is live, each after Avi's go: the patch note (`private.post_message`, which answers its id), then
     the patch row (`private.record_patch('1.4', <title>, <features>, <note id>)`).
- **Why this order:**
  - The 1.4 client's revision read names M26's column, so a 1.4 client on a database without M26 could not read the
    camp at all. M26 goes first, as in every migration release.
  - Recording 1.4 only after its client is live means a reload always brings 1.4: no notice that a reload cannot clear.
  - Tabs still open on 1.3.1 show no notice (their code predates it). From 1.4 on, every open tab learns of the next patch
    within one poll.
- **The row's text is CHANGELOG.md's section, word for word.** `node scripts/patch-statement.mjs 1.4 --message <id>` writes
  the one statement (UTF-8 without a byte-order mark), and Avi approves it with the patch note. The runbook's new
  "Recording a patch" section has the steps and the read-back (`latest_patch` is 1.4 on the public revision read).
- **Every future plan's release task** records its patch the same way, a fix release too.

### Decisions

| Decision | Who |
| --- | --- |
| 1.x numbers back to the launch; Patch A = 1.4, Arena replays 1.5, Party dungeons 1.6 | Avi |
| Ships in Patch A with M26; Party dungeons' migration becomes M27 | Avi |
| Server list of patches and features; the patch in the account menu and on each note; the reload notice | Avi |
| Waiting monsters in 1.1; seed times from the release records; titles from the notes | Claude's call |
| Next second number for features, next third for fixes; every release gets a row | Claude's call |
| `latest_patch` on the existing revision view; no trigger, no Edge change, no new command | Claude's call |
| `record_patch` refuses a number not above every recorded one | Claude's call |
| No foreign key from a patch to its note (`record_patch` checks it); note numbers by one small read after the messages read | Claude's call |
| Patch history inside the messages panel, opened from the menu and a note's number | Claude's call |
| The notice in the notice column; hidden under scenes and dialogs; × for the page's life only; visitors see it | Claude's call |
| `PATCH` pinned to CHANGELOG.md's top section; the statement built from CHANGELOG.md | Claude's call |

## A richer profile card (Avi, 2026-10-29)

Avi, added to this patch: "add easier way to see other players details. in the Gladiators menu, when clicking on the
gladiator name, a small window pop with the gladiator appearance, stats gear, attributes, class and data".

The name already opens a small card (Task 13.7: name, class line, prestige, Now, Rating, a line of gear silhouettes, Follow
and Watch bout). **This section keeps that card, its entry points and its behaviour, and fills it in sections.** Everything
below is **Claude's call** (design pass, 2026-10-29) unless marked **Avi**. It is shown in the clickable mockup
`.superpowers/design/2026-10-29-profile-card/mockups.html`, drawn over real screenshots of the fixture preview at `8f50177`;
its portraits are drawn by the game's look code and its stats are computed by `deriveStats` and `makeFighter` (git-ignored).
**Avi has not looked at that mockup yet.** By his rule, the copy, the layout and the data made public below are a draft
until he approves it in chat; Task 11c waits for that approval.

### What the card shows

In this order (the copy is word for word; `{…}` is a value):

1. **The head.**
   - The **look**: a portrait of the gladiator as the camp draws it, gear included (`lookFor(actor.appearance,
     actor.gladiatorId, actor.equipmentSilhouettes)`, so the legacy look too). It is drawn as the creation preview draws its
     look: a DOM sprite of the gladiator atlas, the idle loop facing south-east (a still frame under reduced motion), on the
     preview's green ground, at scale 2. It is 104 × 124 px on a desktop and 80 × 104 in the touch layout. It is decorative
     (`aria-hidden`): the name and class line say who it is.
   - Beside it, as today: "YOUR GLADIATOR" on the viewer's own card, the name, the latest champion title and the class line
     ("Guardian · Level 6 · Silver league"). Then the **class's bonus chips** (Task 5's `ClassChips`: "Vitality +5%"
     "Endurance +5%") and the season badges.
2. **"ATTRIBUTES · {n} POINTS"**: Strength, Agility, Vitality, Endurance and Precision, in that order. Each has a bar scaled to
   the largest (at least 1) and its points in the **current build** (the number Plan a build shows); `n` is their sum. An
   attribute the class raises shows its bonus after its name ("Vitality +5%", from `classBonuses`). Each attribute also
   starts at 5, and the class bonus multiplies the total; the stats include both.
3. **"STATS · {STANCE} STANCE"** ("STATS · DEFENSIVE STANCE"): five rows computed in the browser from the published build with
   the shared rules (`deriveStats`, `makeFighter(snapshot, 'expedition', RULES_V1)` and `criticalProbability`), so they are what
   a fight uses:
   - "Health" "{maxHealth}" ("197").
   - "Damage" "{n} a hit" ("15 a hit"): a hit that is not critical, on a target with no armor and a balanced stance. It is
     base damage × efficiency × the stance's outgoing factor, rounded half up.
   - "Speed" "every {s} s" ("every 1.13 s"): the attack interval in seconds, rounded half up to hundredths, with trailing
     zeros dropped (1296 ms is "every 1.3 s", 935 ms "every 0.94 s").
   - "Armor" "{armor} · blocks {p}%" ("12.3 · blocks 25%"): the armor to one decimal (a trailing ".0" dropped) and the share of
     a hit it blocks (2% a point, at most 70%), rounded. No armor says "None".
   - "Critical" "{p}% of hits" ("7% of hits").

   When the gear outweighs the load capacity, one line follows: "Overloaded: load {load} of {capacity}, fighting at {e}%"
   ("Overloaded: load 29 of 20.5, fighting at 79%"). The numbers are an expedition's: the Arena's +10% on renown gear is not
   added. **No stamina**: stamina stays the owner's own (an existing rule, pinned by the card tests' private-words check).
4. **"GEAR"**: "Weapon", "Off-hand", "Head", "Body" and "Feet" (the Inventory's `SLOT_LABELS`).
   - Each worn item shows its name and " · Level {tier} · {rarity}", as the Inventory says it ("Spear · Level 5 ·
     uncommon"). The name is in its rarity's colour (common #d6d1c3, uncommon #93d68b, rare #86b6ff); the word says it too.
   - An empty slot says "Empty". The off-hand under a two-handed weapon says "Two-handed weapon". With nothing worn, the
     section is one line: "Nothing worn yet.". An item the catalog does not know is named "Unknown item".
5. **"RECORD"** (the "data"):
   - "Now", as today (the owner's own resting line on its own card).
   - "Rating", as today ("Loading…", "Not available").
   - "Arena record" "{wins}–{losses} · all seasons" ("9–5 · all seasons"; "No bouts yet" at 0–0): the bouts against players
     over every season and league, counted as the standings count them.
   - "This season" "{wins}–{losses}", only when a standings row opened the card: that row's record. Today's card shows it as
     "Rating · record"; that combined row goes.
   - "In camp since" "{date} · {days}" ("2 Oct · 8 days"; "today", "1 day"): the day the gladiator was made, in the viewer's
     time zone, with `src/lib/time-format.ts`'s fixed month names (a new date-only `dateText`; no time of day). The year is
     added when it is not the current one ("2 Oct 2025 · 392 days").
6. On the viewer's own card, under Record: "Other players see this card too."
7. The actions, unchanged: My gladiator and Schedule (own card), Follow and Watch bout.

**States.**
- The card opens at once from the camp's world actor: the head, the chips, Now, and under GEAR today's "Equipped" line
  (`gearText`). ATTRIBUTES and STATS say "Loading…", and Rating "Loading…", until the one profile read arrives.
- If that read fails, ATTRIBUTES, STATS and Rating say "Not available", and GEAR keeps the "Equipped" line. A profile without
  a usable build (null or malformed) does the same for ATTRIBUTES and STATS.
- A gladiator outside the world (a standings row) shows its name and record until the profile arrives, as today.

### Where it opens, and how it sits

- **Every existing entry, unchanged:** a name in the Gladiators list (`RosterPanel`, "Profile: {name}"), a click on a
  gladiator in the camp, and a name in the Arena standings. Visitors see the same card. Escape, ×, a click on the camp and a
  scene opening close it, and the focus rules are today's.
- **Desktop:** 520 px wide. The head runs across the top, then two columns (ATTRIBUTES beside STATS, GEAR beside RECORD), and
  the actions sit at the foot. It is about 540 px tall with everything (541 px for the mockup's Xanthe). `placeCard` places it
  as today: beside the click, or beside the menus at (458, 64) from a list row. In a short window it scrolls (`max-height:
  calc(100% - 76px)`).
- **Touch layout** (`@media (hover: none), (max-width: 480px)`): today's sheet (10 px from each side, 76 px above the bottom,
  at most the view less 140 px), one column in the same order, with STATS as two-column tiles. The sheet's body scrolls and the
  action row stays pinned at its foot, with 44 px targets; no sideways scroll at 360 × 740.
- **The card is nearly opaque** (background alpha 0.96 instead of 0.86): today a phone shows the list through the sheet.

### What becomes public (Avi's request)

Avi asked to see other players' details. So **a gladiator's current build and the gear it wears become public: in this game
they are not private secrets** (anyone watching a bout already sees the gear). Newly public, through the profile read only:

- the **current** build's stance and five attribute points;
- each equipped item's catalog id and version, level (tier), rarity and stats (the fields a market listing already shows);
- the Arena record summed over every season and league (each league-season row is already public, in the standings);
- the time the gladiator was made (today public only while it is new, as its arrival's start time).

**Still private:** a queued (pending) build until it takes effect at its boundary; unspent and earned points; XP; stamina;
gold; renown; the inventory and its other items; the schedule; and every item's id, owner, origin, binding and reservation.
The stats add nothing new: the browser computes them from the build.

### Server: in M26, from `supabase/sql/20-profile-card.sql`

- **`public.public_profiles`** gains two nullable columns with no default and no CHECK (like its other projection columns):
  `build jsonb` and `joined_at_ms bigint`. A nullable column without a default does not rewrite the table.
- **`private.project_character`** (17-appearance.sql's projector) is restated unchanged except its `public_profiles` upsert.
  That upsert also writes the two columns, in its insert, its update and its is-distinct check:
  - `build`: `{"stance": …, "allocations": {…}, "equipment": {"weapon": …, "offHand": …, "head": …, "body": …, "feet": …}}`
    from `builds.current_build`. Each slot is the equipped item's `{"catalogId", "catalogVersion", "tier", "rarity",
    "stats"}`, picked from that gladiator's `item_instances.item` with the slot's id, or null. Never the raw item JSON (it
    holds `ownerId`, `id`, `origin`, `binding` and `reservation`), and never `pending_build`.
  - `joined_at_ms`: `gladiators.created_at_ms`.

  Its triggers are today's: a build taking effect, or a change to the gladiator's items, re-projects it, and an unchanged
  profile is not written (the is-distinct check).
- **`public.public_profile_reads`** is restated with `create or replace` (same columns, `security_invoker=true` kept, grants
  restated). Its `profile` object adds:
  - `build` (`p.build`) and `joinedAtMs` (`p.joined_at_ms`);
  - `arenaRecord`, `{"wins", "losses"}` summed from `public.arena_standings` for that gladiator (0 and 0 without rows). The
    invoker reads `arena_standings`, which anon and authenticated already read.
- **Backfill:** `select public.refresh_projections();` in the migration, so every profile carries its build at once.
- **Access:** no new relation, column grant, function grant or policy. `public_profiles`' table-level SELECT covers the new
  columns, so the access matrix's lines and the `OPEN` list are unchanged. The anonymous probes gain nothing (nothing new can
  be written). The projection tests' forbidden keys (`ownerId`, `inventory`, `pendingBuild`, …) must stay absent from the
  profile, and a visitor's profile must equal a signed-in player's (both pinned in Task 11c).
- **Not in the world read** (Claude's call): every client polls the world every 30 s for every gladiator. The card's data is
  read only when a card opens, with the same one profile request as today.
- **Item stats are published, not looked up** (Claude's call): an item keeps the stats it was made with. Publishing them lets
  the browser run `deriveStats` on exactly the server's inputs, as the owner's build planner does with its own inventory.
- **Why it joins M26, and why that is safe:** one migration per patch. M26 already ships before the client (Release), and the
  1.4 client is the first to read the new keys; an older client ignores them inside the `profile` JSON. There are two costs:
  - M26 restates `private.project_character`. The M24 lesson applies: the replayed body must equal the source's, which the
    schema fingerprint checks.
  - Task 11b's M26 generation waits for this source. **If Avi has not approved the card when M26 is generated, M26 is
    `19-patches.sql` alone**, and the card waits for the next patch's migration.
- **Locks and cost:** adding the columns and replacing the view take brief ACCESS EXCLUSIVE locks; profile reads wait for the
  commit. One profile row grows by about 0.6 KB and one profile read by about 1 KB; no budget changes.

### Client

- **Reads** (`src/lib/api/reads.ts`; the shared contracts under `supabase/functions/_shared` stay unchanged, as with Task 11b's
  `RevisionRead`): `ProfileRead = PublicProfile & { build: PublicBuild | null; joinedAtMs: number | null; arenaRecord:
  ArenaRecord | null }`. `readProfile` checks each new key and maps a malformed one to null (a malformed slot makes the whole
  build null). `GameGateway.profile` answers a `ProfileRead`.
- **Fixture:** the fixture gateway's profiles get sample builds. The owner's is its current build; the Arena gladiators' match
  their silhouettes.
- **The look:** the creation preview's sprite code serves both. `previewLayers` is built on a new `actorLayers(appearance,
  gladiatorId, silhouettes)`, `layerStyle` takes a scale, and a new `ActorPortrait` shares `LookPreview`'s atlas load.
- **Patch note:** at release, one more bullet for Avi's wording: "Click a gladiator's name to see their look, class bonuses,
  attributes, stats, gear and Arena record." It is not yet in the "Patch note draft" above.

### Decisions

| Decision | Who |
| --- | --- |
| Other players' look, stats, gear, attributes, class and data, in a small window from a name in the Gladiators list | Avi |
| The current build and its equipped items become public: they are not secrets in this game | Avi (his request; confirm with the mockup) |
| Keep today's card and every entry point; fill it in sections; 520 px in two columns; the phone sheet scrolls with its actions pinned | Claude's call |
| The portrait drawn with the camp's gear, by the creation preview's sprite code, at scale 2 | Claude's call |
| Attributes as the build's points with the class bonus marked; five stats, an expedition's, never stamina | Claude's call |
| Gear in the Inventory's words; rarity colours; "Nothing worn yet." | Claude's call |
| The Arena record over every season and league, against players; "This season" only from a standings row | Claude's call |
| "In camp since" from the creation time, date only | Claude's call |
| The current build only, never a queued one; the own card says others see it | Claude's call (a question to Avi in the mockup) |
| The data in `public_profiles` and the profile read, joining M26; stats computed in the browser; item stats published | Claude's call |
| The card nearly opaque (0.96) | Claude's call |
