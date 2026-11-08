import type { PartyBattleLog } from '@contracts/events';

// The actor atlases use 64 px square frames with a shared foot anchor at (32, 58).
const FRAME = 64;
const FEET_Y = 58;
const FORMATION_ROWS = 3;
const MAX_SCALE = 4;

export type PartyStageLayout = {
  scale: number;
  /** In participant order. x and y are integer foot anchors relative to the battlefield. */
  units: { id: string; x: number; y: number; scale: number; facing: 'left' | 'right'; hired: boolean }[];
};

export function planPartyStage(log: PartyBattleLog, viewport: { width: number; height: number }): PartyStageLayout {
  const width = Math.floor(viewport.width);
  const height = Math.floor(viewport.height);
  const extraScale = log.participants.some(unit => unit.role === 'major') ? 1 : 0;
  const takenSeats = new Set(log.participants.flatMap(unit => unit.side === 0 && unit.seat !== null ? [unit.seat] : []));
  let nextPartySeat = 0;
  let nextMonsterSeat = 0;
  const slots = log.participants.map(unit => {
    if (unit.side === 1) return nextMonsterSeat++;
    if (unit.seat !== null) return unit.seat;
    while (takenSeats.has(nextPartySeat)) nextPartySeat += 1;
    return nextPartySeat++;
  });
  const gaps = Math.max(FORMATION_ROWS - 1, ...slots);

  // Wide fields allow a stronger horizontal stagger. Narrow fields leave more height between rows.
  const narrowScale = height / (FRAME + 40 * gaps);
  const wideScale = Math.min(width / 224, height / (FRAME + 12 * gaps));
  const widthScale = (width - FRAME * extraScale) / (2 * FRAME);
  const heightScale = height / FRAME - extraScale;
  const scale = Math.max(1, Math.floor(Math.min(MAX_SCALE, widthScale, heightScale, Math.max(narrowScale, wideScale))));

  const leftWidth = Math.floor((width - FRAME * extraScale) / 2);
  const frameSize = FRAME * scale;
  const pitch = Math.max(0, Math.min(frameSize, Math.floor((height - frameSize) / gaps)));
  const firstFeetY = Math.floor((height - frameSize - gaps * pitch) / 2) + FEET_Y * scale;
  const units = log.participants.map((unit, index) => {
    const party = unit.side === 0;
    const major = unit.role === 'major';
    const unitScale = scale + (major ? 1 : 0);
    const sideWidth = party ? leftWidth : width - leftWidth;
    const center = party ? sideWidth / 2 : leftWidth + sideWidth / 2;
    const spread = Math.max(0, Math.min(26 * scale, (sideWidth - FRAME * unitScale) / 2));
    const slot = slots[index];
    const stagger = major ? 0 : [0, -spread, spread][slot % FORMATION_ROWS];
    const x = Math.round(center + (party ? stagger : -stagger));
    const y = major ? Math.floor((height - FRAME * unitScale) / 2) + FEET_Y * unitScale : firstFeetY + slot * pitch;
    return { id: unit.id, x, y, scale: unitScale, facing: party ? 'right' as const : 'left' as const, hired: unit.role === 'hireling' };
  });
  return { scale, units };
}
