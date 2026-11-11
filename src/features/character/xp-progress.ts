// The XP bar's words and widths (Patch 1.9 Task 10; the approved xp-help mockup). Pure: My gladiator's bar and the corner chip's thin line
// both read `xpView`. XP is `progression.xp`, the amount into the current level, and a level costs `xpPerCurrentLevel × level` (the
// active rules; `applyXp` spends it). The expedition the hint speaks of pays its XP only on a win, so every line says "up to" and "can".
import type { ActivityChoice } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { expeditionReward, type ExpeditionId } from '@domain/economy';
import { applyXp } from '@domain/inventory';
import { RULES_V1 } from '@domain/rules-v1';
import type { Rules } from '@domain/types';

export type XpView = {
  /** At the level cap: no bar to fill and no hint. */
  max: boolean;
  /** "Level 5" (the number with thousands separators). */
  levelText: string;
  /** "230 / 500 XP", or "Max level". */
  valueText: string;
  /** "270 XP to Level 6"; empty at the cap. */
  toNextText: string;
  /** The same in parts: the XP still needed ("270 XP") and the level it opens ("Level 6"); empty at the cap. */
  leftText: string;
  nextLevelText: string;
  /** "Each level costs 100 × your level". */
  ruleText: string;
  /** What the next expedition can add, or null (the cap, or nothing to say). */
  hint: string | null;
  /** The next expedition's XP can finish the level: the hint's swatch and the ghost segment turn gold. */
  crosses: boolean;
  /** The bar's fill (0 to 1) and the ghost segment after it (what the next expedition could add, to the end at most). */
  fill: number;
  ghost: number;
  xp: number;
  need: number;
};

const count = (value: number) => value.toLocaleString('en-US');
const PHASES = RULES_V1.clock.phases;
const EXPEDITIONS = Object.values(CATALOG_V1.expeditions);

/** The catalog id of an expedition location ("expedition:outpost"), or null for any other place or an unknown id. */
function expeditionAt(location: string | null | undefined): ExpeditionId | null {
  const id = location?.startsWith('expedition:') ? location.slice('expedition:'.length) : null;
  return id !== null && Object.hasOwn(CATALOG_V1.expeditions, id) ? id as ExpeditionId : null;
}

/**
 * The expedition the hint speaks of: the one running now (its destination is the owner's world location, never the schedule, which can be
 * edited mid-slot; unknown while the world is not loaded), else the next one to run (the phases after the current slot, today's rest and then
 * tomorrow's, in the order they run), else the highest the level allows.
 */
function nextExpedition(owner: Pick<OwnerState, 'progression' | 'schedule' | 'currentActivity'>, nowMs: number, location: string | null | undefined):
  { id: ExpeditionId | null; kind: 'current' | 'scheduled' | 'highest' } {
  const activity = owner.currentActivity;
  if (activity?.kind === 'expedition' && activity.status !== 'completed' && nowMs >= activity.startsAtMs && nowMs < activity.endsAtMs) {
    return { id: expeditionAt(location), kind: 'current' };
  }
  const current = Math.floor(nowMs / RULES_V1.clock.slotMs);
  for (let ahead = 1; ahead <= PHASES.length; ahead++) {
    const choice = owner.schedule[PHASES[(current + ahead) % PHASES.length]];
    if (choice.kind === 'expedition') return { id: choice.expeditionId, kind: 'scheduled' };
  }
  return { id: highest(owner.progression.level), kind: 'highest' };
}

const highest = (level: number): ExpeditionId => EXPEDITIONS.filter(e => e.requiredLevel <= level).sort((a, b) => b.requiredLevel - a.requiredLevel)[0].id as ExpeditionId;

export function xpView(owner: Pick<OwnerState, 'progression' | 'schedule' | 'currentActivity'>, rules: Rules, nowMs: number, location?: string | null): XpView {
  const { level, xp } = owner.progression;
  const ruleText = `Each level costs ${rules.progression.xpPerCurrentLevel} × your level`;
  const levelText = `Level ${count(level)}`;
  if (level >= RULES_V1.attributes.maximumLevel) {
    return { max: true, levelText, valueText: 'Max level', toNextText: '', leftText: '', nextLevelText: '', ruleText, hint: null, crosses: false, fill: 1, ghost: 0, xp, need: 0 };
  }
  const need = rules.progression.xpPerCurrentLevel * level;
  const left = Math.max(0, need - xp);
  const base = { max: false, levelText, valueText: `${count(xp)} / ${count(need)} XP`, toNextText: `${count(left)} XP to Level ${count(level + 1)}`,
    leftText: `${count(left)} XP`, nextLevelText: `Level ${count(level + 1)}`, ruleText, xp, need };
  const fill = Math.min(1, xp / need);
  try {
    const next = nextExpedition(owner, nowMs, location);
    // A running expedition whose destination is not known yet is named, never guessed at: no number and no ghost.
    if (next.id === null) return { ...base, hint: 'Current expedition', crosses: false, fill, ghost: 0 };
    const award = expeditionReward(rules, next.id).xp;
    const reached = applyXp(level, xp, award).level;
    const crosses = reached > level;
    const name = next.kind === 'highest' ? `${CATALOG_V1.expeditions[next.id as keyof typeof CATALOG_V1.expeditions].name} ` : '';
    const which = next.kind === 'current' ? 'current' : 'next';
    const hint = crosses ? `Your ${which} ${name}expedition (up to +${count(award)} XP) can level you up to Level ${count(reached)}`
      : `${which === 'current' ? 'Current' : 'Next'} ${name}expedition: up to +${count(award)} XP · ${count(left - award)} more to Level ${count(level + 1)}`;
    return { ...base, hint, crosses, fill, ghost: Math.min(award, left) / need };
  } catch {
    return { ...base, hint: null, crosses: false, fill, ghost: 0 };
  }
}
