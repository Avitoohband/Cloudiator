# Cloudiator features: what to film

Every player-visible feature, from the launch (1.0) to the planned 1.8, for whoever makes a reel or a video. The exact
words players see are in [CHANGELOG.md](CHANGELOG.md). This file says what each feature gives a player, where to find it on
screen, and which video already showed it. Updated 2026-11-01: patch 1.5 is live.

## New since the last video

The last video, `messages-look-and-beds-update` (2026-10-29), covered patch 1.3. Since then:

**Out now**

- 1.3.1 · Each attribute has +1 and +5 buttons at creation and in a build, on their own line on a phone.
- 1.3.1 · Tap a points number and type a new one; too many is corrected when you leave the box, and the game says why.
- 1.3.1 · A build has no minus: points that took effect stay, and a gray Respec button says a paid respec comes later.

---

**Out now: 1.4 (released 2026-10-31)**

Live in production:

- 1.4 · New arrivals: everyone sees a banner when a gladiator arrives, Find goes to the gate, newcomers get a NEW tag.
- 1.4 · My gladiator shows your class's bonuses and suggested split; in a build, "Suggested" spends points your class's way.
- 1.4 · A Rest says how much stamina it will give back.
- 1.4 · Clock: choose a 12-hour or 24-hour clock; every time in the game follows it.
- 1.4 · On a phone, tap your name to see stamina, gold, renown and the time to the next slot.
- 1.4 · The Gladiators list shows how many players there are and where they are.
- 1.4 · On an expedition, the gladiator searches slowly around each spot and looks around, instead of squatting.
- 1.4 · The live expedition view shows LIVE, the minute and named marks; "Watch from the start" replays what you missed.
- 1.4 · Replay a whole trip in about a minute and a quarter: out through the camp gate, the fights, home, and to bed when
  a Rest follows.
- 1.4 · A replay names and draws your gladiator from its first moment, not only from its first fight.
- 1.4 · Watch your expedition: a button on the camp while your gladiator is away, and the whole trip when it is back.
- 1.4 · Patch numbers: the patch you play in the menu, a number on each patch note, and Patch history.
- 1.4 · When a new patch is out, an open game says so, and Reload brings it in.
- 1.4 · A bigger profile card: click a gladiator's name for its look, class bonuses, attributes, stats, gear and Arena
  record.

Avi folded the 1.3.1 clip into the 1.4 clip: one "what's new" video covers both. The clip/posts reminder was sent after release; no new video was requested or produced.

**Out now: 1.5 (released 2026-11-01)**

My bouts, the shared replay bar/result card, Next bout, named Back, Notifications/Arena/camp Watch links and full-screen tournament chapters are live. The exact feature wording is in CHANGELOG 1.5 and the server record. The clip/feature-post reminder was sent; no video was made or published for this release.

## How to use this file

- For a "what's new" video, show the list above.
- For a general trailer, pick from the areas below (start with "Best moments to film").
- After making a video, add its row to the "Videos" table in CHANGELOG.md, and fill in "Shown in video" here.

## Filming kit

- **Fixture camp:** start the local dev server with `NEXT_PUBLIC_FIXTURE_ENABLED=true npm run dev` and open
  `/game/?mode=fixture`. It is sample data: nothing saves, and the camp opens in a morning. Add `&as=visitor` for what a
  visitor sees, or `&as=resting` for your gladiator resting at home. The live site has no fixture camp. In it, Results
  lists "Sample replays" and "Sample expeditions", the Arena menu its sample bouts, and Tournaments its sample brackets.
- **Replay page:** `/replay/?mode=fixture&activity=<id>`.
- **Expedition page:** `/expedition/?mode=fixture&activity=<id>`; add `&minute=<0-90>` to open at that minute of the
  trip, or `&play=trip` for the whole-trip replay (1.4).
- **Test player:** screens that save (creating a gladiator, the Schedule, Wear, a build, changing a look) need a signed-in
  player. The last videos used a temporary capture spec with test data:
  `D:\Avi\Projects\Animation\Cloudiator\messages-look-and-beds-update\capture\scripts\zz-patch-capture.spec.ts`
  (never commit it).
