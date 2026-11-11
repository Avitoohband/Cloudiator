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

/** The expedition the hint speaks of: the one running now, else the first in the saved schedule, else the highest the level allows. */
function nextExpedition(owner: Pick<OwnerState, 'progression' | 'schedule' | 'currentActivity'>, nowMs: number):
  { id: ExpeditionId; kind: 'current' | 'scheduled' | 'highest' } {
  const scheduled = PHASES.map(phase => owner.schedule[phase]).filter((choice): choice is Extract<ActivityChoice, { kind: 'expedition' }> => choice.kind === 'expedition');
  const activity = owner.currentActivity;
  if (activity?.kind === 'expedition' && activity.status !== 'completed' && nowMs < activity.endsAtMs) {
    const choice = owner.schedule[PHASES[Math.floor(activity.startsAtMs / RULES_V1.clock.slotMs) % PHASES.length]];
    // Its own phase names it; a schedule edited since leaves the first scheduled one, then the highest the level allows.
    const id = choice.kind === 'expedition' ? choice.expeditionId : scheduled[0]?.expeditionId ?? highest(owner.progression.level);
    return { id, kind: 'current' };
  }
  if (scheduled.length > 0) return { id: scheduled[0].expeditionId, kind: 'scheduled' };
  return { id: highest(owner.progression.level), kind: 'highest' };
}

const highest = (level: number): ExpeditionId => EXPEDITIONS.filter(e => e.requiredLevel <= level).sort((a, b) => b.requiredLevel - a.requiredLevel)[0].id as ExpeditionId;

export function xpView(owner: Pick<OwnerState, 'progression' | 'schedule' | 'currentActivity'>, rules: Rules, nowMs: number): XpView {
  const { level, xp } = owner.progression;
  const ruleText = `Each level costs ${rules.progression.xpPerCurrentLevel} × your level`;
  const levelText = `Level ${count(level)}`;
  if (level >= RULES_V1.attributes.maximumLevel) {
    return { max: true, levelText, valueText: 'Max level', toNextText: '', ruleText, hint: null, crosses: false, fill: 1, ghost: 0, xp, need: 0 };
  }
  const need = rules.progression.xpPerCurrentLevel * level;
  const left = Math.max(0, need - xp);
  const base = { max: false, levelText, valueText: `${count(xp)} / ${count(need)} XP`, toNextText: `${count(left)} XP to Level ${count(level + 1)}`, ruleText, xp, need };
  const fill = Math.min(1, xp / need);
  try {
    const next = nextExpedition(owner, nowMs);
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
