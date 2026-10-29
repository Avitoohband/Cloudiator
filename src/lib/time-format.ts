import type { ClockMode } from './clock-setting';

// The one place a time of day is written (Patch A, item 7). Every screen shows a time through here, in the 12-hour or 24-hour
// form the device's clock setting asks for (`src/lib/clock-setting.ts`), so no screen shows the other form. Durations are not
// times of day and do not come through here. The hour and minute are read from Intl as plain numbers (its own text varies with
// the locale and the engine: "pm", a day period first, other digits) and written here, so the shape is the same everywhere.

/** U+00A0: a space a line never breaks at, so "4:20 AM" never parts across two lines. */
const NO_BREAK_SPACE = '\xA0';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The latest instant a Date holds: past it Intl throws, and there is no time to show. */
const MAX_TIME_MS = 8.64e15;
const pad = (n: number) => String(n).padStart(2, '0');

type Fields = { year: number; month: number; day: number; hour: number; minute: number };

/**
 * The calendar fields of `ms` in `timeZone` (the runtime's when undefined), or null for a value that is not a time (not a finite
 * number, or outside the range of a Date). The locale is fixed (en-GB, Latin digits and the Gregorian calendar) so the numbers
 * can be read; `h23` gives the hour as 0 to 23.
 */
function fieldsOf(ms: number, timeZone?: string): Fields | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || Math.abs(ms) > MAX_TIME_MS) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone })
    .formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(candidate => candidate.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') };
}

/** An hour (0 to 23) and minute as a time of day: `3:00 AM` (a no-break space before the day period, AM and PM in capitals) or `03:00`. */
function clockWords(hour: number, minute: number, clock: ClockMode): string {
  if (clock === '24') return `${pad(hour)}:${pad(minute)}`;
  return `${hour % 12 || 12}:${pad(minute)}${NO_BREAK_SPACE}${hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * The time of day of `ms` in `timeZone` (the runtime's zone when undefined): `3:00 AM` and `12:05 PM` in 12-hour form, `03:00`
 * in 24-hour form. A value that is not a time (missing from a read, a broken clock) gives `''`, never a throw during render or a
 * made-up time; each caller then leaves its time out.
 */
export function timeOfDay(ms: number, clock: ClockMode, timeZone?: string): string {
  const fields = fieldsOf(ms, timeZone);
  return fields ? clockWords(fields.hour, fields.minute, clock) : '';
}

/**
 * The day of `ms` in `timeZone` (the runtime's when undefined) as fixed English names, `Sat 10 Oct`: Intl abbreviates its names
 * differently from one ICU version to the next (en-GB writes "Sept"), so only its numbers are used. `''` for a value that is not a time.
 */
export function dayText(ms: number, timeZone?: string): string {
  const fields = fieldsOf(ms, timeZone);
  if (!fields) return '';
  const weekday = new Date(Date.UTC(fields.year, fields.month - 1, fields.day)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${fields.day} ${MONTHS[fields.month - 1]}`;
}

/** A fixed hour of the UTC day with its zone, as the tournament's start is stated: `6:40 PM UTC` or `18:40 UTC`. */
export function utcClockText(hourUtc: number, minuteUtc: number, clock: ClockMode): string {
  return `${clockWords(hourUtc, minuteUtc, clock)} UTC`;
}
