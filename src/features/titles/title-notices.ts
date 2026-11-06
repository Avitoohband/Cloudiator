// The titles in Notifications (patch 1.7, spec "Earning, wearing and notices" and "Notices (Notifications tab)"; the approved mockup,
// section 5), from the owner read's `titles`:
// - a title earned by a result is a gold line inside that result's card (`resultTitleRows`), with Wear;
// - the others are grouped by source and time, one notice each group (`titleNotices`): "Titles from your history" for the release
//   back-fill, "New title: {name}" or "New titles" for the rest; Founder at creation (`joined`) has none. The same groups the server
//   counts in `inbox.newNotifications` (distinct source and time among the rows with no activity and a source other than `joined`);
// - the list merges the notices with the results by time (`notificationEntries`), and the summary line counts both.
// An id this client does not know shows nothing (Review Focus 1). Champion is named "Champion" here (ruling D2); a season title's small
// line is its place ("1st in Season 1 · Silver").
import type { EarnedTitle } from '@contracts/reads';
import { TITLES_V1, titleById } from '@domain/titles';
import { placeInSeasonText } from './title-text';

/** One title as a notice or a result shows it: its name, and its small line (the rule, or the place of a season title). */
export type TitleRow = { id: string; name: string; detail: string };
/** A notice of its own: the titles of one source earned at one time, in catalog order. */
export type TitleNotice = { key: string; kind: 'history' | 'earned'; atMs: number; heading: string; rows: TitleRow[] };

/** The release notice's title and its line (spec "At the release"). */
export const HISTORY_HEADING = 'Titles from your history';
export const HISTORY_INTRO = 'Patch 1.7 counted everything you have done since you joined.';

const CATALOG_ORDER: ReadonlyMap<string, number> = new Map(TITLES_V1.map((title, index) => [title.id, index]));
const byCatalog = (p: TitleRow, q: TitleRow) => (CATALOG_ORDER.get(p.id) ?? 0) - (CATALOG_ORDER.get(q.id) ?? 0);

/** A held title as a row, or null for an id this client does not know. */
function rowOf(title: EarnedTitle): TitleRow | null {
  const known = titleById(title.id);
  if (!known) return null;
  return { id: known.id, name: known.name, detail: title.source === 'season' && title.detail ? placeInSeasonText(title.detail) : known.rule };
}

/** Notices from the owner's titles: rows with no activity grouped by source and time, `joined` left out, newest first. */
export function titleNotices(titles: readonly EarnedTitle[]): TitleNotice[] {
  const groups = new Map<string, { source: EarnedTitle['source']; atMs: number; rows: TitleRow[] }>();
  for (const title of titles) {
    if (title.activityId !== null || title.source === 'joined') continue;
    const row = rowOf(title);
    if (!row) continue;
    const key = `${title.source}:${title.earnedAtMs}`;
    const group = groups.get(key) ?? { source: title.source, atMs: title.earnedAtMs, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups].map(([key, { source, atMs, rows }]): TitleNotice => {
    const sorted = [...rows].sort(byCatalog);
    const history = source === 'history';
    return { key, kind: history ? 'history' : 'earned', atMs,
      heading: history ? HISTORY_HEADING : sorted.length === 1 ? `New title: ${sorted[0].name}` : 'New titles', rows: sorted };
  }).sort((p, q) => q.atMs - p.atMs || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
}

/** The rows a result's notification gains: the titles whose activityId is that result's, in catalog order. */
export function resultTitleRows(titles: readonly EarnedTitle[], activityId: string): TitleRow[] {
  return titles.filter(title => title.activityId === activityId).map(rowOf).filter((row): row is TitleRow => row !== null).sort(byCatalog);
}

/** The history notice's chips: the worn title first and marked (when history earned it), then the others in their order. */
export function historyChips(rows: readonly TitleRow[], worn: string | null): { name: string; worn: boolean }[] {
  const first = rows.filter(row => row.id === worn), rest = rows.filter(row => row.id !== worn);
  return [...first.map(row => ({ name: row.name, worn: true })), ...rest.map(row => ({ name: row.name, worn: false }))];
}

/** One entry of the Notifications list: a result's card, or a notice's. */
export type NotificationEntry<R> = { kind: 'result'; result: R } | { kind: 'notice'; notice: TitleNotice };

/**
 * The Notifications list: the results (newest first, as read) and the notices (newest first) merged by time, a notice at a result's time
 * before it. While the read filled a page of results (`page`), a notice older than the oldest listed result is left out: the results older
 * than it are not listed either.
 */
export function notificationEntries<R extends { settledAtMs: number }>(results: readonly R[], notices: readonly TitleNotice[], page: number): NotificationEntry<R>[] {
  const oldest = results.length >= page ? Math.min(...results.map(result => result.settledAtMs)) : -Infinity;
  const entries: NotificationEntry<R>[] = [];
  let next = 0;
  for (const notice of notices) {
    if (notice.atMs < oldest) continue;
    while (next < results.length && results[next].settledAtMs > notice.atMs) entries.push({ kind: 'result', result: results[next++] });
    entries.push({ kind: 'notice', notice });
  }
  while (next < results.length) entries.push({ kind: 'result', result: results[next++] });
  return entries;
}

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The summary line: "Latest 4 results and 1 title notice · 3 new"; with no notice, "Latest 4 results · nothing new" as before. */
export function notificationsSummary(results: number, notices: number, fresh: number): string {
  const listed = notices > 0 ? `${counted(results, 'result')} and ${counted(notices, 'title notice')}` : counted(results, 'result');
  return `Latest ${listed} · ${fresh > 0 ? `${fresh} new` : 'nothing new'}`;
}
