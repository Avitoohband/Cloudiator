# Game messages and a free look change: code map

Where the [design](2026-10-27-game-messages-design.md) touches the code, at `7d87fe4` (2026-10-27). Line numbers drift; the
names are the anchors.

## Watch out first

- `tests/db/appearance.test.ts` (about :175) asserts that the one `*_appearance.sql` migration is the last migration: M25
  must update that assertion, and a migration named `…_change_appearance.sql` would also break "exactly one".
- The access matrix (`tests/db/access-matrix.test.ts`, about :346 and :554–588) requires every `authenticated` SELECT
  policy outside `OPEN` to use `auth.uid()` and every such read to contain the reader's id; `OPEN`
  (`tests/fixtures/access.ts`) also opens to `anon`. Hence the design's choice: messages travel inside `owner_state`.
- Receipts are permanent (`private.guard_receipt`, `20261018191110_operations.sql`). `presence` is the precedent for a
  command with no receipt (`supabase/functions/_shared/backend/commands.ts`, about :98).
- `tests/browser/live-routes.ts` throws `Unexpected live transport table` for an unknown table; `tables()` lists them.

## HUD and shell

- The pill: `CornerChip` (`src/features/shell/CornerChip.tsx`): `.chipRow` holds the create button and the `chipButton`
  (testids `chip-name`, `-stamina`, `-money`, `-renown`; `Countdown`). The messages button goes in `.chipRow` before the
  toggle; its popover can follow `.chipMenu` (CSS `shell.module.css`), with the same Escape capture and outside-press close.
- Mounted in `CampShell.tsx` (with `MenuRail`, `MenuSurface`, the `railReducer`, focus return to the icon, the shell Escape
  handler that skips `defaultPrevented`). `MenuSurface.tsx` is a non-modal `role=dialog` with `data-menu-surface`; menu ids
  in `menus.ts`. Focus helpers: `focus-lost.ts` (`focusLost`, `useOutcomeFocus`), `useFocusRescue.ts`.

## Reads

- `GameGateway` (`src/lib/api/gateway.ts`): `owner: () => read(readOwner)`; `read()` is the session-checked owner read,
  `publicRead()` the public one. `readOwner` (`src/lib/api/reads.ts`) selects `owner_state.state`, a security-invoker view
  last redefined in M24 (`20261026160844_appearance.sql`, already carrying `appearance`).
- Contracts: `supabase/functions/_shared/contracts/reads.ts` (`OwnerState`, `PublicActor.appearance`, `RevisionState`).
- Polling: `src/lib/api/sync.ts` reads `world_revision` every 30 s; `useGameState.ts` re-reads the owner on revision change,
  slot change, focus and `refreshOwner`. The revision is bumped by `private.projection_changed`.
- Owner-only relation recipe (`identity.sql` pattern): RLS on, revoke all from public/anon/authenticated/service_role, grant
  select to authenticated, service_role DML, `owner_read` policy on `(select auth.uid())`; a `reads.ts` function, a gateway
  method (also in `fixture-gateway.ts`), and the live-routes table.

## Commands (`create-character` as the model)

- Client: `CreateCharacter.tsx` sends `gateway.command`, then `gateway.owner()`, then `onCreated`. The client allow-list of
  command kinds is in `gateway.ts` (an unknown kind is refused as `unavailable`).
- Contract union: `contracts/commands.ts`. Edge: `game-command/index.ts` → `handleCommand` (`backend/commands.ts`):
  `parseCommand` (creation uses `validAppearance`), the kind allow-list, dispatch. `backend/database.ts`: `createGladiator`
  → `rpc('create_gladiator')`; new methods join `CommandDependencies`.
- SQL: `public.create_gladiator` (M24): advisory lock, receipt replay and conflict, `private.valid_appearance`,
  `gladiators_appearance_check`, receipt insert, EXECUTE for `service_role` only. The smallest template is
  `public.set_tournament_opt_in` (`20261014160257_tournaments.sql`). New functions need `SERVICE_ROLE` pins in the access
  matrix.
- Updating `gladiators.appearance` fires the deferred `project_changed_character` trigger (upserts `world_actors`, bumps the
  revision). `guard_historical_strength` is a BEFORE UPDATE trigger on `gladiators` to keep in mind.

## Looks

- `lookFor`, `layersFor`, `tintFor`, `planActorRoutine` (`src/game/actors.ts`); camp `lookKey`/`restyle`/`applyWorld`
  (`camp-scene.ts`, redraws on a new world); expedition `setLook`; replays `replay-looks.ts`, `BattleReplay.tsx`,
  `battle-stage.ts`. Picker: `LookPicker.tsx` (`{look, name, onChange}`) and `LookPreview.tsx`.

## Database conventions

- Sources in `supabase/sql/NN-*.sql` (latest `17-appearance.sql`); generated migrations completed per AGENTS.md; the
  migration record at the top of `docs/operations/migrations.md`.
- `scripts/access-audit.sql` (RLS on every table, `security_invoker` views, no SECURITY DEFINER, `search_path=''`, no client
  EXECUTE or write); `scripts/schema-fingerprint.sql` (seed-count sections); `scripts/hosted-checks.sql` (digests).
- Operator-only functions: revoke all from public/anon/authenticated/service_role (as `cleanup_history`, `health_report`);
  counted as `ownerOnly` by the matrix; run as `postgres` (operator scripts or `db query --linked`).

## Tests

- DB: `tests/fixtures/db.ts` (`resetIdentity` truncates account-keyed tables; `creation`, `request`, `directEdge`); model
  `tests/db/appearance.test.ts`.
- Unit: `tests/backend/commands.test.ts`, `tests/backend/edge.deno.ts`, `tests/domain/appearance.test.ts`,
  `look-picker.test.ts`, `tests/api/looks-read.test.ts`.
- Browser: `live-routes.ts` (`seedSession`, `routeLiveReads` with `setOwner`/`setWorld`); commands faked with
  `context.route` (presence falls back, `identity.spec.ts`); live look redraw `camp.spec.ts`; owner re-read
  `live-camp.spec.ts`.

## Retention

- The retention matrix is in `supabase/sql/14-operations.sql`; a table not pruned by `private.cleanup_history` is kept
  forever (`tests/db/retention.test.ts` follows `OPEN`). Messages and read marks are tiny: kept.
