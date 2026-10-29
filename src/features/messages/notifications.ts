// Words for the Notifications tab of the messages panel (spec "Added 2026-10-28: notifications"): what one of the player's own
// settled activities earned, from its credited summary (the same data the result screens show, owner-only). Plain text lines only,
// never markup. The currency is said as gold, the player-facing word for the `money` fields (the data keeps its field names).
import type { ItemReward } from '@contracts/events';
import type { GameNotification } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The line a level-up shows, e.g. "Level up! Now level 4". */
export const levelUpLine = (level: number): string => `Level up! Now level ${level}`;

/**
 * One item found: its rarity, catalog name and tier, with its quantity when it is more than one ("Rare Sword (tier 5)", "Uncommon
 * Light boots (tier 1) ×2"); salvage is only its name and quantity. A catalog entry this client does not know is named from its id
 * ("iron-sword:5:rare" is "Rare Iron sword (tier 5)"), so a future item is still listed.
 */
function itemLine(item: ItemReward): string {
  const quantity = item.quantity > 1 ? ` ×${item.quantity}` : '';
  const template = item.catalogId.split(':')[0];
  if (template === CATALOG_V1.salvage.id) return `${CATALOG_V1.salvage.name}${quantity}`;
  const name = CATALOG_V1.items[item.catalogId]?.name ?? capital(template.replace(/-/g, ' '));
  return `${capital(item.rarity)} ${name} (tier ${item.tier})${quantity}`;
}

const KIND_NAME = { expedition: 'Expedition', arena: 'Arena', tournament: 'Tournament' } as const;

function titleOf(n: GameNotification): string {
  if (n.kind === 'training') return 'Training finished';
  const name = KIND_NAME[n.kind], result = n.summary.result;
  const title = `${name} ${result === 'victory' ? 'victory' : result === 'defeat' ? 'defeat' : 'finished'}`;
  return n.kind === 'expedition' && n.destination ? `${title}: ${n.destination}` : title;
}

/**
 * A notification as a title and its lines, in the order gold, XP, the level reached, renown, attribute points, the rating change,
 * each item found and the gold for items that did not fit (the result screens' wording). Only what was earned is listed; a result
 * that earned nothing says so in one line. `levelUp` is the level reached (the same one the "Level up!" line names) when this result raised the level, else null.
 */
export function notificationLines(n: GameNotification): { title: string; lines: string[]; levelUp: number | null } {
  const r = n.summary.rewards, rating = n.summary.ratingDelta;
  const lines = [
    r.money ? `+${r.money} gold` : null,
    r.xp ? `+${r.xp} XP` : null,
    n.levelAfter !== null ? levelUpLine(n.levelAfter) : null,
    r.renown ? `+${r.renown} renown` : null,
    r.attributePoints ? `+${r.attributePoints} attribute point${r.attributePoints === 1 ? '' : 's'}` : null,
    rating === undefined ? null : rating === 0 ? 'Rating unchanged' : `Rating ${rating > 0 ? '+' : '−'}${Math.abs(rating)}`,
    ...(r.items ?? []).map(itemLine),
    r.overflowMoney ? `+${r.overflowMoney} gold for items that did not fit` : null,
  ].filter((line): line is string => line !== null);
  return { title: titleOf(n), lines: lines.length ? lines : ['No rewards'], levelUp: n.levelAfter };
}
