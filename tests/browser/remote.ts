import type { Page } from '@playwright/test';

/** A command, Supabase or other request that leaves the test's own origin (the page's `baseURL`). */
export function remoteRequest(url: string, origin: string): boolean {
  if (/54321|supabase|\/functions\/v1\/|\/rest\/v1\//.test(url)) return true;
  if (url.startsWith('data:') || url.startsWith('blob:')) return false;
  return new URL(url).origin !== new URL(origin).origin;
}

/** Collects every command, Supabase or other non-local request the page makes (fixture mode must make none). */
export function forbidRemote(page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error('forbidRemote needs the test baseURL');
  const seen: string[] = [];
  page.on('request', request => {
    if (remoteRequest(request.url(), baseURL)) seen.push(request.url());
  });
  return seen;
}
