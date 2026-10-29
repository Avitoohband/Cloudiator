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
