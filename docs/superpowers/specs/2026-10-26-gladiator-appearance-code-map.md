# Gladiator appearance: where the look flows today (code map, 2026-10-26)

Companion to `2026-10-26-gladiator-appearance-design.md`. Line numbers are as of `4cf873a`; re-locate before editing.
`eS` = `equipmentSilhouettes`.

## Client
- `src/game/actors.ts`: palettes `CLOTH_TINTS` :72 (12), `HAIR_TINTS` :73 (6), `SKIN_TINTS` :75 (5); `LAYER_ORDER` :84
  (hand-copied from the manifest, untested); `layersFor` :95-108 (hair only without head gear :103); `tintFor(id)` :121-124
  (hash); `planActorRoutine` :126-139 (tint :136, layers :137).
- Camp `src/game/camp-scene.ts`: `lookKey` :193, `playerSprites` :437-444, `restyle` :467-473 (from `applyWorld` :495);
  arena/tournament fighters are the same player views (:820, :884); NPC `fighterLook` :915; debug :1190.
- Replay: `src/game/battle-stage.ts:65-84` `fighterLook` (layers :72, `tintFor(p.gladiatorId)` :73, NPC cloth :17);
  `battle-scene.ts:104-110`; `BattleViewport.tsx:22-30` gets only the `log`; `BattleReplay.tsx:286` (reached from the replay
  page, SceneOverlay, TournamentPanel, ArenaPanel).
- Expedition: `src/features/character/ExpeditionView.tsx:295-307` builds `GladiatorLook` (`tintFor` :306; eS from the world
  actor or log participant 0, `expedition-stage.ts:234-237`); `expedition-scene.ts` type :34, `buildHero` :303-315,
  `setLook` :659-664; `ExpeditionViewport.tsx:28/45/73-80`.
- No DOM portrait exists anywhere (`CreateCharacter.tsx:238-241` preview is text). Fixture actors: `src/game/demo-world.ts:36-51`;
  `src/lib/api/fixture-gateway.ts` imports `tests/fixtures` into the app.
- Offline renderers with their own tint copies: `assets/source/tools/render-map.mjs:82,147`, `review-sheets.mjs:64-67`,
  `public/assets/gallery.html:106-107`.

## Contracts and server
- `PublicActor` (`contracts/reads.ts:47-58`): `gladiatorId`, `eS`, no colours; read via `readWorld`
  (`src/lib/api/reads.ts:36`, `select('gladiator_id,actor')`, JSON passthrough) and `PublicProfile.actor` (:73).
  `OwnerState` (:19-43) has no look. `RevealedCombatant` (`contracts/events.ts:25-39`): `gladiatorId`, `eS`.
- `public.gladiators`: `supabase/sql/01-identity.sql:9-27`.
- `create_gladiator`: latest `supabase/sql/04-inventory-shops.sql:230-320` (5 command keys :247-248, 4 input keys :238,
  receipt `request <> command` :244, insert :298-299). Edge parse `backend/commands.ts:29-32`; `prepareCreation`
  `backend/database.ts:108-122` (passes `command` through); command type `contracts/commands.ts:35`.
- Public actor build: `private.project_character`, latest `supabase/sql/15-release.sql:935-996` (actor jsonb :960-966) →
  `public.world_actors` (`06-projections.sql:7-12`); a constraint trigger on `gladiators` (06:93) re-projects on change;
  `world_actor_reads` / `public_profile_reads` (06:122-134) pass the actor through; `public.refresh_projections()` (06:109).
  Owner read: `owner_state` view, latest `15-release.sql:1001-1023`.
- Latest migration restating `project_character`: `20261020075858_idle_rest.sql:393`. New source `supabase/sql/17-*.sql` +
  a generated migration (AGENTS.md completion rules). `tests/rule-retention.test.ts` allows `add column`; a top-level
  `update` backfill needs an allowlist entry.

## Art pipeline
- `assets/source/generators/gladiator.mjs:7-23` (15 layers), painters :25-41 (`body: body(SKIN.light)`, `cloth` = kilt +
  wristWraps, `hair: hair(RAMP.gray,'short')`); frames `<layer>/<action>/<dir>/<i>` (:55).
- `outfits.mjs:171-195` hair already supports 'short', 'long', 'bun' (no ponytail); NPC precedent `npcs.mjs:13` (Livia:
  female-coded, same body, robe, long hair).
- `rig.mjs:153-180` renders every layer of a frame from one skeleton (`DIMS` :17, `torsoPolygon` :134): new painters on the
  same skeleton align; extra bust/hip pixels outside the male torso mask would poke out around armour.
- `build-assets.mjs:62-64` (32 columns), manifest :137-145, `--check` :187-196; atlas 2048×2176, 71 frames per layer;
  `gladiators.json` is statically imported (`src/game/assets.ts:5`) so it lands in the bundle; `assets.ts:243-245` validates
  every layer has all frames; scenes map frames by `name.replace(/^body\//, `${id}/`)`.

## Tests that pin today's look
- `tests/assets/manifest.test.ts` (tint keys :176-178, all frames :179-184, palette :119-133, `--check` :114-117).
- `tests/domain/scene-layout.test.ts:161-182` (`layersFor`, hash spread), `tests/domain/battle-stage.test.ts:58-69,76-79`
  (replay tint = camp tint), `tests/domain/combat.test.ts:244-245` (participant keys).
- Create-character shape: `tests/backend/commands.test.ts:10,29-36`, `edge.deno.ts:9`, `tests/fixtures/db.ts:94`,
  `tests/db/identity.test.ts:132`, `scripts/bench-seed.mjs:108`, `identity.spec.ts:90`, `read-render.spec.ts:271`.
- Actor shape: `tests/db/projections.test.ts:120,141`; `tests/db/recovery.test.ts:611` inserts gladiators directly.
- PublicActor literals: `tests/fixtures/domain.ts:25`, `arena-build.ts:132,143`, `tournament-build.ts:138,189`,
  `resting.ts:15`, `tests/sync.test.ts:88`, `tests/browser/management.spec.ts:213`, `scenes.spec.ts:77`,
  `tests/domain/profile-card.test.ts:14`, `scene-layout.test.ts:23`, `arena-layout.test.ts:26`, `src/game/demo-world.ts`.
- `tests/browser/camp.spec.ts:364-382` reads `debug().actors[].layers`.
