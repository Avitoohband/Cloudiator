import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplayBar } from '@/features/replay/ReplayBar';

// Patch A Task 9 (the controller's ruling, so the Arena-replays patch needs no refactor): the trip's bar is a thin wrapper over one
// generic replay bar, with the signature of docs/superpowers/plans/2026-10-29-arena-replays.md Task 1. These are that task's
// cases for the generic part; tests/browser/trip-replay.spec.ts pins the trip's use of it.

const noop = () => undefined;
const button = (html: string, name: string) => html.match(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`))?.[0] ?? '';
const step = (name: string, shortcut: string, disabled = false) => ({ name, shortcut, disabled, onClick: noop });
const bar = (over = {}) => renderToStaticMarkup(createElement(ReplayBar, {
  label: 'Replay controls', play: { playing: true, onToggle: noop, shortcut: 'K Space' }, time: '0:07 / 0:23', ...over }));

describe('the replay bar', () => {
  it('names each button with its key', () => {
    const html = bar({ previous: step('Previous bout', 'P'), next: step('Next bout', 'N', true) });
    expect(html).toContain('aria-label="Replay controls"');
    expect(button(html, 'Previous bout')).toContain('title="Previous bout (P)"');
    expect(button(html, 'Previous bout')).toContain('aria-keyshortcuts="P"');
    expect(button(html, 'Next bout')).toContain('disabled');
    expect(button(html, 'Pause')).toContain('aria-keyshortcuts="K Space"');
    expect(button(bar({ play: { playing: false, onToggle: noop } }), 'Play')).not.toBe('');
  });

  it('leaves out a step it is not given', () => { expect(bar()).not.toContain('aria-label="Previous bout"'); });

  it('lists chapters, the current one marked, and says the current one in one line for a phone', () => {
    const html = bar({ chapters: { items: [{ id: 'q', label: 'Quarterfinal' }, { id: 's', label: 'Semifinal' },
      { id: 'f', label: 'Final', disabled: true, title: 'Not yet: plays when it happens' }], current: 1, onSelect: noop } });
    expect(html).toMatch(/aria-current="step"[^>]*>Semifinal</);
    expect(html).toContain('title="Not yet: plays when it happens"');
    expect(html).toContain('2 / 3 · Semifinal');
  });

  it('keeps the track, the time and the tail in that order', () => {
    const html = bar({ track: createElement('input', { type: 'range', 'aria-label': 'Replay position' }), tail: '⚑ Result' });
    expect(html.indexOf('Replay position')).toBeLessThan(html.indexOf('0:07 / 0:23'));
    expect(html.indexOf('0:07 / 0:23')).toBeLessThan(html.indexOf('⚑ Result'));
  });

  it('gives a step without a shortcut no key hint, and a play button without one no aria-keyshortcuts', () => {
    const html = bar({ play: { playing: false, onToggle: noop }, previous: { name: 'Previous chapter', disabled: false, onClick: noop } });
    expect(button(html, 'Previous chapter')).toContain('title="Previous chapter"');
    expect(button(html, 'Previous chapter')).not.toContain('aria-keyshortcuts');
    expect(button(html, 'Play')).not.toContain('aria-keyshortcuts');
    // The chapter list is not rendered without chapters, nor the one-line chapter name.
    expect(html).not.toContain('aria-current');
  });
});
