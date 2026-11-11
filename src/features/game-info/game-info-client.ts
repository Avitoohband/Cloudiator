import { getBrowserClient } from '../../lib/api/client';

export type GameInfoTab = 'wiki' | 'future';
export type GameInfoEntry = { id: string; title: string; body: string; patch?: string };
export type GameInfoDocument = { entries: GameInfoEntry[]; videos?: [string | null, string | null] };
export type GameInfoSnapshot = { version: number; document: GameInfoDocument };
export type GameInfoPages = Partial<Record<GameInfoTab, GameInfoSnapshot>>;
type Code = 'forbidden' | 'invalid' | 'conflict' | 'unavailable';
type EditResult = { ok: true } & GameInfoSnapshot | { ok: false; code: Code };
type Command = { tab: GameInfoTab; action: 'read' } | { tab: GameInfoTab; action: 'publish'; expectedVersion: number } |
  { tab: GameInfoTab; action: 'save'; expectedVersion: number; document: GameInfoDocument };

export function youtubeLink(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\/(?:(?:www\.)?youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
}

function snapshot(data: unknown, tab: GameInfoTab): GameInfoSnapshot | null {
  if (!data || typeof data !== 'object' || !('version' in data) || typeof data.version !== 'number' ||
      !Number.isSafeInteger(data.version) || data.version < 0 || !('document' in data)) return null;
  const doc = data.document as Partial<GameInfoDocument> | null;
  if (!doc || !Array.isArray(doc.entries)) return null;
  const entries = doc.entries.filter(entry => entry && typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.body === 'string')
    .map(({ id, title, body, patch }) => ({ id, title, body, ...(tab === 'future' && typeof patch === 'string' ? { patch } : {}) }));
  if (entries.length !== doc.entries.length) return null;
  const document: GameInfoDocument = { entries };
  if (tab === 'wiki') document.videos = [youtubeLink(doc.videos?.[0]), youtubeLink(doc.videos?.[1])];
  return { version: data.version, document };
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
    const page = snapshot(row, tab);
    if (page) pages[tab] = page;
  }
  return pages;
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
    const page = data?.ok === true ? snapshot(data, command.tab) : null;
    return page ? { ok: true, ...page } : unavailable;
  } catch { return unavailable; }
}
