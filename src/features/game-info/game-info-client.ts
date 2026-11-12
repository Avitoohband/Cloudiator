import { getBrowserClient } from '../../lib/api/client';

export type GameInfoTab = 'wiki' | 'future';
export type GameInfoEntry = { id: string; title: string; body: string; patch?: string; video?: string; videoLength?: string };
export type GameInfoDocument = { entries: GameInfoEntry[] };
export type GameInfoSnapshot = { version: number; document: GameInfoDocument };
export type GameInfoPages = Partial<Record<GameInfoTab, GameInfoSnapshot>>;
type Code = 'forbidden' | 'invalid' | 'conflict' | 'unavailable';
type EditResult = { ok: true } & GameInfoSnapshot | { ok: false; code: Code };
type Command = { tab: GameInfoTab; action: 'read' } | { tab: GameInfoTab; action: 'publish'; expectedVersion: number } |
  { tab: GameInfoTab; action: 'save'; expectedVersion: number; document: GameInfoDocument };

const YOUTUBE_LINK = /^https:\/\/(?:(?:www\.)?youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})$/;
const GUIDE_LENGTH = /^(?:[0-9]|[1-5][0-9]):[0-5][0-9]$/;

/** A bare YouTube watch or youtu.be link (the same shape the database accepts), or null. */
export function youtubeLink(value: unknown): string | null {
  return typeof value === 'string' && YOUTUBE_LINK.test(value) ? value : null;
}

/** The video id inside a bare YouTube link, or null. */
export function youtubeId(link: string): string | null {
  return YOUTUBE_LINK.exec(link)?.[1] ?? null;
}

/** A guide length as minutes:seconds, like 1:12 (the same shape the database accepts). */
export function guideLength(value: unknown): string | null {
  return typeof value === 'string' && GUIDE_LENGTH.test(value) ? value : null;
}

/** The picture YouTube serves for a video link, or null when the link is not a bare YouTube link. */
export function guideThumbnail(link: string): string | null {
  const id = youtubeId(link);
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
}

export function parseGameInfo(data: unknown, tab: GameInfoTab): GameInfoSnapshot | null {
  if (!data || typeof data !== 'object' || !('version' in data) || typeof data.version !== 'number' ||
      !Number.isSafeInteger(data.version) || data.version < 0 || !('document' in data)) return null;
  const doc = data.document as Partial<GameInfoDocument> | null;
  if (!doc || !Array.isArray(doc.entries)) return null;
  const entries = doc.entries.filter(entry => entry && typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.body === 'string')
    .map(({ id, title, body, patch, video, videoLength }) => {
      const guide = tab === 'wiki' ? youtubeLink(video) : null;
      const length = guide ? guideLength(videoLength) : null;
      return { id, title, body, ...(tab === 'future' && typeof patch === 'string' ? { patch } : {}),
        ...(guide ? { video: guide } : {}), ...(length ? { videoLength: length } : {}) };
    });
  if (entries.length !== doc.entries.length) return null;
  return { version: data.version, document: { entries } };
}

export async function loadPublishedGameInfo(): Promise<GameInfoPages> {
  const client = getBrowserClient();
  if (!client) return {};
  const { data, error } = await client.from('game_info_reads').select('tab, version, document');
  if (error || !data) return {};
  const pages: GameInfoPages = {};
  for (const row of data) {
    if (row.tab !== 'wiki' && row.tab !== 'future') continue;
    const tab: GameInfoTab = row.tab;
    const page = parseGameInfo(row, tab);
    if (page) pages[tab] = page;
  }
  return pages;
}

/**
 * Fixture preview only (`?mode=fixture&info=draft`): the Wiki and Future Updates drafts in `docs/game-info`, shown as if
 * published, so a full roadmap can be looked at locally. The imports sit inside the positive build-flag branch (as
 * CampShell guards the fixture gateway), so a production build, where the flag is off, drops the drafts' chunks; the
 * release scan refuses a draft-only title (`FIXTURE_MARKERS` in scripts/release-scan.mjs). Otherwise it returns nothing.
 */
export async function loadDraftGameInfo(): Promise<GameInfoPages> {
  if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true') {
    const [wiki, future] = await Promise.all([
      import('../../../docs/game-info/wiki.draft.json'), import('../../../docs/game-info/future-updates.draft.json')]);
    const pages: GameInfoPages = {};
    const wikiPage = parseGameInfo({ version: 0, document: wiki.default }, 'wiki');
    const futurePage = parseGameInfo({ version: 0, document: future.default }, 'future');
    if (wikiPage) pages.wiki = wikiPage;
    if (futurePage) pages.future = futurePage;
    return pages;
  }
  return {};
}

export async function editGameInfo(command: Command): Promise<EditResult> {
  const unavailable = { ok: false, code: 'unavailable' } as const;
  try {
    const client = getBrowserClient();
    if (!client) return unavailable;
    const { data, error } = await client.functions.invoke('game-info', { body: command });
    if (error) {
      const response = 'context' in error ? error.context : null;
      if (!(response instanceof Response)) return unavailable;
      if (response.status === 403) return { ok: false, code: 'forbidden' };
      if (response.status === 409) return { ok: false, code: 'conflict' };
      if (response.status === 400) return { ok: false, code: 'invalid' };
      return unavailable;
    }
    const page = data?.ok === true ? parseGameInfo(data, command.tab) : null;
    return page ? { ok: true, ...page } : unavailable;
  } catch { return unavailable; }
}
