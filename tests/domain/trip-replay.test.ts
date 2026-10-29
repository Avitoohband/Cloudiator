import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RevealedTimeline } from '@contracts/events';
import { EXPEDITION_FIXTURE_TIMELINES as TIMELINES } from '../fixtures/expeditions';
import { EXPEDITION_FIXTURES, type ExpeditionFixtureKey } from '../fixtures/expedition-ids';
import type { MapData } from '@/game/assets';
import { journeyMap, legPath } from '@/game/expedition-path';
import { EXPEDITION_MS, stageWalks, type JourneyPoint } from '@/game/expedition-stage';
import { pathLength } from '@/game/paths';
import { REPLAY_OUTRO_MS } from '@/game/replay';
import {
  TRIP_PACE, clockText, firstLocked, planTrip, tripFrame, tripPositionOf, type TripChapterId, type TripPlan,
} from '@/game/trip-replay';

const MIN = 60_000;
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const MAPS = Object.fromEntries(['woodland', 'outpost', 'mountain'].map(id => [id, readJson(`public/assets/expeditions/${id}-map.json`)])) as Record<string, MapData>;
const SPEED: number = readJson('public/assets/manifest.json').actors.gladiator.walk.tilesPerSecond;
/** The walking time of a leg on a fixture's map, as tests/browser/expedition.spec.ts reads it. */
const walk = (map: string) => {
  const journey = journeyMap(MAPS[map]);
  return (from: JourneyPoint, to: JourneyPoint) => (pathLength(legPath(journey, from, to)!) / SPEED) * 1000;
};
const walkOf = (key: ExpeditionFixtureKey) => walk(EXPEDITION_FIXTURES[key].expedition);
const startOf = (key: ExpeditionFixtureKey) => TIMELINES[key].stages[0].startedAtMs;
const encounters = (key: ExpeditionFixtureKey) => TIMELINES[key].stages.filter(s => s.kind === 'encounter');
const KEYS = Object.keys(EXPEDITION_FIXTURES) as ExpeditionFixtureKey[];
const length = (plan: TripPlan, id: TripChapterId) => { const c = plan.chapters.find(x => x.id === id)!; return c.endMs - c.startMs; };
const labels = (plan: TripPlan | null) => plan!.chapters.map(c => c.label);
/** The timeline as a read at `ms` returns it: the stages revealed by then, and no summary. */
const cutAt = (t: RevealedTimeline, ms: number): RevealedTimeline => {
  const { summary, completion, ...rest } = t;
  return { ...rest, serverNowMs: ms, visibleThroughMs: ms, stages: t.stages.filter(s => s.revealedAtMs <= ms) };
};
const cut = (key: ExpeditionFixtureKey, minute: number) => cutAt(TIMELINES[key], startOf(key) + minute * MIN);
/** The display clock of a view at a minute of the trip. */
const clockAt = (key: ExpeditionFixtureKey, minute: number) => startOf(key) + minute * MIN;
/** The display clock of a view after the arrival (minute 81): nothing of the trip is still being fought. */
const over = (t: RevealedTimeline) => t.stages[0].startedAtMs + 81 * MIN;
const trip = (key: ExpeditionFixtureKey, resting = false) => planTrip(TIMELINES[key], { walkMs: walkOf(key), resting, nowMs: over(TIMELINES[key]) })!;
function deepFreeze<V>(value: V): V {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v); }
  return value;
}

