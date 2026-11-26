import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GameInfoPanel } from '@/features/game-info/GameInfoPanel';

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useState: vi.fn(react.useState) };
});

describe('Game Info Camp Life playlist', () => {
  it.each([
    { tab: 'Wiki', id: 'wiki', index: 0 },
    { tab: 'Future Updates', id: 'future', index: 1 },
  ])('renders one new-tab playlist link on $tab', ({ id, index }) => {
    // Server rendering has no tab events. Set the active tab and render the real panel.
    vi.mocked(useState).mockReturnValueOnce([index, vi.fn()]);
    const html = renderToStaticMarkup(createElement(GameInfoPanel, {
      id: 'game-info',
      onClose: () => {},
      fixture: true,
      editorAccount: null,
      onDirty: () => {},
      allowDiscard: () => true,
    }));

    expect(html).toMatch(new RegExp(`<button[^>]*id="game-info-${id}-tab"[^>]*aria-selected="true"`));
    const links = html.match(/<a\b[^>]*>Watch Camp Life on YouTube<\/a>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('href="https://www.youtube.com/playlist?list=PLZ7qxLlpXTaY"');
    expect(links[0]).toContain('target="_blank"');
    expect(links[0]).toMatch(/\srel="(?:noopener noreferrer|noreferrer noopener)"/);
  });
});
