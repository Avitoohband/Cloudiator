'use client';

// A scene over the camp is a history entry on the camp's own route (plan Decision 4). Opening one pushes an entry
// (Next.js's App Router takes `history.pushState` into its router, so `useSearchParams` follows it and Back/Forward
// restore it); the browser's Back closes it. "Back to camp" goes back to the camp's entry, however many scenes were
// opened on top of it (an expedition's encounter replay is another entry). A scene opened by a link has no camp entry
// below it, so "Back to camp" replaces its entry with the camp instead. A step inside a scene (a bout's ⏭, a bracket's
// chapter: Arena replays Task 3) `replace`s the scene's own entry and keeps its mark, so the camp stays the same number of
// steps back. All of them read the address itself, so a request made twice before the page has followed the first acts once
// (Task 23.5).
import { useCallback, useEffect, useRef } from 'react';
import { campHref, sameScene, sceneHref, sceneOf, type SceneView } from './scene-url';

/** Our mark on a scene's history entry: how many entries back the camp's entry is, or null when there is none. */
const MARK = 'cloudiatorScene';
const markOf = (state: unknown): number | null => {
  const value = state && typeof state === 'object' ? (state as Record<string, unknown>)[MARK] : null;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
};
/**
 * The scene the address names right now. `pushState` changes the address at once, while the router's search params (and
 * so the shell's `scene`) follow a render later: two requests in that gap (a double click, two bridge events) would each
 * push an entry, and Back to camp would then land on the first copy (Task 23.5, C19, the double-open history race).
 */
const addressed = () => sceneOf(new URL(window.location.href).searchParams);

/** `open`, `replace` and `close` change the address (and so the scene the shell shows). */
export function useSceneHistory() {
  /** A Back to camp in flight: its history traversal has not landed yet, so another one would go back past the camp. */
  const leaving = useRef(false);
  useEffect(() => {
    const landed = () => { leaving.current = false; };
    window.addEventListener('popstate', landed);
    return () => window.removeEventListener('popstate', landed);
  }, []);

  const open = useCallback((view: SceneView) => {
    const shown = addressed();
    if (sameScene(shown, view)) return;
    leaving.current = false;
    // From the camp, one entry above it; from a scene, one more than that scene (none above a scene opened by a link).
    const below = shown ? markOf(window.history.state) : 0;
    window.history.pushState({ [MARK]: below === null ? null : below + 1 }, '', sceneHref(window.location.href, view));
  }, []);

  /** Shows another scene (or another step of this one) in the entry the current scene has: no step is added, none is lost. */
  const replace = useCallback((view: SceneView) => {
    // Only while a scene is open and not on its way out: a late step must not turn the camp into a scene, nor rewrite the entry Back is leaving.
    if (!addressed() || leaving.current) return;
    window.history.replaceState({ [MARK]: markOf(window.history.state) }, '', sceneHref(window.location.href, view));
  }, []);

  const close = useCallback(() => {
    if (!addressed() || leaving.current) return;
    const steps = markOf(window.history.state);
    if (steps) {
      leaving.current = true;
      window.history.go(-steps);
    } else window.history.replaceState(null, '', campHref(window.location.href));
  }, []);

  return { open, replace, close };
}