describe('the whole-trip plan', () => {
  it('plans a settled Woodland success as eight chapters of about 1¼ minutes', () => {
    const plan = planTrip(TIMELINES.woodland, { walkMs: walk('woodland'), resting: true, nowMs: over(TIMELINES.woodland) })!;
    expect(plan.chapters.map(c => c.label)).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2', 'Fight 3', 'Heading home', 'Back in camp', 'Resting']);
    expect(plan.chapters.map(c => c.id)).toEqual(['leaving', 'trail', 'fight-1', 'fight-2', 'fight-3', 'heading-home', 'back', 'resting']);
    expect(plan.totalMs).toBeGreaterThan(60_000); expect(plan.totalMs).toBeLessThan(90_000);
    expect(length(plan, 'leaving')).toBe(5_000); expect(length(plan, 'back')).toBe(5_000); expect(length(plan, 'resting')).toBe(6_000);
    expect(plan).toMatchObject({ departureMs: startOf('woodland'), endMs: startOf('woodland') + EXPEDITION_MS });
    expect(plan.chapters.every(c => c.revealed)).toBe(true);
  });

  it('paces the trail at about x150, the fights at their length and the camp at 5 s', () => {
    expect(TRIP_PACE).toEqual({ travel: 150, walk: 8, campMs: 5_000, restMs: 6_000 });
    const plan = trip('woodland', true);
    // 20 minutes of trail in 8 s.
    expect(length(plan, 'trail')).toBeCloseTo((20 * MIN) / TRIP_PACE.travel, 6);
    // A fight and its 2 s result poses, then the rest of the 20 minutes in about 8 s.
    const log = (n: number) => encounters('woodland')[n - 1];
    for (const n of [1, 2] as const) {
      const fight = log(n).endsAtMs - log(n).startedAtMs + REPLAY_OUTRO_MS;
      const stretch = 20 * MIN - fight;
      expect(length(plan, `fight-${n}`), `fight ${n}`).toBeCloseTo(fight + stretch / TRIP_PACE.travel, 6);
    }
    // The last fight has no stretch after it in its chapter: heading home follows.
    expect(length(plan, 'fight-3')).toBe(log(3).endsAtMs - log(3).startedAtMs + REPLAY_OUTRO_MS);
    const home = startOf('woodland') + EXPEDITION_MS - (log(3).endsAtMs + REPLAY_OUTRO_MS);
    expect(length(plan, 'heading-home')).toBeCloseTo(home / TRIP_PACE.travel, 6);
    // The chapters cover the replay without a gap.
    expect(plan.chapters[0].startMs).toBe(0);
    plan.chapters.forEach((c, i) => { if (i) expect(c.startMs, c.id).toBe(plan.chapters[i - 1].endMs); });
    expect(plan.totalMs).toBe(plan.chapters.at(-1)!.endMs);
  });

  it('ends at the gate without a known rest', () => {
    expect(planTrip(TIMELINES.woodland, { walkMs: walk('woodland'), resting: false, nowMs: over(TIMELINES.woodland) })!.chapters.at(-1)!.label).toBe('Back in camp');
  });

  it('marks a lost fight and puts the safe point in place of the fights left', () => {
    expect(planTrip(TIMELINES.outpost, { walkMs: walk('outpost'), resting: false, nowMs: over(TIMELINES.outpost) })!.chapters.map(c => c.label))
      .toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2 ✗', 'Safe point', 'Back in camp']);
    expect(labels(trip('mountain', true))).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2', 'Fight 3 ✗', 'Safe point', 'Back in camp', 'Resting']);
    expect(labels(planTrip(TIMELINES.spectator, { walkMs: walk('outpost'), resting: false, nowMs: over(TIMELINES.spectator) }))).toEqual(['Leaving camp', 'On the trail', 'Fight 1 ✗', 'Safe point', 'Back in camp']);
    expect(labels(planTrip(TIMELINES.tiebreak, { walkMs: walk('mountain'), resting: false, nowMs: over(TIMELINES.tiebreak) }))).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2 ✗', 'Safe point', 'Back in camp']);
    // The ids stay by fight number, whatever the outcome.
    expect(trip('outpost').chapters.map(c => c.id)).toEqual(['leaving', 'trail', 'fight-1', 'fight-2', 'safe-point', 'back']);
    // A lost fight ends with its result poses; the safe point runs from there to the end of the slot.
    const plan = trip('outpost');
    const lost = encounters('outpost')[1];
    const chapter = (id: TripChapterId) => plan.chapters.find(c => c.id === id)!;
    expect(chapter('fight-2')).toMatchObject({ displayFromMs: lost.startedAtMs, displayToMs: lost.endsAtMs + REPLAY_OUTRO_MS });
    expect(chapter('safe-point')).toMatchObject({ displayFromMs: lost.endsAtMs + REPLAY_OUTRO_MS, displayToMs: startOf('outpost') + EXPEDITION_MS });
    expect(length(plan, 'fight-2')).toBe(lost.endsAtMs - lost.startedAtMs + REPLAY_OUTRO_MS);
  });

  it('tells a won fight from a lost one by the logged winner, or without logs by the stage after it', () => {
    // Zero-HP tie-break win (Task 9): still a win. Pruned logs: the published labels and stages decide.
    expect(labels(planTrip(TIMELINES.laststand, { walkMs: walk('mountain'), resting: false, nowMs: over(TIMELINES.laststand) }))).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2', 'Fight 3', 'Heading home', 'Back in camp']);
    expect(labels(planTrip(TIMELINES.expired, { walkMs: walk('woodland'), resting: false, nowMs: over(TIMELINES.expired) }))).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2', 'Fight 3', 'Heading home', 'Back in camp']);
  });

  it('has no plan without a departure', () => {
    expect(planTrip({ ...TIMELINES.woodland, stages: [] }, { walkMs: walk('woodland'), resting: true, nowMs: over(TIMELINES.woodland) })).toBeNull();
    expect(planTrip({ ...TIMELINES.woodland, stages: TIMELINES.woodland.stages.slice(1) }, { walkMs: walk('woodland'), resting: true, nowMs: over(TIMELINES.woodland) })).toBeNull();
  });

  it('does not change what it is given and always plans the same', () => {
    const t = deepFreeze(structuredClone(TIMELINES.woodland));
    const options = { walkMs: walk('woodland'), resting: true, nowMs: over(TIMELINES.woodland) };
    expect(planTrip(t, options)).toEqual(planTrip(t, options));
    expect(planTrip(t, options)).toEqual(planTrip(TIMELINES.woodland, options));
  });

  it('uses no clock, randomness or browser state of its own', () => {
    const source = readFileSync('src/game/trip-replay.ts', 'utf8');
    expect(source).not.toMatch(/Date\.now|performance\.now|Math\.random|window\.|document\./);
    expect(source).not.toMatch(/from '[^']*(phaser|react|combat)[^']*'/);
  });

  it('holds together on every finished fixture trip: chapters follow each other, display time tiles the slot, nothing runs backwards', () => {
    // (`delayed` is a trip whose second fight never came: it is planned below, as a running one.)
    for (const key of KEYS.filter(k => k !== 'delayed')) {
      const plan = trip(key, true);
      const expedition = EXPEDITION_FIXTURES[key].expedition;
      expect(plan.chapters[0], key).toMatchObject({ id: 'leaving', vignette: 'leaving', displayFromMs: plan.departureMs, displayToMs: plan.departureMs });
      expect(plan.chapters[1], key).toMatchObject({ id: 'trail', vignette: null, displayFromMs: plan.departureMs });
      const last = plan.chapters.at(-1)!;
      expect(last, key).toMatchObject({ id: 'resting', vignette: 'resting', displayFromMs: plan.endMs, displayToMs: plan.endMs });
      // The chapters that play the map follow each other in display time from the departure to the end of the slot.
      const played = plan.chapters.filter(c => !c.vignette);
      expect(played[0].displayFromMs).toBe(plan.departureMs);
      expect(played.at(-1)!.displayToMs).toBe(plan.endMs);
      played.forEach((c, i) => { if (i) expect(c.displayFromMs, `${key} ${c.id}`).toBe(played[i - 1].displayToMs); });
      // Every chapter has a length, and the replay is about 1 to 1¼ minutes.
      for (const c of plan.chapters) expect(c.endMs, `${key} ${c.id}`).toBeGreaterThan(c.startMs);
      expect(plan.totalMs, key).toBeGreaterThan(50_000);
      expect(plan.totalMs, key).toBeLessThan(90_000);
      // Replay time never takes the display time back.
      let previous = -Infinity;
      for (let ms = 0; ms <= plan.totalMs; ms += 250) {
        const frame = tripFrame(plan, ms);
        expect(frame.displayMs, `${key} ${expedition} at ${ms}`).toBeGreaterThanOrEqual(previous);
        previous = frame.displayMs;
      }
    }
  });
});

