import { test, expect, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerFixture } from '../fixtures/domain';

// Live mode (Task 16 phase 2b): the Arena card and the Standings panel receive the live gateway, so they read the
// protected Data API (intercepted here with development-only identity transport) instead of saying "not available".
const SLOT = 4_800_000, MINUTE = 60_000;

async function liveArena(context: BrowserContext) {
  const start = Math.floor(Date.now() / SLOT) * SLOT, activity = randomUUID();
  const state = structuredClone(ownerFixture);
  state.processedSlotIndex = start / SLOT;
  state.currentActivity = { id: activity, kind: 'arena', status: 'active', startsAtMs: start, endsAtMs: start + 80 * MINUTE, label: 'Arena' };
  const staging = { id: `${activity}:0`, kind: 'staging', revealedAtMs: start, startedAtMs: start, endsAtMs: start + 60 * MINUTE, label: 'Warming up' };
  const standings = [
    { gladiator_id: state.gladiatorId, name: 'Aster', rating: 1012, human_wins: 1, human_losses: 0, rank: 1, promoted: false },
    { gladiator_id: randomUUID(), name: 'Varro', rating: 988, human_wins: 0, human_losses: 1, rank: 2, promoted: false },
  ];
  const reads: string[] = [];
  const user = { id: randomUUID(), aud: 'authenticated', role: 'authenticated', email: 'arena-live@example.invalid',
    app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: {}, identities: [], created_at: new Date().toISOString() };
  await context.addInitScript(({ user }) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(JSON.stringify({ sub: user.id, exp }))}.test-only`;
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-only', token_type: 'bearer', expires_at: exp, expires_in: 3600, user }));
  }, { user });
  await context.route('http://127.0.0.1:54321/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path === '/auth/v1/user') return json(user);
    if (path === '/rest/v1/owner_state') return json([{ state }]);
    reads.push(path);
    expect(request.headers().authorization).toMatch(/^Bearer /);
    if (path === '/rest/v1/world_revision') return json({ revision: '1', server_now_ms: start + 10 * MINUTE, slot_index: start / SLOT });
    if (path === '/rest/v1/visible_events') return json(url.searchParams.get('activity_id') === `eq.${activity}` ? [{ ordinal: 0, stage: staging }] : []);
    if (path === '/rest/v1/recent_results' || path === '/rest/v1/activities') return json(null);
    if (path === '/rest/v1/arena_standing_reads') return json(url.searchParams.get('select') === 'season_index' ? [{ season_index: 3 }] : standings);
    if (path === '/rest/v1/public_profile_reads') return json({ profile: { actor: {}, combatStrength: 931.75, rating: 1012, prestige: [] } });
    // Other panels' reads are not part of this check; answer them as an empty, unavailable backend.
    return json({ code: 'PGRST000', message: 'not part of this test' }, 503);
  });
  return { reads };
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live UI uses development-only intercepted identity transport.'); });

test('gives the live Arena card and Standings panel the live gateway reads', async ({ page, context }) => {
  const flow = await liveArena(context);
  await page.goto('/game/');
  const arena = page.getByRole('region', { name: 'Arena bouts' });
  await arena.getByRole('button', { name: 'Your arena bout' }).click();
  await expect(arena.getByText('Warming up', { exact: true })).toBeVisible();
  await expect(arena).not.toContainText('not available in this build');
  await page.getByRole('button', { name: 'Standings', exact: true }).click();
  const table = page.getByRole('table', { name: 'Bronze league standings' });
  await expect(table.getByRole('row', { name: /Aster/ })).toContainText('1012');
  await expect(table.getByRole('row', { name: /Varro/ })).toContainText('0–1');
  await expect(page.getByText('Standings are not available in this build yet.')).toHaveCount(0);
  // "Your standing" shows the current combat strength from the live public profile read.
  await expect(page.getByRole('region', { name: 'Your standing' })).toContainText('931.75');
  expect(flow.reads).toEqual(expect.arrayContaining(['/rest/v1/visible_events', '/rest/v1/arena_standing_reads', '/rest/v1/public_profile_reads']));
});
