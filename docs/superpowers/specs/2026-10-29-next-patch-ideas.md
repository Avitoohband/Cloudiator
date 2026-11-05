# Next-patch ideas (Avi, 2026-10-29) — collected, not yet designed

Avi's list after the game-messages release, in his order, with Claude's reading. Nothing here is designed or planned yet;
the UI items get a clickable mockup over a real screenshot before Avi approves them (his rule).

1. **Party PvE dungeons (big; needs its own design).** Avi: "Party for pve dungeons and run system for the dengine majors for
   expeditions working sumoners and keep it balance". Claude's reading (to confirm with Avi): gladiators can form a party
   for PvE dungeons; dungeon runs with major (boss) encounters as a new kind of expedition; keep it balanced for party size.
   **Summoners (Avi, 2026-10-29): a future class** that summons spirits or animal spirits, like warlocks. "That's for the
   future": not part of the party-dungeon design; design it as its own class later.
2. **Announce a new player.** When a new gladiator arrives in the camp, everyone sees an announcement.
3. **Watch an expedition while it runs.** A better way to watch the expedition in progress: a button on screen while my
   gladiator is away on an expedition that opens the live expedition view.
4. **Class bonuses on My gladiator.** Show the class's bonuses on the My gladiator page, and the class's suggested point
   distribution there too (the creation dialog already suggests one).
5. **Phone: tap my name for the bar.** On a phone, tapping my name opens the same bar as on a PC (stamina and the rest).
6. **Rest shows its stamina.** Write how much stamina a rest gives.
7. **12-hour / 24-hour clock.** A setting to switch the times shown between 12-hour and 24-hour.
8. **Players count.** Show the number of players in the Players menu.

Already noted earlier for a future patch (HANDOFF): a named team of bot gladiators (AI players) to make the camp livelier.
Still open in the current plan: Task 10, expedition replays that show the whole trip (leaving camp, the fights, coming back,
resting), design and mockup first. Items 3 and Task 10 overlap (watching an expedition) and should be designed together.

Avi, 2026-10-29: "Yes, you can plan them." Planning starts with a design pass (code map + clickable mockups over real screenshots for the UI items), then a spec and a plan.

Avi, 2026-10-29 after the mockups (local clickable page over 37 real screenshots) and the party-dungeon proposal: "yes, and
your recommendations, go". Decisions: (1) announce a new player during their first slot only (no database change); (2) the
whole-trip replay runs about 1¼ minutes (walking sped up, fights at real speed); (3) the 12/24-hour setting is per device;
(4) a dungeon run is 3 rooms then a boss in one afternoon; (5) automatic grouping plus hired fighters first, friend invites
later; (6) dungeons in the afternoon only; (7) a party that loses to the boss still gets paid for the rooms it cleared;
(8) friends in a party may see each other's planned dungeon, only within the party (with invites, later). Next: Patch A (items
2-8 + whole-trip replay, no migration) and Patch B (party dungeons MVP, M26), each with a spec and a plan, then build.

9. **Arena replays, more comfortable to watch (Avi, 2026-10-29).** "there need to be more comfort way to see my arena replays." To design with a clickable mockup over the real replay screens (how players find their Arena replays, and the viewer itself); reuse Patch A's replay bar where it fits.

Avi, 2026-10-29, after the Arena-replay mockup (`.superpowers/design/2026-10-29-arena-replays/mockups.html`, over real
screenshots): (1) "My bouts" rows show Won/Lost and the rating change (no spoiler hiding); (2) a replay ends on the result
card with Watch again / Next bout / Back (no autoplay); (3) build it as a small patch right after Patch A, reusing Patch A's
replay bar, before Patch B. Next: spec and plan for that patch.

More ideas from Avi, 2026-10-29 (collected, not yet designed):

10. **A rotating schedule.** "an option to form a dynamic schedule. Like 3 days different schedule routine": a routine of
    several different days (for example 3) that repeats, instead of one day's plan.
11. **Undo a purchase.** "an undo button for buying things": take back a purchase just made (shops; the market needs care,
    since another player was paid).
12. **How many I already have.** "if I have an item that is showing in the market or shops, show how much I currently have
    from the same item": the owned count beside each market and shop listing.

Bug from Avi, 2026-10-29 (production, phone): the attribute points can't be added. Typing any number resets it to the
most. Wanted: +1 and +5 beside each attribute (wrapping to a second row on a phone if needed), and typing still possible.
Being fixed as a hotfix from the release branch (`claude/points-hotfix`).

Avi, 2026-10-29: the Arena-replay spec and plan (`docs/superpowers/specs/2026-10-29-arena-replays-design.md`,
`docs/superpowers/plans/2026-10-29-arena-replays.md`) are approved ("Ok"). It ships as patch 1.5, after Patch A (1.4) and
before Party dungeons (1.6).

Economy and progression feedback from Avi, 2026-10-29 (collected; an economy design pass follows):

