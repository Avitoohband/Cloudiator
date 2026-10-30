// The words of My bouts in 📜 Results (Arena replays spec 1, the approved mockup's rows): a row's badge, name, tag, sub-lines and
// button, the day groups, the tab's count and the empty states. Pure: no clock, React or storage. Every time of day goes through the
// shared formatter (`src/lib/time-format.ts`) in the form the device's clock setting asks for. Whether a replay is kept is decided by
// the server's time (the shared display clock), never the device's: a row turns into a dimmed "replay no longer kept" row the moment
// the clock passes its expiry, and from then on never names its opponent, as the read never does for an expired replay.
import type { ClockMode } from '../../lib/clock-setting';
import type { BoutFilter, MyBout } from '../../lib/api/reads';
import { replayKept } from '../../lib/replay-retention';
import { dayText, timeOfDay } from '../../lib/time-format';

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
