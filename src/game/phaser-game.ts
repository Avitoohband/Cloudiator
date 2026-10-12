import type * as PhaserNS from 'phaser';

type Capture = [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined];

/**
 * Creates a Phaser game whose destroy() also removes the document 'visibilitychange' listener that
 * Phaser 4.2.1 adds in Game.start (VisibilityHandler) and never removes: without this, every mounted
 * scene leaks one listener holding the dead game's event emitter. Game.start calls the postBoot
 * callback and then VisibilityHandler synchronously, so the listener is captured in between.
 */
export function startGame(P: typeof PhaserNS, config: PhaserNS.Types.Core.GameConfig): { game: PhaserNS.Game; destroy(): void } {
  const captured: Capture[] = [];
  const postBoot = config.callbacks?.postBoot;
  const captureNextVisibilityListener = () => {
    const add = document.addEventListener;
    const restore = () => {
      if (document.addEventListener !== patched) return;
      delete (document as { addEventListener?: unknown }).addEventListener;
      if (document.addEventListener !== add) document.addEventListener = add;
    };
    const patched = function (this: Document, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      if (listener && /visibilitychange$/.test(type)) { captured.push([type, listener, options]); restore(); }
      return add.call(this, type, listener as EventListenerOrEventListenerObject, options);
    } as typeof add;
    document.addEventListener = patched;
    // Never outlive the synchronous start-up, whatever Phaser does.
    queueMicrotask(restore);
  };
  const game = new P.Game({ ...config, callbacks: { ...config.callbacks, postBoot: g => { postBoot?.(g); captureNextVisibilityListener(); } } });
  let destroyed = false;
  return {
    game,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      game.destroy(true);
      for (const [type, listener, options] of captured.splice(0)) document.removeEventListener(type, listener, options);
    },
  };
}
