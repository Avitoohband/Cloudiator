# Art source

Every atlas, map and manifest file in `public/assets/` is generated from the code in this
folder. This code is the art source: change a generator, rebuild, and review the result. Never
edit the generated PNG or JSON files by hand. The one exception is `public/assets/gallery.html`,
a hand-written inspection page that has its own provenance record.

**Production method (approved by Avi on 2026-10-12):** original pixel art written as deterministic
code, in the colorful-fantasy, angled-isometric style of reference panels A
(`docs/superpowers/specs/references/`). No image-generation output, downloaded packs or other
third-party assets are used. The plan's wording ("image-generation tool or free licensed packs")
was replaced by this route on purpose. Task 11 records this as an approved deviation.

## Commands

| Command | Effect |
| --- | --- |
| `node assets/source/build-assets.mjs` | Rebuild every file in `public/assets` plus `provenance.json`, and remove an atlas image's superseded content-addressed versions. |
| `node assets/source/build-assets.mjs --check` | Fail if any committed file differs from a fresh build, or if an orphan file (a stale content-addressed image, or an atlas image at an old unhashed path) sits in `public/assets`. `tests/assets` runs this check. |
| `node assets/source/tools/review-sheets.mjs` | Rewrite the review images in `docs/operations/art-review/`. |
| `node assets/source/tools/review-sheets.mjs --appearance [dir]` | Write only the appearance sheets (male and female bodies with each hair style, idle and walk, 1× and 4×, three colour sets, armour alignment) to `dir`, by default `node_modules/.cache/appearance-sheets/` (not committed). |
| `node assets/source/tools/render-map.mjs <map> <out.png> [scale] [--actors]` | Render one map offline. |
| Open `/assets/gallery.html` on any static server | Play every animation live, with layer toggles and tints. |

Output is byte-identical between runs. Randomness comes only from seeded `tools/random.mjs`.
PNG compression depends on the zlib build, so the builder keeps a committed PNG whenever its
decoded pixels are unchanged. Hashes therefore stay stable across Node versions and machines.

## Atlas image names

Every atlas image is named by its content: `actors/gladiators.<hash>.png`, where `<hash>` is the first 10 hex digits of the
sha256 of its bytes (`tools/content-names.mjs`). The manifest's `atlases.<key>.image` and the atlas table's `meta.image` carry
that name, and every loader (the camp, expedition and battle scenes, the creation preview, the gallery and the offline tools)
reads it from the manifest. Never write an atlas image's path in code or tests. The frame tables (`actors/gladiators.json`) keep
fixed names, because `src/game/assets.ts` bundles them into the JavaScript.

Why (final review F1, 2026-10-26): a tab keeps the frame tables of the release it loaded, but fetches an atlas image again
for every new scene, and `/assets/*` is not cached as immutable (`scripts/build-headers.mjs`). If changed art kept its name,
a tab left open across a release would draw every gladiator from the wrong atlas cells until reloaded. With content names,
changed art has a new address. When art changes, the build writes the new image and removes the superseded version. An old
tab then cannot find its image, and shows the scene's "art could not load" notice (as for any failed image load) instead of
scrambled gladiators.

**Nothing is retained for open tabs.** The atlas images of release `84f2d44`, which was serving players when images were
first named by content, stayed at their old unhashed paths (`actors/gladiators.png`) for one release, listed in `retained.mjs`
with their sha256. They were deleted, with `retained.mjs`, its provenance records and the two retained-image tests, in the next
release that changed art: the bigger camp beds (Task 7c, 2026-10-29). A tab left open on a release that old now shows the
scene's "art could not load" notice until it is reloaded, like a tab left open across any later art change. `--check` and
`tests/assets/manifest.test.ts` now refuse any atlas image that is not a manifest atlas's current content-named version. To
keep an old release's images for its open tabs again, restore a `retained.mjs` list and its `--check` handling from git history
(`git show 8ed0697:assets/source/retained.mjs`), and delete them in the next art release.

## Layout

- `tools/`: palette-locked `PixelCanvas` and `Mask` (`canvas.mjs`), the PNG codec, atlas packing,
  the seeded random generator, and the review and map renderers.
- `generators/rig.mjs`: the pose rig and the depth slots used to clip layers.
- `generators/poses.mjs`: keyframes for all 17 gladiator animations plus the NPC `talk` and `tend` loops.
- `generators/outfits.mjs`: layer painters for body (male and female), cloth and the female chest wrap, hair
  (short, long, ponytail, bun), armor, head gear, weapons, shield, held props, NPC clothing and troll features.
