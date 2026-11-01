import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSceneHistory } from '@/features/shell/useSceneHistory';

// Arena replays (patch 1.5) Task 3: `replace` rewrites the scene's own history entry (a step inside a scene, as a later task's
// ⏭ does), so the camp entry stays the same number of steps back and Back to camp still leaves in one step. The hook runs here
// against an in-memory browser: React renders it once (server rendering runs its callbacks' hooks, not its effects).
const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002';
const T = 'tournament:373248:bronze', BOUT = `${T}:3:0`;

type Entry = { url: string; state: unknown };
/** A browser's session history: entries, the current one, and the three calls the hook makes on it. */
function fakeBrowser(start: string) {
  const entries: Entry[] = [{ url: new URL(start).pathname + new URL(start).search, state: null }];
  let index = 0;
  const origin = new URL(start).origin;
  const history = {
    get state() { return entries[index].state; },
    pushState(state: unknown, _title: string, url: string) { entries.splice(index + 1); entries.push({ url, state }); index = entries.length - 1; },
    replaceState(state: unknown, _title: string, url: string) { entries[index] = { url, state }; },
    go(delta: number) { index = Math.min(entries.length - 1, Math.max(0, index + delta)); },
  };
  const location = { get href() { return origin + entries[index].url; } };
  return { entries, history, location, at: () => entries[index].url, index: () => index, search: () => Object.fromEntries(new URL(location.href).searchParams) };
}

function mount(browser: ReturnType<typeof fakeBrowser>) {
  vi.stubGlobal('window', { history: browser.history, location: browser.location, addEventListener: () => {}, removeEventListener: () => {} });
  let hook!: ReturnType<typeof useSceneHistory>;
  renderToStaticMarkup(createElement(function Probe() { hook = useSceneHistory(); return null; }));
  return hook;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('a scene opened over the camp, and a step inside it', () => {
  it('opens one entry above the camp, and leaves it in one step after any number of replaces', () => {
    const browser = fakeBrowser('http://x/game/?mode=fixture');
    const scenes = mount(browser);
    scenes.open({ kind: 'replay', activityId: A, from: 'bouts' });
    expect(browser.entries).toHaveLength(2);
    expect(browser.search()).toEqual({ mode: 'fixture', view: 'replay', activity: A, from: 'bouts' });
    expect(browser.history.state).toEqual({ cloudiatorScene: 1 });
    // Three steps inside the scene (⏭ through three bouts): each rewrites the same entry.
    for (const activityId of [B, A, B]) scenes.replace({ kind: 'replay', activityId, from: 'bouts' });
    expect(browser.entries).toHaveLength(2);
    expect(browser.index()).toBe(1);
    expect(browser.history.state).toEqual({ cloudiatorScene: 1 });
    expect(browser.search()).toEqual({ mode: 'fixture', view: 'replay', activity: B, from: 'bouts' });
    // Back to camp goes one entry back, to the camp's own.
    scenes.close();
    expect(browser.index()).toBe(0);
    expect(browser.search()).toEqual({ mode: 'fixture' });
  });

  it('keeps the number of steps back of a scene opened over another scene', () => {
    const browser = fakeBrowser('http://x/game/');
    const scenes = mount(browser);
    scenes.open({ kind: 'expedition', activityId: A, play: 'trip', from: 'results' });
    scenes.open({ kind: 'replay', activityId: A, stageId: `${A}:1`, from: 'results' });
    expect(browser.history.state).toEqual({ cloudiatorScene: 2 });
    scenes.replace({ kind: 'replay', activityId: B, from: 'results' });
    expect(browser.entries).toHaveLength(3);
    expect(browser.history.state).toEqual({ cloudiatorScene: 2 });
    expect(browser.search()).toEqual({ view: 'replay', activity: B, from: 'results' });
    scenes.close();
    expect(browser.index()).toBe(0);
    expect(browser.at()).toBe('/game/');
  });

  it('writes the next step with its own origin, stage, play and bout, and none of the old', () => {
    const browser = fakeBrowser('http://x/game/');
    const scenes = mount(browser);
    scenes.open({ kind: 'expedition', activityId: A, play: 'trip', from: 'gladiators' });
    scenes.replace({ kind: 'replay', activityId: A, stageId: 's2' });
    expect(browser.search()).toEqual({ view: 'replay', activity: A, stage: 's2' });
    scenes.replace({ kind: 'bout', tournamentId: T, boutId: BOUT, from: 'tournaments' });
    expect(browser.search()).toEqual({ view: 'bout', tournament: T, bout: BOUT, from: 'tournaments' });
    scenes.replace({ kind: 'bout', tournamentId: T, boutId: `${T}:2:0`, from: 'tournaments' });
    expect(browser.search()).toEqual({ view: 'bout', tournament: T, bout: `${T}:2:0`, from: 'tournaments' });
    expect(browser.entries).toHaveLength(2);
  });

  it('keeps a scene opened by a link without a camp entry below it, and then returns by replacing it', () => {
    const browser = fakeBrowser(`http://x/game/?mode=fixture&view=replay&activity=${A}&from=arena`);
    const scenes = mount(browser);
    scenes.replace({ kind: 'replay', activityId: B, from: 'arena' });
    expect(browser.entries).toHaveLength(1);
    expect(browser.history.state).toEqual({ cloudiatorScene: null });
    scenes.close();
    expect(browser.entries).toHaveLength(1);
    expect(browser.at()).toBe('/game/?mode=fixture');
  });

  it('opens the same scene from another origin once, as it does from the same one', () => {
    const browser = fakeBrowser('http://x/game/');
    const scenes = mount(browser);
    scenes.open({ kind: 'replay', activityId: A, from: 'bouts' });
    scenes.open({ kind: 'replay', activityId: A, from: 'arena' });
    scenes.open({ kind: 'replay', activityId: A });
    expect(browser.entries).toHaveLength(2);
    expect(browser.search()).toEqual({ view: 'replay', activity: A, from: 'bouts' });
    // Another stage of it is another scene.
    scenes.open({ kind: 'replay', activityId: A, stageId: 's2', from: 'bouts' });
    expect(browser.entries).toHaveLength(3);
  });

  it('replaces nothing when no scene is open, so a late step never reopens a scene over the camp', () => {
    const browser = fakeBrowser('http://x/game/?mode=fixture');
    const scenes = mount(browser);
    scenes.replace({ kind: 'replay', activityId: A, from: 'bouts' });
    expect(browser.entries).toHaveLength(1);
    expect(browser.at()).toBe('/game/?mode=fixture');
    expect(browser.history.state).toBeNull();
  });

  it('replaces nothing while Back to camp is on its way', () => {
    const browser = fakeBrowser('http://x/game/');
    const scenes = mount(browser);
    scenes.open({ kind: 'replay', activityId: A, from: 'bouts' });
    scenes.close();
    // The traversal has not landed (the browser's own is a task later): a step now would rewrite the entry being left.
    browser.history.go(1);
    scenes.replace({ kind: 'replay', activityId: B, from: 'bouts' });
    expect(browser.search()).toEqual({ view: 'replay', activity: A, from: 'bouts' });
  });
});