- **Live game:** `https://cloudiator-arena.pages.dev`, with real players. The evening part of each game day (torches
  lit) starts at 02:40, 06:40, 10:40, 14:40, 18:40 and 22:40 UTC and lasts 80 minutes.
- **Phone:** a window 390 × 844, or 360 px wide.
- Don't film while something else builds or runs browser tests in the same worktree: they share the dev output.

| Sample | Id | Open on |
| --- | --- | --- |
| `<Aster vs Varro>`: an Arena bout | `a1d0c2e4-5f60-4b7a-9c3d-1e2f3a4b5c61` | Replay page |
| `<Tie-break bout>`: Aster vs Cassia | `d4a3f5b7-8c93-4eab-8f60-4b5c6d7e8f94` | Replay page |
| `<NPC bout>`: Aster vs the Iron Warden | `b2e1d3f5-6a71-4c8b-8d4e-2f3a4b5c6d72` | Replay page |
| `<Expired bout>`: replay no longer kept | `e5b4a6c8-9da4-4fbc-9071-5c6d7e8f9aa5` | Replay page |
| `<Woodland fights>`: three creature fights | `c3f2e4a6-7b82-4d9c-9e5f-3a4b5c6d7e83` | Replay page |
| `<Woodland trip>`: three wins, then a Rest | `f6c5b7d9-0eb5-4a1d-8e2f-6d7e8f9a0b16` | Expedition page |
| `<Outpost defeat>`: lost the second fight | `a7d6c8ea-1fc6-4b2e-9f30-7e8f9a0b1c27` | Expedition page (opens at minute 65) |
| `<Mountain defeat>`: lost the third fight | `b8e7d9fb-2ad7-4c3f-8a41-8f9a0b1c2d38` | Expedition page |
| `<Last stand>`: the last fight won at 0 HP | `2f3e4d5c-7b6a-4f8e-8d9c-1b2a3f4e5d6c` | Expedition page |
| `<Varro's trip>`: someone else's expedition | `ebab0cce-5d0a-4f62-9d74-bc2d3e4f5a6b` | Expedition page |

## Features by area

