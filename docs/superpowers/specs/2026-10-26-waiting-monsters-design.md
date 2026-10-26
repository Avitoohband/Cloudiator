# Expedition monsters waiting at their spots (design)

Avi tested the bench on 2026-10-26: "in the wood expedition, I didn't see the monster or enemies they fight with". The
cause (bench data): a creature is drawn only while its revealed battle plays; encounter battles last 5 s on average
(2–12 s), three per 80-minute expedition, so a monster is on screen less than 1% of the trip. Avi approved the clickable
mockup (https://claude.ai/artifact/4P463MuqMHjTDs7wHFLEyG) the same day: "approved, build the monsters too".

## Goal

On every expedition scene (Woodland, Outpost, Mountain; owner and spectator), each encounter's creature waits at its
encounter spot from the start of the trip, idling and facing the way the gladiator comes, until its fight. The fight plays
exactly as today, from the same spot. Afterwards: a creature the gladiator beat fades as today; a creature that won stays
at its spot, idling. Encounters that never happen (the trip ended at the safe point after a defeat) keep their creature
waiting.

## Non-goals

- No change to the server, the battle, its timing, rewards or what is revealed: the creature of each encounter is fixed per
  expedition (the server's `creature:<id>:<n>` ids), not an outcome, so showing it early reveals nothing.
- No new art, no wandering or roaming creatures, no camp changes.

## Decisions (Claude's calls, matching the mockup)

- One source for which creature fights at which encounter: the shared domain's table (today a private `CREATURES` constant
  in `supabase/functions/_shared/domain/expedition.ts`), exported and read by the scene. The server's behaviour does not
  change, so no Edge redeploy is needed.
- A waiting creature stands where its fight puts it (`journey.encounters[n].enemy`), mirrored like the fight's right-hand
  fighter, so the fight starts with no jump; while its battle is staged the waiting sprite is hidden and the fight sprite
  takes over.
- Reduced motion: a still idle frame. Depth: the same depth rule as the fight's creature.
- The scene's debug state gains the waiting creatures (encounter, creature id, position, frame, visible) for the browser
  tests.
