// The words of My bouts in 📜 Results (Arena replays spec 1, the approved mockup's rows): a row's badge, name, tag, sub-lines and
// button, the day groups, the tab's count and the empty states. Pure: no clock, React or storage. Every time of day goes through the
// shared formatter (`src/lib/time-format.ts`) in the form the device's clock setting asks for. Whether a replay is kept is decided by
// the server's time (the shared display clock), never the device's: a row turns into a dimmed "replay no longer kept" row the moment
// the clock passes its expiry, and from then on never names its opponent, as the read never does for an expired replay.
// The replay viewer's words (Arena replays spec 2, Task 5) are here too: its eyebrow, chapter names, end card and buttons.
import type { LeagueId } from '@contracts/commands';
import type { ActivitySummary, BattleLog, RevealedStage } from '@contracts/events';
import type { ClockMode } from '../../lib/clock-setting';
import type { BoutFilter, MyBout } from '../../lib/api/reads';
import { replayKept } from '../../lib/replay-retention';
import { calendarDays, dayText, timeOfDay } from '../../lib/time-format';
import { tournamentRound } from '../../lib/tournament-id';
import type { QueueEntries } from './bout-queue';

export type BoutRowText = {
  kept: boolean;
  badge: { letter: 'W' | 'L'; name: 'Won' | 'Lost' } | null;
  name: string;
  tag: 'NPC' | 'TOURNAMENT' | null;
  sub: { wide: string; narrow: string };
  action: '▶ Watch' | 'Result' | null;
  label: string;
};

const SEP = ' · ';
/** The kind word a sub-line starts with when no round names it; a phone leaves it out (the mockup's phone rows). */
const KIND_WORD: Record<MyBout['kind'], string> = { arena: 'Arena', tournament: 'Tournament' };
/** A row whose opponent is not named: the bout's kind. */
const GENERIC_NAME: Record<MyBout['kind'], string> = { arena: 'Arena bout', tournament: 'Tournament bout' };

/** A rating change as the notifications write it: "Rating +14", "Rating −13" (U+2212). */
export function ratingText(delta: number): string {
  return `Rating ${delta < 0 ? '−' : '+'}${Math.abs(delta)}`;
}

/**
 * Whether a bout's replay is kept: by the server's time once the display clock has it; until then by what its summary says, so a
 * row shows in its kept form (with no button) rather than calling a kept replay gone.
 */
function keptAt(bout: MyBout, nowMs: number | null): boolean {
  return nowMs === null ? bout.replayExpiry.state === 'available' : replayKept(bout.replayExpiry, nowMs);
}

/**
 * One row of My bouts. Kept: "vs Varro" (an NPC tag, or TOURNAMENT), the sub-line "Arena · 3:00 AM · +10 renown · Rating +14" (zero
 * parts left out; a tie-break after the time; a tournament's round instead of the kind) and ▶ Watch. Gone: "Arena bout", dimmed, "3:00 AM
 * · replay no longer kept" and Result. The narrow sub-line (a phone) leaves out a leading "Arena" or "Tournament". Until the server's
 * time is known (`nowMs` null) a row offers no button. The button's name is unique in the list: "Watch: vs Varro, Sat 10 Oct, 3:00 AM".
 */
export function boutRow(bout: MyBout, nowMs: number | null, clock: ClockMode, timeZone?: string): BoutRowText {
  const kept = keptAt(bout, nowMs);
  const time = timeOfDay(bout.foughtAtMs, clock, timeZone);
  const badge = bout.result === 'victory' ? { letter: 'W', name: 'Won' } as const : bout.result === 'defeat' ? { letter: 'L', name: 'Lost' } as const : null;
  const opponent = kept ? bout.opponent : null;
  const name = opponent ? `vs ${opponent.name}` : GENERIC_NAME[bout.kind];
  const tag = !opponent ? null : bout.kind === 'tournament' ? 'TOURNAMENT' : opponent.npc ? 'NPC' : null;
  let sub: BoutRowText['sub'];
  if (kept) {
    const lead = bout.kind === 'tournament' && bout.round ? bout.round : KIND_WORD[bout.kind];
    const details = [
      time,
      bout.tieBreak ? (bout.result === 'defeat' ? 'lost on a tie-break' : 'won on a tie-break') : '',
      bout.renown > 0 ? `+${bout.renown} renown` : '',
      bout.ratingDelta ? ratingText(bout.ratingDelta) : '',
    ].filter(Boolean);
    const narrow = lead === KIND_WORD[bout.kind] ? details : [lead, ...details];
    sub = { wide: [lead, ...details].join(SEP), narrow: narrow.join(SEP) };
  } else {
    const gone = [time, 'replay no longer kept'].filter(Boolean).join(SEP);
    sub = { wide: gone, narrow: gone };
  }
  const action = nowMs === null ? null : kept ? '▶ Watch' : 'Result';
  const when = [dayText(bout.foughtAtMs, timeZone), time].filter(Boolean).join(', ');
  return { kept, badge, name, tag, sub, action, label: `${kept ? 'Watch' : 'Result'}: ${name}${when ? `, ${when}` : ''}` };
}

