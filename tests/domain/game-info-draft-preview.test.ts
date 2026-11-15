import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guideThumbnail, loadDraftGameInfo, parseGameInfo, youtubeId } from '../../src/features/game-info/game-info-client';

type Draft = { entries: { id: string; title: string; body: string; patch?: string; video?: string; videoLength?: string }[] };
const draft = (name: string) => JSON.parse(readFileSync(`docs/game-info/${name}.draft.json`, 'utf8')) as Draft;

describe('the fixture preview of the Game Info drafts (?mode=fixture&info=draft)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns every Wiki topic and every Future Updates entry from docs/game-info, patches kept', async () => {
    vi.stubEnv('NEXT_PUBLIC_FIXTURE_ENABLED', 'true');
    const pages = await loadDraftGameInfo();
    const wiki = draft('wiki');
    const future = draft('future-updates');
    expect(pages.wiki?.document.entries.map(entry => entry.id)).toEqual(wiki.entries.map(entry => entry.id));
    expect(pages.future?.document.entries).toEqual(future.entries);
    expect(future.entries.length).toBeGreaterThan(20);
    expect(pages.future?.document.entries.filter(entry => entry.patch).length).toBeGreaterThan(0);
  });

  it('keeps each Wiki guide and its length, and never adds videos', async () => {
    vi.stubEnv('NEXT_PUBLIC_FIXTURE_ENABLED', 'true');
    const pages = await loadDraftGameInfo();
    const wiki = draft('wiki');
    const guides = wiki.entries.filter(entry => entry.video);
    expect(guides.length).toBe(14);
    expect(pages.wiki?.document.entries).toEqual(wiki.entries);
    expect(pages.wiki?.document).not.toHaveProperty('videos');
  });

  it('keeps video and videoLength on the Wiki only, and drops a bad optional value', () => {
    const entry = (extra: object) => ({ id: 'a', title: 'A', body: 'B', ...extra });
    const wiki = (entries: object[]) => parseGameInfo({ version: 1, document: { entries } }, 'wiki')?.document.entries;
    expect(wiki([entry({ video: 'https://youtu.be/AAAAAAAAAAA', videoLength: '1:12' })])).toEqual([entry({ video: 'https://youtu.be/AAAAAAAAAAA', videoLength: '1:12' })]);
    expect(wiki([entry({ video: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' })])).toEqual([entry({ video: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' })]);
    expect(wiki([entry({ video: 'https://youtu.be/AAAAAAAAAAA?si=x', videoLength: '1:12' })])).toEqual([entry({})]);
    expect(wiki([entry({ video: 'https://youtu.be/AAAAAAAAAAA', videoLength: '1:60' })])).toEqual([entry({ video: 'https://youtu.be/AAAAAAAAAAA' })]);
    expect(wiki([entry({ videoLength: '1:12' })])).toEqual([entry({})]);
    expect(wiki([entry({ video: null, videoLength: null })])).toEqual([entry({})]);
    expect(parseGameInfo({ version: 1, document: { entries: [entry({ video: 'https://youtu.be/AAAAAAAAAAA', videoLength: '1:12' })], videos: [null, null] } }, 'future')?.document)
      .toEqual({ entries: [entry({})] });
    expect(parseGameInfo({ version: 1, document: { entries: [], videos: [null, null] } }, 'wiki')?.document).toEqual({ entries: [] });
  });

  it('reads the YouTube id and the thumbnail address of a bare YouTube link only', () => {
    expect(youtubeId('https://youtu.be/n_JSh16FMkY')).toBe('n_JSh16FMkY');
    expect(youtubeId('https://www.youtube.com/watch?v=n_JSh16FMkY')).toBe('n_JSh16FMkY');
    expect(youtubeId('https://youtube.com/watch?v=n_JSh16FMkY')).toBe('n_JSh16FMkY');
    expect(guideThumbnail('https://youtu.be/n_JSh16FMkY')).toBe('https://i.ytimg.com/vi/n_JSh16FMkY/mqdefault.jpg');
    for (const bad of ['https://youtu.be/n_JSh16FMk', 'https://youtu.be/n_JSh16FMkY?si=a', 'http://youtu.be/n_JSh16FMkY', 'https://example.com/watch?v=n_JSh16FMkY', '']) {
      expect(youtubeId(bad)).toBeNull();
      expect(guideThumbnail(bad)).toBeNull();
    }
  });

  it('gives nothing in a build without the fixture', async () => {
    vi.stubEnv('NEXT_PUBLIC_FIXTURE_ENABLED', 'false');
    expect(await loadDraftGameInfo()).toEqual({});
  });
});
