# Game messages and a free look change (design)

Avi, 2026-10-27: "I want that the players will get message from the game, each time there is update, there will be patch
notes. It will appear near the upper bar." Players "see notification on messages icon near their character name bar. The
number of messages appear in a circle. They open it and can read messages, usually messages from admin, from game, and
patch notes." And: "when the appearance update go live, I want the players to have a 'free' change look option they will
see in the messages." Asked how often: "for now make it unlimited. add a disclaimer that says it temporary. and will cost
in the future." Avi approved the clickable mockup (https://claude.ai/artifact/TBTq5ik1vgQZSzGw9tiopD, desktop and phone)
with "Yes". Decisions marked **Claude's call** were stated to Avi with the mockup or are settled here for the builder.

## Intent

Players have no way to learn what changed in the game, and Avi has no way to talk to them. Since the appearance release
(M24, live 2026-10-27), new gladiators choose a look, but every gladiator created before it keeps the legacy look and
cannot change it: the M24 design kept changing a look for a future real-money shop. This change gives the game a voice
(patch notes with every update, messages from Avi) and uses its first patch note to let every player change their
gladiator's look, free for now.

## Goals

1. **A messages button** left of the signed-in HUD pill (name, energy, gold, stars, slot timer), with a red circle holding
   the number of unread messages (Avi). It shows wherever the pill shows.
2. **The messages panel** opens from the button: newest first, each row with its tag (**Patch notes** or **Admin**), date,
   title and a one-line preview, unread rows marked with a gold dot and a bold title. Opening a message shows its full
   text, with Back to the list and a Close button. Reading a message marks it read for that account on every device, and
   the count drops.
3. **Patch notes with every update** (Avi): each release players can see gets one Patch notes message in plain words.
   Admin messages carry Avi's own text.