/** The Arena menu's relative day, time and one detail, with My bouts' retention and identity rules. */
export function recentRow(bout: MyBout, nowMs: number | null, clock: ClockMode, timeZone?: string): BoutRowText {
  const row = boutRow(bout, nowMs, clock, timeZone);
  const day = dayText(bout.foughtAtMs, timeZone);
  const days = nowMs === null ? null : calendarDays(bout.foughtAtMs, nowMs, timeZone);
  const relative = days === 0 ? 'Today' : days !== null && days > 0 && days <= 6 ? day.split(' ')[0] : day;
  const when = [relative, timeOfDay(bout.foughtAtMs, clock, timeZone)].filter(Boolean).join(', ');
  const detail = !row.kept ? 'replay no longer kept' : bout.ratingDelta ? ratingText(bout.ratingDelta)
    : bout.tieBreak ? (bout.result === 'defeat' ? 'lost on a tie-break' : 'won on a tie-break') : bout.renown > 0 ? `+${bout.renown} renown` : '';
  return { ...row, sub: { wide: [when, detail].filter(Boolean).join(SEP), narrow: [when, row.kept && bout.tieBreak && !bout.ratingDelta ? 'tie-break' : detail].filter(Boolean).join(SEP) } };
}

/**
 * The bouts by the day they were fought, in the viewer's time zone (or `timeZone`, for tests), in the list's order (newest first):
 * "TODAY · SAT 10 OCT" for the display clock's day, "FRI 9 OCT" for another. A `nowMs` that is not a time (the server's time not known
 * yet) calls no day today.
 */
export function dayGroups(bouts: readonly MyBout[], nowMs: number, timeZone?: string): { label: string; bouts: MyBout[] }[] {
  const today = dayText(nowMs, timeZone);
  const groups = new Map<string, MyBout[]>();
  for (const bout of bouts) {
    const day = dayText(bout.foughtAtMs, timeZone);
    const group = groups.get(day);
    if (group) group.push(bout);
    else groups.set(day, [bout]);
  }
  return [...groups].map(([day, list]) => ({ label: `${day !== '' && day === today ? 'TODAY · ' : ''}${day.toUpperCase()}`, bouts: list }));
}

/** The tab's count: the kept replays among `bouts` with no watched mark on this device. */
export function unwatchedCount(bouts: readonly MyBout[], watched: ReadonlySet<string>, nowMs: number | null): number {
  return bouts.filter(bout => keptAt(bout, nowMs) && !watched.has(bout.activityId)).length;
}

const EMPTY: Record<BoutFilter, string> = {
  all: 'No bouts yet. Your Arena and tournament bouts show here with their replays.',
  won: 'No won bouts yet.',
  lost: 'No lost bouts yet.',
};
/** What an empty list says, for its chip. */
export const emptyText = (filter: BoutFilter): string => EMPTY[filter];

// ------------------------------------------------------------------ the replay viewer (Task 5)

/** The Result card's line before the fight ends, on every width. */
export const RESULT_HINT = 'The result appears when the fight ends, or now with ⚑ Result.';

/**
 * The viewer's eyebrow: the kind and when the bout was fought, never the server's stage label, which names the outcome ("Bout:
 * victory"; plan Review Focus 4). An Arena bout: "ARENA · SAT 10 OCT, 3:00 AM" (phone "ARENA · SAT 3:00 AM"), against an NPC "· NPC
 * OPPONENT" (phone "· NPC"), at the stage's start (minute 60, its reveal). A tournament's bout, known by its round in the label or a
 * bracket's league: "TOURNAMENT · BRONZE · FINAL", or "TOURNAMENT · FINAL" for a run whose timeline carries no league. An
 * expedition's encounter keeps today's "Expedition · Encounter 1: Dire Wolf" (it holds no result).
 */
export function boutEyebrow(stage: RevealedStage, options: { npc: boolean; league: LeagueId | null; compact: boolean }, clock: ClockMode, timeZone?: string): string {
  if (stage.kind === 'encounter') return `Expedition${SEP}${stage.label}`;
  // The bracket supplies a safe round label rather than the run's outcome-bearing stage label.
  const bracketRound = /^Tournament · (Final|Semifinals?|Quarterfinals?|Round [1-9]\d{0,2})$/.exec(stage.label)?.[1];
  const round = tournamentRound(stage.label) ?? bracketRound?.replace(/finals$/, 'final') ?? null;
  if (round !== null || options.league !== null) return ['TOURNAMENT', options.league ?? '', round ?? ''].filter(Boolean).join(SEP).toUpperCase();
  const day = dayText(stage.startedAtMs, timeZone);
  const time = timeOfDay(stage.startedAtMs, clock, timeZone);
  const when = options.compact ? [day.split(' ')[0], time].filter(Boolean).join(' ') : [day, time].filter(Boolean).join(', ');
  return ['ARENA', when, options.npc ? (options.compact ? 'NPC' : 'NPC OPPONENT') : ''].filter(Boolean).join(SEP).toUpperCase();
}

