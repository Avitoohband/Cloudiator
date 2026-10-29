import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { campHref, sameScene, sceneForResult, sceneHref, sceneOf } from '@/features/shell/scene-url';
import { BattleReplay } from '@/features/arena/BattleReplay';
import { ExpeditionUnavailable } from '@/features/character/ExpeditionView';

// Plan Decision 4: a scene over the camp is a history entry on the current route, `?view=replay&activity=<id>[&stage=<id>]`
// or `?view=expedition&activity=<id>`; Back and "Back to camp" close it.
const params = (search: string) => new URLSearchParams(search);
const A1 = 'a1d0c2e4-5f60-4b7a-9c3d-1e2f3a4b5c61';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ').trim();

describe('scenes over the camp in the address', () => {
  it('reads a replay or an expedition scene, and nothing else', () => {
    expect(sceneOf(params(`view=replay&activity=${A1}&stage=s2`))).toEqual({ kind: 'replay', activityId: A1, stageId: 's2' });
    expect(sceneOf(params(`view=replay&activity=${A1}`))).toEqual({ kind: 'replay', activityId: A1 });
    expect(sceneOf(params(`mode=fixture&view=expedition&activity=${A1}&stage=s2`))).toEqual({ kind: 'expedition', activityId: A1 });
    for (const search of ['', 'mode=fixture', 'view=replay', 'view=replay&activity=', `view=arena&activity=${A1}`, `activity=${A1}`, 'view=arena&activity=a1']) {
      expect(sceneOf(params(search)), search).toBeNull();
    }
  });

  it('reads the whole-trip replay from &play=trip on an expedition, and ignores any other value (Patch A Task 8)', () => {
    expect(sceneOf(params(`view=expedition&activity=${A1}&play=trip`))).toEqual({ kind: 'expedition', activityId: A1, play: 'trip' });
    expect(sceneOf(params(`mode=fixture&view=expedition&activity=${A1}&stage=s2&play=trip`))).toEqual({ kind: 'expedition', activityId: A1, play: 'trip' });
    for (const other of ['fast', 'TRIP', 'trip ', '', 'trip,trip', '1']) {
      const scene = sceneOf(params(`view=expedition&activity=${A1}&play=${encodeURIComponent(other)}`));
      expect(scene, other).toEqual({ kind: 'expedition', activityId: A1 });
      expect(scene, other).not.toHaveProperty('play');
    }
    expect(sceneOf(params(`view=expedition&activity=${A1}`))).not.toHaveProperty('play');
    // A replay scene has no whole-trip form, and a malformed id names no activity (so no play either).
    expect(sceneOf(params(`view=replay&activity=${A1}&play=trip`))).toEqual({ kind: 'replay', activityId: A1 });
    expect(sceneOf(params(`view=replay&activity=${A1}&play=trip`))).not.toHaveProperty('play');
    expect(sceneOf(params('view=expedition&activity=a1&play=trip'))).toEqual({ kind: 'expedition', activityId: null });
    expect(sceneOf(params('view=expedition&activity=a1&play=trip'))).not.toHaveProperty('play');
  });

  it('names no activity for a malformed id, as the expedition page does, so the scene reads nothing (final review Minor 6)', () => {
    for (const bad of ['a1', 'not-an-id', `${A1}x`, `x${A1}`, `${A1}:0`, A1.slice(0, 35), "1' or '1'='1"]) {
      expect(sceneOf(params(`view=replay&activity=${encodeURIComponent(bad)}&stage=s2`)), bad).toEqual({ kind: 'replay', activityId: null });
      expect(sceneOf(params(`view=expedition&activity=${encodeURIComponent(bad)}`)), bad).toEqual({ kind: 'expedition', activityId: null });
    }
    expect(sceneOf(params(`view=replay&activity=${A1.toUpperCase()}`))).toEqual({ kind: 'replay', activityId: A1.toUpperCase() });
  });

  it('adds a scene to the current route and keeps its other options', () => {
    expect(sceneHref('http://127.0.0.1/game/?mode=fixture&as=visitor', { kind: 'replay', activityId: 'a1', stageId: 'a1:1' }))
      .toBe('/game/?mode=fixture&as=visitor&view=replay&activity=a1&stage=a1%3A1');
    expect(sceneHref('http://127.0.0.1/', { kind: 'expedition', activityId: 'a 1' })).toBe('/?view=expedition&activity=a+1');
    // Another scene replaces the one in the address, with no stale stage.
    expect(sceneHref('http://127.0.0.1/game/?view=replay&activity=a1&stage=s2', { kind: 'expedition', activityId: 'b2' }))
      .toBe('/game/?view=expedition&activity=b2');
  });

  it('writes the whole-trip replay as &play=trip, and drops it for any other scene', () => {
    expect(sceneHref('http://127.0.0.1/game/?mode=fixture', { kind: 'expedition', activityId: 'a1', play: 'trip' }))
      .toBe('/game/?mode=fixture&view=expedition&activity=a1&play=trip');
    // The address it writes reads back as the same scene.
    expect(sceneOf(new URL(`http://127.0.0.1${sceneHref('http://127.0.0.1/game/', { kind: 'expedition', activityId: A1, play: 'trip' })}`).searchParams))
      .toEqual({ kind: 'expedition', activityId: A1, play: 'trip' });
    // A live expedition scene, a replay scene and the camp have no play: a stale one never stays in the address.
    expect(sceneHref('http://127.0.0.1/game/?view=expedition&activity=a1&play=trip', { kind: 'expedition', activityId: 'a1' }))
      .toBe('/game/?view=expedition&activity=a1');
    expect(sceneHref('http://127.0.0.1/game/?view=expedition&activity=a1&play=trip', { kind: 'replay', activityId: 'a1', stageId: 'a1:1' }))
      .toBe('/game/?view=replay&activity=a1&stage=a1%3A1');
    expect(sceneHref('http://127.0.0.1/game/?view=replay&activity=a1', { kind: 'expedition', activityId: 'b2', play: 'trip' }))
      .toBe('/game/?view=expedition&activity=b2&play=trip');
  });

  it('knows when the scene in the address is the one being opened: a trip replay is not the live view of the same expedition', () => {
    const live = { kind: 'expedition' as const, activityId: A1 }, trip = { ...live, play: 'trip' as const };
    const shown = (search: string) => sceneOf(params(search));
    expect(sameScene(shown(`view=expedition&activity=${A1}`), live)).toBe(true);
    expect(sameScene(shown(`view=expedition&activity=${A1}&play=trip`), trip)).toBe(true);
    expect(sameScene(shown(`view=expedition&activity=${A1}`), trip)).toBe(false);
    expect(sameScene(shown(`view=expedition&activity=${A1}&play=trip`), live)).toBe(false);
    // A replay is still told apart by its stage, and a scene of another kind or activity, or none, is never the same.
    expect(sameScene(shown(`view=replay&activity=${A1}&stage=s2`), { kind: 'replay', activityId: A1, stageId: 's2' })).toBe(true);
    expect(sameScene(shown(`view=replay&activity=${A1}&stage=s2`), { kind: 'replay', activityId: A1 })).toBe(false);
    expect(sameScene(shown(`view=replay&activity=${A1}`), { kind: 'replay', activityId: A1 })).toBe(true);
    expect(sameScene(shown(`view=replay&activity=${A1}`), live)).toBe(false);
    expect(sameScene(shown(`view=expedition&activity=${A1}`), { ...live, activityId: 'b2' })).toBe(false);
    expect(sameScene(shown('view=expedition&activity=a1'), live)).toBe(false);
    expect(sameScene(null, live)).toBe(false);
  });

  it('takes the scene out of the address to return to the camp', () => {
    expect(campHref('http://127.0.0.1/game/?mode=fixture&view=replay&activity=a1&stage=s2#x')).toBe('/game/?mode=fixture#x');
    expect(campHref('http://127.0.0.1/?view=expedition&activity=a1')).toBe('/');
    expect(campHref('http://127.0.0.1/game/?mode=fixture&view=expedition&activity=a1&play=trip#x')).toBe('/game/?mode=fixture#x');
  });

  it('opens a result by its kind: expeditions as expeditions, Arena and tournament bouts as replays', () => {
    // An expedition result opens the whole-trip replay (Patch A Task 8).
    expect(sceneForResult('a1', 'expedition')).toEqual({ kind: 'expedition', activityId: 'a1', play: 'trip' });
    expect(sceneForResult('a1', 'arena')).toEqual({ kind: 'replay', activityId: 'a1' });
    expect(sceneForResult('a1', 'tournament')).toEqual({ kind: 'replay', activityId: 'a1' });
    // Training and Rest have no replay (Tasks 7, 9).
    expect(sceneForResult('a1', 'training')).toBeNull();
    expect(sceneForResult('a1', 'rest')).toBeNull();
  });
});

describe('a scene whose activity cannot be read (final review Minor 6)', () => {
  it('says a live read failure cannot be loaded right now, never that this build lacks it', () => {
    const replay = text(renderToStaticMarkup(createElement(BattleReplay, { view: { kind: 'unavailable', reason: 'unavailable' }, headingLevel: 2 })));
    expect(replay).toBe('This replay is not available This replay cannot be loaded right now. Try again shortly.');
    for (const overCamp of [true, false]) {
      const expedition = text(renderToStaticMarkup(createElement(ExpeditionUnavailable, { fixture: false, reason: 'unavailable', overCamp })));
      expect(expedition).toContain('This expedition cannot be loaded right now.');
      expect(expedition).not.toMatch(/in this build|may not exist/);
    }
  });

  it('says a malformed or unknown link names nothing', () => {
    expect(text(renderToStaticMarkup(createElement(BattleReplay, { view: { kind: 'unavailable', reason: 'not-found' }, headingLevel: 2 }))))
      .toBe('This replay is not available No fight was found for this link.');
    expect(text(renderToStaticMarkup(createElement(ExpeditionUnavailable, { fixture: false, reason: 'not-found', overCamp: true }))))
      .toBe('This expedition is not available No expedition matches this link.');
  });
});