describe('replay time and display time', () => {
  const plan = trip('woodland', true);

  it('plays each fight at real speed and each walk at x8', () => {
    for (const fight of encounters('woodland')) expect(tripFrame(plan, tripPositionOf(plan, fight.startedAtMs) + 1_000).displayMs).toBe(fight.startedAtMs + 1_000);
    const walks = stageWalks(TIMELINES.woodland);
    expect(walks).toHaveLength(8);
    for (const w of walks) { const p = tripPositionOf(plan, w.atMs); expect(tripFrame(plan, p + 100).displayMs - tripFrame(plan, p).displayMs).toBe(800); }
  });

  it('lets each walk take as long as the leg takes to walk, and plays the rest of the stretch in what is left', () => {
    const w = walk('woodland');
    const [first, second] = stageWalks(TIMELINES.woodland);
    const firstMs = w(first.from, first.to), secondMs = w(second.from, second.to);
    const fightStart = encounters('woodland')[0].startedAtMs;
    const pos = (displayMs: number) => tripPositionOf(plan, displayMs);
    // A leg plays for its walking time over 8 (a walk is shown at x8).
    // (To the 0.2 ms an epoch time in milliseconds can be told apart by, /8.)
    expect(pos(first.atMs + firstMs) - pos(first.atMs)).toBeCloseTo(firstMs / TRIP_PACE.walk, 3);
    expect(pos(second.atMs + secondMs) - pos(second.atMs)).toBeCloseTo(secondMs / TRIP_PACE.walk, 3);
    // The search and the wait share the rest of the stretch's 8 s, in proportion to their display length.
    const searching = pos(second.atMs) - pos(first.atMs + firstMs);
    const waiting = pos(fightStart) - pos(second.atMs + secondMs);
    expect(searching + waiting).toBeCloseTo(8_000 - firstMs / TRIP_PACE.walk - secondMs / TRIP_PACE.walk, 3);
    expect(searching / waiting).toBeCloseTo((second.atMs - (first.atMs + firstMs)) / (fightStart - (second.atMs + secondMs)), 3);
    expect(length(plan, 'trail')).toBeCloseTo(8_000, 6);
    // The search is played far faster than a walk.
    const rate = (displayMs: number) => (tripFrame(plan, pos(displayMs) + 10).displayMs - tripFrame(plan, pos(displayMs)).displayMs) / 10;
    expect(rate(first.atMs + 1_000)).toBe(TRIP_PACE.walk);
    expect(rate(first.atMs + 60_000)).toBeGreaterThan(100);
  });

  it('shows no search faster or slower than the stretch allows: the steps around a search spot are not walks', () => {
    // The search's own steps (SEARCH_PATTERN) are part of the search, which is compressed like any other waiting. Only the legs
    // of stageWalks play at x8: count the runs at that speed.
    const runs: number[] = [];
    let walking = false;
    for (let ms = 0; ms < plan.totalMs; ms += 20) {
      const rate = (tripFrame(plan, ms + 10).displayMs - tripFrame(plan, ms).displayMs) / 10;
      const eight = Math.abs(rate - TRIP_PACE.walk) < 1e-6;
      if (eight && !walking) runs.push(ms);
      walking = eight;
    }
    expect(runs).toHaveLength(stageWalks(TIMELINES.woodland).length);
  });

  it('gives a stretch whose walks use up its budget no time for the searching and waiting', () => {
    // A 15-minute walk takes 112.5 s at x8, far over the 8 s of a 20-minute stretch; the second leg is a short one.
    const slow = planTrip(TIMELINES.woodland, { walkMs: from => (from === 'start' ? 15 * MIN : 20_000), resting: false, nowMs: over(TIMELINES.woodland) })!;
    const [first, second] = stageWalks(TIMELINES.woodland);
    expect(length(slow, 'trail')).toBe(112_500 + 2_500);
    // The display time of the search in between is skipped: the same replay position all through it.
    const walked = tripPositionOf(slow, first.atMs + 15 * MIN);
    expect(walked).toBe(112_500 + 5_000);
    expect(tripPositionOf(slow, second.atMs)).toBe(walked);
    expect(tripPositionOf(slow, first.atMs + 15 * MIN + 1_000)).toBe(walked);
    expect(tripFrame(slow, walked).displayMs).toBe(second.atMs);
    // The walks are still shown at x8, and the replay still never runs backwards.
    for (const w of [first, second]) {
      const p = tripPositionOf(slow, w.atMs);
      expect(tripFrame(slow, p + 100).displayMs - tripFrame(slow, p).displayMs).toBe(800);
    }
    let previous = -Infinity;
    for (let ms = 0; ms <= slow.totalMs; ms += 250) { const d = tripFrame(slow, ms).displayMs; expect(d).toBeGreaterThanOrEqual(previous); previous = d; }
  });

  it('maps replay time to display time without going back, and back again', () => {
    const woodland = TIMELINES.woodland;
    let previous = -Infinity;
    for (let ms = 0; ms <= plan.totalMs; ms += 250) {
      const frame = tripFrame(plan, ms);
      expect(frame.displayMs, `at ${ms}`).toBeGreaterThanOrEqual(previous);
      previous = frame.displayMs;
      // The trail and the fights are each a single walk, search or fight: their positions come back within 1 ms.
      if (['trail', 'fight-1', 'fight-2', 'fight-3', 'heading-home'].includes(frame.chapter.id)) {
        expect(Math.abs(tripPositionOf(plan, frame.displayMs) - ms), `at ${ms} (${frame.chapter.id})`).toBeLessThanOrEqual(1);
      }
    }
    // Every fight position and its display time round-trip exactly.
    for (const fight of encounters('woodland')) {
      for (const at of [0, 1_000, 3_000]) {
        const p = tripPositionOf(plan, fight.startedAtMs + at);
        expect(tripFrame(plan, p).displayMs).toBe(fight.startedAtMs + at);
      }
    }
    expect(woodland.stages[0].startedAtMs).toBe(plan.departureMs);
  });

  it('reads the frame at a position: its chapter, its index and the vignette of the camp chapters', () => {
    const at = (id: TripChapterId) => plan.chapters.find(c => c.id === id)!;
    const frame = (ms: number) => tripFrame(plan, ms);
    expect(frame(0)).toMatchObject({ index: 0, displayMs: plan.departureMs, vignette: { kind: 'leaving', elapsedMs: 0, durationMs: 5_000 } });
    expect(frame(2_500)).toMatchObject({ index: 0, displayMs: plan.departureMs, vignette: { kind: 'leaving', elapsedMs: 2_500, durationMs: 5_000 } });
    expect(frame(2_500).chapter.id).toBe('leaving');
    // The trail starts where the leaving chapter ends, with no vignette.
    expect(frame(5_000)).toMatchObject({ index: 1, displayMs: plan.departureMs, vignette: null });
    expect(frame(5_000).chapter.id).toBe('trail');
    // The camp's ends are drawn at the end of the slot.
    const back = at('back');
    expect(frame(back.startMs + 1_000)).toMatchObject({ displayMs: plan.endMs, vignette: { kind: 'back', elapsedMs: 1_000, durationMs: 5_000 } });
    const resting = at('resting');
    expect(frame(resting.startMs + 4_000)).toMatchObject({ displayMs: plan.endMs, vignette: { kind: 'resting', elapsedMs: 4_000, durationMs: 6_000 } });
    expect(frame(resting.startMs + 4_000).index).toBe(plan.chapters.length - 1);
    // Outside the replay it holds the first and the last frame.
    expect(frame(-100)).toMatchObject({ index: 0, vignette: { kind: 'leaving', elapsedMs: 0 } });
    expect(frame(plan.totalMs + 5_000)).toMatchObject({ index: plan.chapters.length - 1, displayMs: plan.endMs, vignette: { kind: 'resting', elapsedMs: 6_000, durationMs: 6_000 } });
    // A frame knows the chapter it sits in.
    expect(frame(at('fight-2').startMs + 1)).toMatchObject({ index: 3, chapter: { id: 'fight-2', label: 'Fight 2' } });
    expect(frame(at('fight-2').startMs).displayMs).toBe(encounters('woodland')[1].startedAtMs);
    // Without a rest the trip ends at the gate.
    const gate = trip('woodland', false);
    expect(tripFrame(gate, gate.totalMs + 1)).toMatchObject({ displayMs: gate.endMs, vignette: { kind: 'back', elapsedMs: 5_000, durationMs: 5_000 } });
  });

  it('finds the position of a display time, from before the departure to after the end', () => {
    const woodland = TIMELINES.woodland;
    const fight1 = plan.chapters.find(c => c.id === 'fight-1')!;
    expect(tripPositionOf(plan, encounters('woodland')[0].startedAtMs)).toBe(fight1.startMs);
    // Before the departure it is the start of the trail (after the leaving camp vignette); after the slot, the gate.
    expect(tripPositionOf(plan, plan.departureMs - MIN)).toBe(5_000);
    expect(tripPositionOf(plan, plan.departureMs)).toBe(5_000);
    expect(tripPositionOf(plan, plan.endMs)).toBe(plan.chapters.find(c => c.id === 'back')!.startMs);
    expect(tripPositionOf(plan, plan.endMs + 5 * MIN)).toBe(plan.chapters.find(c => c.id === 'back')!.startMs);
    // Inside a fight, display time counts at real speed.
    expect(tripPositionOf(plan, encounters('woodland')[2].startedAtMs + 2_500) - plan.chapters.find(c => c.id === 'fight-3')!.startMs).toBeCloseTo(2_500, 6);
    expect(woodland.stages.length).toBeGreaterThan(0);
  });
});

