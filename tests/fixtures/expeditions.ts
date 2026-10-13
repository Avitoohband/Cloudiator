// Revealed expedition timelines for the fixture preview. They are JSON files produced by the real Task 3
// engine and the Task 9 stage sequence (see tests/domain/expedition-fixtures.test.ts); this module only
// reads them, so the browser never runs combat. Each timeline holds every stage of its run: the fixture
// gateway has no clock, and the expedition view shows only the stages revealed by its display time.
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events.ts';
import woodland from './expeditions/woodland.json';
import outpost from './expeditions/outpost.json';
import mountain from './expeditions/mountain.json';
import delayed from './expeditions/delayed.json';
import expired from './expeditions/expired.json';
import spectator from './expeditions/spectator.json';
import { EXPEDITION_FIXTURES, type ExpeditionFixtureKey } from './expedition-ids.ts';

export { EXPEDITION_FIXTURES };

export const EXPEDITION_FIXTURE_TIMELINES: Record<ExpeditionFixtureKey, RevealedTimeline> = {
  woodland: woodland as unknown as RevealedTimeline, outpost: outpost as unknown as RevealedTimeline,
  mountain: mountain as unknown as RevealedTimeline, delayed: delayed as unknown as RevealedTimeline,
  expired: expired as unknown as RevealedTimeline, spectator: spectator as unknown as RevealedTimeline,
};

/** Timelines by activity id, as gateway.timeline(id) returns them. */
export const EXPEDITION_TIMELINES: Record<string, RevealedTimeline> = Object.fromEntries(
  (Object.keys(EXPEDITION_FIXTURES) as ExpeditionFixtureKey[]).map(key => [EXPEDITION_FIXTURES[key].activityId, EXPEDITION_FIXTURE_TIMELINES[key]]));

/** Sample expeditions listed on the fixture game page. */
export const EXPEDITION_SAMPLES: { activityId: string; label: string }[] = Object.values(EXPEDITION_FIXTURES).map(({ activityId, label }) => ({ activityId, label }));
