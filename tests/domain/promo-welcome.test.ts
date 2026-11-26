import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PromoWelcome } from '../../src/features/promo/PromoWelcome';
import { showPromoWelcome } from '../../src/features/promo/usePromoWelcome';

describe('campaign welcome', () => {
  it('renders the approved welcome as a region with two actions', () => {
    const html = renderToStaticMarkup(createElement(PromoWelcome, { onDismiss: () => {} }));
    expect(html).toContain('<section');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('Build your gladiator');
    expect(html).toContain('Sign in with Google to play.');
    expect(html).toMatch(/<button[^>]+aria-describedby=[^>]+>Play free in your browser<\/button>/);
    expect(html).toMatch(/<button[^>]+>Explore the camp<\/button>/);
    expect(html).not.toContain('aria-modal');
  });

  const eligible = { confirmedVisitor: true, source: 'yt-profile' as const, dismissed: false, blocked: false };

  it('offers the welcome on a confirmed anonymous campaign entry', () => {
    expect(showPromoWelcome(eligible)).toBe(true);
  });

  it.each([
    { confirmedVisitor: false },
    { source: null },
    { dismissed: true },
    { blocked: true },
  ])('keeps the camp clear when %j', state => {
    expect(showPromoWelcome({ ...eligible, ...state })).toBe(false);
  });
});
