# Art source

Every file in `public/assets/` is generated from the code in this folder. This code is the art
source: change a generator, rebuild, and review the result. Never edit the generated PNG or JSON
files by hand.

**Production method (approved by Avi on 2026-10-12):** original pixel art written as deterministic
code, in the colorful-fantasy, angled-isometric style of reference panels A
(`docs/superpowers/specs/references/`). No image-generation output, downloaded packs or other
third-party assets are used. The plan's wording ("image-generation tool or free licensed packs")
was replaced by this route on purpose. Task 11 records this as an approved deviation.

## Commands

| Command | Effect |
| --- | --- |
| `node assets/source/build-assets.mjs` | Rebuild every file in `public/assets` plus `provenance.json`. |
| `node assets/source/build-assets.mjs --check` | Fail if any committed file differs from a fresh build. `tests/assets` runs this check. |
| `node assets/source/tools/review-sheets.mjs` | Rewrite the review images in `docs/operations/art-review/`. |
| `node assets/source/tools/render-map.mjs <map> <out.png> [scale] [--actors]` | Render one map offline. |
| Open `/assets/gallery.html` on any static server | Play every animation live, with layer toggles and tints. |

Output is byte-identical between runs. Randomness comes only from seeded `tools/random.mjs`.

## Layout

- `tools/`: palette-locked `PixelCanvas` and `Mask` (`canvas.mjs`), the PNG codec, atlas packing,
  the seeded random generator, and the review and map renderers.
- `generators/rig.mjs`: the pose rig and the depth slots used to clip layers.
- `generators/poses.mjs`: keyframes for all 17 gladiator animations plus the NPC `talk` and `tend` loops.
- `generators/outfits.mjs`: layer painters for body, cloth, hair, armor, head gear, weapons,
  shield, held props, NPC clothing and troll features.
- `generators/gladiator.mjs`, `npcs.mjs`, `creatures.mjs`: actor packages.
- `generators/tiles.mjs`: corner-based 64×32 isometric autotiles. There are 16 masks per environment.
- `generators/props.mjs`: camp and expedition props, and the 16 arena wall segments.
- `generators/maps.mjs`: camp and expedition layouts, covering zones, stations, walkability, path
  graphs, lights and routes.
- `generators/effects.mjs`: combat effects and 16×16 icons.
- `provenance.json`: generated. It gives the hash, generator and license for every shipped file.

## Rules the tests enforce

- **One palette, hard edges.** Every opaque pixel uses a color from `tools/palette.mjs` at alpha 255.
  Add a color to the palette before you use it.
- **Frame sizes.** Actor frames are 64×64 with a 1px transparent border, and the ground-contact
  anchor is at (32, 58). Ground tiles are 64×32 diamonds.
- **Reusable body.** Every gladiator layer has a frame for every body frame
  (`<layer>/<action>/<dir>/<i>`). Draw the layers in manifest order. The rig clips each layer part
  by the body parts in front of it, so a fixed draw order always gives correct depth.
- **Directions.** South-east (`se`) and north-east (`ne`) are drawn. `sw` and `nw` mirror them
  (`manifest.directions`). Only `idle` and `walk` have `ne` frames. Other actions play facing
  `se` or `sw`.
- **Projection.** The north vertex of tile (x, y) is at screen ((x − y)·32, (x + y)·16). A prop's
  anchor is the north vertex of its anchor tile. Its draw depth is
  `screenY(anchor) + sortY`, where `floor` props draw under actors and `foreground` props over them.

## Runtime notes for Tasks 12, 14 and 15

- Tint the `cloth` and `hair` layers per player, because they are drawn in grays. Do not tint
  other layers.
- When the gladiator holds a two-handed weapon (spear or bow), hide `offhand-shield`.
- Attack variants: `thrust` for the spear and `shoot` for the bow
  (`actors.gladiator.attackVariants`).
- Use nearest-neighbour scaling everywhere. Phaser's pixel-art mode covers this.
- Lighting, sky tint and torch glow come from the scene (Task 12). Animated props reference the
  `prop-<atlas>-torch` and `prop-<atlas>-campfire` animations.
