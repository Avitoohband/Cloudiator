// Patch 1.9 Task 27 (Avi, 2026-11-12: "option to see gladiators arena match history\expedition history and tournaments battles history"; the
// approved mockup `.superpowers/design/2026-11-12-gladiator-history/`): the words of a gladiator's History on its card. Pure: no clock, React or
// storage. A row's words come from the public history read (the same for every reader), and on the viewer's own card only from its own
// rewards as well (`OwnRewards`, the owner read); another gladiator's card never shows a reward. Whether a replay is kept is decided by the
// server's time (the shared display clock), as My bouts decides it: a row that passes its expiry turns into a dimmed "replay no longer kept"
// row and no longer names its opponent. Times go through the shared formatter in the form the device's clock setting asks for.
import type { HistoryCounts, HistoryEntry, HistoryKind } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { ClockMode } from '../../lib/clock-setting';
import type { OwnRewards } from '../../lib/api/reads';
import { replayKept } from '../../lib/replay-retention';
import { dayText, timeOfDay } from '../../lib/time-format';
import { ratingText } from '../bouts/bout-text';
import type { SceneView } from '../shell/scene-url';

const SEP = ' · ';
/** The three lists, in the chips' order. */
export const HISTORY_KINDS: readonly HistoryKind[] = ['arena', 'tournament', 'expedition'];
/** The view's title: "Lucilla's history", or on the viewer's own card "My history". */
export const historyTitle = (name: string, own: boolean): string => (own ? 'My history' : `${name}'s history`);
export const HISTORY_SUBTITLE = 'Newest first · 20 at a time';
/** After the last page: nothing more to show. */
export const EVERYTHING = 'That is everything.';

const CHIPS: Record<HistoryKind, { icon: string | null; label: string }> = {
  arena: { icon: null, label: 'Arena' },
  // The controller's ruling (Task 25 review): the counts count fights, so the chip says so.
  tournament: { icon: '🏆', label: 'Tournament fights' },
  expedition: { icon: null, label: 'Expeditions' },
};
/** A chip's words; its icon is a picture only. */
export const chipText = (kind: HistoryKind): { icon: string | null; label: string } => CHIPS[kind];
/** A chip's number: the Arena list's won–lost, the other lists' size; nothing until the counts are read. */
export function chipCount(kind: HistoryKind, counts: HistoryCounts | null): string {
  if (!counts) return '';
  const { total, won } = counts[kind];
  return kind === 'arena' ? `${won}–${total - won}` : String(total);
}

const RETENTION: Record<HistoryKind, string> = {
  // The controller's ruling (fix round 1): the Arena list (and its chip) counts NPC and bot bouts too, over the 90 days a result is kept.
  arena: 'Replays are kept for 7 days. ▶ Watch shows where a replay is still kept. Last 90 days, NPC and bot bouts included.',
  tournament: 'Tournament replays are kept for 7 days after the tournament ends.',
  expedition: 'Expedition replays are kept for 7 days. A trip still under way can be watched once it is over.',
};
/** The line under the chips: how long a list's replays are kept. */
export const retentionText = (kind: HistoryKind): string => RETENTION[kind];
/** The view's foot: whose rewards show. */
export const footerText = (own: boolean): string => (own ? 'You see your own rewards here. Other players see only the results.'
  : 'Rewards stay private. Anyone can watch a kept replay; it shows the fights, never loot.');
/** An empty list: its title and line, with the gladiator's name (the viewer's own on its own card). */
export function emptyHistory(kind: HistoryKind, name: string): { title: string; line: string } {
  return kind === 'arena' ? { title: 'No Arena bouts yet', line: `${name} has not fought in the Arena.` }
    : kind === 'tournament' ? { title: 'No tournament battles yet', line: `${name} has not fought in a tournament.` }
      : { title: 'No expeditions yet', line: `${name} has not been on an expedition.` };
}