**Status:** Live (in the game now) · In 1.7.1 (built, not out yet) · Planned 1.8 (designed, not built: don't film
them, don't promise them on an end card, and expect details to change). Avi's videos end with no "Coming soon" line.

**Shown in video:** Concept trailer = `concept-video` (2026-10-23) · Looks update = `appearance-and-ui-update`
(2026-10-28) · Too Tiny = `camp-life-too-tiny` (2026-10-29) · Messages update = `messages-look-and-beds-update`
(2026-10-29) · 1.6 update = `patch-1-6-economy` (2026-11-05, https://youtu.be/WrzLvSFmEpQ). Folders are under `D:\Avi\Projects\Animation\Cloudiator\`. "—" means no video has shown it yet.

### Camp

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| A shared, living camp | Every player's gladiator lives out its day in one camp: training, eating, resting, going out through the gate. | 1.0 | Live | Fixture camp, or the live game | Concept trailer; Too Tiny |
| Move the camera | Drag to look around; scroll, pinch or the zoom buttons to zoom. | 1.0 | Live | Fixture camp; zoom buttons at the bottom of the left rail | — |
| Day and night | Morning, afternoon and evening each have their own light, and torches burn in the evening. | 1.0 | Live | Live game in an evening part (see Filming kit) | Too Tiny |
| Resting at home | A gladiator whose player is away rests at home, and says when it will be back. | 1.0 | Live | Fixture camp → Gladiators → Otho; `&as=resting` for your own | — |
| Bigger beds | The camp's beds fit a whole gladiator. Punchy asked for them. | 1.3 | Live | Live camp while gladiators Rest (the Messages update used the fixture camp with test gladiators sent to rest) | Messages update; Too Tiny |
| More guards | Five guards in all: two at the gate, a lookout at the watchtower and two patrols walking along the inside of the walls. | 1.5.1 | Live | Fixture camp: zoom in at the gate (east side) and follow a wall; names show from zoom 2 | — |
| Night watch | In the evening the two wall patrols carry torches, and the light goes with them along the walls. | 1.5.1 | Live | An evening part (torches lit; see Filming kit); the fixture camp opens in a morning | — |
| New camp NPCs | Petra the water carrier, Felix the herald, Quintus the porter (a crate on his shoulder) and Silva the forester (an axe) walk their rounds through the camp. | 1.5.1 | Live | Fixture camp, zoomed in: the well and training yard, the Arena gate, the stalls, the wooded corners | — |

### Your gladiator: creation, looks, class, attributes and build

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| Sign in and create | Sign in with Google and create one gladiator: a name and a class (Berserker, Guardian or Duelist). | 1.0 | Live | A new account's first screen (test player) | Looks update (the creation dialog) |
| Attributes and stance | Spend points on Strength, Agility, Vitality, Endurance and Precision, and pick a fighting stance. | 1.0 | Live | My gladiator → Plan a build | Concept trailer |
| Gear in five slots | Weapon, off-hand, head, body and feet, each shown on your gladiator. | 1.0 | Live | Inventory and shops → "Wearing now" | Looks update |
| Clear creation points | Creation shows the points left, each attribute's cap and effect, a Reset and a suggestion for your class. | 1.1 | Live | Creation dialog, points step (test player) | Looks update |
| Wear your gear | My gladiator shows what you wear, and Wear in the inventory swaps it; a shield comes back when a one-handed weapon replaces a two-handed one. | 1.1 | Live | Inventory and shops → Wear (test player) | Looks update |
| Choose a look | Pick a male or female body; short, long, ponytail or bald hair; skin, hair and clothes colours; or a Random look, with a live preview. | 1.2 | Live | Creation dialog, look step (test player) | Looks update |
| Your look everywhere | Every gladiator is drawn in its own look in the camp, on expeditions and in replays. | 1.2 | Live | The camp crowd; any replay | Looks update |
| Free look change | Change your gladiator's look from the look patch note, free and as often as you like for now. | 1.3 | Live | Messages → the look note → Change look (test player to save) | Messages update (named as coming in Looks update) |
| Points after a level-up | The build shows how many points are left; saved points and your class are fixed, and your stance can still change. | 1.3 | Live | My gladiator → Plan a build after a level-up (test player) | Messages update (named as coming in Looks update) |
| +1 and +5 buttons | Each attribute has +1 and +5 buttons at creation and in a build, on their own line on a phone. | 1.3.1 | Live | Plan a build at phone width (test player) | — |
| Type your points | Tap a points number and type; too many is corrected when you leave the box, and the game says why. | 1.3.1 | Live | Plan a build, type a number above what is left (test player) | — |
| Points that stay | A build has no minus: points that took effect are permanent, and a gray Respec button says a paid respec comes later. | 1.3.1 | Live | Plan a build (test player) | — |
| Class bonuses | My gladiator shows your class's bonuses and its suggested split of every 10 points. | 1.4 | Live | Fixture camp → My gladiator (Aster is a Guardian) | — |
| Suggested build | "Suggested for Guardian" (or your class) spends the points left your class's way, with Undo. | 1.4 | Live | My gladiator → Plan a build with points left (test player) | — |

### Schedule and stamina

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| A day that repeats | A game day is three 80-minute parts (morning, afternoon, evening) that repeat until you change them. | 1.0 | Live | Schedule (the fixture camp shows a sample plan) | Concept trailer |
| Training | Training earns attribute points for your build; gladiators lift weights and hit dummies in the yard. | 1.0 | Live | The camp's training yard; Schedule | Concept trailer |
| Stamina | Each activity costs stamina, a Rest refills it, and a part you cannot afford becomes a Rest. | 1.0 | Live | The ⚡ number beside your name; Schedule | — |
| Plan the whole day | Plan all three parts and save once; the schedule says which part is running now. | 1.1 | Live | Schedule (test player) | Looks update |
| A Rest shows its stamina | A Rest says how much stamina it gives back, in the Schedule and on My gladiator. | 1.4 | Live | Schedule, under a Rest (test player) | — |
| Training limit | Training gives a point until your gladiator has 10 + 4 × its level in points; at that limit the Schedule says Training is full and until which level, and Notifications say a Training gave no point. At most two Training activities run per game day: another request becomes a Rest, and the Schedule warns before saving. | 1.6 | Live | Schedule, under a Training choice and above Save, once v2 is active (after the economy switch) | 1.6 update |

### Expeditions and dungeons

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| Three expeditions | The Woodland Path, then the Ruined Outpost and the Mountain Pass at higher levels, pay XP, gold and gear. | 1.0 | Live | Fixture camp → Results → Sample expeditions | Concept trailer |
| Three fights a trip | Fights at minutes 20, 40 and 60; lose one and the gladiator rests at a safe point, keeping all its gear. | 1.0 | Live | Expedition page, `<Outpost defeat>` | Concept trailer |
| Watch a trip | Follow a gladiator on the trail as it happens, and replay each fight. | 1.0 | Live | Expedition page, `<Woodland trip>`, `&minute=30`; or Gladiators → Watch expedition | Concept trailer |
| Waiting monsters | Each monster waits at its spot, named over its head, until its fight; a beaten one fades away. | 1.1 | Live | Expedition page, `<Woodland trip>`, `&minute=18`, then the fight at 20 | Looks update |
| A real search | The gladiator searches slowly around each spot: crouching, shading its eyes and looking around. | 1.4 | Live | Expedition page, `<Woodland trip>`, `&minute=10`; one search lasts about 15 s | — |
| LIVE with named marks | The live view shows LIVE and the minute, and names each mark: leaving camp, each fight, the way back. "Watch from the start" replays what you missed, never past now. | 1.4 | Live | Expedition page, `<Woodland trip>`, `&minute=30` → ⏪ | — |
| Whole-trip replay | Replay a whole trip in about a minute and a quarter: out through the camp gate, the trail, the fights at real speed, home through the gate, and to bed when a Rest follows. | 1.4 | Live | Expedition page, `<Woodland trip>`, `&play=trip` → ▶; it opens at the camp gate and ends in bed | — (named as coming in Looks update) |
| Your gladiator from the start | A replay names and draws your gladiator from its first moment, not only from its first fight. | 1.4 | Live | The first seconds of any whole-trip replay | — |
| Watch your expedition | While your gladiator is away, a button on the camp shows where it is and opens the live view; once back, it offers the whole trip with your rewards. | 1.4 | Live | The camp while the owner's gladiator is on a trip (test player); on a phone it sits beside ☰. Once the trip is back, the same button offers the whole trip | — |
| Slower levels | Expeditions pay less: 30, 75 and 150 XP and 4, 10 and 18 gold, so level 10 takes about three weeks; gear is found half as often. | 1.6 | Live | Not in the fixture camp: a trip's rewards once v2 is active (after the economy switch) | 1.6 update |
| Dungeons | Choose a dungeon for the afternoon: Wolf Den (level 3), Raider Stronghold (level 7) or Troll Hall (level 12). | 1.8 | Planned 1.8 | Not built | — |
| Team up | Everyone who chose the same dungeon is put in a party of up to 3; hired fighters fill empty seats, so you can always go, even alone. | 1.8 | Planned 1.8 | Not built | — |
| Rooms, then the boss | A run is 3 rooms, then the boss, in one afternoon; health carries from fight to fight. | 1.8 | Planned 1.8 | Not built | — |
| Dungeon rewards | Every fight your party wins pays you; the boss pays most and opens a chest; lose to the boss and you keep what the rooms paid. A run costs 40 stamina. | 1.8 | Planned 1.8 | Not built | — |
| Watch your run | Watch the party walk the dungeon live, with the camp button and a replay of the whole run. | 1.8 | Planned 1.8 | Not built | — |
| Off to the dungeon | The party leaves through the camp gate together, and the camp shows where it went ("In Wolf Den"). | 1.8 | Planned 1.8 | Not built | — |

### Arena and tournaments

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| Automatic Arena | Your gladiator fights others of similar strength on its own, climbing leagues from Bronze to Champion for rating and renown. | 1.0 | Live | Arena menu; its sample bouts | Concept trailer (league ladder) |
| Stance, not buttons | Nobody presses attack: you choose a stance, and the server decides every blow. | 1.0 | Live | Replay page, `<Aster vs Varro>` | Concept trailer |
| Fights in the camp ring | Arena bouts play live in the camp's rings at their real time. | 1.0 | Live | Live game, minute 60 of an evening part (for example 19:40 UTC); the fixture camp shows the warm-up | Concept trailer (warm-up only) |
| NPC opponents | When no player can be matched, your gladiator fights an NPC instead. | 1.0 | Live | Replay page, `<NPC bout>` | — |
| Standings | League standings, season by season, in the Arena menu. | 1.0 | Live | Arena → standings | — |
| Tournaments | Brackets every Wednesday and Saturday. | 1.0 | Live | Tournaments → a sample bracket | Concept trailer |
| Seasons | Four-week seasons end with awards for the top 3: rewards, titles and badges. | 1.0 | Live | Arena → standings → a season | Concept trailer (as "28 days") |
| Evening Arena | The Arena runs in the evening part only, and tournaments start in the evening too, at 18:40 UTC. | 1.1 | Live | Schedule: Arena is offered in the evening only | Looks update |
| Your recent bouts | The Arena menu lists your three latest bouts, each with ▶ Watch. | 1.5 | Live | Arena → Your recent bouts; All my bouts opens Results on My bouts (All) | — |
| Watch from the camp | After your bout, a button on the camp says who won and plays it. | 1.5 | Live | Camp → settled Arena bout button | — |
| Full-screen tournament bouts | Tournament bouts play full screen, and Next bout walks through the bracket. | 1.5 | Live | Tournaments → Watch replay → bracket chapters | — |
| Tournament prizes by league | A win pays 40, 60, 80 or 100 gold in Bronze, Silver, Gold or Champion, the other places scaled the same way; the Tournaments rules list them. | 1.6 | Live | Fixture camp → Tournaments → Registration: the last rule lists each league's prizes (the preview words the 1.6 rules); live once v2 is active | 1.6 update |
| Season prizes by league | From the first season after 1.6, gold prizes depend on the league (200 to 500 for first place); the season card shows every league's prizes. | 1.6 | Live | Fixture camp → Arena → standings: the current sample season's prize table, Aster's Bronze row marked "· yours" (live: the first season opened after the switch) | 1.6 update |
| Free tournament entry | Tournament entry costs no stamina; regular Arena still costs its stamina when no bracket forms. | 1.6 | Live | Fixture camp → Tournaments → Registration: "0 stamina for tournament entry" and the first rule; the Schedule's evening Arena line in the live game once v2 is active | 1.6 update |

### Results and replays

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| Results | Everyone's results, newest first, each fight with its replay. | 1.0 | Live | Results | Concept trailer |
| A fight up close | Watch any bout up close, blow by blow, with health bars. | 1.0 | Live | Replay page, `<Aster vs Varro>`; `<Tie-break bout>` for a close finish | Concept trailer |
| Replays kept a week | Every replay can be watched for 7 days. | 1.0 | Live | Replay page, `<Expired bout>` shows the "no longer kept" card | — |
| The whole trip from Results | Replay on an expedition in Results opens the whole-trip replay. | 1.4 | Live | Results → Replay on an expedition row | — |
| My bouts | Results opens on your own Arena and tournament bouts, by day, with Won or Lost, the rating change and a dot until watched; show All, Won or Lost. | 1.5 | Live | Results → My bouts → Watch; replay page | — |
| A new replay bar | Play and pause, a track you can drag, the time, a speed of 1×, 2× or 4× that the device remembers, and ⚑ Result. | 1.5 | Live | Results → My bouts → Watch; replay page | — |
| The result on the arena | When a bout ends, its result shows on the arena with Watch again and Next bout. | 1.5 | Live | Results → My bouts → Watch; replay page | — |
| Next bout | Watch your bouts one after another, with a counter and "Up next". | 1.5 | Live | Results → My bouts → Watch → ⏭; Lost follows only losses | — |
| Back where you were | Back names where you came from (My bouts, Arena, Notifications…) and takes you there in one step. | 1.5 | Live | Results → My bouts → Watch; replay page | — |
| No spoilers | The replay no longer shows who won above the fight before it plays. | 1.5 | Live | Results → My bouts → Watch; replay page | — |
| Replays on a phone | On a phone the replay shows who won without scrolling. | 1.5 | Live | Results → My bouts → Watch; replay page | — |
| Your Arena result on the camp | After your bout ends, see who won and the credited rewards, Watch the bout, or dismiss it on this device. | 1.5 | Live | Live camp after your Arena bout; phone beside ☰ | — |
| Party fights up close | Any dungeon fight up close, up to 3 against 3, the boss bigger and sweeping the whole party. | 1.8 | Planned 1.8 | Not built | — |
| Dungeon results | Results and Notifications say "Wolf Den cleared" or "the party was beaten", with your own rewards. | 1.8 | Planned 1.8 | Not built | — |

### Market, shops and gold

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| Shops and inventory | Buy gear from the weaponsmith and the armorer, and keep it in your inventory. | 1.0 | Live | Inventory and shops | Concept trailer |
| Player market | Buy from and sell to other players at fixed prices; visitors can browse. | 1.0 | Live | Marketplace (the fixture camp has sample listings) | Concept trailer |
| A fair market fee | A sale's fee is at least 1 gold and the lowest price is 2 gold; the sell form shows what you receive. | 1.1 | Live | Marketplace → Sell | Looks update |
| Gold | Money is called gold everywhere; your amount is unchanged. | 1.3 | Live | Marketplace; My gladiator | Messages update |
| Salvage at 4 gold | Salvage sells to merchants for 4 gold instead of 10 (a game message warns a day before). | 1.6 | Live | A merchant sale after the economy switch | 1.6 update |
| A new economy | When 1.6 goes live everyone's gold is cut to a quarter; levels, items, points and renown stay, and shop prices do not change. | 1.6 | Live | Not visual: the patch note says it | 1.6 update |

### Messages and notifications

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| Messages | A button beside your name, with a count, where patch notes and news from the game arrive. | 1.3 | Live | Fixture camp: the button beside your name | Messages update; Too Tiny (a drawn copy) |
| Notifications | See what your training, expeditions, Arena fights and tournaments earned: XP, level-ups, gear and gold. | 1.3 | Live | Messages → Notifications | Messages update (named as coming in Looks update) |
| Patch numbers | The menu under your name shows the patch you play, each patch note shows its number, and Patch history lists what every patch added. | 1.4 | Live | The chip menu: tap or click your name for "Patch 1.4" and Patch history ›; a patch note's number opens the history at that patch | — |
| New patch notice | When a new patch is out, an open game says so, and Reload brings it in. | 1.4 | Live | Needs a server ahead of the game: in the test camp call `setLatestPatch` with a version strictly above the current client `PATCH` (increment its major number), then focus the window; the notice shows under your name | — |
| Watch from Notifications | Arena and tournament results get ▶ Watch, and expeditions ▶ Watch the trip. | 1.5 | Live | Messages → Notifications → Watch; Back returns to the Notifications tab | — |

### Players and community

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| Gladiators and profiles | See every gladiator, open its profile, and Find or Follow it in the camp. | 1.0 | Live | Gladiators | — |
| Visitors welcome | Anyone can watch the camp and the public menus without signing in. | 1.0 | Live | `/game/?mode=fixture&as=visitor` | — |
| New arrivals | Everyone sees a banner when a gladiator arrives; Find goes to the gate, and newcomers come first in the Gladiators list with a NEW tag. | 1.4 | Live | Fixture camp (it always shows a banner) → Find | — |
| Players count | The Gladiators list shows how many players there are and where they are now. | 1.4 | Live | Fixture camp → Gladiators, the line on top | — |
| Richer profile card | Click a gladiator's name to open a bigger card: their look, class bonuses, attributes, stats, gear with level and rarity, Arena record and days in camp. | 1.4 | Live | Fixture camp → Gladiators → a name (Lucilla has a sample build); a click on a gladiator in the camp opens it too | — |
| Arena banner on the profile | A bought Arena banner shows on your profile card. | 1.6 | Live | Fixture camp → Gladiators → Aster (she owns it): the 🚩 Arena banner pill under her name; Inventory → Armorer: the shop's banner lines | 1.6 update |
| Bot gladiators | A named team of bot gladiators fills dungeon seats and lives in the camp. | 1.8 | Planned 1.8 | Being designed | — |

### Titles

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| Titles to earn | 31 titles for expeditions won, Trainings, Arena wins, tournaments, season places, gear ever owned, gold earned and a few special ones; a gladiator wears one beside its name. | 1.7 | Live | The server counts and grants them; My gladiator → the Title button → "Choose your title" → All · 31 lists every title by family, the earned ones (✓ Earned) to wear and the locked ones with how close you are ("34 of 50") | — |
| Your history counts | Everything done before 1.7 counts: a notice in Notifications lists the titles a gladiator's history earned. | 1.7 | Live | The server counts history at the release; Messages → Notifications: the card "Titles from your history" with "Patch 1.7 counted everything you have done since you joined.", the earned titles as gold chips (the worn one first, filled), "Choose a title" (opens the picker on My gladiator) and "You now wear Founder."; it counts on the Messages badge and in "Latest 4 results and 1 title notice · 3 new" | — |
| Founder | Every gladiator made in Season 1 (it ends on 22 Nov 2026) is a Founder; nobody gets it again. | 1.7 | Live | The server grants it (at creation, and to Season 1's gladiators by the release back-fill); it shows with the name in the camp, the Gladiators list and on the profile card | — |
| Choose your title | A Title button on My gladiator opens "Choose your title": one title or none, free, any time; locked titles show how close you are. | 1.7 | Live | My gladiator: the Title button beside the name (TITLE, the worn title, ›) opens the picker: the preview shows the choice in the camp and in menus, Earned · {n} or All · 31, No title first; pick one, Wear title, and "You now wear {name}." shows under the name. On a phone it fills the screen with Wear title and Cancel pinned at the foot | — |
| Your title with your name | A gold line over the name in the camp, and the title in the Gladiators list, on the profile card, in Arena bouts and replays, and in tournament brackets. | 1.7 | Live | In the camp: zoom in (2 or more) and a gold italic line stands over each name; the selected or followed gladiator's shows from zoom 1.4; also the Gladiators list and the profile card; the Arena card's header and its Opponent row, the replay header (under each fighter's name; an NPC has none) and each fighter in a tournament bracket's bout cells show the title too | — |
| New-title notices | New titles arrive in Notifications; one earned by a result shows inside that result, with Wear. | 1.7 | Live | Messages → Notifications: a result that earned a title (an expedition that was the 10th won) has a gold line "New title: Wanderer · 10 expeditions won" with Wear; press it and it reads "Worn ✓" (the Title button agrees). A title earned elsewhere (a season place, a shop) is its own card, "New title: {name}" or "New titles"; each counts on the Messages badge | — |
| Titles on the card | The profile card counts the titles a gladiator has earned. | 1.7 | Live | A gladiator's profile card: RECORD → Titles, "{n} earned" or "None yet"; the worn title also shows under the name there and in the Gladiators list | — |
| Hand-given titles | The Game Master can give a special title to a gladiator (Game Master, High Ground); only its holder sees it in the picker, and it arrives in Notifications with Wear. | 1.7.1 | In 1.7.1 | Messages → Notifications: a card "New title: Game Master" with its rule line ("The game's Game Master") and Wear. My gladiator → Title → "Choose your title": the holder's All · 32 lists it under Special and Earned counts it; everyone else still sees All · 31 and no such title. No patch note is shown | — |

### Settings and accessibility

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| Desktop and phone | On a desktop the menus slide in from the left edge; on a phone, ☰ opens each menu as a sheet from the bottom. | 1.0 | Live | Any menu; phone width for ☰ | — |
| Keyboard and reduced motion | Every camp action also works from the keyboard through the menus, everything has screen-reader names, and reduced motion turns off the sliding. | 1.0 | Live | Hard to film | — |
| Clearer busy buttons | While a button sends its command, it dims and keeps the keyboard focus, and pressing it again does nothing. | 1.2.1 | Live | Wear, Buy or Queue build (test player) | — |
| 12- or 24-hour clock | Choose a 12-hour or 24-hour clock in the menu under your name; every time in the game follows it. | 1.4 | Live | Menu under your name → Clock; watch the times in Results change | — |
| Phone status bar | On a phone, tap your name to see stamina, gold, renown and the time to the next slot. | 1.4 | Live | Fixture camp at phone width → tap your name | — |
| Replay keys | Space or K plays and pauses, the arrows skip 5 s, N and P change bout, F the speed, R restarts. | 1.5 | Live | Open a replay and use its keys | — |

### Under the hood

| Feature | What players get | Patch | Status | How to film it | Shown in video |
| --- | --- | --- | --- | --- | --- |
| Nothing shown early | Fights and expedition stages appear at their time, so nobody sees a result before it happens. | 1.0 | Live | Not visual | — |
| Clear refusals | A build the server refuses says why and reloads your gear; the schedule drops an old note when the day changes. | 1.2 | Live | Not visual | — |

### Ideas, not in a patch yet (don't film or promise)

- A rotating schedule: a routine of several different days that repeats.
- Undo a purchase you just made.
- How many you already own, beside each market and shop item.
- Friend parties and invites for dungeons (after 1.8).
- A renown skins shop: colours and dyes for clothes and weapons (1.8 or 1.9).
- New gear with level and attribute requirements (a later patch).
- The Deep: a weekly solo delve from level 15 (after the dungeons).
- A summoner class, with spirits or animal spirits.
- Respec as a paid option (the gray Respec button since 1.3.1).

## Best moments to film

1. **The whole-trip replay** (1.4). Expedition page, `<Woodland trip>`, `&play=trip`, then ▶: a whole trip in about a
   minute and a quarter; ⏭ jumps chapter to chapter for a short cut.
2. **A fight up close** (1.0). Replay page, `<Aster vs Varro>`: health bars and every blow; `<Tie-break bout>` for a finish
   decided by a tie-break.
3. **The camp at night** (1.0). The live game in an evening part: blue light and lit torches; pan slowly across the camp.
4. **The new search** (1.4). Expedition page, `<Woodland trip>`, `&minute=10`: the gladiator crouches, shades its eyes and
   looks around; hold about 15 s for one whole search.
5. **Bigger beds** (1.3). Gladiators asleep on the cots while they Rest; Punchy's story is ready-made (Too Tiny).
6. **Look creation** (1.2). The creation dialog: press Random look a few times and watch the live preview change.
7. **A monster waits, then the fight** (1.1). Expedition page, `<Woodland trip>`, `&minute=18`: the named creature waits
   at its spot, and the fight starts at minute 20.
8. **An Arena bout in the camp ring** (1.0). Minute 60 of an evening part (for example 19:40 UTC): the bout plays live
   in the ring and lasts 12 to 23 s.
9. **A new arrival** (1.4). Fixture camp: the NEW ARRIVAL banner, then Find moves the camera to the newcomer at the gate.
10. **LIVE on the trail** (1.4). Expedition page, `<Woodland trip>`, `&minute=30`: the red LIVE badge and the named marks,
    then ⏪ Watch from the start.
