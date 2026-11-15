import type { ActivitySummary, ItemReward } from '@contracts/events';
import type { EarnedTitle, GameMessage, GameNotification, HistoryEntry, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { RestedActivity } from '../../src/lib/api/reads';
import { fixtureUuid } from './arena-ids';
import { worldFixture } from './domain';

export type AwaySample = 'big' | 'small' | 'empty';
const minute = 60_000;
const ago = (minutes: number) => worldFixture.serverNowMs - minutes * minute;
export const AWAY_SAMPLE_SEEN_MS = ago(2 * 24 * 60);

function reward(catalogId: string): ItemReward {
  const item = catalogId === CATALOG_V1.salvage.id ? CATALOG_V1.salvage : CATALOG_V1.items[catalogId];
  return { catalogId, catalogVersion: CATALOG_V1.version, tier: item.tier, rarity: item.rarity, quantity: 1 };
}

function notification(name: string, kind: GameNotification['kind'], minutesAgo: number, rewards: Partial<ActivitySummary['rewards']>,
  options: { destination?: string; lost?: boolean; levelAfter?: number; dungeon?: ActivitySummary['dungeon']; ratingDelta?: number } = {}): GameNotification {
  const activityId = fixtureUuid(`away-sample-${name}`), settledAtMs = ago(minutesAgo);
  return { activityId, kind, settledAtMs, destination: options.destination ?? null, levelAfter: options.levelAfter ?? null,
    summary: { activityId, settledAtMs, resolvedKind: kind, result: options.lost ? 'defeat' : kind === 'training' ? 'completed' : 'victory',
      success: !options.lost, receiptId: fixtureUuid(`away-receipt-${name}`), replayExpiry: { state: 'expired' },
      rewards: { money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0, ...rewards },
      ...(options.ratingDelta !== undefined ? { ratingDelta: options.ratingDelta } : {}),
      ...(options.dungeon ? { dungeon: options.dungeon } : {}) } };
}

const outpost = (name: string, minutesAgo: number, item?: string, levelAfter?: number) =>
  notification(name, 'expedition', minutesAgo, { xp: 75, money: 10, items: item ? [reward(item)] : [] }, { destination: 'Ruined Outpost', levelAfter });
const tournament = notification('silver-tournament', 'tournament', 355, { money: 18, renown: 15 }, { lost: true });
const spearOutpost = outpost('spear-outpost', 600, 'spear:5:rare');
const big: GameNotification[] = [
  notification('training-newest', 'training', 45, { attributePoints: 1 }),
  notification('arena-win-newest', 'arena', 125, { renown: 10 }, { ratingDelta: 12 }),
  notification('wolf-den', 'dungeon', 190, { xp: 48, money: 8, items: [reward('salvage')] },
    { destination: 'Wolf Den', dungeon: { id: 'wolf-den', terminalFight: 4, partyWon: true } }),
  outpost('boots-outpost', 270, 'light-boots:5:common'),
  tournament,
  outpost('helmet-outpost', 435, 'iron-helmet:5:uncommon', 7),
  notification('arena-loss', 'arena', 515, { renown: 2 }, { lost: true, ratingDelta: -10 }),
  spearOutpost,
  notification('lost-outpost', 'expedition', 700, {}, { destination: 'Ruined Outpost', lost: true }),
  outpost('empty-outpost', 785),
  notification('arena-win-oldest', 'arena', 945, { renown: 10 }, { ratingDelta: 12 }),
  notification('training-oldest', 'training', 1045, { attributePoints: 1 }),
];

export function awaySampleResults(sample: AwaySample): readonly GameNotification[] {
  return sample === 'big' ? big : sample === 'small' ? [outpost('small-outpost', 60)] : [];
}

export function awaySampleProgression(sample: AwaySample): Partial<OwnerState['progression']> {
  return sample === 'big' ? { level: 7, xp: 168, league: 'silver', earnedAttributePoints: 22, unspentAttributePoints: 2 }
    : sample === 'small' ? { level: 6, xp: 495, league: 'silver' } : {};
}

export const AWAY_SAMPLE_TITLES: readonly EarnedTitle[] = [
  { id: 'rare-find', earnedAtMs: spearOutpost.settledAtMs, activityId: spearOutpost.activityId, source: 'result', detail: null },
];

export const AWAY_SAMPLE_RESTS: readonly RestedActivity[] = [
  { activityId: fixtureUuid('away-rested-outpost'), settledAtMs: ago(865), planned: 'expedition', destination: 'Ruined Outpost', reason: 'stamina', name: 'Aster' },
];

export const AWAY_SAMPLE_TOURNAMENT: HistoryEntry = {
  entryId: 'tournament:373243:silver:2:0', kind: 'tournament', activityId: tournament.activityId, foughtAtMs: tournament.settledAtMs - minute,
  settledAtMs: tournament.settledAtMs, result: 'defeat', success: false, replayExpiry: { state: 'expired' }, league: 'silver',
  tournamentId: 'tournament:373243:silver', round: 'Semifinal', place: 3, expeditionId: null, opponent: null,
};

export const AWAY_SAMPLE_REPLY: GameMessage = {
  id: 4, kind: 'team-reply', title: 'The team answered your feedback', preview: 'Thanks for the suggestion.',
  body: [{ p: 'Thanks for the suggestion.' }], action: null, publishedAtMs: ago(55),
};
