# Task 13.6 report: visitors watch and join

Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-13`, base `43573b9`.
Commit: `6f5730c feat: let visitors watch and join from the camp` (not pushed).

## What was implemented

**Visitor (signed out)**
- **Corner chip** (`CornerChip.tsx`). It shows the mockup's white Google "G" mark and "Sign in with Google to join". In the touch layout (`(hover: none), (max-width: 480px)`) the label is "Sign in to join"; the hidden label is `display: none`, so the accessible name follows the layout. A click starts `startGoogleSignIn()` (the existing Task 5 redirect), shows "Opening Google…", and says "Google sign-in could not be started. Please try again." if it fails.
  - Where sign-in cannot start (the fixture preview, or a build without Supabase configured), the chip opens My gladiator, which says why.
- **My gladiator** (`CharacterPanel.tsx`, `SignIn.tsx`). It keeps "A legend awaits" and adds the mockup's visitor note: "You’re watching as a visitor.", "Everything in the camp is open to watch…", and a G-mark button **"Sign in with Google to create your gladiator"** that starts sign-in.
  - It is disabled with "Google sign-in is unavailable until the project is configured." (unconfigured build) or "This preview cannot sign in." (`?mode=fixture&as=visitor`).
  - The creation form no longer appears for a visitor (see Concern 1).
- **Public menus only.** `menusFor` is unchanged: five menus. **Tournaments** now renders Registration only for `viewer === 'player'`; everyone else sees the countdown and brackets (13.4 review M5).

**Joining (signed in, no gladiator)**
- `CampShell` opens the **"Create your gladiator" dialog** over the running camp when the viewer becomes `no-gladiator`, once per account per page load. Returning from Google reloads the page, so it always opens after sign-in.
- `CreateCharacter.tsx` is now that dialog: a native modal `<dialog>` (`role="dialog"`, named by its h2 "Create your gladiator"), styled after the mockup's box (glass, 380 px, scrolls internally, "Not now" and "Create gladiator" pinned at its foot). The title takes focus on open.
  - "Not now" or Escape closes it (`onDismiss`). While a creation is being confirmed, "Not now" is disabled and Escape is held, so the outcome is shown.
  - The existing form, validation, draft (`cloudiator.creation-draft.v1`) and operation-ID retry logic are unchanged.
- After "Not now", the **chip** shows "Create your gladiator" (gold) beside a "Signed in" account button (Sign out), and **My gladiator** shows "You’re signed in. Create your gladiator to join…" with a "Create your gladiator" button. Both reopen the dialog.
- On success the dialog closes; once the owner refresh lands, My gladiator opens on the new gladiator.
- An owner read that fails is never "no gladiator": no dialog and no create offer (as before).

**Session change**
- When `rail.open` names a menu the viewer no longer has (sign-out, expiry, account change), the shell sends `'escape'` (13.5 review a). Before, the derived `open` hid the panel but `rail.open` stayed set, so the rail could never slide away and the grip stayed hidden.
- The private panel unmounts, the chip flips to the visitor's, and no owner value remains on screen.

**Sign-in result (plan Decision 6)**
- `AuthCallback.tsx`: success → `location.replace('/game/')` (unchanged); a cancellation → `location.replace('/game/?signin=cancelled')`; any failure → `?signin=failed`. The callback page no longer shows an error or a "Return to the camp" link. Provider text is never shown, and `next=` is never followed.
- `src/app/game/page.tsx` reads `signin` and passes `signInResult` to `CampShell`. The shell keeps the message in state and removes the parameter with `history.replaceState` (other parameters such as `mode` are kept).
- Messages, below the chip with a × "Dismiss": "Google sign-in was canceled. You can keep watching the camp." / "Google sign-in could not be completed. Please try again."

**Other carried Minors**
- (b) "Connection lost — showing the last known camp" now shows only for `syncError === 'unavailable'`, not during the stale-session local sign-out.
- (c) The G mark and the touch label, above.
- The notices below the chip now stack in one `.notices` column (lost connection, then the sign-in message).

**Test transport**
- `tests/browser/live-routes.ts` answers `/auth/v1/authorize` with the same test-only consent page as `identity.spec.ts` ("Approve test Google" / "Cancel test Google"), and the PKCE `token` exchange (verifier checked against the challenge) with a session for `LiveTransport.googleUser`. Refresh tokens are still refused.
- `tests/browser/shell-helpers.ts`: `joinButton`, `creationDialog`, `chipToggle`; `openChipMenu` now finds the account button by `aria-expanded` (a no-gladiator chip has two buttons).

## TDD evidence

**RED, unit** (`npx vitest run tests/domain/tournament-panel.test.ts`): 1 failed, 22 passed.
- New: "shows Registration to a player only…": `visitor: expected '<section …' not to contain '>Registration</h3>'`.

**RED, browser** (`visitor.spec.ts` plus the new `full-screen.spec.ts` case, both projects): 12 failed. The grep also matched two existing desktop-only chip cases of `full-screen.spec.ts` ("shows only the grip and the corner chip at rest", "never lets a panel cover the corner chip"): 2 passed on desktop, 2 skipped on mobile.
- "lets a visitor watch…": My gladiator had no "Sign in with Google to create your gladiator" button (element not found).
- "starts Google sign-in from the corner chip": desktop, no `google-mark` inside the chip button; mobile, accessible name "Sign in with Google to join", expected "Sign in to join".
- "opens the create dialog…" and "returns a cancelled sign-in…": timed out waiting for the test consent page's links. The chip opened My gladiator and never started sign-in.
- "closes a private menu…": after sign-out, the rail stayed `data-revealed="true"` when the pointer left it (desktop) and when ☰ was tapped (mobile) — the stuck rail of 13.5 review (a). The private panel itself was already hidden by the derived `open`, so this is the assertion that failed.
- "never says the connection is lost while a rejected session is signed out": "Connection lost — showing the last known camp" was shown (count 1, expected 0) while the local sign-out was held.

**GREEN.**
- Unit: `tournament-panel.test.ts` 23/23; full `npm test` 39 files, 949 tests.
- Browser, first run after implementing: 10 of 12. Both failures were the test's own locator (strict mode: the demo crowd has a second "Aster"); with `.first()` the Gladiators check passed in the Step 4 run below.
- `visitor.spec.ts`, `identity.spec.ts` and `shell.spec.ts` (plan Step 4): 34 passed, 4 skipped (production-only cases).
- The dialog test also covers Review Focus 1 for the creation name: typing `+0-` and an arrow key there leaves the camp camera unchanged.

**Adapted existing tests (changed selectors and flows; no check dropped without a replacement)**
- `identity.spec.ts`: sign-in starts from the chip; the draft is written in the dialog after sign-in (a visitor has no form any more).
  - "retains creation draft through canceled OAuth, back and refresh": sign in, write the draft, "Not now", sign out, cancel a sign-in (back at `/game/` with the message), sign in again → the draft is in the dialog; again after a reload. The old "Back lands on `/auth/callback/`" check became "Back does not land on `/auth/callback/`": the cancelled return now replaces the callback entry (Decision 6).
  - The callback-failure and fragment-cancel tests now expect the fixed `/game/` URL and the camp's message instead of the callback page's alert and link; the fragment test routes the live reads, since it now lands on the live camp.
  - The owner-error test also checks there is no dialog and no "Create your gladiator" offer.
  - Visitor checks use "Sign in with Google to create your gladiator" instead of "Continue with Google".
- `shell.spec.ts`: the same prompt and its configuration state (disabled with the configuration message in the production export); the static callback test expects `/game/` and the message.
- `live-camp.spec.ts`: three "Continue with Google" selectors → the new prompt.

## Gate results (in order; no build overlapped a browser run, nothing else ran during `test:db`)

| Gate | Result |
| --- | --- |
| `npm test` | 39 files, 949 tests passed |
| `npm run typecheck` | exit 0 (tsc, deno check, 2 Deno tests ok) |
| `npm run test:db` | run 1: 9 files, 177 of 177 passed. Edge `StartedAt` `2026-10-17T08:04:14.838600905Z` before and after (unchanged; the run counts). The known `arena.test.ts:642` race did not occur. One run only. |
| `node assets/source/build-assets.mjs --check` | assets up to date (28 files) |
| `npm run build`, then `npm run verify:static` | exit 0, 7 static pages; "Static export verified: 5 fixed routes; 90 assets scanned; no forbidden backend material." (13.5 reported 91 assets; the scan is of the new output) |
| Full development browser suite (`pw-claude.config.mjs`, port 3200) | 333 passed, 19 skipped, 0 failed (6.4 min). Port 3200 free before and after. |
| Isolated production gate | `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`: exit 0. `verify:static -- .next/browser-test`: 5 routes, 90 assets, clean. Static Playwright run: 16 passed, 336 skipped. |
| `git diff --check` | clean |

## Files changed

- **New:** `src/features/auth/SignIn.module.css`, `src/features/character/CreateCharacter.module.css`, `tests/browser/visitor.spec.ts` (5 cases × 2 projects).
- **Source:** `src/app/game/page.tsx`, `src/features/auth/AuthCallback.tsx`, `src/features/auth/SignIn.tsx`, `src/features/character/CharacterPanel.tsx`, `CharacterPanel.module.css`, `CreateCharacter.tsx`, `src/features/shell/CampShell.tsx`, `CornerChip.tsx`, `shell.module.css`, `src/features/tournaments/TournamentPanel.tsx`.
  - Outside the brief's list: `page.tsx` (reads `?signin=`), `SignIn.tsx` and the two CSS modules, `TournamentPanel.tsx` (carried Minor).
- **Tests:** `tests/browser/{identity,shell,full-screen,live-camp}.spec.ts`, `live-routes.ts`, `shell-helpers.ts`; `tests/domain/tournament-panel.test.ts`.

## Screenshots (not committed)

In `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-16-task-13-full-screen-camp\shots\`, from the gate's development run (live routes):
- **Required:**
  - `visitor-desktop-1280x720-at-rest.png`, `visitor-pixel7-at-rest.png`
  - `visitor-desktop-1280x720-my-gladiator.png`
  - `join-desktop-1280x720-create-dialog.png`, `join-pixel7-create-dialog.png`
  - `visitor-desktop-1280x720-signin-cancelled.png`
- **Extra:** `visitor-pixel7-my-gladiator.png`, `visitor-pixel7-signin-cancelled.png`, `join-desktop-1280x720-not-now-chip.png`, `join-pixel7-not-now-chip.png` (the chip after "Not now").

## Concerns

1. **A visitor no longer drafts a gladiator before signing in.** The visitor's My gladiator shows only the prompt (spec "Menus", Visitor column; the mockup), and the form opens as the dialog after sign-in (spec "Joining"). The draft still lives on the device: it survives "Not now", a reload, a sign-out, a cancelled sign-in and a new sign-in (tested). The Task 5 line "Your draft stays on this device while you sign in" became "Your draft stays on this device."
2. **The callback page no longer shows an error or a "Return to the camp" link**; every outcome replaces it with `/game/` (Decision 6). Message text uses the codebase's "canceled"; the parameter is Decision 6's verbatim `cancelled`.
3. **After a successful creation, My gladiator opens** on the new gladiator once its owner read lands. The spec does not say what follows creation; the mockup shows a toast. It also keeps the existing identity checks (the gladiator heading) meaningful.
4. **The dialog is a native modal `<dialog>`.** The camp keeps animating behind it but takes no input, so the chip's Sign out is reached after "Not now". Escape closes it except while a creation is being confirmed.
5. **Without sign-in available, the chip opens My gladiator** (fixture `?as=visitor`, or an unconfigured build), where the disabled button says why. Only a live, configured, signed-out visitor's chip starts sign-in.
6. **`'escape'` keeps the rail shown** after a lost menu closes, as an ordinary Escape does; it slides away when the pointer next leaves it (desktop) or ☰ is tapped (touch). Before, it could not hide at all.
7. **Observation, not tested: the back-forward cache.** The chip and the My gladiator button show "Opening Google…" (disabled) while the browser leaves for Google. A browser that restores the camp from its back-forward cache after Back could show that state until a reload; the old "Continue with Google" button behaved the same. Playwright's Chrome runs without the cache (a probe saw Back reload the page), and a stand-in (an authorize navigation answered 204, then a synthetic `pageshow`) stalled Playwright's locators, so I did not add an unverified `pageshow` reset. A follow-up could reset `busy` on `pageshow` with `persisted`.
8. **One owner read is still extra after creation** (13.3 Minor): `CreateCharacter` reads the owner, then the shell's `refreshOwner` reads it again before opening My gladiator.

## Note for the controller (test environment, not product evidence)

- Playwright's Chrome here runs without the back-forward cache: after Back from the consent page, a marker set on the camp was gone (a reload).
- A navigation answered `204` (it never commits) stalls Playwright: a locator click waits for it, and `expect` on the page returns no result until the test times out.
- The local-testing memory could record both; I changed no memory or skill.

## Fix round 1 (review I1 and I2, controller check 3)

Commit: `0332c2a fix: keep the keyboard in the creation dialog and reset sign-in after Back` on `6f5730c` (new commit, no amend, not pushed). Concerns 1–4 are left as they are, as the review ruled.

**I1: the shell's keyboard handler and the modal dialog.**
- **Fix.**
  - `CampShell.tsx`: the document `keydown` handler returns at once while a modal dialog is open (`document.querySelector('dialog:modal')`; `:modal` is Safari 15.6+, inside the 16.4 floor). Neither the first-Tab rail reveal nor Escape-closes-the-menu runs behind the creation dialog or a discard confirmation.
  - `CornerChip.tsx`: the account menu's capture-phase Escape handler has the same guard. The creation dialog can open over that menu (it opens itself when the owner read finds no gladiator), and that handler's `preventDefault` would also have stopped the dialog's Escape. "Create your gladiator" in the chip now closes the account menu first. **Not covered by a test:** this guard needs the account menu open at the moment the dialog opens itself.
  - `CreateCharacter.tsx`: after a failed submit the reason (`role="alert"`, now `tabIndex={-1}`) takes the focus. While a creation is confirmed its button and fields are disabled, which dropped the focus to `<body>`. The effect runs when the error is set and nothing is being sent.
- **Observed while testing.** In this Chrome, a click on the dialog's text focuses the `<dialog>` element itself, not `<body>`. So the test stands in for the fall to `<body>` with a blur of the focused element. The real path to `<body>` is the disabled confirm button, which "moves the focus to the reason when a creation is refused" covers.
- **RED.**
  - "keeps Tab and Escape inside the dialog when the focus has fallen to the page" (desktop) failed: after Tab, "Gladiator name" was `inactive`. The shell had swallowed the Tab and tried to focus the inert first rail icon.
  - Escape: a temporary probe spec ran only the Escape half (desktop): the dialog stayed `visible`. The shell had closed My gladiator behind it and cancelled the keydown. The probe was deleted right after.
  - "moves the focus to the reason when a creation is refused" (desktop): the alert was `inactive` (focus on `<body>`).
- **GREEN.**
  - The two tests above pass.
  - The first checks: Tab from `<body>` focuses "Gladiator name" and the rail stays at `data-revealed="false"`; with My gladiator open behind the dialog, Escape from `<body>` closes the dialog and the menu stays open.
  - The second checks: a refused creation (`409 conflict`, routed `game-command`) leaves the focus on the alert, and Shift+Tab stays inside the dialog.

**I2: Back from Google leaves the join buttons stuck.**
- **Fix.** `useGoogleSignIn` (`SignIn.tsx`) listens for `pageshow` and clears `busy` when `event.persisted` (with cleanup). It covers the chip and My gladiator's button, which share the hook.
- **Test.** "offers sign-in again when the camp comes back from the back-forward cache" (both projects). `/auth/v1/authorize` is routed to `route.abort('aborted')`, so the page never commits the navigation and stays on "Opening Google…" (disabled). Then the test dispatches `new PageTransitionEvent('pageshow', { persisted: true })`. It does this for the chip, then for My gladiator's button.
- **RED:** after the `pageshow`, the chip's join button was not found (still "Opening Google…"), on both projects. **GREEN:** both buttons are enabled again.
- **Limit:** this proves the handler with a dispatched `pageshow`. A real back-forward-cache restore was not exercised: this Chrome runs without the cache (see the note above).

**Check 3: the creation dialog at 360×740.**
- New mobile-project test "fits the creation dialog on a 360 px phone with its actions in view". At 360×740 after sign-in it checks:
  - `document.documentElement.scrollWidth <= innerWidth`;
  - the dialog box inside 360×740;
  - "Not now" and "Create gladiator" each inside the viewport (`toBeInViewport` and their boxes). They are pinned at the dialog's foot, so no scrolling was needed.
- It passed on its first run, with no code change: it is a check, not a TDD fix.
- Screenshot: `shots/join-phone-360x740-create-dialog.png` (the dialog at its top, both actions visible).

**Covering runs**

| Check | Result |
| --- | --- |
| The four new tests before the fixes | 4 failed (I1 ×2 desktop, I2 ×2 projects); 360 px check 1 passed; 3 skipped |
| The same after the fixes | 5 passed, 3 skipped |
| `visitor.spec.ts`, `identity.spec.ts`, `full-screen.spec.ts` (both projects) | 64 passed, 14 skipped |
| Full development browser suite (`pw-claude.config.mjs`, port 3200; no build during it) | 338 passed, 22 skipped, 0 failed (6.0 min); port 3200 free before and after. The 8 new cases account for +5 passed and +3 skipped against the first gate run (333/19). |
| `npm run typecheck` | exit 0 |
| `git diff --check` | clean |

No build or `test:db` ran in this round: no backend file changed, and the brief did not ask for them.

**Files changed:** `src/features/shell/CampShell.tsx`, `src/features/shell/CornerChip.tsx`, `src/features/character/CreateCharacter.tsx`, `src/features/auth/SignIn.tsx`, `tests/browser/visitor.spec.ts` (4 new tests, 2 helpers).
