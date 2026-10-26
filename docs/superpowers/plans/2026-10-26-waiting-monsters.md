# Waiting Monsters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every expedition scene, each encounter's creature waits idling at its encounter spot until its fight; a beaten
creature fades as today, a winner stays.

**Architecture:** Client only, in the Phaser expedition scene. The scene already knows every encounter spot and its creature
from the map (`journeyMap(map).encounters[n]`: `enemy` tile, `enemyFacing`, `creature`). It draws one idle sprite per
encounter whose battle has not been staged yet, hides it while that battle is staged (the fight sprite takes over at the
same feet), and after the fight keeps the creature only if it won. No server, contract or rule change.

**Tech Stack:** Next.js 16.4.3 static client, Phaser (injected), Vitest, Playwright (`channel: 'chrome'`).

**Spec:** `docs/superpowers/specs/2026-10-26-waiting-monsters-design.md` (mockup
https://claude.ai/artifact/4P463MuqMHjTDs7wHFLEyG, approved by Avi 2026-10-26).

## Global Constraints

- Nothing revealed early: only the creature's identity and spot (fixed per expedition) show before its fight; the outcome
  appears only when the battle is revealed, as today.
- The fight itself (timing, poses, effects, labels, replay) is unchanged.
- After a fight: gladiator victory → the creature fades as today (`CREATURE_FADE_MS`); gladiator defeat → the creature stays
  at its spot, idling. Encounters that never happen keep their creature waiting.
- Reduced motion: a still idle frame (frame 0), no fade animation (instant hide), as the scene does today.
- Depth: the same rule as the fight's creature (`y + depth / 100`).
- TDD; no package downloads; gate of record `node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs`.

## Review Focus

1. A scene opened mid-trip (after encounter 1, before encounter 2): encounter 1's beaten creature is not drawn, 2 and 3
   wait (test `opens mid-slot with the beaten creature gone and the next two waiting`).
2. A defeat at encounter 2: creature 2 stays idling at its spot after the result poses, creature 3 keeps waiting, and the
   gladiator goes to the safe point as today (test `a creature that wins stays at its spot`).
3. No jump at fight start: the waiting sprite's position equals the fight sprite's position at the battle's first frame
   (test `the fight starts where the creature waited`).
4. Spectator view (another player's expedition) shows the same waiting creatures.
5. The map's encounter creatures agree with the server's plan ids (`creature:<id>:<n>`) for all three expeditions (unit
   test `map creatures match the server's encounter creatures`).

---

### Task 1: Waiting creatures in the expedition scene

**Files:**
- Create: `src/game/expedition-creatures.ts` (pure: which encounters show a waiting creature and in which state)
- Modify: `src/game/expedition-scene.ts` (draw the waiting sprites; extend `ExpeditionDebugState` with
  `waiting: { encounter: number; creatureId: string; x: number; y: number; frame: string; visible: boolean }[]`;
  keep a victorious creature instead of fading it)
- Test: `tests/domain/expedition-creatures.test.ts`, `tests/browser/expedition.spec.ts`

**Interfaces:**
- Produces: `waitingCreatures(state: ExpeditionSceneState): { encounter: number; mode: 'waiting' | 'fighting' | 'gone' |
  'stays' }[]` — one entry per encounter 1..3: `fighting` while that encounter's battle is staged (in progress or in its
  result poses), `gone` after a gladiator victory once its fade is done, `stays` after a gladiator defeat, `waiting`
  otherwise.

- [ ] **Step 1: Write the failing unit tests** for `waitingCreatures` over the stage states (before any encounter; during
  encounter 1; after a victory at 1; after a defeat at 2 with encounter 3 never fought; reduced motion irrelevant here) and
  `map creatures match the server's encounter creatures` (for woodland, outpost, mountain: each map encounter's
  `creature` equals the id inside the server plan's `creature:<id>:<n>` participant, via `planExpedition` with a fixture
  snapshot or an exported read-only table from `supabase/functions/_shared/domain/expedition.ts`).
- [ ] **Step 2: Run** `npx vitest run tests/domain/expedition-creatures.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the module, then the scene: one idle sprite per `waiting`/`stays` encounter at
  `worldToScreen(enemy.x + 0.5, enemy.y + 0.5)`, facing `enemyFacing` (mirrored as the fight's right-hand fighter), idle
  animation from the creature's manifest `idle` frames (frame 0 under reduced motion), hidden while `fighting`; the fight's
  creature after a defeat stays visible in its final pose instead of fading. Extend `debug()`.
- [ ] **Step 4: Browser tests** in `expedition.spec.ts`: Review Focus 1–4 above, plus the existing fight and fade tests
  updated only where the "winner stays" rule changes them. Run with the private config; expect PASS. Then `npx vitest
  run`, `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: show each expedition monster waiting at its spot`.

### Task 2: Gate, bench, production

- [ ] **Step 1:** Gate of record 12/12 on a quiet host; push (fast-forward).
- [ ] **Step 2:** Bench: fast-forward `bench`, deployed harness 9/9; check a Woodland scene on the bench visually.
- [ ] **Step 3:** Production: fast-forward `release` (client only), deployed harness 9/9. Record in release-evidence.
