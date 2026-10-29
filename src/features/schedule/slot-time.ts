import type { ClockMode } from '../../lib/clock-setting';
import { timeOfDay } from '../../lib/time-format';

const DAY_MS = 86_400_000;

/** The viewer's local calendar day of `ms`, as that date's midnight in UTC: whole days apart are exact through daylight-saving changes. */
const localDay = (ms: number) => { const date = new Date(ms); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()); };

/** The day's own words for `ms`, short, in the viewer's locale and local time zone (`Intl.DateTimeFormat` with no locale named). */
const dayWords = (ms: number, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, options).format(ms);

/**
 * A slot boundary's time, short, in the viewer's local time zone, the time of day written by the shared formatter in the form
 * `clock` asks for (the device's clock setting, Patch A item 7: `4:20 AM` or `04:20`) and the day's words in the viewer's locale
 * (no locale named). No seconds, since boundaries fall on whole minutes. `nowMs` is the display time the screen already uses;
 * what it shows depends on the local calendar day of the boundary against that of `nowMs`, never on 24-hour differences:
 * - the same local day: the time only (`4:20 AM`);
 * - the next local day: `tomorrow 4:20 AM`;
 * - the 2nd to the 6th local day ahead: the short weekday and time (`Sat 4:20 AM`);
 * - anything else, from the 7th day ahead or on an earlier day: the short month, day and time (`Oct 26, 4:20 AM`).
 * The time part itself never breaks across lines (`timeOfDay` joins its pieces with a no-break space); a line may break before it.
 * The Schedule panel's estimated starts and effective times, the Build panel's effective time and the owner's resting line
 * (Task 23.9) all show their times this way (Task 23.10), and so do My gladiator's activity end (`· ends …`), the Arena
 * card's reveal time (Task 24.0b) and each stage start in the expedition's activity log (Task 24.0c).
 *
 * A time or display time that is not a finite number (missing from a read, or a broken clock) gives `''`, never a throw
 * during render or a made-up date; each caller then leaves its time out (Task 23 final review, Minor 4).
 */
export function slotTimeText(ms: number, nowMs: number, clock: ClockMode): string {
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return '';
  const time = timeOfDay(ms, clock);
  if (!time) return '';
  const days = (localDay(ms) - localDay(nowMs)) / DAY_MS;
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days >= 2 && days <= 6) return `${dayWords(ms, { weekday: 'short' })} ${time}`;
  return `${dayWords(ms, { month: 'short', day: 'numeric' })}, ${time}`;
}
