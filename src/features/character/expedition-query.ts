// The /expedition/ page's query: ?activity=<id>[&mode=fixture[&minute=<0..90>]]. The activity id must be
// UUID-shaped, or the page shows "not available" without reading anything. Fixture mode needs a build with
// fixtures enabled (next.config.ts forces the flag off in production exports), and the minute is read only
// there: it sets the fixture preview's display clock and never grants live time or reward authority.
export type ExpeditionQuery = {
  /** The URL asked for the fixture preview. */
  requested: boolean;
  /** The fixture preview is on: requested, in a fixture-enabled build. */
  fixture: boolean;
  activityId: string | null;
  /** Fixture preview only: open at this minute of the expedition. */
  minute: number | null;
};

const ACTIVITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINUTE = /^\d{1,2}(?:\.\d{1,3})?$/;
export const MAX_FIXTURE_MINUTE = 90;

export function expeditionQuery(params: { get(name: string): string | null }, fixtureBuild: boolean): ExpeditionQuery {
  const requested = params.get('mode') === 'fixture';
  const fixture = requested && fixtureBuild;
  const id = params.get('activity');
  const raw = fixture ? params.get('minute') : null;
  const minute = raw !== null && MINUTE.test(raw) && Number(raw) <= MAX_FIXTURE_MINUTE ? Number(raw) : null;
  return { requested, fixture, activityId: id !== null && ACTIVITY_ID.test(id) ? id : null, minute };
}
