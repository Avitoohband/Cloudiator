import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { campHref, sceneForResult, sceneHref, sceneOf } from '@/features/shell/scene-url';
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

  it('takes the scene out of the address to return to the camp', () => {
    expect(campHref('http://127.0.0.1/game/?mode=fixture&view=replay&activity=a1&stage=s2#x')).toBe('/game/?mode=fixture#x');
    expect(campHref('http://127.0.0.1/?view=expedition&activity=a1')).toBe('/');
  });

  it('opens a result by its kind: expeditions as expeditions, Arena and tournament bouts as replays', () => {
    expect(sceneForResult('a1', 'expedition')).toEqual({ kind: 'expedition', activityId: 'a1' });
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
