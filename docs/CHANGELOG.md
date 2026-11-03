# Cloudiator changelog

**How to use it:** newest patch first. Everything above the last video's patch is new since that video (see "Videos"
just below). Each bullet is one player-visible feature or fix, in plain words; the released sections are the server's patch
list word for word (`public.patches` and `public.patch_features`, Patch A spec "Patch numbers and the changelog").

Rules for agents: a task that builds a player-visible feature adds its bullet to the in-progress section in the same commit.
The release moves the section to released (its date in the heading, the "Built"/"Planned" sub-headings removed) and
records it on the server. A fix-only release from `release` takes the next third number (1.3.1). After a video is made, add
its row to "Videos". Bullets are plain text, one line each, at most 240 characters, no Markdown inside them: players read
them as they are.
That task also adds its row to [FEATURES.md](FEATURES.md); after a video is made, fill in its "Shown in video" column there.

## Videos

Project folders under `D:\Avi\Projects\Animation\Cloudiator\`.

| Video | Made | Covers |
| --- | --- | --- |
| `messages-look-and-beds-update` | 2026-10-29 (rendered 09:41 UTC) | 1.3. It was rendered before 1.3.1 shipped. |
| `camp-life-too-tiny` | 2026-10-29 | No patch: a comedy episode. It shows 1.3's bigger beds. |
| `appearance-and-ui-update` | 2026-10-28 | 1.1 and 1.2. It showed 1.3's free look change as "coming soon". It did not show 1.2.1. |
| `concept-video` | 2026-10-23 | Before 1.0: the concept trailer. |

**Last video's patch: 1.3.** New since then: 1.3.1, 1.4, 1.5 and 1.5.1 are live; 1.6 is in progress.

## 1.6 — A new economy: slower levels and prizes by league (in progress, not yet released)

Patch 1.6 (economy rebalance). The title is the draft patch note's; Avi approves the wording at release.

### Built

- Expeditions give less XP and gold: 30 XP and 4 gold on the Woodland Path, 75 and 10 on the Ruined Outpost, 150 and 18 on the Mountain Pass. Level 10 takes about three weeks.
- Everyone's gold was cut to a quarter when 1.6 went live. Levels, items, points and renown stayed, and shop prices did not change.

### Planned

- Gear is found half as often on expeditions, and salvage sells to merchants for 4 gold.
- Tournament gold depends on the league: a win pays 40 in Bronze, 60 in Silver, 80 in Gold and 100 in Champion, the other places scaled the same way. The Tournaments rules list them.
- Season gold prizes depend on the league from the next season, up to today's: 200, 300, 400 or 500 gold for first place. The season card shows every league's prizes. Season 1 pays what it promised.
- Training gives a point until your gladiator has 10 + 4 × its level in points. At that limit it gives nothing until the next level, and the Schedule says so. Points you have stay.
- A Training that gave no point says so in Notifications.
- The Arena banner shows on your profile card.

## 1.5.1 — More guards and new faces in the camp (2026-11-01)

Released 2026-11-01: a small app-only patch after 1.5, with the three features below recorded on the server. The verified client follow-up shipped 2026-11-02 without reposting its note or record. The bigger camp and its plots remain a later patch after 1.8.

- More guards watch the camp: a second guard at the gate, a lookout at the watchtower and two patrols that walk along the walls.
- In the evening the two wall patrols are the night watch: they carry torches, and the light goes with them.
- New faces in the camp: Petra carries water from the well, Felix the herald walks between the Arena gate and the camp gate, Quintus carries crates to the stalls and the kitchen, and Silva the forester tends the woods.

## 1.5 — Watch your Arena bouts more easily (2026-11-01)

Released 2026-11-01: Arena replays are live. The exact ten features below are recorded on the server with the patch note.

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

## 1.4 — Watch your expedition, gladiator cards and a clock (2026-10-31)

Released 2026-10-31: M26, client `26dd0d7`, note 5 and the linked 14-feature record are live.
Patch A (branch `claude/task-24`). Avi approved the exact note and patch-history wording. After 1.4:
1.5 Arena replays, 1.6 the economy rebalance, 1.7 wearable titles, then 1.8 party dungeons and the bot team (all planned,
not built); new gear comes in a later patch.

- New arrivals: everyone in the camp sees a banner when a gladiator arrives. Find takes you to the gate, and the Gladiators list shows newcomers first with a NEW tag.
- My gladiator shows your class's bonuses and its suggested split of points. When you plan a build, Suggested spends the points left your class's way.
- A Rest says how much stamina it will give back, in the Schedule and on My gladiator.
- Clock: choose a 12-hour or 24-hour clock in the menu under your name. Every time in the game follows it on this device.
- On a phone, tap your name to see your stamina, gold, renown and the time to the next slot.
- The Gladiators list shows how many players there are and where they are now.
- On an expedition, a gladiator searches slowly around each spot instead of squatting.
- The live view of an expedition shows LIVE with the minute and names each mark on its timeline: leaving camp, each fight and the way back. Watch from the start replays what you missed, never past now.
- Replay a whole trip in about a minute and a quarter: out through the camp's gate, the trail, the fights at their real speed, home through the gate, and to bed in camp when a Rest follows.
- A replay names and draws your gladiator from its first moment, not only from its first fight.
- While your gladiator is away, a button on the camp shows where it is and opens the live view. Once it is back, the same button offers the whole trip with your own result.
- Patch numbers: the menu under your name shows the patch you are playing, each patch note shows its number, and Patch history lists what every patch added.
- When a new patch is out, an open game says so, and Reload brings it in.
- Click a gladiator's name to open a bigger card: their look, class bonuses, attributes, stats, gear with level and rarity, Arena record and days in camp.

## 1.3.1 — Phone attribute points (2026-10-29)

- Each attribute has +1 and +5 buttons when you create a gladiator or plan a build, on their own line on a phone.
- Tap a points number and type: what you type replaces it. A number above what you have left is corrected when you leave the box, and the game says why.
- The build step has no minus: points in a build that has taken effect are permanent. A gray Respec button says it is coming later as a paid option.

## 1.3 — Messages, gold, fixed builds and bigger beds (2026-10-29)

- Messages: a button beside your name, with a count, where patch notes and news from the game arrive.
- Notifications: what your training, expeditions, Arena fights and tournaments earned, with XP, level-ups, gear and gold.
- Change your gladiator's look from the look patch note, free and as often as you like for now.
- Money is now called gold everywhere. Your amount is unchanged.
- When you level up, the build shows how many points are left. Saved points and your class are fixed; your stance can still change.
- The beds in the camp are bigger, so a gladiator fits on one. Punchy asked for it.

## 1.2.1 — Clearer busy buttons (2026-10-27)

- While a build, market, inventory or shop button sends its command, it dims and keeps the keyboard focus, and pressing it again does nothing.

## 1.2 — Choose your gladiator's look (2026-10-27)

- Choose a look when you create a gladiator: a male or female body; short, long, ponytail or bald hair; skin, hair and clothes colours; a Random look and a live preview.
- Every gladiator is drawn in its own look in the camp, on expeditions and in replays. Gladiators made before keep the original look.
- A build the server refuses says why and reloads your gear, and the schedule drops an old saved note when the day changes in the background.

## 1.1 — Evening Arena, waiting monsters, clearer menus (2026-10-26)

- Arena runs in the evening part of the day only. Wednesday and Saturday tournaments start in the evening too, at 18:40 UTC.
- Plan the whole day and save it once. The schedule says which part is running now.
- Market sales pay a fee of at least 1 gold, and the lowest price is 2 gold.
- Character creation says how many points are left and each attribute's cap.
- My gladiator shows the gear you wear, and the inventory swaps it with Wear. A shield comes back when a one-handed weapon replaces a two-handed one.
- On an expedition, each monster waits at its spot, named over its head, until its fight.

## 1.0 — Public launch (2026-10-25)

- Sign in with Google and create one gladiator: a name, a class (Berserker, Guardian or Duelist) and starting attribute points.
- A shared camp where every gladiator lives out its day, with a camera you can move, on a desktop or a phone. Visitors can watch without signing in.
- A day of three 80-minute parts (morning, afternoon and evening) that repeats until you change it: Training, Expedition, Arena or Rest.
- Stamina: each activity spends it, a Rest refills it, and a part you cannot afford becomes a Rest.
- Training earns attribute points for your build: five attributes, a fighting stance and gear in five slots.
- Expeditions to the Woodland Path, the Ruined Outpost and the Mountain Pass earn XP, levels, gold and gear. Watch a trip live and replay its fights.
- Automatic Arena fights in strength leagues, with a rating, renown and a replay of every bout.
- Tournaments on Wednesdays and Saturdays, and four-week seasons with prestige awards.
- Shops, a player market at fixed prices, and an inventory.
- Results, the Gladiators list and every gladiator's profile.
