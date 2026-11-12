import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDraftGameInfo } from '../../src/features/game-info/game-info-client';

type Draft = { entries: { id: string; title: string; body: string; patch?: string }[] };
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
    expect(future.entries.length).toBeGreaterThan(30);
    expect(pages.future?.document.entries.filter(entry => entry.patch).length).toBeGreaterThan(0);
  });

  it('gives nothing in a build without the fixture', async () => {
    vi.stubEnv('NEXT_PUBLIC_FIXTURE_ENABLED', 'false');
    expect(await loadDraftGameInfo()).toEqual({});
  });
});
