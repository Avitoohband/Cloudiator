import { expect, test, type Page } from './fixtures';
import { contentSecurityPolicy } from '../../scripts/build-headers.mjs';
import { ownerFixture } from '../fixtures/domain';
import { SUPABASE_URL, emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { campReady, cornerChip, creationDialog, expectOwnerShown, joinButton, openMenu, revealRail, signOutFromChip } from './shell-helpers';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const campaignPaths = [
  '/game/p/yt-profile/', '/game/p/yt-trailer/', '/game/p/ig-bio/', '/game/p/tiktok-bio/',
  '/game/p/reddit-webgames-01/', '/game/p/reddit-playmygame/', '/game/p/itch-page/',
  '/game/p/indiedb-page/', '/game/p/reddit-ad-01/',
];
const PROFILE = '/game/p/yt-profile/';
const TRAILER = '/game/p/yt-trailer/';
const TAB_SOURCE = 'cloudiator.promo.source.v1';
const SIGNUP_SOURCE = 'cloudiator.signup-source.v1';

const welcome = (page: Page) => page.getByRole('region', { name: 'Build your gladiator', exact: true });
const play = (page: Page) => welcome(page).getByRole('button', { name: 'Play free in your browser', exact: true });
const explore = (page: Page) => welcome(page).getByRole('button', { name: 'Explore the camp', exact: true });
const gameInfo = (page: Page) => cornerChip(page).getByRole('button', { name: 'Game Info', exact: true });
const camera = (page: Page) => page.evaluate(() => {
  const { zoom, centerX } = window.__cloudiatorCamp!.state()!.camera;
  return { zoom, centerX };
});
const sourceRecords = (page: Page) => page.evaluate(({ tab, signup }) => ({
  tab: JSON.parse(sessionStorage.getItem(tab) ?? 'null') as { v: number; code: string; capturedAtMs: number } | null,
  signup: JSON.parse(localStorage.getItem(signup) ?? 'null') as { code: string; capturedAtMs: number } | null,
}), { tab: TAB_SOURCE, signup: SIGNUP_SOURCE });

async function expectSource(page: Page, code: string) {
  await expect.poll(() => sourceRecords(page)).toEqual({
    tab: { v: 1, code, capturedAtMs: expect.any(Number) }, signup: { code, capturedAtMs: expect.any(Number) },
  });
  const { tab, signup } = await sourceRecords(page);
  expect(tab?.capturedAtMs).toBe(signup?.capturedAtMs);
  return { tab, signup };
}

test.describe('the exported campaign pages', () => {
  test.skip(!production, 'The generated HTML and headers are served by the production export.');

  test('serves every issued path and the regular entry routes with the existing policy', async ({ request }) => {
    for (const path of [...campaignPaths, '/', '/game/', '/auth/callback/']) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(200);
      expect(response.headers()['content-type'], path).toMatch(/^text\/html/);
      expect(response.headers()['content-security-policy'], path).toBe(contentSecurityPolicy(null));
      expect(response.headers()['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
      expect(response.headers()['x-content-type-options'], path).toBe('nosniff');
    }
    const unknown = '/game/p/not-an-issued-placement/';
    expect((await request.get(unknown, { maxRedirects: 0 })).status()).toBe(404);
  });

  test('loads the exported camp and Camp Life link with the welcome suppressed without Auth', async ({ page, request }) => {
    await page.goto(PROFILE);
    await expect(page).toHaveURL(PROFILE);
    await expect(page.locator('[data-camp-view] canvas')).toHaveCount(1, { timeout: 45_000 });
    await expect(welcome(page)).toHaveCount(0);
    expect(await sourceRecords(page)).toEqual({ tab: null, signup: null });
    const scripts = await page.locator('script[src^="/_next/static/"]').evaluateAll(elements =>
      elements.map(element => element.getAttribute('src')).filter((src): src is string => src !== null));
    expect(scripts.length).toBeGreaterThan(0);
    expect((await request.get(scripts[0])).ok()).toBe(true);
    await gameInfo(page).click();
    await expect(page.getByRole('dialog', { name: 'Game Info', exact: true })
      .getByRole('link', { name: 'Watch Camp Life on YouTube', exact: true })).toBeVisible();
  });
});

test.describe('the live campaign welcome', () => {
  test.skip(production, 'The visitor and OAuth cases use the development-only intercepted transport.');

  test('opens the interactive camp, keeps one join action and restores focus on dismissal', async ({ page, context, isMobile }) => {
    const viewport = isMobile ? { width: 360, height: 740 } : { width: 1280, height: 720 };
    await page.setViewportSize(viewport);
    await routeLiveReads(context, { world: emptyWorld() });
    const requests: { origin: string; path: string; type: string }[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        requests.push({ origin: url.origin, path: url.pathname, type: request.resourceType() });
      }
    });
    await page.goto(PROFILE);
    await campReady(page);
    await expect(welcome(page)).toBeVisible();
    await expect(play(page)).toHaveAccessibleDescription('Sign in with Google to play.');
    await expect(joinButton(page)).toHaveCount(0);
    await expect(gameInfo(page)).toBeVisible();
    const bounds = await welcome(page).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(12);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 12);
    expect(bounds!.y).toBeGreaterThan(viewport.height / 2);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    if (isMobile) {
      const menus = page.getByRole('button', { name: 'Menus', exact: true });
      await expect(menus).toBeInViewport();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual((await menus.boundingBox())!.y);
      for (const button of [play(page), explore(page)]) {
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    }
    expect(await welcome(page).evaluate(element => element.contains(document.activeElement))).toBe(false);
    if (isMobile) await page.touchscreen.tap(viewport.width / 2, 100);
    else await page.mouse.click(viewport.width / 2, 100);
    await expect(welcome(page)).toBeVisible();
    const beforeZoom = await camera(page);
    const camp = page.getByRole('application');
    if (isMobile) await camp.press('+');
    else {
      await revealRail(page);
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    }
    await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(beforeZoom.zoom);
    const beforePan = await camera(page);
    await camp.press('ArrowRight');
    await expect.poll(async () => (await camera(page)).centerX).not.toBe(beforePan.centerX);
    await expect(welcome(page)).toBeVisible();
    const appOrigin = new URL(page.url()).origin;
    expect(requests.filter(({ origin }) => origin !== appOrigin && origin !== SUPABASE_URL)).toEqual([]);
    expect(requests.filter(({ origin, path, type }) => origin === appOrigin && ['fetch', 'xhr', 'ping'].includes(type)
      && !path.startsWith('/_next/') && !path.startsWith('/assets/'))).toEqual([]);
    const initial = await expectSource(page, 'yt-profile');

    await play(page).focus();
    await page.keyboard.press('Shift+Tab');
    expect(await welcome(page).evaluate(element => element.contains(document.activeElement))).toBe(false);
    await play(page).focus();
    await page.keyboard.press('Tab');
    await expect(explore(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(welcome(page)).toHaveCount(0);
    await expect(joinButton(page)).toBeFocused();
    await page.goto(TRAILER);
    await campReady(page);
    await expect(joinButton(page)).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    expect(await sourceRecords(page)).toEqual(initial);
    await page.reload();
    await expect(joinButton(page)).toBeVisible();
    expect(await sourceRecords(page)).toEqual(initial);

    const other = await context.newPage();
    await other.goto('/game/');
    await expect(joinButton(other)).toBeVisible();
    expect(await sourceRecords(other)).toEqual({ tab: null, signup: initial.signup });
  });

  test('keeps the welcome actions reachable at 200% text in a short phone viewport', async ({ page, context, isMobile }) => {
    test.skip(!isMobile, 'The short phone case uses the touch layout.');
    await page.setViewportSize({ width: 740, height: 360 });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { left: 20, right: 20, bottom: 24 } });
    await routeLiveReads(context, { world: emptyWorld() });
    await page.goto(PROFILE);
    await expect(welcome(page)).toBeVisible();
    await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    await expect.poll(() => welcome(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const bounds = (await welcome(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(20);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(720);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(336);
    for (const button of [play(page), explore(page)]) {
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport({ ratio: 1 });
    }
    await explore(page).click();
    await expect(joinButton(page)).toBeFocused();
  });

  test('lets Game Info and contextual sign-in take over the welcome', async ({ page, context }) => {
    const live = await routeLiveReads(context, { world: emptyWorld() });
    await page.goto(PROFILE);
    await expect(play(page)).toBeVisible();
    await gameInfo(page).press('Enter');
    const wiki = page.getByRole('dialog', { name: 'Game Info', exact: true }).getByRole('tab', { name: 'Wiki', exact: true });
    await expect(wiki).toBeFocused();
    await expect(welcome(page)).toHaveCount(0);
    await wiki.press('Escape');
    await expect(gameInfo(page)).toBeFocused();
    await expect(joinButton(page)).toBeVisible();
    await page.reload();
    await expect(joinButton(page)).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);

    const other = await context.newPage();
    await other.goto(TRAILER);
    await expect(play(other)).toBeVisible();
    const mine = await openMenu(other, 'My gladiator');
    await expect.poll(() => mine.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await expect(welcome(other)).toHaveCount(0);
    await mine.getByRole('button', { name: 'Sign in with Google to create your gladiator', exact: true }).click();
    await expect(other.getByRole('link', { name: 'Approve test Google' })).toBeVisible();
    expect(live.authRequests.filter(request => request.path === '/auth/v1/authorize')).toHaveLength(1);
  });

  test('preserves deep-linked scenes and suppresses the welcome on plain or fixture entries', async ({ page, context }) => {
    await routeLiveReads(context, { world: emptyWorld() });
    for (const path of ['/?ref=yt-profile', '/game/?ref=yt-profile']) {
      await page.goto(path);
      await expect(joinButton(page)).toBeVisible();
      await expect(welcome(page)).toHaveCount(0);
      expect(await sourceRecords(page)).toEqual({ tab: null, signup: null });
    }
    await page.goto(`${PROFILE}?mode=fixture&as=visitor`);
    await expect(page.getByText('Fixture mode — progress is not saved online')).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    expect(await sourceRecords(page)).toEqual({ tab: null, signup: null });
    await page.goto(`${PROFILE}?view=replay&activity=unknown`);
    const scene = page.getByRole('dialog', { name: 'Replay', exact: true });
    await expect(scene).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    await expect(scene.getByRole('button', { name: 'Back to Camp', exact: true })).toBeVisible();
    await expectSource(page, 'yt-profile');
  });

  test('never opens the welcome or captures a source for a noncanonical pathname', async ({ page, context }) => {
    await routeLiveReads(context, { world: emptyWorld() });
    const invalidPaths = [
      '/game/p/YT-profile/', '/game/p/%79t-profile/', '/game/p/yt%2Fprofile/', '/game/p/yt-profile/extra/',
      `/game/p/${'a'.repeat(41)}/`, '/game/p/not-an-issued-placement/',
    ];
    for (const path of invalidPaths) {
      const response = await page.goto(path);
      expect([200, 400, 404], path).toContain(response?.status());
      if (response?.ok()) await expect(joinButton(page)).toBeVisible();
      await expect(welcome(page)).toHaveCount(0);
      expect(await sourceRecords(page)).toEqual({ tab: null, signup: null });
    }
  });

  test('still allows dismissal and Google sign-in when promo storage writes fail', async ({ page, context }) => {
    await context.addInitScript(signupKey => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if ((this === sessionStorage && key.startsWith('cloudiator.promo.')) || (this === localStorage && key === signupKey)) {
          throw new DOMException('Promo storage denied by test', 'SecurityError');
        }
        return write.call(this, key, value);
      };
    }, SIGNUP_SOURCE);
    await routeLiveReads(context, { world: emptyWorld() });
    await page.goto(PROFILE);
    await expect(explore(page)).toBeEnabled();
    expect(await sourceRecords(page)).toEqual({ tab: null, signup: null });
    await explore(page).click();
    await expect(welcome(page)).toHaveCount(0);
    await expect(joinButton(page)).toBeFocused();
    await page.reload();
    await expect(play(page)).toBeEnabled();
    await play(page).click();
    await expect(page.getByRole('link', { name: 'Approve test Google' })).toBeVisible();
  });

  test('keeps a signed-in owner in normal play and suppresses the welcome after sign-out', async ({ page, context }) => {
    const owner = { ...ownerFixture, name: 'Welcome Test Owner' };
    await seedSession(context);
    const live = await routeLiveReads(context, { world: emptyWorld(), owner });
    const release = live.hold('owner_state');
    await page.goto(PROFILE);
    try {
      await expect.poll(() => live.count('owner_state')).toBeGreaterThan(0);
      await expect(welcome(page)).toHaveCount(0);
      expect(await sourceRecords(page)).toEqual({ tab: null, signup: null });
    } finally {
      release();
    }
    await expectOwnerShown(page, owner.name);
    await signOutFromChip(page);
    await expect(joinButton(page)).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    expect(await sourceRecords(page)).toEqual({ tab: null, signup: null });
  });

  test('waits for a pending Auth refresh before treating a player as a visitor', async ({ page, context }) => {
    const owner = { ...ownerFixture, name: 'Refreshing Welcome Owner' };
    await seedSession(context, undefined, { expiresIn: -1 });
    const live = await routeLiveReads(context, { world: emptyWorld(), owner });
    live.renewSessions();
    let releaseRefresh!: () => void;
    const hold = new Promise<void>(resolve => { releaseRefresh = resolve; });
    await context.route(url => url.origin === SUPABASE_URL && url.pathname === '/auth/v1/token'
      && url.searchParams.get('grant_type') === 'refresh_token', async route => {
      if (route.request().method() === 'POST') await hold;
      await route.fallback();
    });
    try {
      const refresh = page.waitForRequest(request => request.method() === 'POST'
        && new URL(request.url()).searchParams.get('grant_type') === 'refresh_token');
      await page.goto(PROFILE);
      await refresh;
      await expect(welcome(page)).toHaveCount(0);
      expect(await sourceRecords(page)).toEqual({ tab: null, signup: null });
    } finally {
      releaseRefresh();
    }
    await expectOwnerShown(page, owner.name);
    await expect(welcome(page)).toHaveCount(0);
    expect(await sourceRecords(page)).toEqual({ tab: null, signup: null });
  });

  test('takes a new Google account through the fixed callback to the existing create dialog', async ({ page, context }) => {
    const live = await routeLiveReads(context, { world: emptyWorld(), owner: null });
    const attributedBackendRequests: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === SUPABASE_URL && (url.href.includes('yt-trailer') || request.postData()?.includes('yt-trailer'))) {
        attributedBackendRequests.push(url.pathname);
      }
    });
    await page.goto(TRAILER);
    await expect(play(page)).toBeEnabled();
    const initial = await expectSource(page, 'yt-trailer');
    await play(page).click();
    await page.getByRole('link', { name: 'Approve test Google' }).click();
    await expect(page).toHaveURL('/game/');
    await expect(creationDialog(page)).toBeVisible({ timeout: 30_000 });
    await expect(welcome(page)).toHaveCount(0);
    expect(await sourceRecords(page)).toEqual(initial);
    const authorize = live.authRequests.filter(request => request.path === '/auth/v1/authorize');
    expect(authorize).toHaveLength(1);
    expect(authorize[0].query.get('provider')).toBe('google');
    expect(authorize[0].query.get('scopes')).toBe('openid email profile');
    const callback = new URL(authorize[0].query.get('redirect_to')!);
    expect(callback.origin).toBe(new URL(page.url()).origin);
    expect(callback.pathname).toBe('/auth/callback/');
    expect(authorize[0].query.get('code_challenge_method')).toBe('s256');
    expect(attributedBackendRequests).toEqual([]);
  });

  test('keeps the ordinary visitor controls on a failed initial Auth lookup', async ({ page, context }) => {
    await context.addInitScript(() => {
      const read = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (this === localStorage && key === 'sb-127-auth-token') {
          document.documentElement.dataset.authLookupFailed = 'true';
          throw new DOMException('Auth lookup denied by test', 'SecurityError');
        }
        return read.call(this, key);
      };
    });
    await routeLiveReads(context, { world: emptyWorld() });
    await page.goto(PROFILE);
    await expect(page.locator('html')).toHaveAttribute('data-auth-lookup-failed', 'true');
    await expect(joinButton(page)).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    expect(await sourceRecords(page)).toEqual({ tab: null, signup: null });
  });

  test('allows Back from Google and keeps the first source through cancellation or a failed exchange', async ({ page, context }) => {
    const live = await routeLiveReads(context, { world: emptyWorld() });
    await page.goto(PROFILE);
    await expect(play(page)).toBeEnabled();
    const initial = await expectSource(page, 'yt-profile');
    await play(page).click();
    await expect(page.getByRole('link', { name: 'Cancel test Google' })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(PROFILE);
    await expect(play(page)).toBeEnabled();
    await play(page).click();
    await page.getByRole('link', { name: 'Cancel test Google' }).click();
    await expect(page).toHaveURL('/game/');
    await expect(page.getByRole('status').filter({ hasText: 'Google sign-in was canceled. You can keep watching the camp.' })).toBeVisible();
    await expect(joinButton(page)).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    expect(await sourceRecords(page)).toEqual(initial);

    await page.goto(TRAILER);
    await expect(play(page)).toBeEnabled();
    await play(page).click();
    await expect(page.getByRole('link', { name: 'Approve test Google' })).toBeVisible();
    const appOrigin = new URL(live.authRequests.filter(request => request.path === '/auth/v1/authorize').at(-1)!.query.get('redirect_to')!).origin;
    await page.goto(`${appOrigin}/auth/callback/?code=unknown-test-code`);
    await expect(page).toHaveURL('/game/');
    await expect(page.getByRole('status').filter({ hasText: 'Google sign-in could not be completed. Please try again.' })).toBeVisible();
    await expect(joinButton(page)).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    expect(live.authRequests.some(request => request.path === '/auth/v1/token' && request.query.get('grant_type') === 'pkce')).toBe(true);
    expect(await sourceRecords(page)).toEqual(initial);
  });

  test('keeps focus during OAuth startup, guards repeat activation and offers retry on failure', async ({ page, context }) => {
    const live = await routeLiveReads(context, { world: emptyWorld() });
    await page.goto(PROFILE);
    await expect(play(page)).toBeEnabled();
    // Let the real SDK reach PKCE, then fail before browser navigation. The next digest is restored for a real retry.
    await page.evaluate(() => {
      const subtle = crypto.subtle;
      const digest = subtle.digest;
      let attempts = 0;
      subtle.digest = () => {
        document.documentElement.dataset.promoPkceAttempts = String(++attempts);
        return new Promise<ArrayBuffer>((_resolve, reject) => {
          window.addEventListener('finish-promo-pkce-probe', () => {
            subtle.digest = digest;
            reject(new DOMException('Test PKCE startup failure', 'OperationError'));
          }, { once: true });
        });
      };
    });
    await play(page).focus();
    await play(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(page.locator('html')).toHaveAttribute('data-promo-pkce-attempts', '1');
    const opening = welcome(page).getByRole('button', { name: 'Opening Google…', exact: true });
    await expect(opening).toBeFocused();
    await expect(explore(page)).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(welcome(page)).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('finish-promo-pkce-probe')));
    await expect(welcome(page).getByRole('alert')).toHaveText('Google sign-in could not be started. Please try again.');
    await expect(play(page)).toBeEnabled();
    await expect(explore(page)).toBeEnabled();
    expect(live.authRequests.filter(request => request.path === '/auth/v1/authorize')).toHaveLength(0);
    await play(page).click();
    await expect(page.getByRole('link', { name: 'Approve test Google' })).toBeVisible();
    expect(live.authRequests.filter(request => request.path === '/auth/v1/authorize')).toHaveLength(1);
  });

  test('responds to sign-in and sign-out in another tab without reopening the welcome', async ({ page, context }) => {
    const owner = { ...ownerFixture, name: 'Cross-tab Welcome Owner' };
    await routeLiveReads(context, { world: emptyWorld(), owner });
    await page.goto(PROFILE);
    await expect(play(page)).toBeEnabled();
    const initial = await expectSource(page, 'yt-profile');
    const other = await context.newPage();
    await other.goto('/game/');
    await joinButton(other).click();
    await other.getByRole('link', { name: 'Approve test Google' }).click();
    await expectOwnerShown(other, owner.name);
    await expectOwnerShown(page, owner.name);
    await expect(welcome(page)).toHaveCount(0);
    expect(await sourceRecords(other)).toEqual({ tab: null, signup: initial.signup });
    await signOutFromChip(other);
    await expect(joinButton(page)).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    expect(await sourceRecords(page)).toEqual(initial);
  });

  test('keeps a single PKCE attempt when leaving the welcome before Google opens', async ({ page, context }) => {
    const live = await routeLiveReads(context, { world: emptyWorld() });
    await page.goto(PROFILE);
    await expect(play(page)).toBeEnabled();
    await page.evaluate(() => {
      const subtle = crypto.subtle;
      const digest = subtle.digest.bind(subtle);
      subtle.digest = (...args) => {
        const root = document.documentElement;
        root.dataset.promoPkceAttempts = String(Number(root.dataset.promoPkceAttempts ?? 0) + 1);
        return new Promise(resolve => window.addEventListener('continue-promo-pkce', () => resolve(digest(...args)), { once: true }));
      };
    });
    await play(page).click();
    await expect(page.locator('html')).toHaveAttribute('data-promo-pkce-attempts', '1');
    await gameInfo(page).click();
    await expect(welcome(page)).toHaveCount(0);
    await joinButton(page).evaluate((button: HTMLButtonElement) => button.click());
    await expect(cornerChip(page).getByRole('button', { name: 'Opening Google…' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-promo-pkce-attempts', '1');
    await page.evaluate(() => window.dispatchEvent(new Event('continue-promo-pkce')));
    await expect(page.getByRole('link', { name: 'Approve test Google' })).toBeVisible();
    expect(live.authRequests.filter(request => request.path === '/auth/v1/authorize')).toHaveLength(1);
  });
});
