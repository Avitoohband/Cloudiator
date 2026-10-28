# Next Patch: Game Messages, Notifications, Free Look Change, Fixed Builds, Gold, Bigger Beds and Fuller Expedition Replays

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players get a messages inbox beside the HUD with patch notes (the first offers a free, unlimited look change),
and the build step shows the points left, caps typing, and no longer lets a class change or points go back.

**Architecture:** One new migration (M25) from two reapplicable sources: messages are public rows in an `OPEN` table,
read marks an owner-only table, and the owner read carries a small `inbox`; two new game commands (`change-appearance`
with a receipt, `read-message` without one); the build command refuses a class change or a lower attribute in the Edge
preparation and in SQL. The client adds a messages button and panel to the corner chip, a change-look dialog that reuses
`LookPicker`, and a clearer attribute step in `BuildPanel`.

**Tech Stack:** Next.js 16.4.3 static client, Deno Edge function `game-command` (shared `supabase/functions/_shared`),
Supabase Postgres 17 (CLI 2.120.0), Vitest, Playwright (`channel: 'chrome'`).

**Spec:** `docs/superpowers/specs/2026-10-27-game-messages-design.md` (including "Added 2026-10-28: fixed class and
points"); code map `docs/superpowers/specs/2026-10-27-game-messages-code-map.md` (lines as of `7d87fe4`).

## Global Constraints

- Message kinds `patch-notes` | `admin`; tags shown "Patch notes" | "Admin"; the only action `change-look`. Title 1–80
  characters, preview 1–140, body 1–20 blocks `{ "p": text }` or `{ "li": text }` with at most 2,000 characters in all;
  rendered as plain text only.
- Unread: published after the gladiator's `created_at_ms` and not read by the account. Badge: the number, "9+" above 9,
  hidden at 0; button name "Messages, {n} new" or "Messages".
- Disclaimer, in the message and the dialog: "**Free for now**, as often as you like. This is temporary: changing your look
  will cost something in the future." Saved line: "Look saved. {name} wears it in camp now."
- Look change: free, unlimited, own gladiator only, validated as at creation; opens on the current look (legacy → male,
  short, the colours `tintFor` shows).
- Builds: class fixed; no attribute below the current build's value; every allowed change costs 0; points become fixed when
  the build takes effect. Copy exactly as in the spec's "Added 2026-10-28" section.
- The three first patch notes are word for word as in the spec ("Settled after the builder check"), posted launch note
  first, then the look note, then this release's note (bigger beds, crediting Punchy).
- Committed migrations are never edited (new M25, completed and replayed per AGENTS.md, every CHECK after the function it
  calls, access audit after the migration); TDD; DB-test rule; no package downloads; gate of record
  `node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs` 12/12 with the local Edge serve running.
- Production writes need Avi's go in chat at release time; deploy outside Wed/Sat 17:20–20:00 UTC with no open boundary.

## Review Focus

1. A legacy gladiator that opens Change look and saves nothing keeps exactly its look: Save stays disabled until a choice
   changes, and `legacyAppearance(id)` draws exactly like `null` (Tasks 2 and 7).
2. A message whose text contains `<b>x</b>` or `<script>` shows those characters literally (Task 6 test).
3. A player created after a message was posted sees it listed as read with no badge; an older player sees it unread
   (Task 3 DB test, Task 6 browser test).
4. In the build step, typing 99 caps at the field's value plus the points left, and typing below the current build's value
   is raised back with the "can't go below" line (Task 5 tests).
5. A message posted while the panel is open shows after the next owner read, without reopening the panel (Task 6 test).

---

### Task 1: Fixed class and points (rules and server)

**Files:**
- Modify: `supabase/functions/_shared/domain/build.ts` (add `lockedChange`), `supabase/functions/_shared/backend/database.ts`
  (`prepareBuild` refuses a locked change as `invalid`)
- Create: `supabase/sql/18-messages.sql` section 1: `private.planning_command` restated from `16-launch-feedback.sql` with,
  in the `queue-build` branch, `err:='invalid'` when `c->>'classId'` differs from `b.current_build->>'classId'` or any
  attribute of `c->'allocation'` is below `b.current_build->'allocations'`, and the fee rule `fee<>0` → `invalid` (was
  `fee not in (0,100,200)`)
- Test: `tests/domain/build.test.ts`, `tests/backend/commands.test.ts` (or the prepare-build test beside it),
  `tests/db/build-locks.test.ts` (new); update every existing test that expects a 100 or 200 build fee
  (`grep -rn "classChange\|respec\|fee: 100\|fee: 200" tests`)

**Interfaces:**
- Produces: `lockedChange(current: BuildInput, next: BuildInput): 'class' | 'points' | null`. `buildChangeFee` is unchanged
  and returns 0 for every change `lockedChange` allows.

- [ ] **Step 1: Failing tests**: `lockedChange` is `'class'` for another class, `'points'` when any attribute is one lower,
  `null` for a stance change, an equipment change and +1 on any attribute; `prepareBuild` refuses a class change and a
  decrease; DB: a class change and a decrease are refused `invalid` with no reservation and no new build version; a stance
  change plus one point is accepted with `reservedMoney` 0; a pending build may be revised down to the current build's
  values (not below) and still be cancelled.
- [ ] **Step 2: Run** `npx vitest run tests/domain/build.test.ts tests/backend` and `npm run test:db -- tests/db/build-locks.test.ts`; expect FAIL.
- [ ] **Step 3: Implement**; apply `18-messages.sql` locally with the psql fallback (container label check first).
- [ ] **Step 4: Run** the step 2 commands and the existing planning tests; expect PASS.
- [ ] **Step 5: Commit** `feat: keep the class and added points of a build`.

### Task 2: The change-appearance command

**Files:**
- Modify: `supabase/functions/_shared/contracts/commands.ts` (`{ kind: 'change-appearance'; appearance: Appearance }`),
  `backend/commands.ts` (`parseCommand` case `shape('appearance') && validAppearance(value.appearance)`, the kind
  allow-list, dispatch), `backend/database.ts` (`changeAppearance`, added to `CommandDependencies`), `src/lib/api/gateway.ts`
  (client allow-list), `src/game/actors.ts` (`legacyAppearance`)
- Modify: `supabase/sql/18-messages.sql` section 2: `public.change_appearance(actor_id uuid, operation_id uuid, input
  jsonb) returns jsonb`, shaped like `public.set_tournament_opt_in` (account lock, receipt replay and `conflict`, keys
  exactly `appearance`, `kind`, `operationId`, `private.valid_appearance`, own gladiator `for update`, `not-found` without
  one, update only when distinct, receipt), result `{ ok: true, receiptId, value: { appearance, receivedAtMs } }`; EXECUTE
  for `service_role` only
- Test: `tests/backend/commands.test.ts`, `tests/db/change-appearance.test.ts` (new), `tests/game/actors.test.ts` (or
  where `lookFor` is tested), access-matrix pins for the new function

**Interfaces:**
- Produces: `legacyAppearance(gladiatorId: string): Appearance` (male, short, skin `(h>>>11)%5`, hairColor `(h>>>5)%6`,
  cloth `h%12` with `h = hashString(gladiatorId)`); command result value `{ appearance: Appearance; receivedAtMs: number }`.

- [ ] **Step 1: Failing tests**: `lookFor(legacyAppearance(id), id, s)` equals `lookFor(null, id, s)` for 50 ids;
  `parseCommand` accepts a valid change and refuses each invalid look of the appearance tests and an extra key; DB: a
  legacy gladiator changes to a chosen look and `world_actors` shows it and the world revision rises; three changes in a
  row all apply (no limit); the same operation id replays the stored result and a different body under it is `conflict`;
  an account without a gladiator gets `not-found`; an invalid look writes nothing.
- [ ] **Step 2: Run** `npx vitest run tests/backend tests/game` and `npm run test:db -- tests/db/change-appearance.test.ts`; expect FAIL.
- [ ] **Step 3: Implement**; reapply the source.
- [ ] **Step 4: Run** the step 2 commands; expect PASS.
- [ ] **Step 5: Commit** `feat: let a player change their gladiator's look`.

### Task 3: Messages, read marks and the inbox

**Files:**
- Modify: `supabase/sql/18-messages.sql` section 3:
  - `private.valid_message_body(body jsonb) returns boolean` (the Global Constraints shape), then
    `public.game_messages(id bigint generated always as identity primary key, kind text check (kind in ('patch-notes','admin')),
    title text, preview text, body jsonb check (private.valid_message_body(body)), action text check (action is null or
    action='change-look'), published_at_ms bigint not null, hidden boolean not null default false)` with the length checks;
    RLS on, `select` for `anon` and `authenticated` with a policy `using (not hidden)`; the deferred `projection_changed`
    constraint trigger (insert, update, delete) so a post or hide bumps the world revision
  - `public.message_reads(owner_id uuid references auth.users(id) on delete cascade, message_id bigint references
    public.game_messages(id) on delete cascade, read_at_ms bigint not null, primary key (owner_id, message_id))`; owner-only
    RLS on `(select auth.uid())`, `select` for `authenticated`, DML for `service_role` only
  - `public.read_message(actor_id uuid, message_id bigint) returns jsonb`: a visible message → insert the mark `on conflict
    do nothing`, `{ ok: true, value: { messageId } }`; missing or hidden → `{ ok: false, code: 'not-found' }`; no receipt;
    EXECUTE for `service_role` only
  - operator-only `private.post_message(kind text, title text, preview text, body jsonb, action text default null) returns
    bigint` (stamps `clock_timestamp()` in ms) and `private.hide_message(message_id bigint) returns boolean`; no client or
    `service_role` EXECUTE
  - `public.owner_state` restated from `17-appearance.sql` plus `'inbox', jsonb_build_object('unread', …, 'readIds', …,
    'sinceMs', g.created_at_ms)`
- Modify: `contracts/commands.ts` (`{ kind: 'read-message'; messageId: number }`), `backend/commands.ts` (parse
  `shape('messageId')` with a positive safe integer; dispatch without a receipt), `backend/database.ts` (`readMessage`),
  `contracts/reads.ts` (`OwnerState.inbox: Inbox`, `GameMessage`, `MessageBlock`), `src/lib/api/reads.ts`
  (`readMessages`: newest 50 by `published_at_ms` then `id`, descending), `gateway.ts` (`messages()` through `publicRead`;
  `read-message` in the allow-list), `fixture-gateway.ts`, every `OwnerState` literal (typecheck lists them),
  `tests/fixtures/access.ts` (`game_messages` joins `OPEN`), `tests/fixtures/db.ts` (`resetIdentity` truncates both
  tables, restarting identity), `tests/browser/live-routes.ts` (`game_messages` in `tables()`)
- Test: `tests/db/messages.test.ts` (new), `tests/backend/commands.test.ts`, `tests/api/*gateway*.test.ts`, the access
  matrix and retention tests as they follow `OPEN`

**Interfaces:**
- Produces: `type Inbox = { unread: number; readIds: number[]; sinceMs: number }`; `type MessageBlock = { p: string } | { li:
  string }`; `type GameMessage = { id: number; kind: 'patch-notes' | 'admin'; title: string; preview: string; body:
  MessageBlock[]; action: 'change-look' | null; publishedAtMs: number }`; `GameGateway.messages(): Promise<GameMessage[]>`.

- [ ] **Step 1: Failing tests**: posting as `postgres` returns an id and raises the world revision; `anon`,
  `authenticated` and `service_role` cannot execute `post_message` or `hide_message`; a bad kind, an 81-character title, a
  body with an unknown key, an empty block or 2,001 characters is refused; visitors and players read visible rows only
  (a hidden one disappears); `read_message` marks only the caller's account, a repeat is a no-op, a hidden or missing id is
  `not-found`, and no receipt row is written; `owner_state.inbox`: a message posted before the gladiator was created is not
  counted, one after is, reading it lowers `unread` and adds its id to `readIds`, and a second session of the same account
  sees the same; `parseCommand` accepts `read-message` with id 1 and refuses 0, 1.5, a string and an extra key.
- [ ] **Step 2: Run** `npm run test:db -- tests/db/messages.test.ts` and `npx vitest run tests/backend tests/api`; expect FAIL.
- [ ] **Step 3: Implement**; reapply the source; update the literals and fixtures.
- [ ] **Step 4: Run** the step 2 commands, `npm run typecheck` and `npx vitest run`; expect PASS.
- [ ] **Step 5: Commit** `feat: store game messages and each player's read marks`.

### Task 3b: Notifications (server and reads)

Spec "Added 2026-10-28: notifications".

**Files:**
- Modify: `supabase/sql/18-messages.sql` section 4: `public.notification_marks(owner_id uuid primary key references
  auth.users(id) on delete cascade, seen_ms bigint not null)` owner-only like `message_reads`;
  `public.see_notifications(actor_id uuid, up_to_ms bigint) returns jsonb` (stores `greatest(old, least(up_to_ms, now))`,
  no receipt, `service_role` EXECUTE only); `owner_state.inbox` gains `newNotifications` (the owner's completed, revealed,
  non-rest activities settled after the mark, or after the gladiator's creation without one) and `notificationsSeenMs`
- Modify: contracts (`{ kind: 'see-notifications'; upToMs: number }`, `Inbox` gains `newNotifications: number;
  notificationsSeenMs: number`, `GameNotification`), `backend/commands.ts` and `database.ts` (as `read-message`),
  `src/lib/api/reads.ts` (`readNotifications`: the owner's completed activities with `settled_at_ms` at or before the
  server's now, newest 20, `id, summary, settled_at_ms` plus whatever names the destination), `gateway.ts`
  (`notifications()`, the command allow-list), `fixture-gateway.ts`, `src/features/messages/notifications.ts`
  (`notificationLines(n: GameNotification): { title: string; lines: string[]; levelUp: number | null }`)
- Test: `tests/db/notifications.test.ts`, `tests/features/notifications.test.ts`, `tests/backend/commands.test.ts`

**Interfaces:**
- Produces: `type GameNotification = { activityId: string; kind: 'training' | 'expedition' | 'arena' | 'tournament';
  settledAtMs: number; summary: ActivitySummary; destination: string | null; levelAfter: number | null }`;
  `GameGateway.notifications(): Promise<GameNotification[]>`.

- [ ] **Step 1: Failing tests**: DB: a settled training after the gladiator's creation counts 1 new; `see_notifications`
  sets the mark, a lower `up_to_ms` never moves it back, a future one is cut to now, another account's mark is untouched;
  an unrevealed Arena result is not counted; a rest is not counted. Units: `notificationLines` for training ("+40 XP",
  "+1 attribute point"), an expedition with money, XP, a Rare Iron sword (tier 5) and an overflow sale, an Arena victory
  with renown and rating change, and "Level up! Now level 4" only when `levelAfter` is set.
- [ ] **Step 2: Run** `npm run test:db -- tests/db/notifications.test.ts` and `npx vitest run tests/features tests/backend`; expect FAIL.
- [ ] **Step 3: Implement**; decide `levelAfter` from stored settlement data and ledger the ruling.
- [ ] **Step 4: Run** the step 2 commands and `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: notify players of their own results`.

### Task 4: M25

**Files:**
- Create: `supabase/migrations/<generated>_messages.sql` (`db pull messages --local --schema public,private --yes`, completed
  and replayed per AGENTS.md: ACLs, RLS, invoker view, each CHECK after its function, the projection trigger, schema reload)
- Modify: `tests/db/appearance.test.ts` (the "appearance migration is the last" assertion becomes "M24 is
  `20261026160844_appearance.sql`, and exactly one file ends `_appearance.sql`"), the migration-count pins (24 → 25, e.g.
  `tests/db/restore-hosted.test.ts`), `docs/operations/migrations.md` (M25 record with its release order),
  `docs/operations/runbook.md` (new section "Posting a game message": `post_message` and `hide_message` through
  `db query --linked` after Avi's go, never before the client that shows messages is live)

- [ ] **Step 1: Generate and complete M25**; `db reset --local --no-seed --yes`; inspect the replayed functions,
  `search_path`, ACLs, policies, triggers and the invoker view.
- [ ] **Step 2: Run** the access audit (`scripts/access-audit.sql`, `tests/db/access-matrix.test.ts`), the full
  `npm run test:db` under the DB-test rule, lint and advisors `--local`; expect PASS.
- [ ] **Step 3: Commit** `feat: messages, read marks, look changes and fixed builds (M25)`.

### Task 5: The build step: points left, capped, class fixed

**Files:**
- Modify: `src/features/character/creation-points.ts` (`pointsLeft(allocation, total)`, `setPoints(allocation, key, wanted,
  total, floor?)` with `floor` defaulting to zero, a `raised` flag beside `capped`, and `raisedNote(name, floor)` returning
  "{Name} can't go below {floor}: added points are permanent."), `CreateCharacter.tsx` (passes `creationPoints`),
  `src/features/build/BuildPanel.tsx` (class as text "Class: {Class}", no class select; the counter "{left} of {earned}
  left" / "All {earned} spent"; inputs `min` = the current build's value and `max` = value + left; typed values through
  `setPoints` with the current build as `floor`; the capped and raised status lines; the spec's note replaces the respec
  line; the "Estimated reservation" line goes, every change being free)
- Test: `tests/domain/creation-points.test.ts`, `tests/browser/planning.spec.ts` (or the spec that covers `BuildPanel`)

- [ ] **Step 1: Failing tests**: units for the total and floor parameters (creation unchanged); browser: with 12 earned
  and 9 spent the counter reads "3 of 12 left"; typing 99 into Strength sets value + 3 with the capped line; typing 0 into
  an attribute the current build has at 4 sets 4 with "Strength can't go below 4: added points are permanent."; no class
  select exists and "Class: Berserker" shows; Queue build sends the current class.
- [ ] **Step 2: Run** `npx vitest run tests/domain/creation-points.test.ts` and the browser spec; expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the step 2 commands and the creation browser tests; expect PASS.
- [ ] **Step 5: Commit** `feat: show the points left and keep added points in the build`.

### Task 6: The messages button and panel

**Files:**
- Create: `src/features/messages/messages.ts` (`badgeText(unread: number): string | null`, `isUnread(message: GameMessage,
  inbox: Inbox): boolean`, `messageDate(ms: number): string` like "27 Oct"), `src/features/messages/MessagesButton.tsx`,
  `src/features/messages/MessagesPanel.tsx`, `src/features/messages/messages.module.css`
- Modify: `src/features/shell/CornerChip.tsx` (the button in `.chipRow` before the toggle, when an owner is shown),
  `src/features/shell/CampShell.tsx` (loads `gateway.messages()` on open, sends `read-message` then `refreshOwner`,
  reloads the open list when `inbox.unread` changes, opens the change-look dialog from the action)
- Test: `tests/features/messages.test.ts` (units), `tests/browser/messages.spec.ts` (new)

**Interfaces:**
- Consumes: Task 3's `Inbox`, `GameMessage`, `GameGateway.messages()`, the `read-message` command.
- Produces: `MessagesButton({ inbox, load, loadNotifications, read, seeNotifications, changeLook }: { inbox: Inbox; load():
  Promise<GameMessage[]>; loadNotifications(): Promise<GameNotification[]>; read(id: number): Promise<void>;
  seeNotifications(upToMs: number): Promise<void>; changeLook(): void })`.

- [ ] **Step 1: Failing tests**: units for `badgeText` (0 → null, 2 → "2", 10 → "9+") and `isUnread`; browser: a visitor
  sees no button; a player with 2 unread sees "Messages, 2 new" and a "2" badge; the panel lists newest first with tags,
  dates and previews; opening the look note sends `read-message` with its id and the badge drops after the owner re-read;
  Back and Close work, Escape closes and the focus returns to the button; a message text with `<b>x</b>` shows literally;
  bullets render as a list; a message posted while the panel is open appears after the next owner read; 12 unread show
  "9+"; at 360 × 740 the panel fits with no sideways scroll; the a11y helpers find no contrast or name issue. With Task 3b:
  the panel has two tabs, "Messages" and "Notifications", each with its count; the badge is their sum; opening
  Notifications sends `see-notifications` with the newest shown time and its count clears after the owner re-read; a
  notification lists its lines (items by name, tier and rarity) and a "Level up!" line when there is one.
- [ ] **Step 2: Run** `npx vitest run tests/features/messages.test.ts` and
  `npx playwright test --config node_modules/.cache/pw-claude.config.mjs tests/browser/messages.spec.ts`; expect FAIL.
- [ ] **Step 3: Implement** as the spec's Layout and Accessibility decisions say.
- [ ] **Step 4: Run** the step 2 commands; expect PASS.
- [ ] **Step 5: Commit** `feat: show game messages beside the corner chip`.

### Task 7: The change-look dialog

**Files:**
- Create: `src/features/character/ChangeLookDialog.tsx` (modal `role="dialog"`, title "Change your look", the disclaimer,
  `LookPicker` on `owner.appearance ?? legacyAppearance(owner.gladiatorId)`, Cancel, Save look; sends `change-appearance`
  with one operation id reused on a transient retry; `refresh` then closes; a refusal shows "Your look could not be saved.
  Try again.")
- Modify: `CampShell.tsx` (opens it from the message action; on save shows the saved line as a status; focus returns to the
  messages button)
- Test: `tests/browser/messages.spec.ts`

**Interfaces:**
- Consumes: Task 2's command and `legacyAppearance`; Task 6's `changeLook()`.
- Produces: `ChangeLookDialog({ owner, gateway, refresh, onClose }: { owner: OwnerState; gateway: GameGateway; refresh():
  Promise<void>; onClose(saved: boolean): void })`.

- [ ] **Step 1: Failing tests**: Change look opens the dialog on the legacy look with Save disabled; choosing Female and
  Ponytail enables Save, which sends exactly `{ body: 'female', hair: 'ponytail', … }`; after the reply the dialog closes
  and "Look saved. Aster wears it in camp now." is announced; Cancel and Escape close without a command; a refusal keeps the
  dialog open with the error; at 360 × 740 the dialog fits and its targets are 44 px; reduced motion shows a still preview.
- [ ] **Step 2: Run** the browser spec; expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the browser spec; expect PASS.
- [ ] **Step 5: Commit** `feat: change a gladiator's look from the patch note`.

### Task 7b: The currency is called gold

Avi, 2026-10-28: "about the money, next patch change it to gold." Every word a player reads says gold. My call: internal
names stay (the `money` columns, JSON fields such as `money` and `overflowMoney`, the command and event contracts, the
`money` icon id), so no schema or contract change rides on a change of wording. The patch note in the spec already says
gold, and the Task 3b/6 notification lines say gold from the start.

**Files:**
- Modify (player text only): `src/features/market/market-text.ts`, `src/features/market/MarketPanel.tsx`,
  `src/features/inventory/InventoryPanel.tsx`, `src/features/inventory/gear.ts`, `src/features/build/build-refusal.ts`,
  `src/features/build/BuildPanel.tsx`, `src/features/schedule/schedule-text.ts`, `src/features/tournaments/tournament-text.ts`,
  `src/features/arena/BattleReplay.tsx`, `src/features/arena/StandingsPanel.tsx`, `src/features/character/ExpeditionView.tsx`,
  `src/features/character/CharacterPanel.tsx`, `src/features/character/CreateCharacter.tsx`, `src/features/shops/ShopPanel.tsx`,
  `src/features/shell/CornerChip.tsx` (labels and aria text).
- Test: `tests/domain/currency-word.test.ts` (new); the browser specs that expect the old word (`market`, `inventory`,
  `management`, `planning`, `expedition`, `full-screen`).

- [ ] **Step 1:** Write `tests/domain/currency-word.test.ts`: the amount formatter gives `'1,250 gold'` for 1250, and every
  text builder in `market-text`, `schedule-text`, `tournament-text`, `build-refusal` and `gear` (sample values) gives
  text that does `not.toMatch(/\bmoney\b/i)`. Run `npx vitest run tests/domain/currency-word.test.ts`: FAIL on
  "1,250 money".
- [ ] **Step 2:** Change the words in the files above ("money" → "gold", "Available money" → "Available gold"). Afterwards
  `git grep -n -i -w money -- src/features` lists only identifiers, never text. The test passes.
- [ ] **Step 3:** In `full-screen.spec.ts` (fixture preview) open every menu and assert
  `expect(page.locator('body')).not.toContainText(/\bmoney\b/i)`; change the specs that expected "money" to "gold". Run the
  private Playwright config: pass.
- [ ] **Step 4:** Commit `feat: call the currency gold`.

### Task 7c: Bigger beds in the camp (Punchy's request)

Avi, 2026-10-28: "about the beds, make those look better next patch, it is too tiny for the gladiators. In the patch
message for the beds, say that this is for Punchy request." Today the camp's 12 bedrolls (`bedroll-teal` and
`bedroll-crimson`) are one floor tile each, at x 15-19, y 35-41 on every second tile, beside gladiators who stand taller
than a tile. The credit line is in the spec's third patch note.

**Files:** `assets/source/generators/props.mjs` (the bed frames), `assets/source/generators/maps.mjs` (placement),
the regenerated camp atlas under `public/assets/camp/`, and `tests/assets` (station counts and footprints).

- [ ] **Step 1:** Design first, Avi's mockup rule: draw the new bed next to a gladiator at the camp's zoom, and show Avi
  a before-and-after over a real camp screenshot. The bed is sized for a gladiator lying on it (a footprint of at least
  1 × 2 tiles, a pillow end and a blanket; the generator's own palette), and the beds still give 12 rest spots. Build
  only after Avi approves the look.
- [ ] **Step 2:** Test first in `tests/assets`: 12 beds, each footprint as approved, no two overlapping, none on a path
  tile, and every bed reachable (the existing station-count and walkability tests extended). Run: FAIL on the old 1 × 1
  footprint.
- [ ] **Step 3:** Change the generators, rebuild with `node assets/source/build-assets.mjs` (then `--check`, which covers
  provenance), refresh the review sheets with `node assets/source/tools/review-sheets.mjs`, and check the camp's
  50-gladiator layout test still places everyone. As this is the next art release, also delete the old atlas files kept
  from the last one (`assets/source/retained.mjs`, the runbook's open item).
- [ ] **Step 4:** Look at it in the fixture preview at desktop and phone size next to the mockup Avi approved; commit
  `feat: bigger camp beds`.

### Task 8: Gate, review and release

- [ ] **Step 1:** Start the local Edge serve; run the gate of record; expect 12/12 (DB-test rule; no build during the
  browser run).
- [ ] **Step 2:** A fresh reviewer checks the whole branch against the spec; fix what it finds; rerun the affected tests and
  the gate.
- [ ] **Step 3:** Hosted pre-checks (read-only, `db query --linked --agent no`): no open boundary; the count of pending
  builds that change class or lower an attribute (expect 0; any found apply as queued, note them).
- [ ] **Step 4:** Avi's go in chat, with the three notes' text. Then `db push --dry-run` (exactly M25), `db push`, the access
  audit and fingerprint; `functions deploy game-command --project-ref djkblzbnritgbmctsvob`; the `release` fast-forward;
  the deployed checks about 2 minutes after Pages is live.
- [ ] **Step 5:** Post the launch note, then the look note, then the release note, with `private.post_message`; read back
  3 visible messages and the inbox of one account (unread 3).
- [ ] **Step 6:** Record the evidence in `release-evidence.md` and `deployment.md`, update HANDOFF; commit
  `deploy: ship game messages and fixed builds`.

### Task 9: A short clip of the new features for Avi's players

Avi, 2026-10-28: "also make a little clip for the new changes, so I can send to my players, for the new menus and so on."
Made after the release, from the real game (HyperFrames skill; `npx hyperframes usage --json` first).

- [ ] **Step 1:** Capture the real screens locally with representative data (the concept-capture setup): the badge on the
  corner chip, the panel and a patch note, the Notifications tab, the look picker before and after, the build step's
  counter and the fixed class.
- [ ] **Step 2:** A clip of about 20–30 s, 1920 × 1080 at 30 fps (the skill's default; Avi skipped questions): one scene per
  feature with short on-screen captions in plain words, a sound on each visible action, narration in the concept film's
  voice (local Kokoro bm_george) and the music low under it (about 0.1; Avi asked for it lower three times on the
  2026-10-28 clip); the closing card names the game and the update, with no "Coming soon" and no URL.
  `npx hyperframes check --json` clean, snapshot review, then render.
- [ ] **Step 3:** Send Avi the file (under the 30 MiB send cap) and keep the project in its own folder under
  `D:\Avi\Projects\Animation\Cloudiator`, named after what the clip shows, not in the game repository.

### Task 10: Expedition replays show the whole trip (needs its own design first)

Avi, 2026-10-28: "for the expedition replay, make more to see, not only the battle: how the gladiator leaves the camp, how
he arrives back, and when he rests, so the player can watch it all." Not designed yet: before building, a short design and
a clickable mockup over the real expedition scene (Avi's mockup rule), then its own tasks in this plan.

## Status (2026-10-28)

Avi: "all I say insert to a plan for next patch." This plan is the **next patch**: nothing in it is built yet (Task 1 had
not started). It waits for Avi's go; the video of the changes already live is separate work.