13. **Gold harder to get**, so it matches the tournament prizes: "about gold, it should be harder to get, so it match the
    trounements prises".
14. **A skins shop for renown**: "about renown, start the skins shop".
15. **More PvE**: "we need to develop the pve aspect more".
16. **Higher leagues, higher prizes**: "higher leagues have higher prises".
17. **Lower prizes and lower expedition gold**: "again the prises should be lower and the gold from expeditions".
18. **Harder progression**: "the game should be harder to progress".

Gear feedback from Avi, 2026-10-29 (collected; a gear design pass follows, aligned with the economy pass):

19. **More gear**, "much more clothes, and weapons": "we need to add more gear".
20. **Attribute requirements**: "certain gear demands certain attributes to wear".
21. **New weapons**: "also new weapons".

More from Avi, 2026-10-29:

22. **A respec offered in a message**, with an explanation of which attributes suit which class, coming with a video: "respec
    option for attributes in messages with explanation about which attrubutes good for which class. it will come with video."
    (Like 1.3's free look change from a patch note. It fits the gear-requirement change, ideas 19-21.)
23. **New classes ahead, maybe**: "maybe new classes ahead" (summoners are already noted as a future class).
24. **A suggested spread per class in the attributes section**: "the attributes section should have suggestion for spread
    attributes for each class". Built in 1.4 (Patch A Task 5): the class card's "of every 10 points" split on My gladiator, and
    "Suggested for {Class}" with Undo in the Build panel.

25. **Long endgame dungeons (Avi, 2026-10-29).** "a player could go the dungeon, it takes a whole day, even more than a day. he
    going thorugh stages there. every few levels there is mini boss, and there is the dungeon final boss at the end which is
    high level gladitor, or monster. big prises at the end, those dungeos are super hard and not for early game at all."
    Different from 1.6's party dungeons (3 rooms and a boss in one afternoon): a multi-day delve of many stages, mini bosses
    every few stages, a final boss, big prizes, endgame only. Goes into the PvE part of the economy pass, then its own design.

26. **Titles a gladiator wears (Avi, 2026-10-30).** "I want to add titles that gladiator wear and it shows something. From
    tournaments. Dungeons, number of expeditions, number of training and more. A unique title for the first batch of players
    that they are the test group." Earned titles (tournament wins, dungeon clears, expedition and Training counts, and more);
    a gladiator wears one, shown with its name; a unique founders' title for the first batch of players (the test group).
    Today only the season "champion" title exists (prestige, Task 21). Avi added: "Titles for gear collection as well" and "For amount of gold".

27. **More NPCs, more guards (Avi, 2026-10-30).** "Add more npcs. More guards".
28. **A bigger camp map.** "i want to make the map bigger".
29. **Future facilities where the trees are.** "also where there are trees in the camp, in the future it will be new
    facilities": the wooded parts of the camp are reserved as plots for new buildings later.

More from Avi, 2026-10-30 (collected for the plans, not yet designed):

30. **Player support.** "Add players reach out support option": a way for players to contact support from the game.
31. **A watch mode for the Arena and tournaments, for streams.** "a button when arena is live which shows different battle
    and a text narration it, who's fighting, wins, blows and more": while the Arena is live, a button opens a spectator view
    that moves between bouts, with a running text commentary (who fights, the blows, the winner). It builds on 1.5's replay
    viewer.
32. **Stream the game 24/7 on YouTube (to check).** "checking the option to live stream the game 24/7 somehow at YouTube":
    a feasibility check, likely a headless browser on the watch mode (idea 31) pushed to a YouTube live stream on the Indigo
    Labs channel; cost and hosting to be checked.
33. **An NPC "the Champ".** "Add npc 'the champ' - which was the champ of the arena, level unknown": a legendary former Arena
    champion in the camp, level shown as unknown (fits the 1.5.1 camp NPCs and the bigger camp's plots).

34. **An in-game guide (a small wiki) and an explainer clip (Avi, 2026-10-31).** "all of those should be in the game
    details somewhere, maybe a little wiki, when it comes out. also a clip should explain that as well. and what each stat does,
    how agility, precision affect the game, and fights, why someone miss or dodge." Covers: stamina costs per activity and
    overload; what each attribute does (Strength, Agility, Vitality, Endurance, Precision) in numbers; class bonuses; how a
    fight resolves (hit, miss, dodge, critical, armour, attack speed); Rest and the Training cap. The numbers must be read from
    the active rules (v1 now, v2 after 1.6), never typed by hand. A players' explainer clip follows its release.

35. **Class quests that raise the class bonus (Avi, 2026-10-31, future).** "quest per class, that improve their class
    bonuses, should be very hard to achieve. for example, Berserker has more % STR and Guardian have 10% endurance instead of 5."
    One long, very hard quest chain per class; finishing it upgrades that class's bonus (Berserker Strength above +10 %,
    Guardian Endurance +5 % → +10 %, Duelist Agility/Precision up). Endgame; fits with the Deep and titles (a title for each).

More from Avi, 2026-10-31 (a pasted list; items already listed are folded into 30-34):

36. **Videos in the guide.** "In the wiki your links to YouTube videos and explanation and links to the patch notes videos on
    YouTube": the in-game guide (idea 34) links the explainer videos and each patch's video on YouTube (Indigo Labs).
37. **A better inventory with item pictures, and in the shops too.** "Better inventory setup with items appearance. Also in
    shop": each item shown with its picture, in Inventory and in the shops.
38. **A look-change option.** "appearance look change option": change look from the menu at any time (today only from the 1.3
    patch note's one free change); maybe priced, or tied to the renown skins shop.
39. **Support with triage.** Idea 30 plus "with jev to classify those issues": support requests are classified (bug, account,
    balance, idea…) automatically; Avi's word "jev" to confirm.
40. **A world tournament with a statue for the winner.** "World tournament for statue for winner": a big all-leagues
    tournament; the winner gets a statue in the camp (a facility plot, idea 29).
41. **Events.** "Make events": timed in-game events.
42. **Potions for stamina and health.** "Potions for stamina and health": consumables (fits the 1.6 economy and the shops).
43. **Houses, decorations and achievements.** "When camp full, the gladiator rest in house, add decorations and achievements":
    when the camp's beds are full, a gladiator rests in a house; houses can be decorated; achievements.
44. **Guilds and raids.** "Guilds in the future with raids. And special items to sell in market": guilds, raid content, and
    special raid items that can be sold on the market.

Already listed: the watch mode for streams (31), the 24/7 stream (32), the Champ (33), Endurance and load and what each stat
does (34).

More from Avi, 2026-11-04 (for the gear wave and later):

45. **Elemental damage and defence for PvE.** "elemental damage and defense for pve": fire, frost and poison damage and
    matching resistances, used against monsters in expeditions, dungeons and the Deep (PvP stays plain unless decided otherwise).
46. **Weapon upgrades by material rank.** "weapon upgrade with bronze, copper, iron, gold and salvages for each rank": a forge
    (a facility plot) upgrades gear through ranks, each rank paid with its material (bronze, copper, iron, gold) plus salvage.
    Materials come from expeditions, dungeons and salvaging. Avi, 2026-11-05: "mateirals for weapon upgrades are received
    from expeditions(bronze, cooper, iron, gold, platinum and so on)": the ranks go past gold (platinum, then higher), and
    expeditions drop the materials (higher expeditions, higher materials; ties to idea 52).
47. **Plan routines several days ahead.** "an option to plan routine of few days forward and not just same day since max
    level": schedule several days at once (ties to idea 10, the rotating multi-day routine).
48. **Potions for health and stamina** (repeats idea 42; Avi asked again).
49. **Two-handed weapons have an edge.** "two handed weapon like spear should have an edge on one handed weapons": a
    two-handed weapon (spear, great sword, war hammer) outdamages a one-handed weapon enough to make up for the missing shield.
    The gear pass already found the sword beats every weapon today; fix the balance in the gear wave.
50. **Show the odds.** "show probability for crit damage, dodge and so on": the card and the guide show hit, dodge, critical
    chance and critical damage as percentages, from the same rules as the fights (ties to idea 34, the in-game guide).

More from Avi, 2026-11-05 (for the PvE and gear waves):

51. **A little follower for PvE.** "little follower for dungeons and pve stuff": a small companion that goes with the
    gladiator into dungeons, expeditions and other PvE and helps there (PvP left out unless decided otherwise). To design with
    1.8's party dungeons and bot team; close to the future summoner class (idea 1), which should stay different.
52. **Expeditions for higher levels.** "add expeditions for more lvls maybe 12,15,18,20": today the top expedition is the
    Mountain Pass at level 10 (Woodland Path 1, Ruined Outpost 5). New ones open at about levels 12, 15, 18 and 20, with
    pay set by the 1.6 economy, and they drop the higher upgrade materials (idea 46).

UI ideas from Avi, 2026-11-05 (for a later UI patch; mockup over real screenshots first, his rule):

53. **Character creation in steps.** "sections for the character creation visual, class, attribues, can go forward and
    backward in the form": the creation form becomes three steps, Look, Class and Attributes, with Back and Next between
    them, so a player can go back and change an earlier choice before creating. Fits the 2026-10-25 points rework (reset,
    class suggestion) already in the Attributes part.
54. **Wider menu screens, adjustable.** "wider menu screens maybe adjustable in some fixed range": the menu panels (Schedule,
    Inventory, Arena and the rest) open wider, and a player can resize them between a fixed narrowest and widest width,
    remembered per device. A phone keeps its full-width panels.
55. **A sticky menu, placed where I want.** "sticky option for the menu so it won't disapear, also option to choose where it
    would be, bottom, top, left, or right": a setting keeps the menu always shown (it does not hide), and a second setting
    puts it at the bottom, top, left or right of the screen. Per device, like the 12/24-hour clock (idea 7).
