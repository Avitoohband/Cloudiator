// Pose-driven 2D humanoid rig. Every drawn direction faces screen-right:
// 'front' = south-east (we see the face), 'back' = north-east (we see the back).
// Left-facing directions are produced by horizontal mirroring at runtime.
import { Mask, PixelCanvas } from '../tools/canvas.mjs';

export const FRAME = 64;
export const GROUND = 58;
export const ANCHOR = { x: 32, y: GROUND };

const D2R = Math.PI / 180;
const vec = (deg, len) => [Math.sin(deg * D2R) * len, Math.cos(deg * D2R) * len];
export const add = (p, v) => [p[0] + v[0], p[1] + v[1]];
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const dirVec = vec;

/** Body proportions (unscaled pixels): stocky, big-headed figures read well at 64x64. */
export const DIMS = {
  hipHalf: 2.4, shoulderHalf: 4.4, torso: 11, thigh: 6.6, shin: 6.4, upperArm: 5.6, foreArm: 5.2,
  headRx: 5.7, headRy: 6.1, headUp: 6.6,
  legW: [4.8, 3.9, 3.5], armW: [3.9, 3.4, 3.0], hand: 1.9,
};

/** Depth order of body slots, back to front. Parts of every layer are clipped by the body slots in front of them. */
export const SLOT_ORDER = {
  front: ['back', 'farLeg', 'nearLeg', 'farArm', 'torso', 'head', 'shield', 'nearArm', 'weapon', 'held'],
  back: ['shield', 'farLeg', 'nearLeg', 'farArm', 'torso', 'back', 'head', 'nearArm', 'weapon', 'held'],
};
const BODY_SLOTS = new Set(['farLeg', 'nearLeg', 'farArm', 'torso', 'head', 'nearArm']);

const DEFAULT_POSE = {
  lean: 0, breath: 0, air: 0, shiftX: 0, head: [0, 0], rotate: 0, seat: null,
  nearArm: [15, 35], farArm: [25, 50], nearLeg: [-6, 0], farLeg: [8, 0],
  weapon: 'hand', weaponAngle: 140, offhand: 'guard', held: null, face: 'normal',
};

export function withDefaults(pose) {
  return { ...DEFAULT_POSE, ...pose };
}

/**
 * Compute absolute joint positions for a pose.
 * @param {object} pose
 * @param {'front'|'back'} view
 * @param {number} scale
 */
export function skeleton(rawPose, view, scale = 1) {
  const pose = withDefaults(rawPose);
  const s = scale;
  const side = view === 'front' ? -1 : 1; // screen direction of the near (right-hand) side
  const p = {};
  p.hip = [0, 0];
  p.nearHip = [side * DIMS.hipHalf * s, 0];
  p.farHip = [-side * DIMS.hipHalf * s, 0];
  const leg = (hip, [a1, a2]) => {
    const knee = add(hip, vec(a1, DIMS.thigh * s));
    const ankle = add(knee, vec(a1 + a2, DIMS.shin * s));
    return { knee, ankle };
  };
  ({ knee: p.nearKnee, ankle: p.nearAnkle } = leg(p.nearHip, pose.nearLeg));
  ({ knee: p.farKnee, ankle: p.farAnkle } = leg(p.farHip, pose.farLeg));
  p.neck = [pose.lean * s, (-DIMS.torso - pose.breath) * s];
  p.nearShoulder = add(p.neck, [side * DIMS.shoulderHalf * s, 1 * s]);
  p.farShoulder = add(p.neck, [-side * DIMS.shoulderHalf * s, 0]);
  p.head = add(p.neck, [(1 + pose.head[0]) * s, (-DIMS.headUp + pose.head[1]) * s]);
  const arm = (shoulder, [a1, a2]) => {
    const elbow = add(shoulder, vec(a1, DIMS.upperArm * s));
    const hand = add(elbow, vec(a1 + a2, DIMS.foreArm * s));
    return { elbow, hand };
  };
  ({ elbow: p.nearElbow, hand: p.nearHand } = arm(p.nearShoulder, pose.nearArm));
  ({ elbow: p.farElbow, hand: p.farHand } = arm(p.farShoulder, pose.farArm));

  // Rotate (lying/falling) around the hip, then place on the ground.
  if (pose.rotate) {
    const r = pose.rotate * D2R;
    const c = Math.cos(r);
    const sn = Math.sin(r);
    for (const key of Object.keys(p)) {
      const [x, y] = p[key];
      p[key] = [x * c - y * sn, x * sn + y * c];
    }
  }
  let dy;
  if (pose.seat != null) {
    dy = pose.seat;
  } else {
    const lowest = Math.max(p.nearAnkle[1] + 1.5 * s, p.farAnkle[1] + 1.5 * s, p.head[1] + DIMS.headRy * s, p.neck[1] + 2 * s, p.nearHand[1] + 1.5 * s, p.farHand[1] + 1.5 * s);
    const lowestLegs = Math.max(p.nearAnkle[1], p.farAnkle[1]) + 1.5 * s;
    // Lying bodies sit 1px higher so heavy-armour bulk keeps clear of the frame's bottom border.
    dy = GROUND - (pose.rotate ? lowest + 1 : lowestLegs);
  }
  dy -= pose.air;
  let dx = ANCHOR.x + pose.shiftX;
  if (pose.rotate) {
    // Lying bodies are long: shift horizontally so head and feet (with outline) stay inside the frame.
    const xs = Object.entries(p).map(([key, [x]]) => (key === 'head' ? [x - DIMS.headRx * s - 1, x + DIMS.headRx * s + 1] : [x - 3 * s, x + 3 * s])).flat();
    const lo = Math.min(...xs) + dx;
    const hi = Math.max(...xs) + dx;
    if (lo < 3) dx += 3 - lo;
    else if (hi > FRAME - 4) dx -= hi - (FRAME - 4);
  }
  for (const key of Object.keys(p)) p[key] = [p[key][0] + dx, p[key][1] + dy];
  return { p, pose, view, side, scale: s };
}

