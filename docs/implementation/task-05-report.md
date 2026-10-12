# Task 5 implementation report

Status: **DONE_WITH_CONCERNS** — local frontend behavior is complete; real hosted Google/provider/origin configuration and release proof remain Task 24.

Date: 2026-10-12, Asia/Jerusalem. Branch: `codex/gladiator-arena`.
Base: `3d41ae900e5eaa0d2fafff5ab1cfd7b26321b3d5`.
Source: **`8fcb9c3e7209045e0f5ee5ed3a37dccbc6adc40d`**, `feat: add Google login and character creation`.
Final source: **`5b3c2a5f52d7cbca30274095e951a5f18c027550`**, `fix: preserve confirmed owner after stale reads`.
Controller owns independent specification/quality review, HANDOFF updates and push. These source checkpoints have not been reviewed or pushed by the implementer.

## Delivered behavior

The static frontend creates one browser Supabase client with `flowType: 'pkce'`, explicit callback exchange, persisted Auth session and automatic SDK token refresh. Google is the only sign-in provider and requests only `openid email profile`. The exact app return is `${window.location.origin}/auth/callback/`; hosted provider configuration must allow that exact destination. Client configuration reads only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Missing/invalid configuration disables sign-in visibly. Secret/legacy service credentials are not accepted by this client configuration.

The fixed exported callback route explicitly exchanges the code through the SDK. One shared exchange promise prevents React StrictMode effect replay from consuming a one-use code twice. Query/fragment provider errors are handled safely; access denial displays cancellation, other failures display a generic retry message, and provider descriptions are never rendered. Callback query/fragment data is removed from history. Success uses fixed `/game/` replacement; user-supplied redirect/next parameters cannot choose navigation. A reload after a canceled/failed callback still provides the fixed camp return link.

`useSession()` exposes presentation status, user ID and expiry time. It subscribes to the SDK's Auth changes, keeps an older initial lookup from overwriting a newer Auth event, and removes signed-in presentation at expiry or when a focus/visibility check observes expiry. SDK refresh events update expiry; SDK sign-out broadcasts clear the other tab. The root clears in-memory owner state on sign-out/expiry and guards asynchronous owner responses by account, effect lifetime and request revision. None of this client presentation supplies backend identity authority; Task 4 independently verifies every command.

Signed-out users can prepare a creation draft. The form retains only a versioned name/class/allocation draft and optional account-scoped immutable attempted command/operation UUID in `cloudiator.creation-draft.v1`. SDK Auth persistence is separate. No owner DTO, wallet, inventory, server receipt or private game authority is persisted. Draft input is safely parsed on return; editing clears the attempted command, account changes generate a new operation ID, and unchanged retries/reloads reuse the original command. The immutable payload is stored before transmission. A synchronous in-flight guard prevents duplicate submissions before a disabled button renders. Browser storage failures are visible rather than crashing the form.

The form trims name whitespace, validates the approved 3–20 English letter/digit/space/underscore/hyphen alphabet, and shows backend invalid/conflict/session/rate-limit/unknown-outcome errors. It does not pretend to know global name availability. A conflict reloads owner state first, allowing another tab's existing character to enter the camp rather than inviting a second character. Unknown outcomes keep the draft and operation ID for safe confirmation. After successful owner reload, the creation draft is cleared. A request completing after its form was unmounted does not clear a newer draft.

All three classes expose the versioned percentage bonuses. Ten starting points default to two per attribute; fractional, invalid and incorrect-total allocation cannot submit. Starter preview constructs visual catalog rolls and calls the reviewed `validateCreationAllocation`, `validateBuild` and `deriveStats`; no parallel health/stamina/load formula was introduced. The Guardian default preview is independently asserted as health **123**, stamina **104**, load **7 / 24.7**. The request contains only canonical creation fields, never preview inventory/derived values or owner IDs. Labels, fieldsets/radios, whole-point inputs, live status/error text, disabled pending controls, keyboard submission and mobile layout are implemented. Desktop/mobile screenshots were inspected; mobile has no horizontal overflow.

Creation success reloads the protected online owner aggregate before rendering name/build/schedule/balances. Live values have live labels, while the explicit local fixture preview retains its sample labels and unavailable commands. A late focus read taken before creation cannot replace the confirmed owner: confirmation advances the shared request revision so stale success/error results are ignored.

## Integration interfaces