4. **Change look, free and unlimited for now** (Avi): the appearance patch note holds a **Change look** button that opens
   the look picker (the creation dialog's look step, same options and preview) on the gladiator's current look. **Save
   look** stores it at once; the camp, expeditions and replays draw it. The message and the picker both say (Avi's
   disclaimer): "**Free for now**, as often as you like. This is temporary: changing your look will cost something in the
   future." After saving, a status line confirms: "Look saved. <name> wears it in camp now."

## Non-goals

- **Game messages** (sales, tournament results, rewards), shown in the mockup as an example: a later change
  (**Claude's call**, stated with the mockup). The storage leaves room for them.
- A price, a shop or any limit on look changes. Pushes, e-mail or notifications outside the game. Replies, deleting
  messages, or messages from player to player. An admin screen: Claude posts messages for Avi.
- Any change to combat, stats, rewards, matchmaking or what a look is (options, palettes, art).

## Anti-goals

- A message that can run script or carry markup: titles and text are shown as plain text only.
- A look change checked only in the client, or one that changes another player's gladiator.
- A look change that costs anything now, or a limit Avi did not ask for.
- A new player greeted by a badge full of old patch notes.
- A message that only some devices of the same account see as read.
- Editing a committed migration (this is M25).

## Decisions (Claude's calls)

- **Who sees messages:** signed-in players with a gladiator (the HUD pill's audience). Visitors and accounts without a
  gladiator see no button.
- **Unread:** a message counts as unread for an account when it was published after that account was created and the
  account has not read it. Older messages are listed but already read, so a new player starts at no badge. All 9 live
  accounts predate this release, so they see the new messages as unread.
- **Badge:** the number, "9+" above 9, hidden at 0. The button's name says the count ("Messages, 2 new").
- **Storage:** broadcast messages (one row per message: kind, title, preview, body, optional action, published time, a
  hidden flag) and per-account read marks (account, message, read time). `kind` is `patch-notes` or `admin` (see "Settled
  from the code map" for Game messages); the only `action` now is `change-look`. Clients never write either table; a read
  mark is written by a game command (`read-message`), only for the caller's own account, and a repeat is a no-op.
- **Message text:** a title (at most 80 characters) and a body of paragraphs and bullet items (plain text, at most 2,000
  characters in all), stored as data, not markup, and rendered as text.
- **Posting:** Claude posts messages through an operator-only database function (post, and hide for a mistake) run with
  the linked CLI, after Avi's go like any production write. Each player-visible release adds posting its patch note to the
  release steps; a message is posted only once the client that can show it is live.
- **First messages:** the patch note for the 26 Oct releases and the appearance patch note (with **Change look**), word for
  word in "Settled after the builder check"; Avi sees them again in the release request. Admin messages only when Avi
  writes one.
- **Change look command:** a new game command (`change-appearance`) with the five-key look, validated by the Edge parser
  and in SQL exactly as at creation, for the caller's own gladiator only; free, no count, no cooldown beyond the existing
  command limits. It refreshes that gladiator's public read so other players see the new look on their next read. A
  replay draws each gladiator's current look (as since M24); old replays show the new look too.
- **The picker opens on the current look.** A legacy gladiator opens on male, short hair and the colours it shows today
  (the palette indices `tintFor` picks), so opening and saving without a change keeps its look. **Save look** is disabled
  until something changes; **Cancel** keeps the old look. No Random button here (it is a creation aid).
- **Where Change look lives:** only in the appearance message for now (Avi: "they will see in the messages").
- **Reading the inbox:** when the game loads, when the panel opens and at a slow interval (every few minutes, not every
  poll); a read mark updates the count at once. Messages are tiny; no retention rule.
- **Layout (mockup):** the button is a 44 px round dark button 8 px left of the pill; the badge sits on its top right.
  Desktop: the panel drops below the HUD at the right edge, about 380 px wide. Phone (360 px and up): the panel spans the
  screen width below the HUD; the look picker is a full-height dialog. Tag colours: Patch notes gold, Admin violet, Game
  teal (later).
- **Accessibility:** the button reports `aria-expanded`; the panel is a labelled region that returns focus to the button on
  close; rows are real buttons; the look picker is a modal dialog with the creation step's 44 px targets and named
  swatches; the saved line is a status message; reduced motion shows a still preview.

## Settled from the code map (Claude's calls)

- **Messages are public text; read marks are the owner's.** The access matrix allows a non-owner `authenticated` read
  only through its open (`OPEN`) list, which also opens to visitors, and a broadcast row carries no owner id. Patch notes
  and messages to all players are not secret, so the messages table joins `OPEN` (visible rows only; the client still
  shows the button only to players), and the read marks are an owner-only table. The owner read (`owner_state`, re-read
  on revision change, slot change and focus) carries only a small `inbox` (unread count and the ids read); the message
  list loads when the panel opens. Posting or hiding a message bumps the world revision (the projection trigger), so
  badges update within one poll. Per-player Game messages, later, need their own owner-scoped storage: this table holds
  only `patch-notes` and `admin`.
- **Unread uses the gladiator's creation time** (`gladiators.created_at_ms`), which the owner read already has; the
  account's own creation time is not readable there. Only players with a gladiator see messages, so the two agree in
  practice.
- **A read mark writes no receipt.** Receipts are permanent (`private.guard_receipt` blocks deletes), and one per opened
  message would pile up. `read-message` follows the `presence` precedent: an idempotent upsert of the account's own mark,
  no receipt, then an owner re-read.
- **`change-appearance` follows the creation command's pattern** (lock, receipt replay, exact keys, `private.valid_appearance`),
  with a receipt like other state changes. Updating `gladiators.appearance` already re-projects the public actor and bumps
  the world revision, so other players redraw on their next world read (at most one poll later).
- **The picker is the existing `LookPicker`/`LookPreview`**, reused, not copied.
- **Known test edits:** `tests/db/appearance.test.ts` asserts the appearance migration is the last one, so M25 updates that
  assertion; the browser live-read fake (`tests/browser/live-routes.ts`) learns any new read; `resetIdentity` truncates the
  read-mark table if the `gladiators` cascade does not reach it; new functions get their access-matrix pins.

## Settled after the builder check (Claude's calls)

- **Dates are posting dates.** Messages are never back-dated: the posting function stamps the time of posting, and the
  panel shows that date. The two first notes are posted one after the other with this release, the launch note first, so
  the look note is newest and on top. Every live account predates both, so each starts with a badge of 2.
- **The first two patch notes, word for word** (the mockup's text; the 26 Oct note covers both releases of that day,
  launch feedback and the waiting monsters; the keyboard-focus fix of 27 Oct is too small to announce):

  1. Posted first. Title: **Evening Arena, waiting monsters, clearer menus**. Preview line: "Arena and tournaments move to
     the evening; market sales pay at least 1 gold." Body: the paragraph "What changed:" and the bullets
     - "Arena runs in the evening part of the day only. Wednesday and Saturday tournaments start in the evening too."
     - "Market sales pay a fee of at least 1 gold."
     - "On expeditions, each monster waits at its spot until its fight."
     - "Character creation, the schedule and equipped gear are easier to read and use."
  2. Posted second, with the `change-look` action. Title: **New: choose your gladiator's look**. Preview line: "Pick a
     body, hair and colours. Changing your look is free for now." Body:
     - "Gladiators now have their own look: a male or female body; short, long, ponytail or bald hair; and your choice of
       skin, hair and clothes colours."
     - "New gladiators choose a look when they are created. Yours keeps the original look until you change it."
     then the Change look button and the disclaimer quoted in Goal 4.

  The preview line is the first sentence-sized summary stored with the message (or derived from the body; the builder's
  call), so the list never cuts words mid-way.

## Added 2026-10-28: fixed class and points (same release)

Avi, while the plan was written: "for the spending attributes points in my gladiator menu, it is not obvious how many points
left for me to spend, and also I shouldn't be able to enter higher number than my max spare points." Then: "I shouldn't be
able to take points back as well. After saving it's fixed. In the future, for real money, people would be able to respec."
And: "class shouldn't be able to be changed as well, only stance, and the class change will cost real money." Asked when
points become fixed, he said "skip questions".

- **Points left:** the build's attribute step shows "{left} of {earned} left" ("All {earned} spent" at 0), as the creation
  dialog does, and a typed number above what is left is capped with the creation dialog's status line.
- **No respec, no class change:** a queued build keeps the current build's class, and no attribute may go below the
  current build's value. Today both cost game money (`RULES_V1.fees.classChange` and `fees.respec`, 100 gold each); from
  this release they are refused, so every allowed build change is free. Stance and equipment still change freely. Both
  will come back later as paid (real-money) options; nothing about that is built now.
- **When points become fixed (Claude's call, after "skip questions"):** when the build takes effect at the next boundary.
  Until then a pending build can still be revised down to the current build or cancelled, so a typo can be fixed. This is
  the floor the server enforces; a stricter "fixed at Queue build" would make a typo permanent and complicate cancelling.
- **Server first:** the Edge build preparation and the SQL build command both refuse a class change or a lower attribute
  (`invalid`); the client only stops a player from asking. Pending builds queued before the release keep their fee and
  apply as queued.
- **Copy:** the class is shown, not chosen ("Class: Berserker"); the note under the points reads "Adding points is free.
  Points can't be taken back once this build takes effect, and your class is fixed. Respec and class changes will come
  later as paid options." A number typed below the current build's value is raised to it with the line "{Attribute} can't
  go below {n}: added points are permanent."

## Added 2026-10-28: notifications (same release)

Avi: "in the messages, add section for notification: what I received in training, how much exp/points, if I levelled; what
I received in expedition, which gear dropped, how much money earned." This replaces the non-goal "Game messages" for the
player's own results.

- **Two sections in the panel:** **Messages** (patch notes and Admin, as above) and **Notifications**, each with its own
  count; the button's badge is the sum.
- **A notification per settled activity**, newest first, built from the owner's own settled activity summaries (already
  owner-only under RLS, the same data the result screens use), so nothing new is stored per result: Training (XP, attribute
  points), Expedition (destination, result, money, XP, each item found with its tier and rarity, extra items sold for
  gold), Arena (victory or defeat, renown, rating change) and Tournament (result, money, renown). Rest gives nothing and is
  left out (**Claude's call**). "Level up! Now level {n}" shows on the activity that raised the level; how the level change
  is known is the builder's (stored settlement data first; never a guess shown as fact).
- **New since last seen:** one "seen up to" time per account, server-side, so every device agrees. Opening the
  Notifications section marks everything shown as seen (a `see-notifications` command, no receipt, never moves backwards).
- **Only revealed results:** a notification appears once its result is visible to the owner (the timeline's own rule),
  never before an Arena or tournament reveal.
- **At most the newest 20** are listed; older results stay in the existing result screens.

## Constraints

- Production is live with 8 gladiators and 9 accounts; M25 must replay cleanly on the live schema and change no
  gladiator's look by itself.
- The bench is gone (24.12): the release gate of record (12/12, private config) and the deployed checks are the evidence;
  production needs Avi's go in chat (`db push`, `functions deploy`, the `release` fast-forward and each message post).
- Every new table, view and function passes the access audit and the catalog-driven access matrix (no client write
  privilege).
- Deploy outside Wed/Sat 17:20–20:00 UTC, with no open boundary.

## Left to the builder

Component structure, the exact read shape and polling interval, the migration's internal shape, test layout, and copy
beyond what is quoted here and in the mockup.
