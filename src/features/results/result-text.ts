// Words for the Results menu, from a result's public fields only (what happened, how it ended, when, and whether its
// replay is kept). Never a reward, receipt or rating change: those are the owner's, and no result row carries them.
// Training and Rest have no replay at all (Tasks 7, 9: their summary always says `expired`), so they never offer one
// and never say it is "no longer kept". Whether a replay is kept is decided by server time (Task 22.5, `replayKept`).
import type { PublicActivitySummary } from '@contracts/events';
import type { ResultRow } from '@contracts/reads';
import type { ClockMode } from '../../lib/clock-setting';
import { replayKept } from '../../lib/replay-retention';
import { dayText, timeOfDay } from '../../lib/time-format';

/** The Recent results panel's one line on retention (Task 22.5). */
export const RETENTION_TEXT = 'Detailed replays are kept for 7 days. Results and credited rewards stay here for 90 days.';

type Kind = PublicActivitySummary['resolvedKind'];
type Outcome = PublicActivitySummary['result'];

const WHAT: Record<Kind, Record<Outcome, string>> = {
  arena: { victory: 'won an Arena bout', defeat: 'lost an Arena bout', completed: 'fought an Arena bout' },
  expedition: { victory: 'returned victorious from an expedition', defeat: 'was defeated on an expedition', completed: 'returned from an expedition' },
  dungeon: { victory: 'Dungeon', defeat: 'Dungeon', completed: 'Dungeon' },
  tournament: { victory: 'won a tournament', defeat: 'was knocked out of a tournament', completed: 'fought in a tournament' },
  training: { victory: 'finished training', defeat: 'finished training', completed: 'finished training' },
  rest: { victory: 'finished resting', defeat: 'finished resting', completed: 'finished resting' },
};
const KIND: Record<Kind, string> = { arena: 'Arena', expedition: 'Expedition', dungeon: 'Dungeon',
  tournament: 'Tournament', training: 'Training', rest: 'Rest' };

/** Whether a kind of activity ever has a replay. */
const replayable = (kind: Kind) => kind !== 'training' && kind !== 'rest';

/**
 * One result as a line of text, and whether its replay can be watched at the server time `serverNowMs`: a summary that
 * still says `available` past its expiry (cleanup has not flipped it yet) is no longer kept either. While the server's
 * time is not known (null) no replay is offered and none is said to be gone.
 */
export function resultLine(row: ResultRow, serverNowMs: number | null): { text: string; replay: boolean } {
  const { resolvedKind, result, replayExpiry } = row.summary;
  const text = `${row.name} ${WHAT[resolvedKind][result]}`;
  if (!replayable(resolvedKind) || serverNowMs === null) return { text, replay: false };
  return replayKept(replayExpiry, serverNowMs) ? { text, replay: true } : { text: `${text} · replay no longer kept`, replay: false };
}

/** The kind of activity, as the row's second line names it. */
export const resultKind = (row: ResultRow) => KIND[row.summary.resolvedKind];

/**
 * When a result settled, in the viewer's time zone (or `timeZone`, for tests) and the form `clock` asks for (the device's clock
 * setting): "Sat 10 Oct, 2:40 PM" or "Sat 10 Oct, 14:40". `''` for a time that cannot be shown.
 */
export function resultTime(ms: number, clock: ClockMode, timeZone?: string): string {
  const day = dayText(ms, timeZone), time = timeOfDay(ms, clock, timeZone);
  return day && time ? `${day}, ${time}` : '';
}
