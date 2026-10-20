const DAY_MS = 86_400_000;

/** The viewer's local calendar day of `ms`, as that date's midnight in UTC: whole days apart are exact through daylight-saving changes. */
const localDay = (ms: number) => { const date = new Date(ms); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()); };

/**
 * A slot boundary's time, short, in the viewer's locale and local time zone (`Intl.DateTimeFormat` with no locale named; no
 * seconds, since boundaries fall on whole minutes). `nowMs` is the display time the screen already uses; what it shows depends
 * on the local calendar day of the boundary against that of `nowMs`, never on 24-hour differences:
 * - the same local day: the time only (`4:20 AM`);
 * - the next local day: `tomorrow 4:20 AM`;
 * - the 2nd to the 6th local day ahead: the short weekday and time (`Sat 4:20 AM`);
 * - anything else, from the 7th day ahead or on an earlier day: the short month, day and time (`Oct 26, 4:20 AM`).
 * The Schedule panel's estimated starts and effective times, the Build panel's effective time and the owner's resting line
 * (Task 23.9) all show their times this way (Task 23.10).
 */
export function slotTimeText(ms: number, nowMs: number): string {
  const days = (localDay(ms) - localDay(nowMs)) / DAY_MS;
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', ...options }).format(ms);
  if (days === 0) return format({});
  if (days === 1) return `tomorrow ${format({})}`;
  if (days >= 2 && days <= 6) return format({ weekday: 'short' });
  return format({ month: 'short', day: 'numeric' });
}