- `getBrowserClient(): SupabaseClient | null`, `startGoogleSignIn(): Promise<void>` and `completeGoogleSignIn(): Promise<void>` live in `src/lib/api/client.ts`.
- `useSession(): SessionState` and `signOut(): Promise<void>` live in `src/lib/api/session.ts`. `SessionState` status is `loading | unavailable | signed-out | signed-in`, with nullable `userId` and `expiresAtMs`.
- `createLiveGateway(): GameGateway` is added beside the existing canonical interface. `command<T>` supports creation via `/functions/v1/game-command`, sends the Auth bearer token plus publishable key, and preserves typed business envelopes on non-2xx responses. Network/malformed responses return `unavailable`; missing/expired sessions return `unauthenticated`. Future commands explicitly return `unavailable` without fixture mutation.
- `owner(): Promise<OwnerState>` preserves the reviewed interface. It calls **`client.from('owner_state').select('state').maybeSingle()`**, with no client owner filter/authority. `data === null` throws `GatewayReadError('not-found')`; query errors remain `unavailable`/`unauthenticated`, never no-character. `data.state` is the canonical owner DTO. The root offers creation only after confirmed absence; read errors offer owner-load retry.
- All future live reads (`world`, `revision`, `timeline`, `profile`, `market`, `standings`, `tournament`, `recent`) reject with explicit `GatewayReadError('unavailable')`. General public projection/read/polling work remains Task 10; no general `reads.ts` adapter was needed.
- `<CreateCharacter gateway={gateway} />` consumes its session through `useSession`. Optional `onCreated(owner: OwnerState)` lets the root render the freshly reloaded owner. SignIn/AuthCallback are separate focused components.

## Authorized C1 contract integration

`_shared/contracts/reads.ts` now exports `CampLocation = orientation | camp | training | rest | arena | tournament | expedition:woodland | expedition:outpost | expedition:mountain` and the eleven requested `EquipmentSilhouette` machine IDs. Only `PublicActor.location` and `PublicActor.equipmentSilhouettes` use these unions. The public fixture location changed from `Practice yard` to `training`; the fixture gateway assertion checks that machine value.

Existing `FighterSnapshot`/`RevealedCombatant` battle silhouettes remain catalog-ID strings, with engine/events/combat tests untouched. No owner/read shapes besides the authorized PublicActor fields changed, no runtime public projection was fabricated, and no database migration was introduced. Task 10 must populate and sanitize the canonical public values. Claude's assets/scenes/panels/replays and reserved tests were not edited.

## File map and justified adjustments

The source checkpoint contains exactly **21** files:

- Specified: `src/lib/api/client.ts`, `src/lib/api/session.ts`, `src/lib/api/gateway.ts`, `src/features/auth/SignIn.tsx`, `src/features/auth/AuthCallback.tsx`, `src/features/character/CreateCharacter.tsx`, `tests/browser/identity.spec.ts`, and the existing `src/app/page.tsx`, `src/app/game/page.tsx`, `src/app/auth/callback/page.tsx` routes.
- `src/app/globals.css`: responsive form, accessible controls, preview and sign-out styling.
- `next.config.ts`: explicit production rejection of the test-only identity key; existing fixture production denial remains. Browser-test-only `CLOUDIATOR_BROWSER_TEST=true` isolates the dev output at `.next/browser-test`, preserving the port-3000 preview.
- `playwright.config.ts`: development-only test public URL/key and isolated output, plus an explicit optional `PLAYWRIGHT_STATIC_ROOT` passed to the local static host. Default production static root remains `out`.
- `scripts/serve-static.mjs`: optional `CLOUDIATOR_STATIC_ROOT` for the actual isolated export; default remains `out`.
- `tsconfig.json`: Next-generated type includes for `.next/browser-test/{types,dev/types}`. Existing app and mandatory Deno boundaries are retained.
- Authorized C1: `supabase/functions/_shared/contracts/reads.ts`, `tests/fixtures/domain.ts`, `tests/api/fixture-gateway.test.ts`.
- `tests/api/live-gateway.test.ts`: unavailable future live reads/command cannot return fixture authority. `tests/static.test.ts`: executes production configuration with the explicitly test-only key and asserts rejection. `tests/browser/shell.spec.ts`: replaces the old disabled-auth assumption, verifies production fixture refusal and the exported static callback.

