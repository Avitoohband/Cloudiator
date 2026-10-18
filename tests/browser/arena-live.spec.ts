import { test, expect, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { RevealedStage, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { PublicProfile, StandingsPage } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture } from '../fixtures/domain';
import { emptyWorld, routeLiveReads, seedSession, testUser } from './live-routes';
import { openMenu } from './shell-helpers';

// Live mode (Task 16 phase 2b): the Arena card and the Standings panel receive the live gateway, so they read the
// protected Data API (intercepted here with development-only identity transport) instead of saying "not available".
const SLOT = 4_800_000, MINUTE = 60_000;

async function liveArena(context: BrowserContext) {
  const start = Math.floor(Date.now() / SLOT) * SLOT, activity = randomUUID();
  const state = structuredClone(ownerFixture);
  state.processedSlotIndex = start / SLOT;
  state.currentActivity = { id: activity, kind: 'arena', status: 'active', startsAtMs: start, endsAtMs: start + 80 * MINUTE, label: 'Arena' };
  const staging: RevealedStage = { id: `${activity}:0`, kind: 'staging', revealedAtMs: start, startedAtMs: start, endsAtMs: start + 60 * MINUTE, label: 'Warming up' };
  const timeline: RevealedTimeline = { activityId: activity, serverNowMs: start + 10 * MINUTE, visibleThroughMs: start + 10 * MINUTE, stages: [staging] };
  const standings: StandingsPage = { league: 'bronze', seasonId: '3', archived: false, nextCursor: null, rows: [
    { rank: 1, gladiatorId: state.gladiatorId, name: 'Aster', rating: 1012, humanWins: 1, humanLosses: 0, promoted: false, inactive: false, rewardEligible: false, awardPlace: null },
    { rank: 2, gladiatorId: randomUUID(), name: 'Varro', rating: 988, humanWins: 0, humanLosses: 1, promoted: false, inactive: false, rewardEligible: false, awardPlace: null },
  ] };
  const profile = { actor: {}, combatStrength: 931.75, rating: 1012, prestige: [] } as unknown as PublicProfile;
  const user = await seedSession(context, testUser('arena-live@example.invalid'));
  const live = await routeLiveReads(context, { world: emptyWorld(start + 10 * MINUTE), owner: state, timelines: { [activity]: timeline },
    standings: [standings], profiles: { [state.gladiatorId]: profile } });
  return { live, user };
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live UI uses development-only intercepted identity transport.'); });

test('gives the live Arena card and Standings panel the live gateway reads', async ({ page, context }) => {
  const { live, user } = await liveArena(context);
  await page.goto('/game/');
  // The Arena menu holds the Arena card and the league standings (Task 13.5).
  await openMenu(page, 'Arena');
  const arena = page.getByRole('region', { name: 'Arena bouts' });
  await arena.getByRole('button', { name: 'Your arena bout' }).click();
  await expect(arena.getByText('Warming up', { exact: true })).toBeVisible();
  await expect(arena).not.toContainText('not available in this build');
  await openMenu(page, 'Arena');
  const table = page.getByRole('table', { name: 'Bronze league standings' });
  await expect(table.getByRole('row', { name: /Aster/ })).toContainText('1012');
  await expect(table.getByRole('row', { name: /Varro/ })).toContainText('0–1');
  await expect(page.getByText('Standings are not available in this build yet.')).toHaveCount(0);
  // "Your standing" shows the current combat strength from the live public profile read.
  await expect(page.getByRole('region', { name: 'Your standing' })).toContainText('931.75');
  expect(live.requests.map(r => r.table)).toEqual(expect.arrayContaining(['visible_events', 'seasons', 'arena_standing_reads', 'public_profile_reads']));
  // Every read carried the signed-in session.
  expect(live.requests.every(r => r.reader === user.id)).toBe(true);
});
