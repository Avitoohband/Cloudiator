'use client';

// Patch 1.9, Task 11: the talking NPC's pixel speech bubble over the camp (the approved mockup's markup and look): its name,
// the line and four dots for which of its four lines it is, with a stepped tail pointing at the NPC. The camp scene tells it
// where the NPC is every frame (`TalkFrame`), so it follows a walking NPC; it sits over the name or head, inside the view, and
// under the feet when the bar along the top leaves no room, clear of a pinned menu rail (`insets`). It fades out in 0.4 s when
// the scene says the line's time is up. It takes no clicks: a click on it reaches the camp underneath (a stall's awning).
// Camp characters cannot take the keyboard, so each line is also announced in a polite live region; the bubble itself is
// drawn for the eyes only. The scene answers Escape and clicks elsewhere (src/game/camp-scene.ts).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type { TalkFrame } from './camp-scene';
import { placeTalkBubble, type TalkMargin } from './npc-talk';
import styles from './GameViewport.module.css';

type Shown = Pick<TalkFrame, 'seq' | 'npcId' | 'name' | 'line' | 'index' | 'count' | 'fading'>;
/** What the page keeps covered at the view's sides and bottom (a pinned menu rail), in CSS px from each edge. */
export type TalkInsets = Omit<TalkMargin, 'top'>;
const NO_INSETS: TalkInsets = { left: 8, right: 8, bottom: 8 };

/** The bar along the top of the full-screen camp (the corner chip, and on a phone the notice under it), kept clear. */
const hudTop = (width: number) => (width <= 480 ? 92 : 60);

export function TalkBubble({ sink, hud, insets = NO_INSETS }: {
  /** Where the page hands the scene's frames: this component listens on it while mounted. */
  sink: MutableRefObject<((frame: TalkFrame | null) => void) | null>;
  /** The full-screen camp, with the corner chip along its top; a framed view keeps only a small margin. */
  hud: boolean;
  /** Kept clear at the sides and bottom: a pinned menu rail, measured by the page. */
  insets?: TalkInsets;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [said, setSaid] = useState('');
  const bubble = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  const frame = useRef<TalkFrame | null>(null);
  const current = useRef<Shown | null>(null);
  const placed = useRef('');

  /** Puts the bubble over the NPC from the last frame; only writes the style when it moved. */
  const place = useCallback(() => {
    const el = bubble.current, f = frame.current;
    const parent = el?.parentElement;
    if (!el || !f || !parent) return;
    const view = { width: parent.clientWidth, height: parent.clientHeight };
    const at = placeTalkBubble({ x: f.x, top: f.top, feet: f.feet }, { width: el.offsetWidth, height: el.offsetHeight }, view,
      { top: hud ? hudTop(view.width) : 8, left: insets.left, right: insets.right, bottom: insets.bottom });
    const left = Math.round(at.left), top = Math.round(at.top), tailAt = Math.round(at.tail);
    const key = `${left}|${top}|${tailAt}|${at.below}|${f.visible}`;
    if (key === placed.current) return;
    placed.current = key;
    el.style.transform = `translate(${left}px, ${top}px)`;
    el.style.visibility = f.visible ? '' : 'hidden';
    if (at.below) el.dataset.below = 'true'; else delete el.dataset.below;
    if (tail.current) tail.current.style.left = `${tailAt}px`;
  }, [hud, insets]);

  useEffect(() => {
    sink.current = next => {
      frame.current = next;
      if (!next) {
        if (current.current) { current.current = null; placed.current = ''; setShown(null); setSaid(''); }
        return;
      }
      const was = current.current;
      if (!was || was.seq !== next.seq || was.fading !== next.fading) {
        const line: Shown = { seq: next.seq, npcId: next.npcId, name: next.name, line: next.line, index: next.index, count: next.count, fading: next.fading };
        current.current = line;
        setShown(line);
        if (!was || was.seq !== next.seq) { placed.current = ''; setSaid(`${next.name}: ${next.line}`); }
      }
      place();
    };
    return () => { sink.current = null; };
  }, [sink, place]);

  // A new line changes the bubble's size, and a pinned rail its room: place it once it has rendered, before it paints.
  useLayoutEffect(() => { if (shown) { placed.current = ''; place(); } }, [shown, place]);

  return <>
    {shown && (
      <div ref={bubble} className={styles.bubble} data-testid="npc-bubble" data-npc={shown.npcId} data-fading={shown.fading ? 'true' : undefined} aria-hidden="true">
        <div className={styles.bubbleName} data-testid="npc-bubble-name">{shown.name}</div>
        <div className={styles.bubbleLine} data-testid="npc-bubble-line">{shown.line}</div>
        <div className={styles.bubbleDots}>
          {Array.from({ length: shown.count }, (_, i) => <i key={i} data-dot={i === shown.index ? 'on' : 'off'} />)}
        </div>
        <div ref={tail} className={styles.bubbleTail}>
          <svg width="14" height="8" viewBox="0 0 14 8" shapeRendering="crispEdges">
            <path d="M0 0h14v2h-2v2h-2v2h-2v2h-2v-2h-2v-2h-2v-2h-2z" fill="#1a1423" />
            <path d="M2 0h10v2h-2v2h-2v2h-2v-2h-2v-2h-2z" fill="#f4e8cb" />
          </svg>
        </div>
      </div>
    )}
    <p className={styles.talkLive} aria-live="polite" data-testid="npc-talk-live">{said}</p>
  </>;
}
