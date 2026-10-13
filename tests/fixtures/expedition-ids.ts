// Fixture expedition activity ids and gladiators (no JSON imports, so browser specs can use them directly).
// The timelines themselves are engine-generated JSON in tests/fixtures/expeditions/ (see
// tests/domain/expedition-fixtures.test.ts) and are read through tests/fixtures/expeditions.ts.
export const EXPEDITION_GLADIATORS = {
  aster: { id: '0d5f8471-d919-428f-9ab7-058c95821757', name: 'Aster' },
  varro: { id: '5b0c3f8e-2d4a-4e61-9a7b-6c5d4e3f2a10', name: 'Varro' },
} as const;

export const EXPEDITION_FIXTURES = {
  /** The owner's full Woodland Path success, settled with credited rewards. */
  woodland: { activityId: 'f6c5b7d9-0eb5-4a1d-8e2f-6d7e8f9a0b16', expedition: 'woodland', owner: true, label: 'Woodland Path: three encounters, settled' },
  /** The owner's Ruined Outpost run, defeated in encounter 2; the default view is minute 65. */
  outpost: { activityId: 'a7d6c8ea-1fc6-4b2e-9f30-7e8f9a0b1c27', expedition: 'outpost', owner: true, label: 'Ruined Outpost: minute 65, after a defeat' },
  /** The owner's Mountain Pass run, defeated in encounter 3 and settled without rewards. */
  mountain: { activityId: 'b8e7d9fb-2ad7-4c3f-8a41-8f9a0b1c2d38', expedition: 'mountain', owner: true, label: 'Mountain Pass: three encounters, settled' },
  /** Encounter 2 is not published although minute 40 has passed (a worker delay). */
  delayed: { activityId: 'c9f8eaac-3be8-4d40-9b52-9a0b1c2d3e49', expedition: 'woodland', owner: true, label: 'Woodland Path: encounter 2 delayed' },
  /** Ten days old: the detailed battle logs are pruned and the summary says the replays expired. */
  expired: { activityId: 'dafa9bbd-4cf9-4e51-8c63-ab1c2d3e4f5a', expedition: 'woodland', owner: true, label: 'Woodland Path: ten days ago, replays expired' },
  /** Another gladiator's expedition, as a spectator sees it: no summary and no reward details. */
  spectator: { activityId: 'ebab0cce-5d0a-4f62-9d74-bc2d3e4f5a6b', expedition: 'outpost', owner: false, label: "Varro's Ruined Outpost (another gladiator)" },
} as const;

export type ExpeditionFixtureKey = keyof typeof EXPEDITION_FIXTURES;
