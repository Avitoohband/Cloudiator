'use client';

// Patch 1.9 final fix wave (the feedback mockup's notes.md, Q5: "only the red count on the Feedback tab and on Game Info"): the number of New
// feedback items on the corner chip's Game Info button, for a Game Info editor only.
// - Who: an account this browser has seen pass the Game Info panel's own editor probe (`canEdit`: the draft read, `editGameInfo`). It is
//   remembered in this browser for that account, so at camp load the chip asks the game-info function nothing for any other account (a
//   player who is not an editor, a visitor, the fixture preview) and the count starts at once for the editor. An owner `list` answered
//   `forbidden` (no longer an editor) forgets it.
// - When: at once, again when Game Info closes and when the page becomes visible again, and every 3 minutes while it is visible (the timer
//   never more often than every 2 minutes).
// - What: `newCount` from the owner `list` action (Task 22's M34, through `listFeedback`). A failed read keeps the count shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import { listFeedback } from './feedback-review';

export const NEW_FEEDBACK_POLL_MS = 3 * 60_000;
/** The fastest the count is ever read on a timer. */
export const NEW_FEEDBACK_MIN_POLL_MS = 2 * 60_000;
const EDITOR_KEY = 'cloudiator.feedback-editor';

/** Whether this browser saw `account` pass the Game Info editor probe. Storage that is off or throws reads as no. */
export function rememberedEditor(account: string): boolean {
  try { return window.localStorage.getItem(EDITOR_KEY) === account; } catch { return false; }
}
/** Remembers `account` as an editor, or forgets it (only when it is the one remembered). Never throws. */
export function rememberEditor(account: string, editor: boolean): void {
  try {
    if (editor) window.localStorage.setItem(EDITOR_KEY, account);
    else if (window.localStorage.getItem(EDITOR_KEY) === account) window.localStorage.removeItem(EDITOR_KEY);
  } catch { /* Site data blocked: the panel's probe still starts the count for this page. */ }
}

/** One read of the count: the number, `forbidden` (not an editor), or null (it failed: keep what is shown). */
export type NewFeedbackRead = () => Promise<number | 'forbidden' | null>;

/** Calls `onVisible` each time the page becomes visible again; answers how to stop. Without a document (a server render) it never does. */
function watchDocumentVisible(onVisible: () => void): () => void {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => undefined;
  const listener = () => { if (document.visibilityState === 'visible') onVisible(); };
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

/**
 * Reads the count now, on `refresh()`, when the page becomes visible again (final review, fix round 1), and every `intervalMs` (at least 2
 * minutes) while `visible()`. One read at a time: a refresh during a read reads once more after it. After `stop()` nothing is read and a read
 * still out reports nothing.
 */
export function pollNewFeedback(read: NewFeedbackRead, report: (result: number | 'forbidden') => void,
  { intervalMs = NEW_FEEDBACK_POLL_MS, visible = () => document.visibilityState === 'visible', watchVisible = watchDocumentVisible }:
  { intervalMs?: number; visible?: () => boolean; watchVisible?: (onVisible: () => void) => () => void } = {},
): { refresh(): void; stop(): void } {
  let stopped = false, reading = false, again = false;
  const tick = () => {
    if (stopped) return;
    if (reading) { again = true; return; }
    reading = true;
    read().then(result => { if (!stopped && result !== null) report(result); }, () => undefined).finally(() => {
      reading = false;
      if (again) { again = false; tick(); }
    });
  };
  const timer = setInterval(() => { if (visible()) tick(); }, Math.max(NEW_FEEDBACK_MIN_POLL_MS, intervalMs));
  const unwatch = watchVisible(tick);
  tick();
  return { refresh: tick, stop: () => { stopped = true; clearInterval(timer); unwatch(); } };
}

const readNewCount: NewFeedbackRead = async () => {
  const list = await listFeedback('new');
  return list.ok ? list.newCount : list.code === 'forbidden' ? 'forbidden' : null;
};

/** What the Game Info panel's editor probe found: an editor, not one (`forbidden`), or nothing certain (a failed read). */
export type EditorProbe = 'editor' | 'forbidden' | 'unknown';

/**
 * The corner chip's count for `account` (the signed-in account of the live game; null otherwise): 0 unless it is a known editor. `probed`
 * takes the Game Info panel's editor probe; `refresh` reads again (Game Info closed).
 */
export function useNewFeedback(account: string | null): { count: number; probed(result: EditorProbe): void; refresh(): void } {
  /** The account known as an editor in this browser (remembered, or the panel's probe). */
  const [editor, setEditor] = useState<string | null>(null);
  const [counted, setCounted] = useState<{ account: string; count: number } | null>(null);
  const poll = useRef<{ refresh(): void } | null>(null);
  // The remembered editor is read after mount: storage is the browser's, never the server render's.
  useEffect(() => { setEditor(account && rememberedEditor(account) ? account : null); }, [account]);
  useEffect(() => {
    if (!account || editor !== account) return;
    const watcher = pollNewFeedback(readNewCount, result => {
      if (result === 'forbidden') { rememberEditor(account, false); setEditor(null); setCounted(null); } else setCounted({ account, count: result });
    });
    poll.current = watcher;
    return () => { watcher.stop(); poll.current = null; };
  }, [account, editor]);
  const probed = useCallback((result: EditorProbe) => {
    if (!account || result === 'unknown') return;
    rememberEditor(account, result === 'editor');
    setEditor(result === 'editor' ? account : null);
    if (result === 'forbidden') setCounted(null);
  }, [account]);
  const refresh = useCallback(() => { poll.current?.refresh(); }, []);
  return { count: account && editor === account && counted?.account === account ? counted.count : 0, probed, refresh };
}
