import type { ItemReward } from '@contracts/events';
import type { GameMessage, GameNotification, HistoryEntry, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { trainingDailyLimit } from '@domain/economy';
import { applyXp } from '@domain/inventory';
import { RULES_V2 } from '@domain/rules-v2';
import type { Rules } from '@domain/types';
import type { RestedActivity } from '../../lib/api/reads';
import { ratingText } from '../bouts/bout-text';
import { xpView } from '../character/xp-progress';
import { dungeonOutcome } from '../dungeon/dungeon-text';
import { isUnread } from '../messages/messages';
import { rewardItemName } from '../messages/notifications';
import { restedNoteLines } from '../schedule/stamina-text';
import { ordinal } from '../tournaments/tournament-text';
import { earnedTitleRows, type TitleRow } from '../titles/title-notices';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const MIN_AWAY_MS = 30 * MINUTE_MS;
export const MAX_AWAY_RESULTS = 150;

export function awaySince(nowMs: number, deviceSeenMs: number | null, notificationsSeenMs: number): number {
  return Math.floor(Math.max(0, nowMs - 7 * DAY_MS, deviceSeenMs ?? 0, notificationsSeenMs));
}

export function awayTimeText(elapsedMs: number): string {
  const minutes = Math.max(0, Math.floor(elapsedMs / MINUTE_MS));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  if (hours > 0) return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
  return `${minutes} min`;
}

type AwayLine = {
  kind: GameNotification['kind'] | 'overflow';
  label: string;
  main: string;
  detail?: string;
};

export type AwaySummaryInput = {
  owner: OwnerState;
  rules: Rules;
  sinceMs: number;
  nowMs: number;
  results: readonly GameNotification[];
  rests: readonly RestedActivity[];
  history: readonly HistoryEntry[];
  messages: readonly GameMessage[];
  /** The bounded result read saw the same progression as the owner read, without a newer settlement. */
  progressionTrusted: boolean;
};

export type AwaySummary = {
  duration: string;
  resultCount: number;
  levelBefore: number | null;
  level: number;
  xpGained: number;
  xp: { valueText: string; max: boolean; previousFill: number; gainedFill: number };
  gold: number;
  renown: number;
  lines: AwayLine[];
  titles: TitleRow[];
  rested: string | null;
  items: (ItemReward & { name: string; label: string })[];
  messageCount: number;
  teamReply: boolean;
  seenUpToMs: number | null;
};

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const count = (value: number) => value.toLocaleString('en-US');
const counted = (value: number, word: string) => `${count(value)} ${word}${value === 1 ? '' : 's'}`;
const lootCount = (result: GameNotification) => result.summary.rewards.items.reduce((total, item) => total + item.quantity, 0);

function arenaLine(arena: readonly GameNotification[]): AwayLine | null {
  if (!arena.length) return null;
  const wins = arena.filter(result => result.summary.result === 'victory').length;
  const losses = arena.filter(result => result.summary.result === 'defeat').length;
  const rating = arena.reduce((total, { summary }) => total + (summary.arenaMode === 'unranked' ? 0 : summary.ratingDelta ?? 0), 0);
  const counts = [wins > 0 && `${count(wins)} won`, losses > 0 && `${count(losses)} lost`, rating !== 0 && ratingText(rating).toLowerCase()]
    .filter((text): text is string => typeof text === 'string');
  const [main = 'finished', ...detail] = counts;
  return { kind: 'arena', label: 'Arena', main, ...(detail.length ? { detail: ` · ${detail.join(' · ')}` } : {}) };
}

function tournamentLines(tournaments: readonly GameNotification[], history: readonly HistoryEntry[]): AwayLine[] {
  const places = new Map<string, HistoryEntry>();
  for (const bout of history) {
    if (bout.kind === 'tournament' && bout.place !== null && !places.has(bout.activityId)) places.set(bout.activityId, bout);
  }
  return tournaments.map(result => {
    const row = places.get(result.activityId);
    return { kind: 'tournament',
      label: row?.league ? `${capital(row.league)} Tournament` : 'Tournament',
      main: row?.place ? `${ordinal(row.place)} place` : 'finished',
    };
  });
}

function expeditionLines(expeditions: readonly GameNotification[]): AwayLine[] {
  const trips = new Map<string, { total: number; wins: number; loot: number }>();
  for (const result of expeditions) {
    const destination = result.destination ?? 'Expedition';
    const trip = trips.get(destination) ?? { total: 0, wins: 0, loot: 0 };
    trip.total += 1;
    trip.wins += Number(result.summary.success);
    trip.loot += lootCount(result);
    trips.set(destination, trip);
  }
  return Array.from(trips, ([destination, trip]) => ({
    kind: 'expedition', label: trip.total === 1 ? destination : `${destination} ×${count(trip.total)}`,
    main: trip.total === 1 ? (trip.wins ? 'won' : 'lost') : (trip.wins ? `${count(trip.wins)} won` : `${count(trip.total)} lost`),
    ...(trip.loot ? { detail: ` · back with ${counted(trip.loot, 'item')}` } : {}),
  }));
}

function dungeonLine(result: GameNotification): AwayLine {
  const outcome = dungeonOutcome(result.summary, 'you');
  const dungeon = result.summary.dungeon;
  const label = result.destination ?? (dungeon ? CATALOG_V1.dungeons[dungeon.id]?.name : null) ?? 'Dungeon';
  const prefix = `${label}: `;
  const main = dungeon?.partyWon && dungeon.terminalFight === 4 && result.summary.success ? 'your party won'
    : outcome?.startsWith(prefix) ? outcome.slice(prefix.length) : outcome ?? 'finished';
  const loot = lootCount(result);
  return { kind: 'dungeon', label, main, ...(loot ? { detail: ` · ${counted(loot, 'item')}` } : {}) };
}

function trainingLine(training: readonly GameNotification[], unspent: number): AwayLine | null {
  if (!training.length) return null;
  const points = training.reduce((total, result) => total + result.summary.rewards.attributePoints, 0);
  const label = training.length === 1 ? 'Training' : `Training ×${count(training.length)}`;
  const main = points > 0 ? `+${counted(points, 'attribute point')}` : 'no point (Training was full for your level)';
  return { kind: 'training', label, main, ...(points > 0 && unspent > 0 ? { detail: ' to spend' } : {}) };
}

function restText(rests: readonly RestedActivity[], rules: Rules): string | null {
  if (!rests.length) return null;
  const stamina = rests.some(rest => rest.reason === 'stamina');
  const limited = rests.some(rest => rest.reason === 'limit');
  const limit = trainingDailyLimit(rules) ?? trainingDailyLimit(RULES_V2);
  const reason = [stamina && 'not enough stamina', limited && `the Training limit (${limit} a game day)`].filter(Boolean).join(' or ');
  if (rests.length === 1) {
    // Use the same planned activity name as its notification. The summary adds the count and reason.
    const prefix = 'Your gladiator rested instead of ';
    const activity = restedNoteLines(rests[0], null, rules).title.slice(prefix.length);
    return `Rested once instead of ${activity}: ${reason}.`;
  }
  return `Rested ${count(rests.length)} times instead of planned activities: ${reason}.`;
}

function newItems(results: readonly GameNotification[]): AwaySummary['items'] {
  const items: ItemReward[] = [];
  let salvage: ItemReward | undefined;
  for (const result of results) {
    for (const item of result.summary.rewards.items) {
      if (item.catalogId === 'salvage' && salvage) {
        salvage.quantity += item.quantity;
      } else {
        const copy = { ...item };
        if (item.catalogId === 'salvage') salvage = copy;
        items.push(copy);
      }
    }
  }
  return items.map(item => ({ ...item, name: rewardItemName(item, false), label: rewardItemName(item) }));
}

function xpSummary(owner: OwnerState, rules: Rules, nowMs: number, xpGained: number, trusted: boolean) {
  const view = xpView(owner, rules, nowMs);
  let levelBefore: number | null = null;
  let gainedFill = 0;
  if (trusted && xpGained > 0) {
    const level = owner.progression.level;
    const earned = view.xp + rules.progression.xpPerCurrentLevel * (level * (level - 1) / 2);
    if (Number.isSafeInteger(earned) && earned >= xpGained) {
      const before = applyXp(1, 0, earned - xpGained).level;
      if (before < level) levelBefore = before;
      if (!view.max) gainedFill = Math.min(view.fill, xpGained / view.need);
    }
  }
  return { levelBefore, xp: { valueText: view.valueText, max: view.max, previousFill: Math.max(0, view.fill - gainedFill), gainedFill } };
}

/** Legacy results can have credited gold without a usable list of the sold items. */
function overflowCount(overflow: unknown): number | null {
  if (!Array.isArray(overflow) || overflow.length === 0) return null;
  let count = 0;
  for (const item of overflow) {
    const quantity: unknown = item?.quantity;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
    count += quantity;
  }
  return Number.isSafeInteger(count) ? count : null;
}

export function buildAwaySummary({ owner, rules, sinceMs, nowMs, results, rests, history, messages, progressionTrusted }: AwaySummaryInput): AwaySummary | null {
  const inWindow = (settledAtMs: number | null) => settledAtMs !== null && settledAtMs > sinceMs && settledAtMs <= nowMs;
  const recent = results.filter(result => inWindow(result.settledAtMs)).sort((a, b) => b.settledAtMs - a.settledAtMs).slice(0, MAX_AWAY_RESULTS);
  const earned = owner.titles.filter(title => title.source !== 'joined' && inWindow(title.earnedAtMs));
  const titles = earnedTitleRows(earned);
  const recentRests = rests.filter(rest => inWindow(rest.settledAtMs));
  const rested = restText(recentRests, rules);
  if (!recent.length && !titles.length && !rested) return null;

  const totals = { xpGained: 0, gold: 0, renown: 0, overflowItems: 0, overflowGold: 0 };
  let canCountOverflow = true;
  const byKind: Record<GameNotification['kind'], GameNotification[]> = { arena: [], tournament: [], expedition: [], dungeon: [], training: [] };
  for (const result of recent) {
    const reward = result.summary.rewards;
    totals.xpGained += reward.xp;
    totals.gold += reward.money + reward.overflowMoney;
    totals.renown += reward.renown;
    totals.overflowGold += reward.overflowMoney;
    if (reward.overflowMoney > 0) {
      const quantity = overflowCount(reward.overflow);
      if (quantity === null) canCountOverflow = false;
      else totals.overflowItems += quantity;
    }
    byKind[result.kind].push(result);
  }
  const { xpGained, gold, renown, overflowItems, overflowGold } = totals;
  const after = xpSummary(owner, rules, nowMs, xpGained, progressionTrusted);
  const lines = [
    arenaLine(byKind.arena),
    ...tournamentLines(byKind.tournament, history),
    ...expeditionLines(byKind.expedition),
    ...byKind.dungeon.map(dungeonLine),
    trainingLine(byKind.training, owner.progression.unspentAttributePoints),
  ].filter((line): line is AwayLine => line !== null);
  if (overflowGold > 0) lines.push({ kind: 'overflow', label: 'Bag full',
    main: `${canCountOverflow ? counted(overflowItems, 'item') : 'Items'} sold for ${count(overflowGold)} gold` });

  const titleIds = new Set(titles.map(title => title.id));
  const seenUpToMs = Math.max(0, recent[0]?.settledAtMs ?? 0,
    ...recentRests.map(rest => rest.settledAtMs ?? 0), ...earned.filter(title => titleIds.has(title.id)).map(title => title.earnedAtMs)) || null;
  const messageCount = owner.inbox.unread;
  return {
    duration: awayTimeText(nowMs - sinceMs), resultCount: recent.length, level: owner.progression.level, ...after, xpGained, gold, renown,
    lines, titles, rested, items: newItems(recent), messageCount, seenUpToMs,
    teamReply: messageCount > 0 && messages.some(message => message.kind === 'team-reply' && isUnread(message, owner.inbox)),
  };
}
