import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { backLabel, boutFilterOf, boutsFrom, campHref, namedScene, sameScene, sameSceneSource, sceneForResult, sceneFromOf, sceneHref, sceneKeyOf, sceneOf, type SceneFrom } from '@/features/shell/scene-url';
import { originMenu } from '@/features/shell/menus';
import { BattleReplay } from '@/features/arena/BattleReplay';
import { ExpeditionUnavailable } from '@/features/character/ExpeditionView';

// Plan Decision 4: a scene over the camp is a history entry on the current route, `?view=replay&activity=<id>[&stage=<id>]`
// or `?view=expedition&activity=<id>`; Back and "Back to camp" close it.
const params = (search: string) => new URLSearchParams(search);
const A1 = 'a1d0c2e4-5f60-4b7a-9c3d-1e2f3a4b5c61';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ').trim();

describe('scenes over the camp in the address', () => {
  it('matches a pending step source by live activity, stage and origin, rather than scene identity alone', () => {
    const source = { kind: 'replay' as const, activityId: A1, stageId: 's2', from: 'bouts' as const };
    expect(sameSceneSource(sceneOf(params(`view=replay&activity=${A1}&stage=s2&from=bouts`)), source)).toBe(true);
    for (const search of ['', `view=expedition&activity=${A1}&from=bouts`, 'view=replay&activity=malformed',
      'view=replay&activity=00000000-0000-4000-8000-000000000002&stage=s2&from=bouts',
      `view=replay&activity=${A1}&stage=s1&from=bouts`, `view=replay&activity=${A1}&from=bouts`,
      `view=replay&activity=${A1}&stage=s2&from=bouts-lost`, `view=replay&activity=${A1}&stage=s2`]) {
      expect(sameSceneSource(sceneOf(params(search)), source), search).toBe(false);
    }
    const withoutDetails = { kind: 'replay' as const, activityId: A1 };
    expect(sameSceneSource(sceneOf(params(`view=replay&activity=${A1}`)), withoutDetails)).toBe(true);
    expect(sameSceneSource(sceneOf(params(`view=replay&activity=${A1}&stage=s2`)), withoutDetails)).toBe(false);
    expect(sameSceneSource(sceneOf(params(`view=replay&activity=${A1}&from=bouts`)), withoutDetails)).toBe(false);
  });

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

// Arena replays (patch 1.5) Task 3: the scene says where Back goes. A `from` parameter keeps the origin across a reload, and a
// tournament bout is addressed without an activity (`?view=bout&tournament=<id>&bout=<id>`).
describe('the scene names its origin', () => {
  const A = '00000000-0000-4000-8000-000000000001', T = 'tournament:373248:bronze', B = `${T}:3:0`;
  const ORIGINS: SceneFrom[] = ['bouts', 'bouts-won', 'bouts-lost', 'results', 'arena', 'notifications', 'tournaments', 'gladiators'];

  it('reads and writes the origin', () => {
    expect(sceneOf(params(`view=replay&activity=${A}&from=bouts-lost`))).toEqual({ kind: 'replay', activityId: A, from: 'bouts-lost' });
    expect(sceneOf(params(`view=replay&activity=${A}&from=elsewhere`))).toEqual({ kind: 'replay', activityId: A });
    expect(sceneHref('http://x/game/?mode=fixture', { kind: 'replay', activityId: A, from: 'arena' })).toBe(`/game/?mode=fixture&view=replay&activity=${A}&from=arena`);
    expect(campHref(`http://x/game/?view=bout&tournament=${T}&bout=${B}&from=tournaments`)).toBe('/game/');
  });

  it('reads every origin, and nothing that only looks like one, for every kind of scene', () => {
    for (const from of ORIGINS) {
      expect(sceneOf(params(`view=replay&activity=${A}&from=${from}`)), from).toEqual({ kind: 'replay', activityId: A, from });
      expect(sceneOf(params(`view=expedition&activity=${A}&from=${from}`)), from).toEqual({ kind: 'expedition', activityId: A, from });
      expect(sceneOf(params(`view=bout&tournament=${T}&bout=${B}&from=${from}`)), from).toEqual({ kind: 'bout', tournamentId: T, boutId: B, from });
    }
    for (const bad of ['', 'Bouts', 'bouts ', 'camp', 'bouts,arena', 'constructor', '__proto__', 'toString']) {
      const scene = sceneOf(params(`view=replay&activity=${A}&from=${encodeURIComponent(bad)}`));
      expect(scene, bad).toEqual({ kind: 'replay', activityId: A });
      expect(scene, bad).not.toHaveProperty('from');
    }
    expect(sceneOf(params(`view=replay&activity=${A}`))).not.toHaveProperty('from');
  });

  it('keeps the origin beside the stage and the whole-trip play, and writes them in one order', () => {
    expect(sceneOf(params(`view=expedition&activity=${A}&play=trip&from=gladiators`))).toEqual({ kind: 'expedition', activityId: A, play: 'trip', from: 'gladiators' });
    expect(sceneOf(params(`view=replay&activity=${A}&stage=s2&from=results`))).toEqual({ kind: 'replay', activityId: A, stageId: 's2', from: 'results' });
    expect(sceneHref('http://x/game/?mode=fixture', { kind: 'expedition', activityId: A, play: 'trip', from: 'notifications' }))
      .toBe(`/game/?mode=fixture&view=expedition&activity=${A}&play=trip&from=notifications`);
    expect(sceneHref('http://x/game/', { kind: 'replay', activityId: A, stageId: 's2', from: 'results' })).toBe(`/game/?view=replay&activity=${A}&stage=s2&from=results`);
    // What it writes reads back as the same scene.
    for (const view of [{ kind: 'expedition' as const, activityId: A, play: 'trip' as const, from: 'results' as const }, { kind: 'replay' as const, activityId: A, stageId: 'a:1', from: 'bouts-won' as const },
      { kind: 'bout' as const, tournamentId: T, boutId: B, from: 'tournaments' as const }]) {
      expect(sceneOf(new URL(`http://x${sceneHref('http://x/game/', view)}`).searchParams)).toEqual(view);
    }
  });

  it('drops the origin, the play, the stage and the bout the next scene does not have', () => {
    const shown = `http://x/game/?mode=fixture&view=expedition&activity=${A}&play=trip&from=results`;
    expect(sceneHref(shown, { kind: 'expedition', activityId: A })).toBe(`/game/?mode=fixture&view=expedition&activity=${A}`);
    expect(sceneHref(shown, { kind: 'replay', activityId: A, from: 'arena' })).toBe(`/game/?mode=fixture&view=replay&activity=${A}&from=arena`);
    expect(sceneHref(`http://x/game/?view=bout&tournament=${T}&bout=${B}&from=tournaments`, { kind: 'replay', activityId: A })).toBe(`/game/?view=replay&activity=${A}`);
    expect(sceneHref(`http://x/game/?view=replay&activity=${A}&from=bouts`, { kind: 'bout', tournamentId: T, boutId: B }))
      .toBe(`/game/?view=bout&tournament=${encodeURIComponent(T)}&bout=${encodeURIComponent(B)}`);
    expect(campHref(shown)).toBe('/game/?mode=fixture');
  });

  it('addresses a tournament bout without an activity', () => {
    expect(sceneOf(params(`view=bout&tournament=${T}&bout=${B}`))).toEqual({ kind: 'bout', tournamentId: T, boutId: B });
    expect(sceneOf(params(`view=bout&tournament=${T}&bout=tournament:1:gold:1:0`))).toEqual({ kind: 'bout', activityId: null });
    expect(sceneHref(`http://x/game/?view=bout&tournament=${T}&bout=${B}`, { kind: 'replay', activityId: A })).toBe(`/game/?view=replay&activity=${A}`);
  });

  it('names no bout for a malformed bout address, and no scene for none at all', () => {
    // Either part missing, malformed, or of another tournament; a prefix that is not followed by ":" is another tournament too.
    for (const search of [`view=bout&tournament=${T}`, `view=bout&bout=${B}`, `view=bout&tournament=bad&bout=${B}`, `view=bout&tournament=${T}&bout=bad`,
      `view=bout&tournament=${T}&bout=${T}`, `view=bout&tournament=${T}&bout=${T}:3`, `view=bout&tournament=${T}&bout=tournament:373248:silver:3:0`,
      'view=bout&tournament=tournament:37324:bronze&bout=tournament:373248:bronze:3:0', `view=bout&tournament=${T}&bout=${encodeURIComponent(`${B}x`)}`]) {
      expect(sceneOf(params(search)), search).toEqual({ kind: 'bout', activityId: null });
    }
    expect(sceneOf(params('view=bout'))).toBeNull();
    expect(sceneOf(params(`view=bout&activity=${A}`))).toBeNull();
    // An origin on a malformed address changes nothing.
    expect(sceneOf(params(`view=bout&tournament=${T}&from=arena`))).toEqual({ kind: 'bout', activityId: null });
  });

  it('names the origin and its chip', () => {
    expect([undefined, 'bouts', 'bouts-won', 'results', 'arena', 'notifications', 'tournaments', 'gladiators'].map(f => backLabel(f as SceneFrom | undefined)))
      .toEqual(['Camp', 'My bouts', 'My bouts', 'Results', 'Arena', 'Notifications', 'Tournaments', 'Gladiators']);
    expect(backLabel('bouts-lost')).toBe('My bouts');
    expect([boutFilterOf('bouts'), boutFilterOf('bouts-won'), boutFilterOf('bouts-lost'), boutFilterOf('arena')]).toEqual(['all', 'won', 'lost', null]);
    expect([undefined, 'results', 'notifications', 'tournaments', 'gladiators'].map(f => boutFilterOf(f as SceneFrom | undefined))).toEqual([null, null, null, null, null]);
    // Task 4: a My bouts row names its chip as the origin, and the chip comes back from it.
    expect([boutsFrom('all'), boutsFrom('won'), boutsFrom('lost')]).toEqual(['bouts', 'bouts-won', 'bouts-lost']);
    for (const filter of ['all', 'won', 'lost'] as const) expect(boutFilterOf(boutsFrom(filter))).toBe(filter);
  });

  it('names the menu an origin goes back to, none for the camp and the Notifications panel', () => {
    expect(ORIGINS.map(from => originMenu(from))).toEqual(['results', 'results', 'results', 'results', 'arena', null, 'tournaments', 'gladiators']);
  });

  it('hands the shell the origin and the named scene, and nothing for an address that names none', () => {
    expect(sceneFromOf({ kind: 'replay', activityId: A, from: 'arena' })).toBe('arena');
    expect(sceneFromOf({ kind: 'bout', tournamentId: T, boutId: B, from: 'tournaments' })).toBe('tournaments');
    expect(sceneFromOf({ kind: 'replay', activityId: A })).toBeUndefined();
    expect(sceneFromOf({ kind: 'replay', activityId: null })).toBeUndefined();
    expect(namedScene({ kind: 'replay', activityId: A })).toEqual({ kind: 'replay', activityId: A });
    expect(namedScene({ kind: 'bout', tournamentId: T, boutId: B })).toEqual({ kind: 'bout', tournamentId: T, boutId: B });
    expect(namedScene({ kind: 'bout', activityId: null })).toBeNull();
    expect(namedScene({ kind: 'expedition', activityId: null })).toBeNull();
  });

  it('keys a scene without its origin, and a bracket without its bout', () => {
    expect(sceneKeyOf({ kind: 'replay', activityId: A, from: 'arena' })).toBe(sceneKeyOf({ kind: 'replay', activityId: A }));
    expect(sceneKeyOf({ kind: 'bout', tournamentId: T, boutId: B })).toBe(sceneKeyOf({ kind: 'bout', tournamentId: T, boutId: `${T}:2:0` }));
  });

  it('keys a scene by what makes it another scene: the activity, the stage, the play, the tournament', () => {
    expect(sceneKeyOf({ kind: 'replay', activityId: A })).toBe(`replay|${A}|`);
    expect(sceneKeyOf({ kind: 'replay', activityId: A, stageId: 's2', from: 'bouts' })).toBe(`replay|${A}|s2`);
    expect(sceneKeyOf({ kind: 'expedition', activityId: A })).toBe(`expedition|${A}|`);
    expect(sceneKeyOf({ kind: 'expedition', activityId: A, play: 'trip', from: 'results' })).toBe(`expedition|${A}|trip`);
    expect(sceneKeyOf({ kind: 'bout', tournamentId: T, boutId: B })).toBe(`bout|${T}`);
    expect(sceneKeyOf({ kind: 'bout', activityId: null })).toBe('bout|null');
    expect(sceneKeyOf({ kind: 'replay', activityId: null })).toBe('replay|null');
    expect(sceneKeyOf({ kind: 'expedition', activityId: null })).toBe('expedition|null');
    const keys = [{ kind: 'replay', activityId: A }, { kind: 'replay', activityId: A, stageId: 's2' }, { kind: 'expedition', activityId: A }, { kind: 'expedition', activityId: A, play: 'trip' },
      { kind: 'replay', activityId: 'b2' }, { kind: 'bout', tournamentId: T, boutId: B }, { kind: 'bout', tournamentId: 'tournament:1:gold', boutId: 'tournament:1:gold:1:0' }] as const;
    expect(new Set(keys.map(view => sceneKeyOf(view))).size).toBe(keys.length);
  });

  it('treats the same scene from another origin as the same scene, and another play or bout as another', () => {
    const shown = (search: string) => sceneOf(params(search));
    expect(sameScene(shown(`view=replay&activity=${A}&from=bouts`), { kind: 'replay', activityId: A, from: 'arena' })).toBe(true);
    expect(sameScene(shown(`view=replay&activity=${A}&from=bouts`), { kind: 'replay', activityId: A })).toBe(true);
    expect(sameScene(shown(`view=replay&activity=${A}`), { kind: 'replay', activityId: A, from: 'bouts' })).toBe(true);
    expect(sameScene(shown(`view=expedition&activity=${A}&play=trip&from=results`), { kind: 'expedition', activityId: A, play: 'trip', from: 'gladiators' })).toBe(true);
    expect(sameScene(shown(`view=expedition&activity=${A}&play=trip&from=results`), { kind: 'expedition', activityId: A, from: 'results' })).toBe(false);
    expect(sameScene(shown(`view=replay&activity=${A}&stage=s2&from=results`), { kind: 'replay', activityId: A, from: 'results' })).toBe(false);
    expect(sameScene(shown(`view=bout&tournament=${T}&bout=${B}&from=tournaments`), { kind: 'bout', tournamentId: T, boutId: B })).toBe(true);
    expect(sameScene(shown(`view=bout&tournament=${T}&bout=${B}`), { kind: 'bout', tournamentId: T, boutId: `${T}:2:0` })).toBe(false);
    expect(sameScene(shown(`view=bout&tournament=${T}&bout=${B}`), { kind: 'replay', activityId: A })).toBe(false);
    expect(sameScene(shown(`view=replay&activity=${A}`), { kind: 'bout', tournamentId: T, boutId: B })).toBe(false);
    expect(sameScene(shown(`view=bout&tournament=${T}&bout=bad`), { kind: 'bout', tournamentId: T, boutId: B })).toBe(false);
  });
});