/** A chapter's name on the bar: a tournament run's round ("Quarterfinal"), an expedition encounter's label, else "Bout". */
export function chapterLabel(stage: RevealedStage): string {
  return tournamentRound(stage.label) ?? (stage.kind === 'encounter' ? stage.label : 'Bout');
}

/**
 * The end card's verdict and reason, from the revealed log: "Aster wins", "Varro is defeated."; a simultaneous tie-break "Both fell at
 * the same moment; a seeded tie-break chose Aster."; the time-out endings "Time ran out and Aster kept more health." and "Time ran out
 * with equal health; a seeded tie-break chose Aster." A phone says either tie-break as "A tie-break chose Aster."
 */
export function verdictText(log: BattleLog, compact: boolean): { verdict: string; reason: string } {
  const winner = log.participants.find(p => p.id === log.winnerId) ?? log.participants[0];
  const loser = log.participants.find(p => p.id !== winner.id) ?? log.participants[1];
  const reason = log.victoryReason === 'defeat' ? `${loser.name} is defeated.`
    : log.victoryReason === 'health-fraction' ? `Time ran out and ${winner.name} kept more health.`
      : compact ? `A tie-break chose ${winner.name}.`
        : log.tieBreakReason === 'simultaneous-defeat' ? `Both fell at the same moment; a seeded tie-break chose ${winner.name}.`
          : `Time ran out with equal health; a seeded tie-break chose ${winner.name}.`;
  return { verdict: `${winner.name} wins`, reason };
}

/**
 * The end card's chips: the fighter's credited rewards ("+10 renown", "+100 gold", "Rating +14" or "NPC: no rating change"; zero parts
 * left out), or before settlement "Rewards are credited when the bout settles" ("…when the tournament settles" for a run). A spectator
 * sees none; a tournament run shows them on its last chapter only. An expedition's rewards are the whole trip's, which the Result card
 * below lists, so its end card shows none.
 */
export function rewardChips(summary: ActivitySummary | null,
  options: { fighter: boolean; npc: boolean; kind: 'arena' | 'tournament' | 'expedition'; last: boolean }): string[] {
  if (!options.fighter || !options.last || options.kind === 'expedition') return [];
  if (!summary) return [`Rewards are credited when the ${options.kind === 'tournament' ? 'tournament' : 'bout'} settles`];
  const { renown, money } = summary.rewards;
  return [
    renown > 0 ? `+${renown} renown` : '',
    money > 0 ? `+${money} gold` : '',
    options.npc ? 'NPC: no rating change' : summary.ratingDelta ? ratingText(summary.ratingDelta) : '',
  ].filter(Boolean);
}

/** The end card's step to the next bout: "▶ Next bout · vs Cassia" (phone "▶ Next · vs Cassia"), "▶ Next bout" with no known opponent. */
export function nextLabel(opponent: string | null, compact: boolean): string {
  return `${compact ? '▶ Next' : '▶ Next bout'}${opponent ? `${SEP}vs ${opponent}` : ''}`;
}

/** The end card's replay button: "↺ Watch again" (phone "↺ Again"). */
export function againLabel(compact: boolean): string {
  return compact ? '↺ Again' : '↺ Watch again';
}

/** The position among loaded kept replays, with + while another page exists. */
export function counterText(queue: QueueEntries): { wide: string; narrow: string } {
  const total = `${queue.entries.length}${queue.more ? '+' : ''}`;
  return { wide: `Bout ${queue.index + 1} of ${total} in My bouts`, narrow: `${queue.index + 1} / ${total}` };
}

/** Up next comes from the next chapter's revealed log or the next kept row, through the shared clock formatter. */
export function upNextText(next: { a: string; b: string | null; kind: 'arena' | 'tournament'; foughtAtMs: number }
  | { a: string; b: string; chapter: string }, clock: ClockMode, timeZone?: string): { wide: string; narrow: string } {
  const names = next.b ? `${next.a} vs ${next.b}` : next.a;
  if ('chapter' in next) return { wide: `${names}${SEP}${next.chapter}`, narrow: `${names}${SEP}${next.chapter}` };
  const day = dayText(next.foughtAtMs, timeZone);
  const time = timeOfDay(next.foughtAtMs, clock, timeZone);
  return { wide: `${names}${SEP}${KIND_WORD[next.kind]}${SEP}${day}, ${time}`, narrow: `${names}${SEP}${day.split(' ')[0]} ${time}` };
}
