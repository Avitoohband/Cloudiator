# Next-patch ideas (Avi, 2026-10-29) — collected, not yet designed

See the [Cloudiator roadmap](../../ROADMAP.md) for the consolidated release history and future plans.

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
    the active rules, never typed by hand.
    On 2026-11-11 Avi confirmed two tabs. **Wiki** explains all game systems and will link to two planned YouTube videos.
    Both videos still need to be produced and linked. **Future Updates** shows the player-facing plan for future patches,
    with patch numbers when decided and a place for unassigned ideas if needed. Avi wants to edit pages inside the game
    and give Codex MCP access to edit the same wiki. The editing and publishing workflow still needs design.

35. **Class quests that raise the class bonus (Avi, 2026-10-31, future).** "quest per class, that improve their class
    bonuses, should be very hard to achieve. for example, Berserker has more % STR and Guardian have 10% endurance instead of 5."
    One long, very hard quest chain per class; finishing it upgrades that class's bonus (Berserker Strength above +10 %,
    Guardian Endurance +5 % → +10 %, Duelist Agility/Precision up). Endgame; fits with the Deep and titles (a title for each).

More from Avi, 2026-10-31 (a pasted list; items already listed are folded into 30-34):

36. **Videos in the guide.** "In the wiki your links to YouTube videos and explanation and links to the patch notes videos on
    YouTube": earlier idea for a broader video archive. The confirmed Wiki scope in idea 34 is two planned YouTube links.
37. **A better inventory with item pictures, and in the shops too.** "Better inventory setup with items appearance. Also in
    shop": each item shown with its picture, in Inventory and in the shops.
    Avi reiterated on 2026-11-01 that inventory item appearance is still wanted later; coordinate this with idea 45.
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

Avi, 2026-11-01, added to the future gear/inventory plan:

45. **Gear attributes on hover in My gladiator.** When choosing or switching gear in the My gladiator menu, hovering over
    an item shows that item's attributes/stats. Avi also reiterated that these inventory items should have a visual
    appearance later (idea 37). Keep the requested stat preview and the later item-art work linked when the gear UI is
    designed; keyboard/touch behavior and the concrete presentation are to be settled in that design pass.

Avi, 2026-11-01, added a standalone social feature after the economy patch:

46. **Friends list and friend requests.** "Also need to add friends list and friend request". Avi chose to ship this as a
    standalone feature after the economy patch (1.6), rather than bundle it with party invitations. Link its design to the
    later [friend-party invitations](2026-10-29-party-dungeons-design.md) so that work can build on the Friends feature.
    The request lifecycle, discovery, privacy and interface still need their design pass; no specific patch or migration
    number is assigned yet.

