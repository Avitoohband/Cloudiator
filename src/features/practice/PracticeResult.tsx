'use client';

// A practice fight's result over the camp (Patch 1.9 Task 18; additions spec section 3, "The result"): the replay viewer in a modal that looks
// like a scene over the camp (the same dialog, Back button and body), with the viewer's practice words and actions. It has no address of its
// own (a practice fight has no activity): the shell gives it one history entry, so a phone's Back closes it like any scene, and its Back
// button and Escape go back through that entry (`back.go`). The fighters' looks are the sides' own; the dummy, which has no gladiator, is
// drawn with its look under a stand-in id, so the scene draws it as it draws any gladiator (no new tint path). Each roll remounts the viewer.
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Appearance } from '@domain/appearance';
import type { BattleLog } from '@contracts/events';
import type { ReplayView } from '../../game/replay';
import { BattleReplay } from '../arena/BattleReplay';
import { practiceEyebrow } from '../bouts/bout-text';
import type { PracticeFight } from './practice';
import shell from '../shell/shell.module.css';

/** The id the dummy's look goes under: it has no gladiator, and the replay finds a fighter's look by its gladiator id. */
export const PRACTICE_DUMMY_ID = 'practice-dummy';

/** The fight's log with the dummy under its stand-in id, and the looks of both sides by those ids. */
function shown(fight: PracticeFight): { log: BattleLog; looks: Map<string, Appearance | null> } {
  const log: BattleLog = { ...fight.log, participants: fight.log.participants.map(p => (p.gladiatorId === null ? { ...p, gladiatorId: PRACTICE_DUMMY_ID } : p)) as unknown as BattleLog['participants'] };
  const looks = new Map<string, Appearance | null>();
  for (const side of [fight.you, fight.opponent]) looks.set(side.gladiatorId ?? PRACTICE_DUMMY_ID, side.look);
  return { log, looks };
}

export function PracticeResult({ fight, back, again, change }: {
  fight: PracticeFight;
  /** Where Back, Escape and the browser's Back go ("My gladiator"; a spar's "Camp"). */
  back: { label: string; go(): void };
  /** ⚔ Fight again: a new roll with the same builds. */
  again(): void;
  /** The end card's third action: "Change dummy" (a spar's way back). */
  change: { label: string; go(): void };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const backRef = useRef(back);
  useLayoutEffect(() => { backRef.current = back; });

  // Modal while mounted; Back takes the focus until the replay has loaded and ⏸ takes it (`takeFocus`). The shell puts the focus back.
  useLayoutEffect(() => {
    const element = dialog.current!;
    if (!element.open) element.showModal();
    backButton.current?.focus({ preventScroll: true });
    return () => { if (element.open) element.close(); };
  }, []);

  const { log, looks } = useMemo(() => shown(fight), [fight]);
  const view = useMemo<ReplayView>(() => ({
    kind: 'replay', selected: 0, summary: null,
    battles: [{ stage: { id: 'practice', kind: 'bout', revealedAtMs: 0, startedAtMs: 0, endsAtMs: log.durationMs, label: 'Practice' }, log }],
  }), [log]);
  const practice = useMemo(() => ({ eyebrow: practiceEyebrow(fight.kind), again, change }), [fight.kind, again, change]);

  return (
    <dialog ref={dialog} className={shell.scene} aria-label="Practice replay" data-practice-seed={fight.seed}
      // Escape goes back through the history entry; the dialog stays open until the shell unmounts it.
      onCancel={event => { event.preventDefault(); backRef.current.go(); }}>
      <div className={shell.sceneTop}>
        <button ref={backButton} type="button" className={shell.sceneBack} data-scene-back="" aria-label={`Back to ${back.label}`} onClick={() => back.go()}>
          <span aria-hidden="true">←</span> {back.label}
        </button>
      </div>
      <div className={shell.sceneBody}>
        <BattleReplay key={fight.seed} view={view} headingLevel={2} viewerId={null} looks={{ known: looks }} takeFocus practice={practice} />
      </div>
    </dialog>
  );
}
