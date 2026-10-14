# Full-screen camp and visitor viewing — design

Date: 2026-10-14. Approved in conversation by Avi on 2026-10-14. This amends the approved [game design](2026-10-11-gladiator-arena-design.md). It is implemented in plan Task 13, together with one small backend step for visitor access.

## Intent

**Avi's vision:**
- The whole screen is the camp.
- Menus float on the camp and appear only when hovered or clicked.
- Anyone who opens the game can watch the camp and everything in it, including Arena fights, before signing in.
- To join, a visitor signs in with Google and creates a gladiator.

**Success criteria:**
- A first-time visitor sees a living, full-screen camp with nothing covering it but a faint menu grip and one "Sign in with Google to join" chip.
- They can open every public menu and watch fights, replays and expeditions without an account.
- No private data reaches them, and no action is possible without signing in.
- A signed-in player manages everything from the same screen.

## Decisions (Avi, 2026-10-14)

1. **Visitors see everything a signed-in spectator sees, read-only:**
   - the camp and live fights;
   - replays and other gladiators' expeditions;
   - standings and tournament brackets;
   - public gladiator profiles;
   - Marketplace listings, to browse.

   They never see wallets, inventories, schedules, owner-only summaries, seeds or private plans.
2. **Menus live on an icon rail on the left edge, hidden until hovered.**
3. **The menu list is the eight below, as proposed.** Avi may change it after play-testing.

## Screen

- **Camp.** The camp scene fills the browser window: no page header, footer or side column. Both the site root `/` and `/game/` render this same shell, so the shared link opens straight onto the camp.
- **Camera.** Drag, wheel and pinch work as today. The zoom buttons move to the bottom of the rail. Find and Follow move into the Gladiators panel.
- **At rest.** Only two things are visible:
  - a faint grip, 5 px wide, at the vertical middle of the left edge;
  - a corner chip, top right: "Sign in with Google to join" for visitors, or for a player their name, stamina, money, renown and the slot countdown.
- **Rail.** Moving the pointer within 12 px of the left edge, or over the grip, slides in a slim column of icons. Hovering an icon shows its name.
  - The rail slides away when the pointer leaves, unless a panel is open.
  - Keyboard: the first Tab reveals the rail and focuses its first icon. Tab order is the rail icons, then the corner chip. Esc closes the open panel and returns focus to its icon.
- **Panels.** Clicking an icon opens a floating panel beside the rail, over the camp. One panel is open at a time. Clicking the camp, pressing Esc, or clicking the same icon closes it. Panels scroll internally and never cover the corner chip.
- **Phones and touch.** Touch has no hover, so a small round ☰ button sits in the bottom-left corner. Tapping it shows the icons as a row; a menu opens as a bottom sheet, closed by swiping it down or with its × button. The corner chip shrinks to a name and countdown.
- **Reduced motion.** The rail and panels appear without sliding animations.

## Menus

| Icon | Menu | Player | Visitor |
| --- | --- | --- | --- |
| 🛡 | My gladiator | Stats, class, gear and build, stamina, level | "Sign in with Google to create your gladiator" |
| 🗓 | Schedule | The repeating morning, afternoon and evening plan | Not shown |
| 🎒 | Inventory and shops | Inventory, weapon smith, armorer | Not shown |
| 💰 | Marketplace | Buy, sell, list, cancel | Browse listings only |
| ⚔ | Arena | Current and next bout, standings | Bouts and standings |
| 🏆 | Tournaments | Countdown, registration, brackets | Countdown and brackets |
| 📜 | Results | Recent results and replays | Public recent results and replays |
| 👥 | Gladiators | List everyone; find or follow one on the map | Same |

**Clicking a gladiator** in the camp opens their public profile card. A player's own gladiator also shows management shortcuts.

## Scenes

- An **expedition** or **replay** opens as a full-screen scene over the camp, with a "Back to camp" button, instead of navigating to a separate page.
- The existing `/expedition/` and `/replay/` routes keep working as direct links, for sharing, for visitors and players alike.

## Visitor access (backend)

- **Spec change.** "Initial reads are authenticated" (the plan's global constraints and spec §10.5) becomes:
  > Public projections are readable by anyone, including visitors who have not signed in. Private reads and all commands require Google sign-in, and the acting character is bound to the verified account.

  Two related lines change with it:
  - §10.6: "explicit authenticated-player policies for safe public projections" becomes "explicit read-only policies for visitors and signed-in players on safe public projections".
  - §13 item 11: the unauthenticated access tests also prove that public projections are readable and read-only.
- **Readable by visitors (the `anon` role), read only.** Only the existing sanitized public projections:
  - world actors, the revision record and public profiles (with equipped gear);
  - public activity stages and their revealed battle and expedition logs, with `completion` only, never the owner summary (these feed Results and replays);
  - standings;
  - the public tournament view;
  - Marketplace listings.

  Every private table, owner view, function and command stays denied to `anon`. The guessed-ID rule `reveal_at <= database time` applies to visitors exactly as it does to signed-in readers.
- **Implementation.** One new migration adds `anon` select policies and grants to exactly those public objects, and nothing else. The live gateway reads them without a session; commands still require one.
- **Tests.** An access-denial suite proves, as `anon`, that every private table, view, function and command is refused, and that guessed future IDs return nothing. Browser tests check that a visitor can open every public menu and scene, and that no command is sent.
- **Budget.** Visitor reads add egress and requests. Polling stays at the 30-second revision read and logs load on demand. Task 23 measures visitor load against the free-plan budgets.

## Joining

1. The visitor clicks "Sign in with Google to join" (the existing Task 5 flow).
2. Back in the game:
   - with no gladiator yet, the "Create your gladiator" dialog opens over the camp (the existing creation form);
   - with one, the player chip and the player menus appear.
3. The camp keeps running throughout. A failed or cancelled sign-in returns to the visitor view with a short message.

## Errors and accessibility

- **Scene unavailable** (no WebGL, or the art failed to load): the menus and panels still work over a plain background, with the notice the camp already shows today.
- **Keyboard and labels.** Every world click has a keyboard equivalent in the menus (the Gladiators list, the Arena bout list), as today. Focus is managed when panels open and close. The rail, icons and panels have accessible names. Names render as React text.
- **Small screens.** At 360 px wide there is no horizontal scroll, and sheets fit the viewport.

## Out of scope

- New game features: the menus host existing panels, re-housed.
- Hosted sign-in configuration (Task 24).
- Visitor-load measurement (Task 23).

## Plan impact

- **Task 13** ("Complete owner management over the animated world") is rebuilt around this shell. It also delivers the visitor mode and the joining flow, and it absorbs the gates already recorded for it: the shared sync clock, roster links, live reader flips and the replay clock.
- One backend step precedes the UI: the anonymous public-read migration and its access-denial tests.
- The plan text for Task 13 is updated when its implementation plan is written.