The targeted source fix touches only `src/app/game/page.tsx` and `tests/browser/identity.spec.ts`. This tracked report has an identical ignored scratch copy at `.superpowers/sdd/2026-10-11-gladiator-arena-implementation/task-5-report.md`. Controller HANDOFF changes remain unstaged. No package/lockfile/schema/runtime/backend changes, helper/reviewer agents or pushes.

## RED evidence

1. **Absent creation form:** `npm run test:e2e -- tests/browser/identity.spec.ts --project=desktop --workers=1 --max-failures=1`, with a properly running isolated server, exited 1: **1 failed, 6 did not run**. The first test reached `/game/` and timed out on `getByLabel('Gladiator name').fill('Avi Fighter')`; the missing form is the expected task RED. Earlier native-compiler/second-dev-server startup failures are environment/setup evidence only.
2. **Fragment cancellation:** `npm run test:e2e -- tests/browser/identity.spec.ts --project=desktop --workers=1 -g 'fragment OAuth'` exited 1: **1 failed**. Expected `was canceled`, received the generic `could not be completed` message. Reading fragment error fields corrected this branch; query/fragment data is still scrubbed, and provider descriptions remain unrendered.
3. **Late no-character read:** after source `8fcb9c3`, `npm run test:e2e -- tests/browser/identity.spec.ts --project=desktop --workers=1 -g 'slow no-character'` exited 1: **1 failed**. The test first observed `Confirmed Fighter`, then released a real delayed SDK owner query containing the earlier null snapshot; the confirmed heading disappeared. Shared request revision guarding corrected the product race in `5b3c2a5`.

## GREEN and exact verification

Full source verification (exit 0 unless noted):

```powershell
npm run test:e2e -- tests/browser/identity.spec.ts tests/browser/shell.spec.ts --workers=2
# Last complete development run before the extra slow-read regression:
# 22 passed, 4 intentionally skipped production-only cases, 19.9 s.

npm run test:e2e -- tests/browser/identity.spec.ts --workers=2 -g 'two signed-in tabs|expiry removes|account changes'
# After private owner memory clearing: 6 passed, 13.3 s.

npm test
# 2026-10-12 09:18:48 local: 7 files, 153 passed, 691 ms.
# Includes affected fixture/API, full domain/combat/backend and executed static guards.

npm run typecheck
# Final race-fix source: tsc --noEmit, frozen Deno entrypoint check,
# frozen actual Deno runtime: 1 passed, 0 failed, 10 ms. No compiler diagnostics.

$env:CLOUDIATOR_BROWSER_TEST = 'true'
$env:NEXT_PUBLIC_FIXTURE_ENABLED = 'true'
npm run build
# Final race-fix source: Next16.4 optimized compile/typecheck/export passed;
# /, /_not-found, /auth/callback and /game are static.
# Fresh exported artifact is .next/browser-test, not the old out/.

npm run verify:static -- .next/browser-test
# Final artifact: 3 fixed routes; 37 assets; no forbidden backend material.

$env:PLAYWRIGHT_STATIC = 'true'
$env:PLAYWRIGHT_STATIC_ROOT = '.next/browser-test'
npm run test:e2e -- tests/browser/shell.spec.ts --workers=2
# Final race-fix source/artifact: 6 passed, 2 intentional fixture-only skips, 2.8 s.
# Unconfigured production auth, URL-requested fixture refusal, safe fixed static callback.

# In a separate fresh shell without PLAYWRIGHT_STATIC:
npm run test:e2e -- tests/browser/identity.spec.ts --workers=2 -g 'slow no-character|retries a lost|two signed-in tabs|account changes'
# Final affected follow-up: 8 passed, 8.9 s; desktop and mobile.

git diff --check
git diff --cached --check
# No whitespace errors; configured LF-to-CRLF notices are retained.
```

The final focused follow-up covers both the slow-read regression and adjacent retry/concurrent/account-change behavior. Full unit checks preceded this UI-only request guard; no domain/backend code changed in that guard. TypeScript/Deno, build, fresh scanner and production checks were repeated for its final source. No repeated broad suite beyond the new changes' affected checks.

The browser transport is explicitly test-only and entirely inside the owning test file: intercepted Auth/Data API/command HTTP, in-memory account/receipt state, test JWTs and a test consent page. Actual components, Supabase SDK, PKCE challenge/verifier generation/exchange, session storage/broadcast, callback routes, gateway requests and retry metadata execute unchanged. The harness asserts provider/scopes/S256/fixed redirect, validates the submitted verifier against the challenge, checks exact command keys (excluding owner IDs/authority), exercises lost responses/UUID reuse and checks the resulting rendered owner. Its character-count assertion characterizes frontend requests against the test transport; **it is not new database/Google authority proof**. Real SQL/Auth/RLS/Edge atomicity and uniqueness were proven in Task 4. Actual hosted Google OAuth remains Task 24.

