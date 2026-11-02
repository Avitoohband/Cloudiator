// Patch numbers (Patch A spec, "Patch numbers and the changelog"). The server keeps the list of patches (public.patches, M26) and
// names the newest on every revision read (`latest_patch`); this build knows the patch it is. A tab whose build is behind the
// server's newest patch says so, and a reload brings the new one in.

/**
 * The patch this build is. The first commit of a patch's work sets it and opens the patch's section in docs/CHANGELOG.md; a fix
 * release from `release` sets the next third number the same way. A unit test fails unless it names CHANGELOG.md's top section.
 */
export const PATCH = '1.6';

/** The server's pattern for a patch number (public.patches.number): "1.0" and "1.2.1", never "1.3.0" or "01.2". */
const PATTERN = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})(?:\.([1-9][0-9]{0,2}))?$/;

/**
 * The server's order of patch numbers: the generated `sort_key` of public.patches (major × 1,000,000 + minor × 1,000 + third).
 * Null for anything the server would refuse.
 */
export function patchSortKey(number: string): number | null {
  const match = PATTERN.exec(number);
  if (!match) return null;
  return Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3] ?? 0);
}

/** Whether the server's newest patch is later than this build's. A missing or malformed number is never ahead. */
export function isBehind(latest: string | null, build: string = PATCH): boolean {
  const ahead = latest === null ? null : patchSortKey(latest), mine = patchSortKey(build);
  return ahead !== null && mine !== null && ahead > mine;
}

/** One patch of the server's list, as Patch history shows it: its features in position order. */
export type PatchEntry = { number: string; sortKey: number; title: string; releasedAtMs: number; messageId: number | null; features: string[] };

/**
 * The patch the reload notice announces, or null. It waits while a scene or a modal dialog is open (`blocked`), and × ("Later")
 * hides it for this page's life for that number (`later`): only a newer number shows it again.
 */
export function noticeFor(input: { latest: string | null; build: string; blocked: boolean; later: string | null }): string | null {
  const { latest, build, blocked, later } = input;
  if (blocked || latest === null || !isBehind(latest, build)) return null;
  const dismissed = later === null ? null : patchSortKey(later);
  if (dismissed !== null && patchSortKey(latest)! <= dismissed) return null;
  return latest;
}

/** The notice's words: the bold lead and the rest. A phone shows the short form. */
export function noticeText(latest: string, compact: boolean): [lead: string, rest: string] {
  return compact ? [`Patch ${latest} is out`, ''] : ['A new patch is out', ` — reload to play Patch ${latest}.`];
}

/** Patch history's first line: the patch this tab plays, and the newer one when the server has it. */
export function playingLine(build: string, latest: string | null): string {
  return `You are playing Patch ${build}` + (latest !== null && isBehind(latest, build) ? ` · Patch ${latest} is out` : '');
}
