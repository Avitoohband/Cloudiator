# Gladiator appearance at creation (design)

Avi, 2026-10-26: "I want option to change the look of my gladiator, male, female, white, black, hair, long short, and so on."
The look is chosen when the gladiator is created; changing it later is for a future real-money shop ("real money shop
later"), not this change. Avi approved the clickable mockup (https://claude.ai/artifact/JiXzVcJDUurd5mf2i8hYG2) with
"approved, build it". Decisions marked **Claude's call** were stated to Avi or are settled here for the builder.

## Intent

Today every gladiator shares one body with short hair, and its skin, hair and clothes colours are a hash of its id
(`tintFor`, `src/game/actors.ts`): nobody chooses how their gladiator looks. Players should pick a look that is theirs, and
see it everywhere their gladiator appears. The option data is built so looks can later be sold as cosmetics.

## Goals

1. **Choose a look** in the creation dialog (mockup): Body **Male / Female**; Hair **Short / Long / Ponytail / Bald**; Skin
   tone (the 5 tones of `SKIN_TINTS`: Light, Tan, Olive, Brown, Deep brown); Hair colour (the 6 of `HAIR_TINTS`: Brown,
   Black, Auburn, Blond, Grey, Red); Clothes colour (the 12 of `CLOTH_TINTS`: Teal, Red, Gold, Purple, Blue, Green, Orange,
   Cream, Slate, Leather, Rose, Sky); a **Random look** button; a live, animated preview of the gladiator with its name;
   the line "Your look is set when you create your gladiator." The look step sits after the name, before the class.
2. **Stored and shown everywhere:** the camp (players, arena and tournament fighters), the expedition scene (owner and
   spectator) and battle replays draw the chosen body, hair style and colours.
3. **New art** from the code generators: a female body, a female clothes layer, long hair and ponytail hair, drawn on the
   same skeleton so every equipment layer still fits. Bald draws no hair layer.

## Non-goals

- Changing the look after creation (later, with the real-money shop), cosmetics for sale, the shop itself.
- Any effect on combat, stats, rewards or matchmaking. The look is cosmetic only.
- New faces, beards or marks; new colours beyond today's palettes.

## Anti-goals

- An existing gladiator that suddenly looks different.
- A look that differs between the camp, the expedition and a replay of the same gladiator.
- A look enforced only in the client: the server validates every field.
- Editing a committed migration (a new one, M24).

## Decisions (Claude's calls)

- **Storage:** `public.gladiators.appearance jsonb`, nullable, shape exactly `{body, hair, skin, hairColor, cloth}`:
  `body` ∈ male|female, `hair` ∈ short|long|ponytail|bald, `skin` 0–4, `hairColor` 0–5, `cloth` 0–11 (palette indices,
  so colours can change without rewriting rows). `null` means "the legacy look": male body, short hair, colours from
  `tintFor(gladiatorId)` exactly as today. Existing rows stay `null` (no backfill), so nobody's look changes.
- **One shared definition:** a domain module (`supabase/functions/_shared/domain/appearance.ts`) holds the option lists,
  palette sizes and a validator, used by the Edge parser, the client and tests; SQL restates the same bounds.
- **Command:** `create-character` gains an optional `appearance`. Present: validated (Edge `parseCommand` and SQL
  `create_gladiator`), stored. Absent (an open tab from before the release): stored `null`. The receipt replay compares
  the whole command as today.
- **Reads:** the public actor (`private.project_character` → `world_actors`) and the owner read carry `appearance`
  (`null` for legacy). Projections are refreshed by the migration.
- **Replays:** battle logs are unchanged (no worker, snapshot or SQL validator change). A replay finds each gladiator
  participant's look by `gladiatorId` from the public actor reads (one batched read per replay); until it arrives, or for
  an unknown id, it uses the legacy look. NPCs and creatures are unchanged.
- **One look function on the client:** `lookFor(appearance | null, gladiatorId, silhouettes)` → layers and tints, used by
  the camp, expedition and battle stages instead of the three `tintFor` sites; camp `lookKey` and expedition `setLook`
  include the appearance so a change re-draws.
- **Art layers:** new layers `body-female`, `cloth-female`, `hair-long`, `hair-ponytail` (all 71 frames, same skeleton and
  frame names); `hair` stays the short hair. A female body uses `body-female` and `cloth-female` instead of `body` and
  `cloth`; all equipment layers are shared. Female body and clothes stay inside the male torso and limb masks so armour
  covers them cleanly. Under head gear, any hair is hidden, as today. Palette-only colours, as the asset tests require.
- **Preview:** a small DOM sprite (the atlas frames with the same multiply tints), idle animation, a still frame under
  reduced motion; no Phaser in the dialog.
- **Default look:** the dialog opens with a random look (so new gladiators are not all identical); the creation draft
  (localStorage) keeps the chosen look and moves to version 2 (a version-1 draft gets a random look).
- **Accessibility:** real buttons with `aria-pressed`, swatches named by colour ("Skin tone Olive"), 44 px targets,
  4.5:1 text, the preview decorative with a text summary of the look for screen readers.

## Settled after the builder check (Claude's calls)

- **Replays never swap looks mid-play.** The replay viewport waits for the participants' looks (one batched public
  read, at most 1.5 s) before it mounts the battle scene; on failure or timeout it mounts with the legacy look. A caller
  that already holds the world actors (camp overlays) passes the known appearances in, and the read is skipped for them.
- **The new art gets a visible checkpoint.** The art task comes first and regenerates the contact sheets
  (`assets/source/tools/review-sheets.mjs`) for male and female bodies with each hair style; Claude sends Avi the sheet.
  Building continues meanwhile; any change Avi asks for is an art-only follow-up. `review-sheets.mjs` and `render-map.mjs`
  follow the new layers where their tests need it; `public/assets/gallery.html` is updated only if it is regenerated by the
  asset build.
- **The mockup's details are the dialog spec** (the canvas is private, so they are written here): the preview draws only
  body, clothes, hair and the untinted accent layer (no gear), on a small green ground with the name above in the game's
  pixel-label style, looping the 4 idle frames at 260 ms; Body and Hair are 2-column pill buttons; swatches are 32 px
  circles inside a 44 px hit area, the selected one ringed in gold; each group's label names the current choice ("Skin
  tone · Olive"); Hair colour stays selectable when Bald is chosen (it is stored); the mockup's note "Preview shows
  today's art…" is a mockup annotation and does not ship.

## Constraints

- Live production and bench: M24 must replay cleanly and keep every existing gladiator's look (all `null`).
- The release gate of record (12/12, private config) before any hosted deploy; production needs Avi's go in chat at release.
- The atlas stays under 4096 px tall; the asset `--check` byte-identical rule holds.

## Left to the builder

The exact pixel art (within the palette and masks), component structure, copy beyond what is quoted here, test layout,
and the migration's internal shape.
