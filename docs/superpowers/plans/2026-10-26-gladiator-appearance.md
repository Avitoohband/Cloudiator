# Gladiator Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players choose their gladiator's body, hair style and colours at creation, and the chosen look is drawn
everywhere the gladiator appears.

**Architecture:** One shared domain module defines the options; the server stores them on the gladiator (nullable jsonb,
`null` = today's look) and exposes them in the public actor and owner reads; one client function turns an appearance into
layers and tints for every scene; replays look up participants' looks before mounting. New art comes from the existing
code generators on the same skeleton.

**Tech Stack:** Next.js 16.4.3 static client, Phaser (injected), Deno Edge functions sharing `supabase/functions/_shared`,
Supabase Postgres 17 (CLI 2.120.0), Node asset generators (`assets/source`), Vitest, Playwright (`channel: 'chrome'`).

**Spec:** `docs/superpowers/specs/2026-10-26-gladiator-appearance-design.md`; file/line map
`docs/superpowers/specs/2026-10-26-gladiator-appearance-code-map.md` (lines as of `4cf873a`).

## Global Constraints

- Options exactly: body `male | female`; hair `short | long | ponytail | bald`; skin 0–4 (Light, Tan, Olive, Brown, Deep
  brown = today's `SKIN_TINTS`); hairColor 0–5 (Brown, Black, Auburn, Blond, Grey, Red = `HAIR_TINTS`); cloth 0–11 (Teal,
  Red, Gold, Purple, Blue, Green, Orange, Cream, Slate, Leather, Rose, Sky = `CLOTH_TINTS`).
- Stored shape exactly `{body, hair, skin, hairColor, cloth}` (no other key); `null` = legacy look (male, short hair,
  `tintFor(gladiatorId)` colours). No backfill: existing gladiators stay `null`.
- Cosmetic only: no effect on combat, stats, rewards, snapshots or battle logs.
- New layer ids: `body-female`, `cloth-female`, `hair-long`, `hair-ponytail` (71 frames each, same frame names); `hair`
  stays short hair; bald draws no hair; any hair is hidden under head gear, as today.
- Copy: section title "Choose a look"; "Random look"; "Your look is set when you create your gladiator."; group labels
  "Body", "Hair", "Skin tone · {name}", "Hair colour · {name}", "Clothes colour · {name}".
- Committed migrations are never edited (new M24, completed and replayed per AGENTS.md); TDD; DB-test rule; no package
  downloads; gate of record `node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs` 12/12.
- Production deploys need Avi's go in chat at release time.

## Review Focus

1. A legacy gladiator (`appearance: null`) looks exactly as today in camp, expedition and replay (Task 4 test
   `lookFor(null, …) equals today's layers and tints`).
2. A replay whose look read fails or takes over 1.5 s still plays, with the legacy look, and never swaps looks mid-play
   (Task 5 test `mounts with the legacy look when the read times out`).
3. A creation with an invalid appearance (skin 5, hair `mohawk`, an extra key, a string index) is refused `invalid` by the
   Edge parser and by SQL, writing nothing (Tasks 1 and 3).
4. A female gladiator in heavy armour and a helmet shows no body or clothes pixels outside the male masks (Task 2 test
   `female body and clothes stay inside the male masks`).
5. A version-1 creation draft opens with a random look and keeps its name, class and points (Task 6 test).

---

### Task 1: The appearance options and the create-character command

**Files:**
- Create: `supabase/functions/_shared/domain/appearance.ts`
- Modify: `supabase/functions/_shared/contracts/commands.ts:35`, `supabase/functions/_shared/backend/commands.ts:29-32`,
  `src/game/actors.ts:72-75` (palettes re-exported from the domain module, values unchanged)
- Test: `tests/domain/appearance.test.ts`, `tests/backend/commands.test.ts`

**Interfaces:**
- Produces: `type Appearance = { body: 'male' | 'female'; hair: 'short' | 'long' | 'ponytail' | 'bald'; skin: number;
  hairColor: number; cloth: number }`; `BODIES`, `HAIRS` (readonly id lists); `SKIN_TONES`, `HAIR_COLOURS`,
  `CLOTH_COLOURS`: `readonly { name: string; tint: number }[]` (names and tints from Global Constraints and today's
  arrays); `validAppearance(value: unknown): value is Appearance`; `randomAppearance(random: () => number): Appearance`.
  The create-character command gains optional `appearance?: Appearance`.

- [ ] **Step 1: Failing tests**: `validAppearance` true for every combination's corners, false for skin 5, cloth -1,
  hairColor 1.5, hair `mohawk`, body `other`, a missing key, an extra key, a string index, null; `randomAppearance` always
  valid and covers every option over 500 draws with a seeded generator; the palettes equal today's `SKIN_TINTS`,
  `HAIR_TINTS`, `CLOTH_TINTS` values; `parseCommand` accepts create-character with and without a valid `appearance` and
  refuses one with an invalid `appearance`.
- [ ] **Step 2: Run** `npx vitest run tests/domain/appearance.test.ts tests/backend/commands.test.ts`; expect FAIL.
- [ ] **Step 3: Implement**; `actors.ts` keeps exporting `SKIN_TINTS`/`HAIR_TINTS`/`CLOTH_TINTS` derived from the module.
- [ ] **Step 4: Run** the step 2 command, then `npx vitest run` and `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: define the gladiator appearance options`.

### Task 2: The new art (female body and clothes, long hair, ponytail)

**Files:**
- Modify: `assets/source/generators/gladiator.mjs:7-41`, `assets/source/generators/outfits.mjs:171-195` (ponytail; a
  female body and clothes painter), `assets/source/tools/review-sheets.mjs` (sheets per body × hair),
  `assets/source/tools/render-map.mjs` (only if its tests need the new layers)
- Regenerate: `public/assets/actors/gladiators.png`, `gladiators.json`, `public/assets/manifest.json`,
  `assets/source/provenance.json` via `node assets/source/build-assets.mjs`
- Test: `tests/assets/manifest.test.ts` (new layers, tint keys `body-female` skin, `cloth-female` cloth, `hair-long` and
  `hair-ponytail` hair), a new `tests/assets/appearance-art.test.ts`

**Interfaces:**
- Produces: layers `body-female`, `cloth-female`, `hair-long`, `hair-ponytail` in `manifest.actors.gladiator`, each with
  all 71 body frames.

- [ ] **Step 1: Failing tests**: the four layers exist with every frame and the right tint keys; the atlas stays under
  4096 px tall; `female body and clothes stay inside the male masks` (for every frame, each opaque pixel of `body-female`
  and `cloth-female` is opaque in the union of `body` and `cloth` of the same frame); palette-only colours; the asset
  `--check` passes after the rebuild.
- [ ] **Step 2: Run** `npx vitest run tests/assets`; expect FAIL.
- [ ] **Step 3: Implement** the painters on the same skeleton (reuse `hair(..., 'long')`; add `'ponytail'`); a female
  body that reads as female at 64 px within the male masks (face, hair line, a chest wrap in `cloth-female`).
- [ ] **Step 4: Rebuild** with `node assets/source/build-assets.mjs`; run `npx vitest run tests/assets` and
  `node assets/source/build-assets.mjs --check`; expect PASS. Render the review sheets for male/female × each hair style
  and colour set to `node_modules/.cache/appearance-sheets/` (not committed) and name the file in the report.
- [ ] **Step 5: Commit** `feat: draw the female body, long hair and ponytail`.

### Task 3: Store and read the appearance (M24)

**Files:**
- Create: `supabase/sql/17-appearance.sql` (add column `public.gladiators.appearance jsonb` with a CHECK through
  `private.valid_appearance(jsonb)`; restate `create_gladiator` accepting the optional `appearance` command key (5 or 6
  keys) and storing it or `null`; restate `private.project_character` adding `appearance` to the actor jsonb; restate the
  `owner_state` view adding `appearance`; `select public.refresh_projections();`)
- Create: `supabase/migrations/<generated>_appearance.sql` (M24: `db pull appearance --local --schema public,private
  --yes`, completed and replayed per AGENTS.md)
- Modify: `supabase/functions/_shared/contracts/reads.ts:19-58` (`PublicActor.appearance: Appearance | null`,
  `OwnerState.appearance: Appearance | null`), every PublicActor/OwnerState literal in the code map's list,
  `docs/operations/migrations.md` (M24 record)
- Test: `tests/db/identity.test.ts`, `tests/db/projections.test.ts`, `tests/db/appearance.test.ts` (new), migration-count
  pins (23 → 24), the access matrix

**Interfaces:**
- Consumes: Task 1's `Appearance` and command shape.
- Produces: the stored column; `actor.appearance` and `owner.appearance` in reads (`null` for legacy).

- [ ] **Step 1: Failing DB tests**: creating with a valid appearance stores it and the public actor and owner read show
  it; creating without one stores `null`; each invalid case of Task 1 is refused `invalid` with no gladiator, no receipt
  change beyond today's rules; a replayed create (same operation id, same command) returns the stored result; an existing
  gladiator's actor gains `appearance: null` after the migration's refresh; the CHECK refuses a direct invalid write.
- [ ] **Step 2: Run** `npm run test:db -- tests/db/appearance.test.ts tests/db/identity.test.ts tests/db/projections.test.ts`;
  expect FAIL.
- [ ] **Step 3: Implement** the source, apply it with the psql fallback (container label check first), update the
  contracts and literals.
- [ ] **Step 4: Run** the step 2 command and `npx vitest run`; expect PASS.
- [ ] **Step 5: Generate and complete M24**, `db reset --local --no-seed --yes`, inspect functions/ACLs/view, full
  `npm run test:db` (DB-test rule), lint and advisors `--local`; record M24 in `migrations.md`.
- [ ] **Step 6: Commit** `feat: store each gladiator's chosen look (M24)`.

### Task 4: One look for every scene

**Files:**
- Modify: `src/game/actors.ts:84-139` (`lookFor`, appearance-aware `layersFor`, `LAYER_ORDER` with the new layers),
  `src/game/camp-scene.ts:193` (`lookKey` includes the appearance), `src/game/battle-stage.ts:65-84`,
  `src/features/character/ExpeditionView.tsx:295-307`, `src/game/expedition-scene.ts:659-664` (`setLook` change test),
  `src/game/demo-world.ts`
- Test: `tests/domain/scene-layout.test.ts`, `tests/domain/battle-stage.test.ts`, `tests/browser/camp.spec.ts`,
  `tests/browser/expedition.spec.ts`

**Interfaces:**
- Consumes: Task 1 `Appearance`, palettes; Task 2 layer ids; Task 3 `actor.appearance`.
- Produces: `lookFor(appearance: Appearance | null, gladiatorId: string, silhouettes: readonly string[]): { layers:
  string[]; tint: { skin: number; cloth: number; hair: number } }`; `fighterLook(p, manifest, looks?: ReadonlyMap<string,
  Appearance | null>)` in battle-stage.

- [ ] **Step 1: Failing tests**: `lookFor(null, …) equals today's layers and tints` for 50 ids and several silhouette
  sets; a female appearance uses `body-female` and `cloth-female`, never `body`/`cloth`; `long`/`ponytail` use their
  layers; `bald` has no hair layer; head gear hides any hair; tints come from the chosen indices; `LAYER_ORDER` equals the
  manifest's layer order (new pin); `fighterLook` uses the look from `looks` when present and the legacy look otherwise;
  camp and expedition browser tests draw a fixture actor with a female/ponytail appearance (debug layers and tints).
- [ ] **Step 2: Run** `npx vitest run tests/domain/scene-layout.test.ts tests/domain/battle-stage.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** and replace the three `tintFor` look sites with `lookFor`.
- [ ] **Step 4: Run** the step 2 command, the camp and expedition browser specs (private config), `npx vitest run`,
  `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: draw each gladiator's chosen look in every scene`.

### Task 5: Replays wait for their fighters' looks

**Files:**
- Modify: `src/lib/api/reads.ts` (a batched look read by gladiator ids from `world_actor_reads`),
  `src/game/BattleViewport.tsx:22-30` (a `looks` prop passed to the scene), `src/game/battle-scene.ts:104-110`,
  `src/features/arena/BattleReplay.tsx:286` and its callers (replay page, SceneOverlay, TournamentPanel, ArenaPanel: pass
  known appearances when they hold world actors)
- Test: `tests/domain/battle-replay-looks.test.ts` (new, pure wait/timeout logic), `tests/browser/replay.spec.ts`

**Interfaces:**
- Consumes: Task 4 `fighterLook(p, manifest, looks)`; Task 3 actor reads.
- Produces: `readLooks(ids: readonly string[]): Promise<Map<string, Appearance | null>>`; `BattleViewport` prop
  `looks: ReadonlyMap<string, Appearance | null>`.

- [ ] **Step 1: Failing tests**: the replay mounts after the looks arrive and draws them; `mounts with the legacy look when
  the read times out` (1.5 s) or fails; ids already known from the caller are not read; a viewport unmounted during the read
  ignores the late result; the scene never re-skins mid-play (debug looks constant across the replay).
- [ ] **Step 2: Run** `npx vitest run tests/domain/battle-replay-looks.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, `replay.spec.ts` and the arena/tournament specs that open replays (private
  config), `npx vitest run`, `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: replay each fighter in its chosen look`.

### Task 6: Choose a look in the creation dialog

**Files:**
- Create: `src/features/character/LookPicker.tsx` (+ module CSS), `src/features/character/LookPreview.tsx` (DOM sprite)
- Modify: `src/features/character/CreateCharacter.tsx:26-58, 145` (draft v2 with `appearance`; the command sends it)
- Test: `tests/domain/look-picker.test.ts` (pure helpers), `tests/browser/identity.spec.ts`, `read-render.spec.ts`,
  `release.spec.ts` (aria snapshot), `visitor.spec.ts`

**Interfaces:**
- Consumes: Task 1 options and `randomAppearance`; Task 2 layers; Task 4 `lookFor`.

- [ ] **Step 1: Failing tests**: the dialog opens with a valid random look; each control changes the draft and the
  preview's layers/tints; the summary text for screen readers names the look; the command sent on Create carries exactly the
  chosen appearance; a version-1 draft opens with a random look and keeps its name, class and points; reduced motion shows
  a still frame; swatches have 44 px hit areas and names like "Skin tone Olive"; contrast 4.5:1; 360 px fits.
- [ ] **Step 2: Run** the new unit file; expect FAIL.
- [ ] **Step 3: Implement** per the spec's "mockup's details" (look step after the name, before the class).
- [ ] **Step 4: Run** the browser specs above (private config), `npx vitest run`, `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: choose a look when creating a gladiator`.

### Task 7: Gate, bench, production

- [ ] **Step 1:** Gate of record 12/12 on a quiet host; push (fast-forward).
- [ ] **Step 2:** Bench: link, `db push --dry-run` (only M24), `db push`, deploy `game-command` (and `game-worker` if its
  bundle changed), fast-forward `bench`, deployed harness 9/9, hosted checks; relink production.
- [ ] **Step 3:** Production, with Avi's go in chat: `db push` (only M24), functions, fast-forward `release`, harness 9/9,
  hosted checks; record the evidence in `docs/operations/release-evidence.md`.
