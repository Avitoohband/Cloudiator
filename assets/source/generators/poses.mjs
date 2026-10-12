// Pose keyframes. Angles are degrees from straight down; positive rotates toward the facing direction.
// Legs: [hip angle, knee bend] (negative bend = foot behind). Arms: [shoulder angle, elbow bend].

const stand = { nearLeg: [-8, 2], farLeg: [10, -2] };
const lunge = { nearLeg: [28, -16], farLeg: [-16, 0] };
const crouch = { nearLeg: [-6, -22], farLeg: [16, -26] };
const seated = { seat: 49, nearLeg: [84, -84], farLeg: [78, -78] };
const rest = { weapon: 'stowed', offhand: 'back' };

/** @type {Record<string, { loop: boolean, views: ('front'|'back')[], durations: number[], frames: object[] }>} */
export const GLADIATOR_ACTIONS = {
  idle: {
    loop: true, views: ['front', 'back'], durations: [260, 220, 260, 220],
    frames: [
      { ...stand, nearArm: [-14, 30], farArm: [32, 52], weaponAngle: 176 },
      { ...stand, breath: 1, nearArm: [-13, 29], farArm: [33, 51], weaponAngle: 177 },
      { ...stand, breath: 1, nearArm: [-13, 29], farArm: [34, 50], weaponAngle: 178, head: [0, -0.4] },
      { ...stand, nearArm: [-14, 30], farArm: [32, 52], weaponAngle: 176 },
    ],
  },
  walk: {
    loop: true, views: ['front', 'back'], durations: [110, 110, 110, 110, 110, 110],
    frames: [
      { lean: 1, nearLeg: [24, -6], farLeg: [-22, -20], nearArm: [-16, 30], farArm: [18, 25], weaponAngle: 196 },
      { lean: 1, nearLeg: [12, -4], farLeg: [-6, -42], nearArm: [-8, 30], farArm: [8, 25], weaponAngle: 186, breath: 1 },
      { lean: 1, nearLeg: [-6, -2], farLeg: [14, -26], nearArm: [6, 30], farArm: [-6, 25], weaponAngle: 172, breath: 1 },
      { lean: 1, nearLeg: [-22, -20], farLeg: [24, -6], nearArm: [18, 30], farArm: [-16, 25], weaponAngle: 160 },
      { lean: 1, nearLeg: [-6, -42], farLeg: [12, -4], nearArm: [8, 30], farArm: [-8, 25], weaponAngle: 170, breath: 1 },
      { lean: 1, nearLeg: [14, -26], farLeg: [-6, -2], nearArm: [-6, 30], farArm: [6, 25], weaponAngle: 184, breath: 1 },
    ],
  },
  weights: {
    loop: true, views: ['front'], durations: [320, 240, 420, 240],
    frames: [
      { ...rest, ...crouch, held: 'barbell', face: 'strain', nearArm: [62, 100], farArm: [58, 104] },
      { ...rest, nearLeg: [-8, -8], farLeg: [12, -10], held: 'barbell', face: 'strain', nearArm: [118, 48], farArm: [114, 52] },
      { ...rest, ...stand, breath: 1, held: 'barbell', face: 'strain', nearArm: [168, 6], farArm: [166, 8] },
      { ...rest, nearLeg: [-8, -8], farLeg: [12, -10], held: 'barbell', face: 'strain', nearArm: [118, 48], farArm: [114, 52] },
    ],
  },
  practice: {
    loop: true, views: ['front'], durations: [220, 120, 200, 220],
    frames: [
      { ...stand, lean: -1, nearArm: [200, -20], farArm: [40, 60], weaponAngle: 215 },
      { ...stand, lean: 1, nearArm: [130, -10], farArm: [45, 55], weaponAngle: 150 },
      { ...lunge, lean: 3, nearArm: [55, 0], farArm: [50, 40], weaponAngle: 75, face: 'shout' },
      { ...stand, lean: 1, nearArm: [80, 30], farArm: [40, 55], weaponAngle: 125 },
    ],
  },
  spar: {
    loop: true, views: ['front'], durations: [240, 160, 240, 220],
    frames: [
      { ...stand, nearArm: [35, 55], farArm: [45, 60], weaponAngle: 120 },
      { ...lunge, lean: 3, nearArm: [88, 2], farArm: [50, 50], weaponAngle: 92 },
      { ...stand, nearArm: [30, 60], farArm: [45, 60], weaponAngle: 125 },
      { nearLeg: [-12, -8], farLeg: [14, -10], lean: -1, nearArm: [70, 70], farArm: [120, 30], offhand: 'raised', weaponAngle: 160 },
    ],
  },
  sit: {
    loop: true, views: ['front'], durations: [800, 700],
    frames: [
      { ...rest, ...seated, nearArm: [40, 40], farArm: [35, 45] },
      { ...rest, ...seated, breath: 1, nearArm: [41, 39], farArm: [36, 44], head: [0, -0.5] },
    ],
  },
  eat: {
    loop: true, views: ['front'], durations: [320, 240, 360, 240],
    frames: [
      { ...rest, ...seated, held: 'bowl', farArm: [28, 72], nearArm: [35, 62] },
      { ...rest, ...seated, held: 'bowl', farArm: [28, 72], nearArm: [70, 80] },
      { ...rest, ...seated, held: 'bowl', farArm: [28, 72], nearArm: [86, 88], head: [1, 1], lean: 1 },
      { ...rest, ...seated, held: 'bowl', farArm: [28, 72], nearArm: [60, 75] },
    ],
  },
  sleep: {
    loop: true, views: ['front'], durations: [1000, 900],
    frames: [
      { weapon: 'none', offhand: 'none', rotate: -90, face: 'closed', nearLeg: [0, 0], farLeg: [6, -4], nearArm: [10, 10], farArm: [6, 12] },
      { weapon: 'none', offhand: 'none', rotate: -90, face: 'closed', breath: 1, nearLeg: [0, 0], farLeg: [6, -4], nearArm: [12, 10], farArm: [8, 12] },
    ],
  },
  search: {
    loop: true, views: ['front'], durations: [300, 260, 360, 360],
    frames: [
      { ...rest, nearLeg: [55, -95], farLeg: [18, -70], lean: 3, head: [1, 1], nearArm: [35, 0], farArm: [20, 30] },
      { ...rest, nearLeg: [55, -95], farLeg: [18, -70], lean: 4, head: [1, 1.5], nearArm: [52, -10], farArm: [22, 30] },
      { ...rest, nearLeg: [20, -40], farLeg: [6, -30], head: [0, -1], nearArm: [150, 115], farArm: [25, 40] },
      { ...rest, nearLeg: [20, -40], farLeg: [6, -30], head: [-1, -1], nearArm: [150, 115], farArm: [25, 40] },
    ],
  },
  attack: {
    loop: false, views: ['front'], durations: [90, 80, 120, 150],
    frames: [
      { nearLeg: [-12, 0], farLeg: [14, 0], lean: -2, nearArm: [210, -25], farArm: [40, 60], weaponAngle: 222 },
      { ...stand, lean: 1, nearArm: [140, -10], farArm: [50, 50], weaponAngle: 160 },
      { ...lunge, lean: 4, nearArm: [60, -5], farArm: [55, 35], weaponAngle: 70, face: 'shout' },
      { nearLeg: [14, -8], farLeg: [-8, 0], lean: 2, nearArm: [70, 30], farArm: [40, 55], weaponAngle: 110 },
    ],
  },
  thrust: {
    loop: false, views: ['front'], durations: [90, 80, 130, 150],
    frames: [
      { ...stand, lean: -2, nearArm: [10, 70], farArm: [50, 50], weaponAngle: 95 },
      { ...stand, lean: 1, nearArm: [60, 25], farArm: [75, 15], weaponAngle: 92 },
      { ...lunge, lean: 4, nearArm: [88, 0], farArm: [88, 2], weaponAngle: 90, face: 'shout' },
      { ...stand, lean: 1, nearArm: [40, 40], farArm: [60, 30], weaponAngle: 100 },
    ],
  },
  shoot: {
    loop: false, views: ['front'], durations: [120, 170, 80, 170],
    frames: [
      { ...stand, head: [1, 0], farArm: [90, 0], nearArm: [70, 40], bow: 'nock' },
      { ...stand, head: [1, 0], farArm: [90, 0], nearArm: [-85, 175], bow: 'draw' },
      { ...stand, head: [1, 0], farArm: [90, 0], nearArm: [-105, 160], bow: 'release', face: 'shout' },
      { ...stand, farArm: [70, 20], nearArm: [30, 50], bow: 'rest' },
    ],
  },
  hit: {
    loop: false, views: ['front'], durations: [120, 170],
    frames: [
      { nearLeg: [-14, 4], farLeg: [10, -6], lean: -3, shiftX: -1, head: [-1, 0], nearArm: [40, 20], farArm: [60, 10], weaponAngle: 160, face: 'hurt' },
      { nearLeg: [-10, 2], farLeg: [10, -4], lean: -1, shiftX: -1, nearArm: [30, 40], farArm: [40, 40], weaponAngle: 150, face: 'hurt' },
    ],
  },
  defend: {
    loop: false, views: ['front'], durations: [140, 220],
    frames: [
      { nearLeg: [-14, -16], farLeg: [16, -18], lean: -1, nearArm: [110, 20], farArm: [100, 30], offhand: 'raised', weaponAngle: 150 },
      { nearLeg: [-16, -18], farLeg: [16, -20], lean: -2, shiftX: -1, nearArm: [112, 18], farArm: [104, 28], offhand: 'raised', weaponAngle: 152 },
    ],
  },
  evade: {
    loop: false, views: ['front'], durations: [90, 110, 130],
    frames: [
      { nearLeg: [-6, -20], farLeg: [14, -24], lean: -2, nearArm: [30, 50], farArm: [40, 50], weaponAngle: 140 },
      { nearLeg: [-20, -30], farLeg: [10, -40], lean: -4, air: 3, shiftX: -5, nearArm: [60, 30], farArm: [80, 20], weaponAngle: 120 },
      { nearLeg: [-6, -20], farLeg: [14, -24], lean: -2, shiftX: -3, nearArm: [30, 50], farArm: [40, 50], weaponAngle: 140 },
    ],
  },
  defeat: {
    loop: false, views: ['front'], durations: [160, 180, 160, 400],
    frames: [
      { nearLeg: [-10, -12], farLeg: [12, -20], lean: -3, head: [-1, 1], nearArm: [30, 10], farArm: [20, 10], weaponAngle: 120, face: 'hurt' },
      { nearLeg: [8, -95], farLeg: [70, -72], lean: 2, head: [1, 2], nearArm: [5, 5], farArm: [8, 5], weaponAngle: 30, face: 'hurt' },
      { nearLeg: [4, -30], farLeg: [30, -40], rotate: -45, nearArm: [40, 10], farArm: [60, 10], weapon: 'dropped', offhand: 'dropped', face: 'closed' },
      { nearLeg: [0, 0], farLeg: [6, -10], rotate: -90, nearArm: [10, 10], farArm: [30, 40], weapon: 'dropped', offhand: 'dropped', face: 'closed' },
    ],
  },
  victory: {
    loop: false, views: ['front'], durations: [140, 140, 140, 420],
    frames: [
      { ...stand, nearArm: [120, 30], farArm: [60, 60], weaponAngle: 150 },
      { ...stand, air: 2, nearArm: [172, 4], farArm: [150, 40], weaponAngle: 182, face: 'shout' },
      { ...stand, air: 3, nearArm: [172, 4], farArm: [152, 38], weaponAngle: 182, face: 'shout' },
      { ...stand, nearArm: [172, 4], farArm: [150, 40], weaponAngle: 182 },
    ],
  },
};