- `generators/gladiator.mjs`, `npcs.mjs`, `creatures.mjs`: actor packages.
- `generators/tiles.mjs`: corner-based 64×32 isometric autotiles. There are 16 masks per environment.
- `generators/props.mjs`: camp and expedition props, and the 16 arena wall segments.
- `generators/maps.mjs`: camp and expedition layouts, covering zones, stations, walkability, path
  graphs, lights and routes.
- `generators/effects.mjs`: combat effects and 16×16 icons.
- `generators/closeups.mjs`: the side-on close-up battle backdrops (Task 14): the arena (sand floor, curved
  podium wall with banners and braziers, crowd stands, a calm editor's box behind the fighters) and one per
  expedition (woodland clearing, ruined outpost, mountain snowfield). Each is 320×128 art pixels, shown at 3×.
- `provenance.json`: generated. It gives the hash, generator and license for every shipped file.

## Rules the tests enforce

- **One palette, hard edges.** Every opaque pixel uses a color from `tools/palette.mjs` at alpha 255.
  Add a color to the palette before you use it.
- **Frame sizes.** Actor frames are 64×64 with a 1px transparent border, and the ground-contact
  anchor is at (32, 58). Ground tiles are 64×32 diamonds.
- **Reusable body.** Every gladiator layer has a frame for every body frame
  (`<layer>/<action>/<dir>/<i>`). Draw the layers in manifest order. The rig clips each layer part
  by the body parts in front of it, so a fixed draw order always gives correct depth.
- **One silhouette for every body.** Equipment is cut from the male body masks, so every opaque pixel of
  `body-female` and `cloth-female` is opaque in `body` or `cloth` of the same frame
  (`tests/assets/appearance-art.test.ts`). The female body reads as female through its face, shading and
  the chest wrap, never through extra pixels.
- **Pivots.** Atlas frames carry a normalized `pivot`, which Phaser uses as the sprite origin, and
  the pixel anchor in `anchorPx`. Never write pixel values under `anchor`: Phaser would read them
  as a normalized pivot.
- **Directions.** South-east (`se`) and north-east (`ne`) are drawn. `sw` and `nw` mirror them
  (`manifest.directions`). Only `idle` and `walk` have `ne` frames. Other actions play facing
  `se` or `sw`.
- **Projection.** The north vertex of tile (x, y) is at screen ((x − y)·32, (x + y)·16). A prop's
  anchor is the north vertex of its anchor tile. One-tile props draw at `screenY(anchor) + sortY`.
  Wider props are drawn as 32px vertical slices, each at the screen y of the footprint's front edge
  under it, so actors in front of any face draw over it. Arena wall segments ship explicit
  `slices`: each one sorts at the lowest ground point of the wall band within its own columns.
  Every sort line is biased half a pixel early, so an actor exactly on it draws in front.
  `floor` props draw under all actors and `foreground` props over them. Use `drawSlices` in
  `src/game/depth.ts` (the offline renderers use the identical `tools/depth.mjs`). The rule is also
  in `manifest.depthRule`. It is tested against every wide prop and, pixel by pixel, against the
  arena ring.

## Runtime notes for Tasks 12, 14 and 15

- Draw one body with its clothes: `body` and `cloth`, or `body-female` and `cloth-female` for a female
  body. Draw at most one hair layer: `hair` (short), `hair-long` or `hair-ponytail`, and none when bald.
- Multiply-tint every layer that has a `tint` key (`skin`, `cloth` or `hair`) with that player's
  colour. The `accent` sash, the front flap and the helmet crest share the cloth colour, so
  players stay recognisable under heavy armour.
- Map equipment with `manifest.equipmentLayers`, keyed by the catalog template id (the part of
  `sword:1:common` before the first colon). When the gladiator holds a two-handed weapon (spear or
  bow), hide `offhand-shield`. When it wears head gear, hide every hair layer. Draw `head-helmet-crest`
  only with `head-helmet`.
- Move walkers at `actors.gladiator.walk.tilesPerSecond`, which matches the walk stride.
- Attack variants: `thrust` for the spear and `shoot` for the bow
  (`actors.gladiator.attackVariants`).
- Use nearest-neighbour scaling everywhere. Phaser's pixel-art mode covers this.
- Close-up replays (Task 14): draw a `manifest.closeups` backdrop, the fighters and the effects at the same
  integer `closeups.scale` (3), so every art pixel sits on one grid. Fighters stand on row `groundY` at
  `fighterX` (left faces se; right is mirrored to face sw). `src/game/battle-stage.ts` derives every pose,
  effect and damage label from the revealed battle log.
- Lighting, sky tint and torch glow come from the scene (Task 12). Animated props reference the
  `prop-<atlas>-torch` and `prop-<atlas>-campfire` animations.
