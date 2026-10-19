// Fixture replay activity and battle ids (no JSON imports, so browser specs can use them directly).
export const REPLAY_FIXTURES = {
  pvp: { activityId: 'a1d0c2e4-5f60-4b7a-9c3d-1e2f3a4b5c61', battleId: 'fixture-bout-pvp', label: 'Arena bout: Aster vs Varro' },
  npc: { activityId: 'b2e1d3f5-6a71-4c8b-8d4e-2f3a4b5c6d72', battleId: 'fixture-bout-npc', label: 'Arena bout vs an NPC: Iron Warden' },
  expedition: {
    activityId: 'c3f2e4a6-7b82-4d9c-9e5f-3a4b5c6d7e83',
    battleIds: ['fixture-woodland-encounter-1', 'fixture-woodland-encounter-2', 'fixture-woodland-encounter-3'],
    label: 'Woodland Path: three creature encounters',
  },
  tie: { activityId: 'd4a3f5b7-8c93-4eab-8f60-4b5c6d7e8f94', battleId: 'fixture-bout-tie', label: 'Tie-break bout: Aster vs Cassia' },
  expired: { activityId: 'e5b4a6c8-9da4-4fbc-9071-5c6d7e8f9aa5', label: 'Older bout (replay expired)' },
  /**
   * Task 22.5, retention by server time. A bout of the slot seven days (126 slots) before the current one: its summary says
   * available, and the replay is kept until the end of the current slot.
   */
  lastDay: { activityId: 'f7c6b8da-1e2f-4a3b-9c4d-5e6f7a8b9c01', battleId: 'fixture-bout-pvp', label: 'Bout a week ago: replay kept until this slot ends' },
  /** One slot older: its expiry has passed, but cleanup has not run yet (log still held, summary still available). */
  lapsed: { activityId: 'a8d7c9eb-2f30-4b4c-8d5e-6f7a8b9cad12', label: 'Bout a week and a slot ago: replay no longer kept' },
  /** An expedition nine days old, after cleanup: no stage is left, only the owner's settled summary. */
  cleared: { activityId: 'b9e8dafc-3041-4c5d-9e6f-7a8b9cadbe23', label: 'Woodland Path nine days ago: cleaned up, replays no longer kept' },
} as const;
