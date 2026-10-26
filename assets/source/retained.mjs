// Atlas images retained for open tabs (final review F1, 2026-10-26; README "Atlas image names").
// Release 84f2d44, serving players when the atlas images were first named by their content, fetches each atlas image at its
// old unhashed path (`actors/gladiators.png`) and pairs it with the frame table in its own JavaScript. A tab it left open must
// keep finding those exact bytes there after the next deploy, or it draws gladiators from the wrong atlas cells (the
// gladiator atlas was re-packed after 84f2d44). These files stay in public/assets as they are: build-assets.mjs never writes
// them, records their provenance, and `--check` accepts only these bytes. Delete them, and this list, in the next release that
// changes art: by then no open tab runs 84f2d44.
export const RETAINED_RELEASE = '84f2d44';

/** Each atlas image of RETAINED_RELEASE at its path under public/assets, with the sha256 and size of its bytes there. */
export const RETAINED_FOR_OPEN_TABS = [
  { atlas: 'gladiators', file: 'actors/gladiators.png', sha256: '9f4d3fdfb9ef429548dd7bd06d7eef4cd8c607430ee4b2828d6c32e4fee54450', bytes: 133315 },
  { atlas: 'npcs', file: 'actors/npcs.png', sha256: '8a1df614771d2b7e10c9267a5d8d91e3f4807372a17086db35ccc08cec6082a4', bytes: 36185 },
  { atlas: 'creatures', file: 'actors/creatures.png', sha256: '7fb9aafcfbc924f5066edbe8c38e4d084eee21fb76aec00a2a61b7ff7e38997a', bytes: 46790 },
  { atlas: 'camp', file: 'camp/tiles.png', sha256: 'ceaf9f6a979fedce18a3fd43d2bd0d28a03074a69ff9a010faecf1d83127c34b', bytes: 11472 },
  { atlas: 'camp-props', file: 'camp/props.png', sha256: 'b664d8dc84c2b5bf27f7d0a9746d99ddefdcc6c5ef4a57539411f1fe75dcf09a', bytes: 29826 },
  { atlas: 'woodland', file: 'expeditions/woodland.png', sha256: '12029727ada5adb9cb0dc28b7d28cd5858d49ad4492c97dc60dc8ecea65c44fb', bytes: 16685 },
  { atlas: 'outpost', file: 'expeditions/outpost.png', sha256: '77e64f01c5d176f743f4b06eab750f74acf11343088f0043689a83e94b22fb51', bytes: 13877 },
  { atlas: 'mountain', file: 'expeditions/mountain.png', sha256: 'd337f3b45455ca043662023eb8a43849ecdb01482890a0c0a4f142a4521e5c82', bytes: 14252 },
  { atlas: 'effects', file: 'effects/combat.png', sha256: '24a3bf121083d7be89c13c68388f097dd9063633b9e7624c0ef2dbce740f7a42', bytes: 2602 },
  { atlas: 'icons', file: 'ui/icons.png', sha256: 'd5a35f5d74c5af72d9049d3afc5281ac2fd6d43c6be59a1aef5d0810ee5c8620', bytes: 2559 },
  { atlas: 'closeups', file: 'battle/closeups.png', sha256: '41cd16a63b8fec474259034664db69582da7e29f6294b500f526eed7f88e146a', bytes: 20075 },
];
