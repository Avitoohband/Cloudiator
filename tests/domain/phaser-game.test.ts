import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as PhaserNS from 'phaser';
import { startGame } from '@/game/phaser-game';

type Listener = EventListenerOrEventListenerObject;

/** A document whose listener methods live on the prototype, as on a real Document. */
class FakeDocument {
  readonly listeners = new Set<Listener>();
  addEventListener(_type: string, listener: Listener) { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: Listener) { this.listeners.delete(listener); }
}

const previousBlur = () => 'previous blur';
const previousFocus = () => 'previous focus';
const phaserBlur = () => 'phaser blur';
const phaserFocus = () => 'phaser focus';

/**
 * Stands in for Phaser 4.2.1's Game: start() runs the postBoot callback and then VisibilityHandler,
 * which adds a document 'visibilitychange' listener and overwrites window.onblur/onfocus.
 */
class FakeGame {
  destroyed = false;
  constructor(readonly config: PhaserNS.Types.Core.GameConfig) {}
  start() {
    this.config.callbacks?.postBoot?.(this as unknown as PhaserNS.Game);
    document.addEventListener('visibilitychange', () => {});
    window.onblur = phaserBlur as unknown as typeof window.onblur;
    window.onfocus = phaserFocus as unknown as typeof window.onfocus;
  }
  destroy() { this.destroyed = true; }
}

function setup() {
  const doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { onblur: previousBlur, onfocus: previousFocus });
  const handle = startGame({ Game: FakeGame } as unknown as typeof PhaserNS, {});
  return { doc, handle, game: handle.game as unknown as FakeGame };
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('startGame', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('removes the visibility listener and restores the window handlers on destroy', async () => {
    const { doc, handle, game } = setup();
    game.start();
    await flush();
    expect(doc.listeners.size).toBe(1);
    expect(window.onblur).toBe(phaserBlur);
    handle.destroy();
    expect(game.destroyed).toBe(true);
    expect(doc.listeners.size).toBe(0);
    expect(window.onblur).toBe(previousBlur);
    expect(window.onfocus).toBe(previousFocus);
  });

  it('restores the window handlers when Phaser finishes starting after an early destroy', async () => {
    const { doc, handle, game } = setup();
    handle.destroy();
    game.start();
    await flush();
    expect(doc.listeners.size).toBe(0);
    expect(window.onblur).toBe(previousBlur);
    expect(window.onfocus).toBe(previousFocus);
  });

  it('keeps handlers that someone else installed after Phaser', async () => {
    const { handle, game } = setup();
    game.start();
    await flush();
    const later = () => 'later blur';
    window.onblur = later as unknown as typeof window.onblur;
    handle.destroy();
    expect(window.onblur).toBe(later);
    expect(window.onfocus).toBe(previousFocus);
  });
});