export type HistoryRowText = {
  kept: boolean;
  /** W or L (an expedition: ✓ or ✗), its spoken word, and whether it is the good result (its colour). */
  badge: { text: 'W' | 'L' | '✓' | '✗'; name: 'Won' | 'Lost' | 'Success' | 'Failed'; won: boolean };
  name: string;
  tag: 'NPC' | 'BOT' | null;
  /** A tournament row's round line ("FINAL") and result pill ("WON"); null on other rows. */
  round: string | null;
  pill: 'WON' | 'LOST' | null;
  sub: string;
  /** ▶ Watch while the replay is kept, Result once it is gone; none until the server's time is known. */
  action: '▶ Watch' | 'Result' | null;
  /** The button's name, unique in the list: "Watch: vs Varro, Sat 10 Oct, 2:40 AM". */
  label: string;
};

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
function ordinal(n: number): string {
  const tens = n % 100, ones = n % 10;
  return `${n}${tens >= 11 && tens <= 13 ? 'th' : ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th'}`;
}
/** A catalog item's name ("Iron helmet", "Salvage"), with its count when more than one. */
function itemText(item: { catalogId: string; quantity: number }): string {
  const name = item.catalogId === 'salvage' ? CATALOG_V1.salvage.name : CATALOG_V1.items[item.catalogId]?.name ?? capital(item.catalogId.split(':')[0].replace(/-/g, ' '));
  return item.quantity > 1 ? `${name} ×${item.quantity}` : name;
}
/**
 * The owner's own rewards, as its own card shows them (the mockup's): an Arena bout's renown (always) and rating change; a tournament run's
 * place and prize on its last bout only; an expedition's gold and items. Nothing without rewards (another gladiator's card).
 */
function rewardParts(entry: HistoryEntry, rewards: OwnRewards | null | undefined, runLast: boolean): string[] {
  if (!rewards) return [];
  if (entry.kind === 'arena') {
    return [`+${rewards.renown} renown`, rewards.unranked || entry.arenaMode === 'unranked' ? 'Rating unchanged' : rewards.ratingDelta ? ratingText(rewards.ratingDelta) : '']
      .filter(Boolean);
  }
  if (entry.kind === 'tournament') {
    if (!runLast) return [];
    return [entry.place !== null ? `${ordinal(entry.place)} place` : '', rewards.money > 0 ? `${rewards.money} gold` : '', rewards.renown > 0 ? `+${rewards.renown} renown` : '']
      .filter(Boolean);
  }
  return [rewards.money > 0 ? `+${rewards.money} gold` : '', ...rewards.items.map(itemText)].filter(Boolean);
}

/** The destination's name, or "Expedition" for one this client does not know. */
const expeditionName = (id: string | null) => (id !== null && Object.hasOwn(CATALOG_V1.expeditions, id)
  ? CATALOG_V1.expeditions[id as keyof typeof CATALOG_V1.expeditions].name : 'Expedition');

/**
 * One row of the history. Kept: ▶ Watch and the opponent while the server's time is before its expiry; gone: dimmed, no opponent, "replay
 * no longer kept" and Result. Until the server's time is known (`nowMs` null) the read's own state decides and no button is offered.
 * `rewards` (the viewer's own card only) adds its own rewards; `runLast` says the row is its tournament run's last bout (the prize).
 */
