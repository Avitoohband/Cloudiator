const DAY_MS = 86_400_000;
/** U+00A0: a space a line never breaks at. */
const NO_BREAK_SPACE = '\xA0';
/** Any whitespace: `formatToParts` gives the space before a day period as U+202F in some engines, `format` as an ordinary space. */
const WHITESPACE = /\s/g;
const TIME_PARTS = new Set<Intl.DateTimeFormatPartTypes>(['hour', 'minute', 'second', 'fractionalSecond', 'dayPeriod']);

/** The viewer's local calendar day of `ms`, as that date's midnight in UTC: whole days apart are exact through daylight-saving changes. */
const localDay = (ms: number) => { const date = new Date(ms); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()); };

/**
 * `ms` formatted with `options`, its time part kept on one line: the spaces between the pieces of the time (hours, minutes
 * and the day period, in whatever order the locale puts them: `4:20 AM`) are all U+00A0, so a line never ends between them,
 * whichever space the engine gave. What comes before or after the time (`Sat `, `Oct 26, `) keeps its ordinary spaces, where
 * a line may still break.
 */
function format(ms: number, options: Intl.DateTimeFormatOptions): string {
  const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', ...options }).formatToParts(ms);
  const isTime = parts.map(part => TIME_PARTS.has(part.type));
  const first = isTime.indexOf(true), last = isTime.lastIndexOf(true);
  return parts.map((part, index) => (part.type === 'literal' && index > first && index < last ? part.value.replace(WHITESPACE, NO_BREAK_SPACE) : part.value)).join('');
}

/**
 * A slot boundary's time, short, in the viewer's locale and local time zone (`Intl.DateTimeFormat` with no locale named; no
 * seconds, since boundaries fall on whole minutes). `nowMs` is the display time the screen already uses; what it shows depends
 * on the local calendar day of the boundary against that of `nowMs`, never on 24-hour differences:
 * - the same local day: the time only (`4:20 AM`);
 * - the next local day: `tomorrow 4:20 AM`;
 * - the 2nd to the 6th local day ahead: the short weekday and time (`Sat 4:20 AM`);
 * - anything else, from the 7th day ahead or on an earlier day: the short month, day and time (`Oct 26, 4:20 AM`).
 * The time part itself never breaks across lines (its pieces are joined by no-break spaces); a line may break before it.
 * The Schedule panel's estimated starts and effective times, the Build panel's effective time and the owner's resting line
 * (Task 23.9) all show their times this way (Task 23.10), and so do My gladiator's activity end (`· ends …`) and the Arena
 * card's reveal time (Task 24.0b).
 *
 * A time or display time that is not a finite number (missing from a read, or a broken clock) gives `''`, never a throw
 * during render or a made-up date; each caller then leaves its time out (Task 23 final review, Minor 4).
 */
export function slotTimeText(ms: number, nowMs: number): string {
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return '';
  const days = (localDay(ms) - localDay(nowMs)) / DAY_MS;
  if (days === 0) return format(ms, {});
  if (days === 1) return `tomorrow ${format(ms, {})}`;
  if (days >= 2 && days <= 6) return format(ms, { weekday: 'short' });
  return format(ms, { month: 'short', day: 'numeric' });
}