/** Masks of the bare body parts; shared by the body painter and the occlusion pass. */
export function limbShapes(S) {
  const { p, scale: s } = S;
  const [l0, l1, l2] = DIMS.legW.map(w => w * s);
  const [a0, a1, a2] = DIMS.armW.map(w => w * s);
  const leg = (hip, knee, ankle) => new Mask(FRAME, FRAME).limb(...hip, ...knee, l0, l1).limb(...knee, ...ankle, l1, l2);
  const foot = ankle => new Mask(FRAME, FRAME).ellipse(ankle[0] + 1.6 * s, ankle[1] + 0.6 * s, 2.3 * s, 1.4 * s);
  const arm = (shoulder, elbow, hand) => new Mask(FRAME, FRAME)
    .limb(...shoulder, ...elbow, a0, a1).limb(...elbow, ...hand, a1, a2).ellipse(hand[0], hand[1], DIMS.hand * s, DIMS.hand * s);
  return {
    nearLeg: leg(p.nearHip, p.nearKnee, p.nearAnkle), farLeg: leg(p.farHip, p.farKnee, p.farAnkle),
    nearFoot: foot(p.nearAnkle), farFoot: foot(p.farAnkle),
    nearArm: arm(p.nearShoulder, p.nearElbow, p.nearHand), farArm: arm(p.farShoulder, p.farElbow, p.farHand),
    torso: new Mask(FRAME, FRAME).polygon(torsoPolygon(S)),
    neck: new Mask(FRAME, FRAME).limb(...p.neck, ...lerp(p.neck, p.head, 0.45), 3.4 * s, 3.4 * s),
    head: new Mask(FRAME, FRAME).ellipse(p.head[0], p.head[1], DIMS.headRx * s, DIMS.headRy * s),
  };
}

/** Silhouette masks per depth slot, used for occlusion. */
export function bodyShapes(S) {
  const l = limbShapes(S);
  return {
    nearLeg: l.nearLeg.clone().union(l.nearFoot), farLeg: l.farLeg.clone().union(l.farFoot),
    nearArm: l.nearArm, farArm: l.farArm, torso: l.torso.clone().union(l.neck), head: l.head,
  };
}

export function torsoPolygon(S) {
  const { p, side, scale: s } = S;
  const out = (pt, sign, ax, ay = 0) => [pt[0] + sign * ax * s, pt[1] + ay * s];
  return [
    out(p.nearShoulder, side, 1.7, -1.2),
    out(p.farShoulder, -side, 1.7, -1.2),
    out(p.farHip, -side, 1.6, 1),
    out(p.nearHip, side, 1.6, 1),
  ];
}

/**
 * Render a set of layer painters for one pose.
 * @param {object} pose
 * @param {'front'|'back'} view
 * @param {Record<string, (ctx) => void>} painters
 * @param {{ scale?: number }} opts
 * @returns {Record<string, PixelCanvas>}
 */
export function renderLayers(pose, view, painters, opts = {}) {
  const S = skeleton(pose, view, opts.scale ?? 1);
  const shapes = bodyShapes(S);
  const order = SLOT_ORDER[view];
  const occluders = {};
  for (let i = 0; i < order.length; i += 1) {
    const m = new Mask(FRAME, FRAME);
    for (const slot of order.slice(i + 1)) if (BODY_SLOTS.has(slot)) m.union(shapes[slot].dilate());
    occluders[order[i]] = m;
  }
  const result = {};
  for (const [layerId, painter] of Object.entries(painters)) {
    const parts = [];
    painter({ ...S, shapes, part: (slot, draw) => parts.push({ slot, draw }) });
    parts.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
    const canvas = new PixelCanvas(FRAME, FRAME);
    for (const { slot, draw } of parts) {
      if (!order.includes(slot)) throw new Error(`Unknown slot ${slot}`);
      const temp = new PixelCanvas(FRAME, FRAME);
      draw(temp);
      temp.erase(occluders[slot]);
      canvas.blit(temp, 0, 0);
    }
    clearBorder(canvas);
    result[layerId] = canvas;
  }
  return result;
}

/** Keep a 1px transparent border so nearest-neighbour scaling never bleeds into neighbouring frames. */
export function clearBorder(canvas) {
  for (let i = 0; i < canvas.width; i += 1) {
    canvas.clearPixel(i, 0); canvas.clearPixel(i, canvas.height - 1);
  }
  for (let i = 0; i < canvas.height; i += 1) {
    canvas.clearPixel(0, i); canvas.clearPixel(canvas.width - 1, i);
  }
}

export function flatten(layers, order) {
  const out = new PixelCanvas(FRAME, FRAME);
  for (const id of order) if (layers[id]) out.blit(layers[id], 0, 0);
  return out;
}