describe('a trip still running', () => {
  it('locks the chapters after now in a running trip', () => {
    const at30 = cut('woodland', 30);   // stages revealed by minute 30, no summary
    const plan = planTrip(at30, { walkMs: walk('woodland'), resting: false, nowMs: at30.serverNowMs })!;
    expect(plan.chapters.map(c => c.label)).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2', 'Fight 3', 'Heading home', 'Back in camp']);
    expect(plan.chapters[firstLocked(plan, tripPositionOf(plan, startOf('woodland') + 30 * MIN))].id).toBe('fight-2');
  });

  it('plans the fights not yet revealed as empty chapters at their minute, and what follows them too', () => {
    const plan = planTrip(cut('woodland', 30), { walkMs: walk('woodland'), resting: true, nowMs: clockAt('woodland', 30) })!;
    const s = startOf('woodland');
    const byId = (id: TripChapterId) => plan.chapters.find(c => c.id === id)!;
    expect(plan.chapters.map(c => [c.id, c.revealed])).toEqual([
      ['leaving', true], ['trail', true], ['fight-1', true], ['fight-2', false], ['fight-3', false], ['heading-home', false], ['back', false],
    ]);
    expect(byId('fight-2')).toMatchObject({ displayFromMs: s + 40 * MIN, displayToMs: s + 40 * MIN, startMs: byId('fight-1').endMs, endMs: byId('fight-1').endMs });
    expect(byId('fight-3')).toMatchObject({ displayFromMs: s + 60 * MIN, displayToMs: s + 60 * MIN });
    expect(byId('heading-home')).toMatchObject({ displayFromMs: s + 80 * MIN, displayToMs: s + 80 * MIN });
    // Fight 1 runs on to the minute the next fight is due, as it does in the finished trip.
    expect(byId('fight-1')).toMatchObject({ displayFromMs: encounters('woodland')[0].startedAtMs, displayToMs: s + 40 * MIN });
    expect(plan.totalMs).toBe(byId('fight-1').endMs);
    // And the chapters it has are the ones the finished trip starts with.
    const done = trip('woodland', false);
    for (const id of ['leaving', 'trail', 'fight-1'] as const) expect(byId(id), id).toMatchObject({ startMs: done.chapters.find(c => c.id === id)!.startMs, endMs: done.chapters.find(c => c.id === id)!.endMs });
  });

  it('does not move the chapters it already has when the next fight is revealed', () => {
    const before = planTrip(cut('woodland', 39.9), { walkMs: walk('woodland'), resting: false, nowMs: clockAt('woodland', 39.9) })!;
    const after = planTrip(cut('woodland', 41), { walkMs: walk('woodland'), resting: false, nowMs: clockAt('woodland', 41) })!;
    expect(after.chapters.map(c => c.label)).toEqual(before.chapters.map(c => c.label));
    for (const id of ['leaving', 'trail', 'fight-1'] as const) {
      const a = before.chapters.find(c => c.id === id)!, b = after.chapters.find(c => c.id === id)!;
      expect([b.startMs, b.endMs], id).toEqual([a.startMs, a.endMs]);
    }
    const fight2 = after.chapters.find(c => c.id === 'fight-2')!;
    expect(fight2.revealed).toBe(true);
    expect(fight2.startMs).toBe(before.chapters.find(c => c.id === 'fight-1')!.endMs);
    expect(fight2.endMs).toBeGreaterThan(fight2.startMs);
    // A position kept from before shows the same time in the plan after.
    for (const ms of [0, 1_000, 5_000, 9_000, 14_000, 20_000]) expect(tripFrame(after, ms).displayMs, `${ms}`).toBe(tripFrame(before, ms).displayMs);
    // Fight 3 and the rest are still not revealed.
    expect(after.chapters.filter(c => !c.revealed).map(c => c.id)).toEqual(['fight-3', 'heading-home', 'back']);
  });

  it('keeps the camp chapters of a running trip apart from the real ones: no Resting before the trip ends', () => {
    const plan = planTrip(cut('woodland', 79), { walkMs: walk('woodland'), resting: true, nowMs: clockAt('woodland', 79) })!;
    expect(plan.chapters.map(c => [c.id, c.revealed])).toEqual([
      ['leaving', true], ['trail', true], ['fight-1', true], ['fight-2', true], ['fight-3', true], ['heading-home', true], ['back', false],
    ]);
    // At minute 80 the arrival is revealed: the gate is there, and the Rest the caller knows of.
    const arrived = planTrip(cut('woodland', 80), { walkMs: walk('woodland'), resting: true, nowMs: clockAt('woodland', 80) })!;
    expect(arrived.chapters.at(-2)).toMatchObject({ id: 'back', revealed: true });
    expect(arrived.chapters.at(-1)).toMatchObject({ id: 'resting', revealed: true });
  });

  it('keeps a stage that is not published although its minute has come locked', () => {
    // Worker delay (the `delayed` fixture): minute 45 and fight 2 is still missing.
    const plan = planTrip(cut('delayed', 45), { walkMs: walk('woodland'), resting: false, nowMs: clockAt('delayed', 45) })!;
    expect(plan.chapters.map(c => [c.id, c.revealed])).toEqual([
      ['leaving', true], ['trail', true], ['fight-1', true], ['fight-2', false], ['fight-3', false], ['heading-home', false], ['back', false],
    ]);
    const cap = tripPositionOf(plan, startOf('delayed') + 45 * MIN);
    // Now is past the end of fight 1's chapter, which is as far as the replay goes; fight 2 is not there to play.
    expect(cap).toBe(plan.chapters.find(c => c.id === 'fight-1')!.endMs);
    expect(plan.chapters[firstLocked(plan, cap)].id).toBe('fight-2');
    expect(tripFrame(plan, plan.totalMs + 10_000).chapter.id).toBe('fight-1');
  });

  it('plans a defeat in a running trip as soon as it is decided, and not while the fight is on', () => {
    const lost = encounters('outpost')[1];
    const walkMs = walk('outpost');
    const planAt = (ms: number) => planTrip(cutAt(TIMELINES.outpost, ms), { walkMs, resting: false, nowMs: ms })!;
    // 1 s into the lost fight: its log is known, its end is not shown. No cross, no safe point, nothing decided after it.
    const mid = planAt(lost.startedAtMs + 1_000);
    expect(labels(mid)).not.toContain('Fight 2 ✗');
    expect(labels(mid)).not.toContain('Safe point');
    expect(labels(mid)).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2', 'Fight 3', 'Heading home', 'Back in camp']);
    // What follows the fight is only a locked, empty placeholder, as in any running trip.
    expect(mid.chapters.map(c => c.revealed)).toEqual([true, true, true, true, false, false, false]);
    for (const c of mid.chapters.slice(4)) expect(c.endMs - c.startMs, c.id).toBe(0);
    expect(mid.chapters[3]).toMatchObject({ id: 'fight-2', displayFromMs: lost.startedAtMs, displayToMs: startOf('outpost') + 60 * MIN });
    // At the end of the fight the defeat shows, with the safe point.
    const done = planAt(lost.endsAtMs);
    expect(labels(done)).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2 ✗', 'Safe point', 'Back in camp']);
    expect(done.chapters.map(c => c.revealed)).toEqual([true, true, true, true, true, false]);
    // One millisecond before it ends it is still undecided.
    expect(labels(planAt(lost.endsAtMs - 1))).not.toContain('Fight 2 ✗');
    // The position inside the fight is the same display time in both.
    const p = tripPositionOf(mid, lost.startedAtMs + 1_000);
    expect(tripFrame(done, p).displayMs).toBe(lost.startedAtMs + 1_000);
    expect(tripFrame(mid, p).displayMs).toBe(lost.startedAtMs + 1_000);
    // The same for the last fight: lost, the safe point; won, the way home. Neither while it is being fought.
    const third = encounters('mountain')[2];
    const mountain = (ms: number) => planTrip(cutAt(TIMELINES.mountain, ms), { walkMs: walk('mountain'), resting: false, nowMs: ms })!;
    expect(labels(mountain(third.startedAtMs + 1_000))).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2', 'Fight 3', 'Heading home', 'Back in camp']);
    expect(labels(mountain(third.endsAtMs))).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2', 'Fight 3 ✗', 'Safe point', 'Back in camp']);
    const won = encounters('woodland')[2];
    const woodland = (ms: number) => planTrip(cutAt(TIMELINES.woodland, ms), { walkMs: walk('woodland'), resting: false, nowMs: ms })!;
    const fighting = woodland(won.startedAtMs + 1_000);
    expect(fighting.chapters.find(c => c.id === 'heading-home')).toMatchObject({ revealed: false, startMs: fighting.totalMs, endMs: fighting.totalMs });
    const decided = woodland(won.endsAtMs).chapters.find(c => c.id === 'heading-home')!;
    expect(decided.revealed).toBe(true);
    expect(decided.endMs).toBeGreaterThan(decided.startMs);
  });

  // Task 7 review, added in Task 9: while a fight is on, its plan is the same whether the log says it is won or lost, so nothing
  // (a chapter, its length, a piece) gives the result away. The won copy is the Outpost's lost fight 2 with its winner turned.
  it('plans a fight being fought the same, won or lost, until it ends', () => {
    const lost = encounters('outpost')[1];
    const log = lost.battleLog!;
    const wonCopy: RevealedTimeline = { ...TIMELINES.outpost, stages: TIMELINES.outpost.stages.map(stage => (stage.id !== lost.id ? stage
      : { ...stage, label: stage.label.replace(/defeat/i, 'victory'), battleLog: { ...log, winnerId: log.participants[0].id } })) };
    expect(log.winnerId).not.toBe(log.participants[0].id);
    const walkMs = walk('outpost');
    for (const ms of [lost.startedAtMs + 1_000, lost.endsAtMs - 1]) {
      const asLost = planTrip(cutAt(TIMELINES.outpost, ms), { walkMs, resting: false, nowMs: ms });
      const asWon = planTrip(cutAt(wonCopy, ms), { walkMs, resting: false, nowMs: ms });
      expect(asWon, `at ${ms - lost.startedAtMs} ms into the fight`).toEqual(asLost);
    }
    // Once it has ended the two differ: the lost one has its cross and the safe point.
    expect(labels(planTrip(cutAt(wonCopy, lost.endsAtMs), { walkMs, resting: false, nowMs: lost.endsAtMs }))).not.toContain('Fight 2 ✗');
    expect(labels(planTrip(cutAt(TIMELINES.outpost, lost.endsAtMs), { walkMs, resting: false, nowMs: lost.endsAtMs }))).toContain('Fight 2 ✗');
  });

  it('asks for the display clock, and shows nothing of a trip it is not given one for', () => {
    // The clock is how the plan knows which stages and which results are not to be shown yet: there is no safe default.
    // @ts-expect-error `nowMs` is required
    const plan = planTrip(TIMELINES.woodland, { walkMs: walk('woodland'), resting: true });
    expect(plan).toBeNull();
  });

  it('reads only the stages the display clock has revealed, so an uncut timeline plans the same as a cut one', () => {
    // The fixture gateway returns every stage of a trip, future ones too; the plan must not show them.
    for (const minute of [10, 30, 39.9, 41, 65, 79]) {
      const raw = planTrip(TIMELINES.woodland, { walkMs: walk('woodland'), resting: true, nowMs: clockAt('woodland', minute) })!;
      const cutOne = planTrip(cut('woodland', minute), { walkMs: walk('woodland'), resting: true, nowMs: clockAt('woodland', minute) })!;
      expect(raw, `minute ${minute}`).toEqual(cutOne);
    }
    expect(planTrip(TIMELINES.woodland, { walkMs: walk('woodland'), resting: true, nowMs: startOf('woodland') - 1 })).toBeNull();
    // After a defeat the arrival and the rest are not there either until their time.
    const lost = encounters('outpost')[1];
    const early = planTrip(TIMELINES.outpost, { walkMs: walk('outpost'), resting: true, nowMs: lost.endsAtMs + 5_000 })!;
    expect(early.chapters.map(c => [c.id, c.revealed])).toEqual([['leaving', true], ['trail', true], ['fight-1', true], ['fight-2', true], ['safe-point', true], ['back', false]]);
  });

  it('finds the first locked chapter: the first that starts after the cap, or none without one', () => {
    const plan = trip('woodland', true);
    expect(firstLocked(plan, null)).toBe(plan.chapters.length);
    const fight2 = plan.chapters.find(c => c.id === 'fight-2')!;
    expect(plan.chapters[firstLocked(plan, fight2.startMs - 1)].id).toBe('fight-2');
    // A chapter that starts at the cap is not after it.
    expect(plan.chapters[firstLocked(plan, fight2.startMs)].id).toBe('fight-3');
    expect(firstLocked(plan, 0)).toBe(1);
    expect(firstLocked(plan, plan.totalMs)).toBe(plan.chapters.length);
    expect(firstLocked(plan, -1)).toBe(0);
  });

  it('keeps a chapter that never arrived locked even with no cap: a trip past minute 80 whose fight did not come', () => {
    // The worker is late (the `delayed` fixture): minute 90 and fight 2 is still missing. There is no cap, but nothing to play there.
    const plan = planTrip(cut('delayed', 90), { walkMs: walk('woodland'), resting: false, nowMs: clockAt('delayed', 90) })!;
    expect(plan.chapters.map(c => [c.id, c.revealed])).toEqual([
      ['leaving', true], ['trail', true], ['fight-1', true], ['fight-2', false], ['fight-3', false], ['heading-home', false], ['back', false],
    ]);
    expect(plan.chapters[firstLocked(plan, null)].id).toBe('fight-2');
    // A cap does not unlock it either, and a finished trip has nothing locked.
    expect(plan.chapters[firstLocked(plan, plan.totalMs)].id).toBe('fight-2');
    for (const key of KEYS.filter(k => k !== 'delayed')) expect(firstLocked(trip(key, true), null), key).toBe(trip(key, true).chapters.length);
  });
});