/** Required actions in the order the manifest lists them. */
export const REQUIRED_ACTIONS = ['idle', 'walk', 'weights', 'practice', 'spar', 'sit', 'eat', 'sleep', 'search', 'attack', 'hit', 'defend', 'evade', 'defeat', 'victory'];
/** Weapon-specific attack variants that reuse the same layered body. */
export const ATTACK_VARIANTS = { spear: 'thrust', bow: 'shoot' };

export const NPC_ACTIONS = {
  idle: GLADIATOR_ACTIONS.idle,
  walk: GLADIATOR_ACTIONS.walk,
  talk: {
    loop: true, views: ['front'], durations: [260, 200, 260, 220],
    frames: [
      { ...stand, nearArm: [40, 60], farArm: [20, 30], face: 'shout' },
      { ...stand, nearArm: [85, 45], farArm: [22, 30], head: [0, -0.5] },
      { ...stand, nearArm: [62, 85], farArm: [20, 30], face: 'shout', head: [0.5, 0] },
      { ...stand, nearArm: [30, 50], farArm: [24, 30] },
    ],
  },
  tend: {
    loop: true, views: ['front'], durations: [260, 160, 220, 200],
    frames: [
      { ...stand, lean: 1, nearArm: [150, 20], farArm: [60, 40], weaponAngle: 200 },
      { ...stand, lean: 2, nearArm: [70, 10], farArm: [62, 40], weaponAngle: 100 },
      { ...stand, lean: 2, nearArm: [60, 30], farArm: [64, 38], weaponAngle: 95 },
      { ...stand, lean: 1, nearArm: [110, 30], farArm: [60, 40], weaponAngle: 160 },
    ],
  },
};

export const CREATURE_ACTIONS = ['idle', 'walk', 'attack', 'hit', 'defend', 'evade', 'defeat'];
