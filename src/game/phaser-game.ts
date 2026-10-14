import type * as PhaserNS from 'phaser';

type Capture = [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined];

/**
 * Creates a Phaser game whose destroy() also removes the document 'visibilitychange' listener that
 * Phaser 4.2.1 adds in Game.start (VisibilityHandler) and never removes: without this, every mounted
 * scene leaks one listener holding the dead game's event emitter. Game.start calls the postBoot
 * callback and then VisibilityHandler synchronously, so the listener is captured in between.
 * VisibilityHandler also overwrites window.onblur/onfocus; destroy() puts the previous handlers back
 * when Phaser's are still installed.
 */
export function startGame(P: typeof PhaserNS, config: PhaserNS.Types.Core.GameConfig): { game: PhaserNS.Game; destroy(): void } {
  const captured: Capture[] = [];
  let destroyed = false;
  const before = { blur: window.onblur, focus: window.onfocus };
  let installed: { blur: typeof window.onblur; focus: typeof window.onfocus } | null = null;
  const postBoot = config.callbacks?.postBoot;
  // Give back the window handlers only if nobody replaced Phaser's since.
  const restoreWindowHandlers = () => {
    if (!installed) return;
    if (window.onblur === installed.blur) window.onblur = before.blur;
    if (window.onfocus === installed.focus) window.onfocus = before.focus;
    installed = null;
  };
  const captureNextVisibilityListener = () => {
    const add = document.addEventListener;
    const restore = () => {
      if (document.addEventListener !== patched) return;
      delete (document as { addEventListener?: unknown }).addEventListener;
      if (document.addEventListener !== add) document.addEventListener = add;
    };
    const patched = function (this: Document, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      const result = add.call(this, type, listener as EventListenerOrEventListenerObject, options);
      if (listener && /visibilitychange$/.test(type)) {
        restore();
        // Start-up can finish after an unmount (destroy during texture boot): drop the listener at once.
        if (destroyed) document.removeEventListener(type, listener, options);
        else captured.push([type, listener, options]);
        // VisibilityHandler sets the window handlers right after this call, within the same tick; after
        // an early destroy they are put back as soon as they are known.
        queueMicrotask(() => {
          installed = { blur: window.onblur, focus: window.onfocus };
          if (destroyed) restoreWindowHandlers();
        });
      }
      return result;
    } as typeof add;
    document.addEventListener = patched;
    // Never outlive the synchronous start-up, whatever Phaser does.
    queueMicrotask(restore);
  };
  const game = new P.Game({ ...config, callbacks: { ...config.callbacks, postBoot: g => { postBoot?.(g); captureNextVisibilityListener(); } } });
  return {
    game,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      game.destroy(true);
      for (const [type, listener, options] of captured.splice(0)) document.removeEventListener(type, listener, options);
      restoreWindowHandlers();
    },
  };
}