describe('lengths and guards', () => {
  it('gives every camp vignette its exact length, whatever the sum of the chapters before it', () => {
    const lengths = { leaving: TRIP_PACE.campMs, back: TRIP_PACE.campMs, resting: TRIP_PACE.restMs } as const;
    for (const key of KEYS.filter(k => k !== 'delayed')) {
      const plan = trip(key, true);
      const camps = plan.chapters.filter(c => c.vignette);
      expect(camps.map(c => c.id), key).toEqual(['leaving', 'back', 'resting']);
      for (const c of camps) {
        const kind = c.vignette!;
        // Anywhere in it, and at its very end, which is also the end of the replay for the last one.
        for (const at of [c.startMs, c.startMs + 1, (c.startMs + c.endMs) / 2, c.endMs - 0.001]) {
          expect(tripFrame(plan, at).vignette, `${key} ${kind} at ${at}`).toMatchObject({ kind, durationMs: lengths[kind] });
        }
        expect(tripFrame(plan, c.startMs).vignette!.elapsedMs, `${key} ${kind}`).toBe(0);
      }
      expect(tripFrame(plan, plan.totalMs).vignette, key).toEqual({ kind: 'resting', elapsedMs: TRIP_PACE.restMs, durationMs: TRIP_PACE.restMs });
      const gate = trip(key, false);
      expect(tripFrame(gate, gate.totalMs).vignette, key).toEqual({ kind: 'back', elapsedMs: TRIP_PACE.campMs, durationMs: TRIP_PACE.campMs });
    }
  });

  it('treats a walking time that is not a positive number as no walk', () => {
    const none = planTrip(TIMELINES.woodland, { walkMs: () => 0, resting: true, nowMs: over(TIMELINES.woodland) })!;
    for (const bad of [Number.NaN, Infinity, -Infinity, -5_000, 0]) {
      const plan = planTrip(TIMELINES.woodland, { walkMs: () => bad, resting: true, nowMs: over(TIMELINES.woodland) })!;
      expect(plan, `${bad}`).toEqual(none);
      expect(Number.isFinite(plan.totalMs), `${bad}`).toBe(true);
      // No walk to play at x8: the trail is its 8 s of searching and waiting alone.
      expect(length(plan, 'trail'), `${bad}`).toBeCloseTo(8_000, 6);
      for (let ms = 0; ms <= plan.totalMs; ms += 500) expect(Number.isFinite(tripFrame(plan, ms).displayMs), `${bad} at ${ms}`).toBe(true);
    }
    // And one bad leg does not spoil the others.
    const some = planTrip(TIMELINES.woodland, { walkMs: (from, to) => (from === 'start' ? Number.NaN : walk('woodland')(from, to)), resting: true, nowMs: over(TIMELINES.woodland) })!;
    expect(Number.isFinite(some.totalMs)).toBe(true);
    expect(length(some, 'trail')).toBeCloseTo(8_000, 6);
  });

  it('holds the first moment for a position or a display time that is not a number', () => {
    const plan = trip('woodland', true);
    expect(tripPositionOf(plan, Number.NaN)).toBe(5_000);
    expect(tripFrame(plan, Number.NaN)).toMatchObject({ index: 0, vignette: { kind: 'leaving', elapsedMs: 0 } });
    expect(tripPositionOf(plan, Number.NEGATIVE_INFINITY)).toBe(5_000);
    expect(tripPositionOf(plan, Number.POSITIVE_INFINITY)).toBe(plan.chapters.find(c => c.id === 'back')!.startMs);
  });
});

describe('the time text', () => {
  it('writes elapsed and total times', () => { expect(clockText(0)).toBe('0:00'); expect(clockText(76_400)).toBe('1:16'); });
  it('counts whole seconds, pads them and runs on past the hour', () => {
    expect(clockText(999)).toBe('0:00');
    expect(clockText(1_000)).toBe('0:01');
    expect(clockText(9_999)).toBe('0:09');
    expect(clockText(59_999)).toBe('0:59');
    expect(clockText(60_000)).toBe('1:00');
    expect(clockText(3_725_000)).toBe('62:05');
    // Never a minus.
    expect(clockText(-5_000)).toBe('0:00');
    expect(clockText(Number.NaN)).toBe('0:00');
  });
});