47. **Game music, sound effects and Audio settings (Avi, 2026-11-01).** Add music and sound effects, with separate Music
    and SFX volume sliders and independent mute controls in a Settings menu. Avi chose to remember these preferences per
    device, so phone and desktop can differ. Handle [browser autoplay restrictions](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay#autoplay_availability)
    when starting sound. Music/SFX assets, default levels, sound coverage and the concrete interface need their design
    pass; no release number or asset generation/download is assigned or authorized by this planning entry.

Avi's list of 2026-11-12 (pasted), with "compare it with yours, make sure everything is noted ... anything can be included in 1.9
should be in" and "next patch should be a big one, implementing payment as well", then "skip questions, do recommendations".
Numbering continues at 58 because ideas 48-57 live on `claude/task-24`. Items already built or decided are not repeated here:
mark as read, talking NPCs, names and titles, menu pin and position, attack speed (1.8.1), stat and attribute help, the XP bar,
stacks with search and sort, the Wiki and Future Updates, salvage, sleeping straight on the bed, harder dungeons and Arena
evenings. Placement and recommendations are in the [roadmap](../../ROADMAP.md).

58. **Rest without armour?** "Rest no armor?". Read as: a sleeping gladiator is drawn without armour (1.9, client art).
59. **Homes with trophies.** "Home, with tropies, any one can build home and guest friend" (later; builds on idea 43, needs Friends).
60. **Dungeon-only items.** "Items that can only be getting in the dungeons" (2.0, boss chests).
61. **Stripe and Google Pay.** "stripe and google pay for monetization" (2.0 payments; Stripe's support for Israeli sellers is checked first).
62. **What critical damage is.** "What is the dmg of the crit dmg" (1.9: show x1.5).
63. **Raise critical damage.** "add a way to increas crit dmg ?" (2.0 balance).
64. **Less luck, more strategy.** "make the battles not RNG only based ... people could interfier with the battle, strategy wise" (later design; the 2.0 potion setting comes first).
65. **Lower critical chance.** "down the crit rate" (2.0 balance, after the 1.9 simulations).
66. **Feedback.** "feedback mechanism" (moved into 1.9 by Avi on 2026-11-12 and built there, with ideas 30 and 39; idea 76).
67. **Spar a chosen player.** "invite specific player for spar battle (stamina free and slot free)?" (1.9 spars a copy of a gladiator; invitations come with Friends).
68. **Build-test dummy.** "add option to fight with dummy that I choose stats, for checking my build (stamina free)" (1.9 practice fights).
69. **Bag slots for real money or coupons.** "bad slots for real money coupons", read as bag slots (2.0 payments).
70. **PvE roles with abilities.** "pve roles, builds, and abilites (roles: tank, summoner, buffer, adc)" and "parties roles. Tank, etc" (later).
71. **Check damage against the block share.** Avi, in Hebrew: check that the damage calculation against the block percentage is correct. Checked 2026-11-12 by reading the code: one formula, min(2% per armour point, 70%), in combat and on the card; the card does not show the Arena's renown armour bonus (shown in 1.9).
72. **Checks for balance.** "check about the 2 handed advanted of one handed", "check about the weapons from renown", "check for the arena algorithm, matches" (1.9 simulations, 2.0 balance; the Arena matching is the 2.0 Arena evenings).
73. **Pets?** Already planned: the paid pet follower (2.0 payments) and pettable camp animals (later).
74. **Drop-only gear above level 10.** Avi, 2026-11-12: "I want also items in game, but items that cannot be bought in the store. Items above level 10, like level 12, 15, and more. New armors, new weapons, and all of those." Placed: level 12 tier from dungeon boss chests in 2.0; levels 15-30 with the 2.1 content; shops keep levels 1, 5 and 10.
75. **Security first.** Avi, 2026-11-12: "add also to do before next patch (after 1.9), security measures, pt testing and all derives from those". Placed: a security pass and penetration test after 1.9 and before 2.0 work starts (ROADMAP "Before 2.0").
76. **2.0 is the full release.** Avi, 2026-11-12: "next patch is generally payments and balances, so anything related to payments should be included next as well (dyts, skins, pets and so on.) but for this one, anything non related payments and balance, should be in. next patch might be 2 instead of 1.10 beause it would be the release patch (from open beta to open.) also would consider pay for cloudflrare and supabase for scaling and supporting mass pplayers income". Placed: the payments patch is 2.0 (1.11 is 2.1); Feedback and Buy back move into 1.9 (his choice); dyes, skins and pets join 2.0; scaling prep joins the pre-2.0 security pass. Numbers in ideas above were renamed (1.10 to 2.0, 1.11 to 2.1).

Avi's additions of 2026-11-12/13 (numbering continues after 76).

77. **Compare stats with mine.** "add an option to compare stats with my gladiator and other gladiators in the camp". Placed: 1.9, built (Task 23c): "Compare with mine" on another gladiator's card.
78. **Marketplace as a list with big icons.** "rework the visuality of the free market, to be compile with the inventory and the new shops" and "the items in marketplace should have big icon like the other tabs, but the player who sell should have more emphasize, it still should be a list with all the details and the big iconisuality". Placed: 1.9, built (Task 26); seller fields arrive with M37.
79. **Gladiator history on every card.** "option to see gladiators arena match history\expedition history and tournaments battles history", then "also expedition replays". Placed: 1.9, being built (Tasks 25 and 27): Arena, tournament and expedition history; every kept replay watchable by anyone; rewards and loot of others stay private.
80. **Tournament fights look different.** "for the tournament view, it should look different from the arena match. should be fancier, so people can distinguish" and "for the tournaments, change the scene as well, the battle ground and the crowd". Placed: 1.9, being built (Tasks 27 and 28): gold header band, tournament rows in history, the "League Stands" scene.
81. **Arena league rework.** "and threshholds to get derank in arena league, not only rank up" and "add more league, platinum diamond than champion". Placed: 2.0 with the balance pass: Platinum and Diamond between Gold and Champion; at each season's end the bottom few of a league (lowest win rate, enough bouts) drop one league; a just-promoted gladiator is safe for one season; thresholds and prizes from the 2.0 simulations; new badges and titles with mockups first.

Avi's additions of 2026-11-13 (stamina notices; mockup approved by Avi on 2026-11-13, `.superpowers/design/2026-11-13-stamina-notices/`).

82. **Predict stamina and warn.** "about the stamina, try to predict if could do next action in schedule and a notification both on screen and in schedule on the slot". Placed: 1.9, built (Task 29): the Schedule marks a part that will not run (not enough stamina, or a third Training of a game day) and shows the stamina after the parts that run; a Stamina notice in camp warns before the next slot (Open schedule, dismiss once per slot). Client only, from the Schedule's existing stamina walk.
83. **Say it rested instead.** "if the character should have go expedition or arena, training, whatever, write that he rested instead, cause not enough stamina". Placed: 1.9, built (Task 29): the running Schedule card, the owner's Notifications and the owner's own Results line say "rested instead" and why; other players still see only "finished resting". The numbers ("had 12, needed 30") show on the running card only: after the slot the client cannot read the stamina the boundary found (it is in the private snapshot), so a notification says "Not enough stamina" without them; showing them afterwards would need a server change (not planned).
84. **Expedition or resting? (player report).** A player reported that the game said the gladiator was on an expedition while Follow showed him resting. Finding (2026-11-13): the public data is right; three of the owner's screens misled. The running card showed the planned choice when the slot had become a Rest (fixed by idea 83); after a lost expedition fight the gladiator rests at the safe return point, and the expedition view and away button now say so; and in the minute or two after a slot boundary the owner's screens no longer name the next slot's activity before the server has processed it. Placed: 1.9, built (Task 29).

Avi's additions of 2026-11-13, evening (not built; each needs a mockup first).

85. **Menus with Back and Next.** "remind you : Menus next and backwards instead of scrolling". An older plan (wider menus with previous and next arrows between sections) that Avi asked not to forget: long menus turn into pages with Back and Next instead of long scrolling. Placed: 1.9 (Avi, 2026-11-13, asked whether to hold the release for it: "Inside 1.9, hold the gate"); mockup approved the same evening (`.superpowers/design/2026-11-13-paged-menus/`: rows per page fixed per list, the phone sheet opens tall, sections only for My gladiator and Inventory and shops); being built as plan Tasks 30-33 before the 1.9 gate. Avi's additions: "For list, add an option to show item cap, like 10 items or 50 items", "the circles down could be clicked to go to a certain page right away and not go one by one", and "when hover on the circle, it hints which page is it. And on mobiles, just click, maybe the name pop for a quick second, or if someone hold it with his finger, it show and it can move like that on the pages".
86. **Showoff card.** "in gladiator card, show have an option for Showoff card, big visuality, in the future where people want to showoff their gear and achivements, skins and dye items". An option on the gladiator card that opens a big card: the gladiator drawn large with gear, titles and achievements, and later skins and dyes. Nothing private on it. Placed: *recommended* 2.0, with the cosmetics it shows off.
87. **Marketing the game.** "Add to future plans the marketing thing, how to market the game, like Google Ads, Instagram, maybe through YouTube if it can involve in Steam platform". A marketing plan: Google Ads, Instagram, YouTube, and whether the game can be listed on Steam. Placed: roadmap "Marketing and ads" (internal, so not in the in-game Future Updates); *recommended* after 1.9 ships and before the 2.0 open release; every paid campaign and store listing needs Avi's go.
88. **Ads inside the game.** "how ads can integrate because it's browser, and to make money, like if someone need to watch ad to refill his stamina and things like that at the beginning". Optional rewarded ads in the browser, for example a short ad for a stamina refill. Placed: roadmap "Marketing and ads" and the Future Updates "payments" entry; *recommended* with 2.0 (payments and balance): opt-in only, a daily limit, no combat power, privacy and consent reviewed.
89. **Protect the game from copying and hacking.** "i need to know How to protect my game , so it won't be replicate or hacked". Placed: the roadmap's "Before 2.0" security section (internal, not in Future Updates): Terms of Use and a copyright line in the game, a trademark for the name (Avi's decision and cost), proof of authorship and takedowns of clones, two-step sign-in on admin accounts, and alerts for unusual gains and multi-accounting, on top of the planned review and penetration test.

Avi's addition of 2026-11-14 (not built; needs a mockup first).

90. **Crossover skins and titles.** "i want in the future: Crossover skins? And Crossover titles". Timed crossover events with a partner (another game, a YouTube creator or a brand): skins in the partner's style and a title earned during the event. Placed: roadmap "Camp, social, and events" and Future Updates ("crossovers", no patch number); *recommended* after 2.0, when skins exist (titles are live since 1.7). Each crossover needs the partner's written permission for their characters, names or logos; skins change looks only.