export function historyRow(entry: HistoryEntry, options: { nowMs: number | null; clock: ClockMode; timeZone?: string; rewards?: OwnRewards | null; runLast?: boolean }): HistoryRowText {
  const { nowMs, clock, timeZone } = options;
  const kept = nowMs === null ? entry.replayExpiry.state === 'available' : replayKept(entry.replayExpiry, nowMs);
  const time = timeOfDay(entry.foughtAtMs, clock, timeZone);
  const won = entry.kind === 'expedition' ? entry.success : entry.result === 'victory';
  const extras = rewardParts(entry, options.rewards, options.runLast ?? false);
  const gone = kept ? [] : ['replay no longer kept'];
  const opponent = kept ? entry.opponent : null;
  const action = nowMs === null ? null : kept ? '▶ Watch' as const : 'Result' as const;
  const when = [dayText(entry.foughtAtMs, timeZone), time].filter(Boolean).join(', ');
  const label = (what: string) => `${kept ? 'Watch' : 'Result'}: ${what}${when ? `, ${when}` : ''}`;
  if (entry.kind === 'tournament') {
    const name = entry.league ? `${capital(entry.league)} Tournament` : 'Tournament';
    const round = entry.round ?? 'Tournament bout';
    return { kept, badge: won ? { text: 'W', name: 'Won', won } : { text: 'L', name: 'Lost', won }, name, tag: null, round: round.toUpperCase(), pill: won ? 'WON' : 'LOST',
      sub: [opponent ? `vs ${opponent.name}` : '', time, ...extras, ...gone].filter(Boolean).join(SEP), action,
      label: label(`${name}, ${round}${opponent ? ` vs ${opponent.name}` : ''}`) };
  }
  if (entry.kind === 'expedition') {
    const name = expeditionName(entry.expeditionId);
    return { kept, badge: won ? { text: '✓', name: 'Success', won } : { text: '✗', name: 'Failed', won }, name, tag: null, round: null, pill: null,
      sub: ['Expedition', won ? 'Success' : 'Failed', time, ...extras, ...gone].filter(Boolean).join(SEP), action, label: label(name) };
  }
  const unranked = entry.arenaMode === 'unranked';
  const name = opponent ? `vs ${opponent.name}` : 'Arena bout';
  const tag = !opponent ? null : unranked && opponent.botTeam === 'ludus-nimbus' ? 'BOT' : opponent.npc ? 'NPC' : null;
  // A human opponent's bout names its league (the mockup's "Silver league"); an NPC or bot bout does not.
  const league = opponent && !opponent.npc && !unranked && entry.league ? `${capital(entry.league)} league` : '';
  const sub = kept ? [unranked ? 'Unranked Arena' : 'Arena', time, league, ...extras] : [time, ...extras, ...gone];
  return { kept, badge: won ? { text: 'W', name: 'Won', won } : { text: 'L', name: 'Lost', won }, name, tag, round: null, pill: null,
    sub: sub.filter(Boolean).join(SEP), action, label: label(name) };
}

/**
 * The rows by the day they were fought, in the viewer's time zone (or `timeZone`, for tests), in the list's order (newest first):
 * "TODAY · SAT 10 OCT" for the display clock's day, "FRI 9 OCT" for another; no day is today until the server's time is known.
 */
export function historyDays(entries: readonly HistoryEntry[], nowMs: number | null, timeZone?: string): { label: string; entries: HistoryEntry[] }[] {
  const today = nowMs === null ? null : dayText(nowMs, timeZone);
  const groups = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const day = dayText(entry.foughtAtMs, timeZone);
    const group = groups.get(day);
    if (group) group.push(entry);
    else groups.set(day, [entry]);
  }
  return [...groups].map(([day, list]) => ({ label: `${day !== '' && day === today ? 'TODAY · ' : ''}${day.toUpperCase()}`, entries: list }));
}

/** The newest row of each tournament run (its last bout, which shows the run's prize on the owner's own card). */
export function runLastRows(entries: readonly HistoryEntry[]): Set<string> {
  const seen = new Set<string>(), last = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'tournament' || seen.has(entry.activityId)) continue;
    seen.add(entry.activityId);
    last.add(entry.entryId);
  }
  return last;
}

/**
 * What ▶ Watch opens, as the camp's scenes do (`sceneForResult`): an Arena bout's replay; a tournament bout's run at that round (the run's
 * stage `<activity>:<round>`, the round from the bout id) with its league for the gold band (a run's timeline names none; fix round 1);
 * an expedition's whole trip.
 */
export function historyScene(entry: HistoryEntry): Exclude<SceneView, { kind: 'bout' }> {
  if (entry.kind === 'expedition') return { kind: 'expedition', activityId: entry.activityId, play: 'trip' };
  const round = entry.kind === 'tournament' ? /:(\d{1,3}):\d{1,5}$/.exec(entry.entryId)?.[1] : undefined;
  if (!round) return { kind: 'replay', activityId: entry.activityId };
  return { kind: 'replay', activityId: entry.activityId, stageId: `${entry.activityId}:${round}`, ...(entry.league ? { league: entry.league } : {}) };
}
