'use client';

// Practice fights in the camp shell (Patch 1.9 Task 18): the state `CampShell` keeps for them and the layer it renders. The dummy's setup is
// kept per owner while the page lives, so Change dummy (and the next ⚔ Practice fight) reopens the dialog as it was. ⚔ Fight runs the fight
// here, in the browser (`practiceFight`: nothing is sent or saved), and shows its result over the camp with one history entry of its own
// (the address stays the camp's): the browser's Back, the result's Back button and Escape all leave through that entry, so a phone's Back
// closes the fight instead of leaving the camp. Each entry carries a fresh mark, so an entry left by a reload, or reached with Forward
// after the fight was closed, opens nothing. When the dialog or the result closes, the focus goes back to ⚔ Practice fight.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { OwnerState } from '@contracts/reads';
import { dummySide, ownSide, practiceFight, practiceSeed, presetSetup, type DummySetup, type PracticeFight } from './practice';
import { fightable } from './practice-setup';
import { PracticeDialog } from './PracticeDialog';
import { PracticeResult } from './PracticeResult';

/** Our mark on the result's history entry. */
const MARK = 'cloudiatorPractice';
const markOf = (state: unknown): unknown => (state && typeof state === 'object' ? (state as Record<string, unknown>)[MARK] : undefined);
/** My gladiator's ⚔ Practice fight, which opened the dialog. */
const focusPracticeButton = () => document.querySelector<HTMLElement>('[data-practice-button]')?.focus({ preventScroll: true });

export type PracticeState = {
  /** The dummy as last set up for this owner (null before the first opening). */
  setup: DummySetup | null;
  dialogOpen: boolean;
  /** The fight shown over the camp, or null. */
  fight: PracticeFight | null;
  /** My gladiator's ⚔ Practice fight. */
  open(): void;
  edit(setup: DummySetup): void;
  cancel(): void;
  /** ⚔ Fight: a new fight with the owner's current build; nothing happens while the dummy cannot fight. */
  start(): void;
  again(): void;
  back: { label: string; go(): void };
  change: { label: string; go(): void };
};

export function usePractice(owner: OwnerState | null): PracticeState {
  const ownerId = owner?.gladiatorId ?? null;
  const ownerRef = useRef(owner);
  useLayoutEffect(() => { ownerRef.current = owner; });
  const [saved, setSaved] = useState<{ gladiatorId: string; setup: DummySetup } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [fight, setFight] = useState<PracticeFight | null>(null);
  /** The mark of the history entry the shown fight owns (null: none shown). */
  const token = useRef<string | null>(null);
  /** A Back through that entry is on its way: another would leave the camp. */
  const leaving = useRef(false);
  /** Change dummy: the dialog opens when the entry has been left. */
  const reopen = useRef(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const setup = saved && saved.gladiatorId === ownerId ? saved.setup : null;

  const open = useCallback(() => {
    const current = ownerRef.current;
    if (!current) return;
    // The first opening for an owner: Balanced at the owner's level.
    setSaved(kept => (kept && kept.gladiatorId === current.gladiatorId ? kept : { gladiatorId: current.gladiatorId, setup: presetSetup('balanced', current.progression.level) }));
    setDialogOpen(true);
  }, []);
  const edit = useCallback((next: DummySetup) => {
    const current = ownerRef.current;
    if (current) setSaved({ gladiatorId: current.gladiatorId, setup: next });
  }, []);
  const cancel = useCallback(() => { setDialogOpen(false); setFocusRequest(n => n + 1); }, []);

  const start = useCallback(() => {
    const current = ownerRef.current;
    if (!current || !setup || !fightable(setup) || token.current !== null) return;
    let next: PracticeFight;
    try { next = practiceFight('dummy', ownSide(current), dummySide(setup)); } catch { return; }
    token.current = practiceSeed();
    leaving.current = false;
    window.history.pushState({ [MARK]: token.current }, '');
    setDialogOpen(false);
    setFight(next);
  }, [setup]);
  const fightRef = useRef(fight);
  useLayoutEffect(() => { fightRef.current = fight; });
  const again = useCallback(() => {
    const shown = fightRef.current;
    if (shown && token.current !== null && !leaving.current) setFight(practiceFight(shown.kind, shown.you, shown.opponent));
  }, []);

  /** Leaves the fight's entry (its popstate closes the fight); without one, closes it at once. */
  const close = useCallback(() => {
    if (token.current === null || leaving.current) return;
    if (markOf(window.history.state) === token.current) {
      leaving.current = true;
      window.history.back();
      return;
    }
    token.current = null;
    setFight(null);
    if (reopen.current) { reopen.current = false; setDialogOpen(true); } else setFocusRequest(n => n + 1);
  }, []);
  useEffect(() => {
    const onPop = () => {
      leaving.current = false;
      if (token.current === null || markOf(window.history.state) === token.current) return;
      token.current = null;
      setFight(null);
      if (reopen.current) { reopen.current = false; setDialogOpen(true); } else setFocusRequest(n => n + 1);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // After the dialog or the result has gone, the focus goes back to the button that opened the dialog.
  useEffect(() => { if (focusRequest) focusPracticeButton(); }, [focusRequest]);
  // Another owner (a sign-out, another account): nothing of the last one's practice stays open.
  const shownFor = useRef(ownerId);
  useEffect(() => {
    if (shownFor.current === ownerId) return;
    shownFor.current = ownerId;
    setDialogOpen(false);
    reopen.current = false;
    close();
  }, [ownerId, close]);

  const back = useMemo(() => ({ label: 'My gladiator', go: close }), [close]);
  const change = useMemo(() => ({ label: 'Change dummy', go: () => { reopen.current = true; close(); } }), [close]);
  return { setup, dialogOpen, fight, open, edit, cancel, start, again, back, change };
}

/** The dialog over My gladiator and the fight over the camp. */
export function PracticeLayer({ practice, owner }: { practice: PracticeState; owner: OwnerState | null }) {
  return <>
    {practice.dialogOpen && owner && practice.setup && (
      <PracticeDialog key={owner.gladiatorId} owner={owner} setup={practice.setup} onChange={practice.edit} onFight={practice.start} onClose={practice.cancel} />
    )}
    {practice.fight && <PracticeResult fight={practice.fight} back={practice.back} again={practice.again} change={practice.change} />}
  </>;
}