## Environment observations and limitations

- Default Windows sandbox denied native Next compiler workspace canonicalization; approved escalated browser/build runs succeeded. A second ordinary `next dev` correctly refused to steal the existing port-3000 preview. Isolated test output resolved that task setup without stopping the user's server. Test servers use 3100/4173 and Playwright owns their cleanup; no Edge serving process was stopped. A final read-only request to port 3000 returned **HTTP 200**.
- Next16.4 `output: 'export'` interprets a custom `distDir` as the static export directory. The initial isolated build succeeded at `.next/browser-test`, but an old `out/` scan and static run read Task1's stale artifact: the old scan printed 35 assets, while the old static run failed 2 authentication assertions. These are **excluded from verification evidence**. The local static harness now takes an explicit root; the fresh final artifact scan reports 37 assets and all six applicable production checks pass. Normal configuration and static-root defaults are unchanged.
- Initial product-alert assertions matched Next's additional route announcer, causing strict-locator failures. Tests now scope `p[role=alert]`. Initial 503 owner-error injection exercised current SDK automatic transient GET retries beyond a five-second assertion timeout; the branch test uses a nonretryable database-error HTTP response instead. Production SDK read behavior was not modified or bypassed.
- The first final race-fix affected run produced **7 passed / 1 failed**: `account changes cannot reuse another account creation attempt` never hydrated its initial page. Its trace recorded **`net::ERR_NO_BUFFER_SPACE`**, with the page still at `Checking your session…`, before form interaction. One exact focused repeat passed all eight cases. This is an observed transient Chrome resource failure, not a claimed tested environment mitigation or product RED.
- Browser runs retain the known `NO_COLOR`/`FORCE_COLOR` warning. Expiry tests intentionally reject token refresh and emit sanitized SDK `AuthApiError: Refresh denied` diagnostics. Successful test counts are not described as pristine browser output.
- Node22.19.0/npm11.8.0 and the already pinned Supabase client2.117.3/CLI2.120.0 were inspected; no dependencies installed. CLI version inspection initially encountered its known sandbox telemetry-file restriction, then returned 2.120.0 under approved escalation. No CLI status, gateway configuration, env dump or credential values were printed.
- Real hosted Google consent, authorized origins/redirects, provider secrets, deployed exact-origin/CORS parity and physical-device performance remain release work. No hosted project was created or reused. Public world/competition projections, schedule/build changes and animated camp integration remain their owning tasks; future live gateway methods explicitly fail unavailable. No new SQL work/migration or real DB reset was required.

## Documentation and self-review

Read the full task brief, root AGENTS/HANDOFF, Task2/Task4 reports and Task4 review, implementer prompt, TDD/writing-good-tests, verification-before-completion, Supabase and Vercel React skills. Consulted installed Next16.4 static-export/client-component/search-param/distDir guidance before implementation; client-only URL/storage/session work stays in effects/events and fixed routes still export.

The Supabase markdown changelog request was attempted first (web tool rejected its content type; direct sandbox fetch lacked DNS). Its official [HTML changelog](https://supabase.com/changelog) was then inspected, including current Node22 support, API grants and transient Data API read retries. Reviewed official [Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google), [PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [OAuth sign-in](https://supabase.com/docs/reference/javascript/auth-signinwithoauth) and [code exchange](https://supabase.com/docs/reference/javascript/auth-exchangecodeforsession) docs. Current PKCE docs also describe overlapping-flow verifier replacement; this task keeps stable SDK behavior, so overlapping fresh Google flows may need a restart rather than claiming experimental-flow support.

Vercel React self-review checked direct imports, focused components, stable primitive effect dependencies, synchronous Auth callbacks, effect cleanup and async account/request guards, derived state without redundant state/effects, bounded small preview work, semantic labels/radios/alerts, keyboard creation and mobile screenshots. Corrections include fragment cancellation, guarding draft clearing after unmount, clearing private owner memory, truthful live labels and the targeted late-owner-read race. Existing skills already cover the observed generic lessons; no substantive skill-cache/upkeep change was made or needed.
