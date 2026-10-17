import { describe, expect, it } from 'vitest';
import { campHref, sceneForResult, sceneHref, sceneOf } from '@/features/shell/scene-url';

// Plan Decision 4: a scene over the camp is a history entry on the current route, `?view=replay&activity=<id>[&stage=<id>]`
// or `?view=expedition&activity=<id>`; Back and "Back to camp" close it.
const params = (search: string) => new URLSearchParams(search);

describe('scenes over the camp in the address', () => {
  it('reads a replay or an expedition scene, and nothing else', () => {
    expect(sceneOf(params('view=replay&activity=a1&stage=s2'))).toEqual({ kind: 'replay', activityId: 'a1', stageId: 's2' });
    expect(sceneOf(params('view=replay&activity=a1'))).toEqual({ kind: 'replay', activityId: 'a1' });
    expect(sceneOf(params('mode=fixture&view=expedition&activity=a1&stage=s2'))).toEqual({ kind: 'expedition', activityId: 'a1' });
    for (const search of ['', 'mode=fixture', 'view=replay', 'view=replay&activity=', 'view=arena&activity=a1', 'activity=a1']) {
      expect(sceneOf(params(search)), search).toBeNull();
    }
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
