'use client';

// Practice fights in the camp shell (Patch 1.9 Task 18): the state `CampShell` keeps for them and the layer it renders. The dummy's setup is
// kept per owner while the page lives, so Change dummy (and the next ⚔ Practice fight) reopens the dialog as it was. ⚔ Fight runs the fight
// here, in the browser (`practiceFight`: nothing is sent or saved), and shows its result over the camp with one history entry of its own
// (the address stays the camp's): the browser's Back, the result's Back button and Escape all leave through that entry, so a phone's Back
// closes the fight instead of leaving the camp. Each entry carries a fresh mark, so an entry left by a reload, or reached with Forward
// after the fight was closed, opens nothing. When the dialog or the result closes, the focus goes back to ⚔ Practice fight.
// Task 19: ⚔ Spar a copy on a gladiator's card starts a spar at once (no dialog) with the same entry; its way back says Camp, its end card
// offers ← Camp instead of Change dummy, and the focus goes back to the card's ⚔ Spar a copy.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { OwnerState } from '@contracts/reads';
import { dummySide, ownSide, practiceFight, practiceSeed, presetSetup, type DummySetup, type PracticeFight, type PracticeSide } from './practice';
import { fightable } from './practice-setup';
import { PracticeDialog } from './PracticeDialog';
import { PracticeResult } from './PracticeResult';

/** Our mark on the result's history entry. */
const MARK = 'cloudiatorPractice';
const markOf = (state: unknown): unknown => (state && typeof state === 'object' ? (state as Record<string, unknown>)[MARK] : undefined);
/** What opened the fight, which takes the focus back: My gladiator's ⚔ Practice fight, or the card's ⚔ Spar a copy. */
const OPENER: Record<PracticeFight['kind'], string> = { dummy: '[data-practice-button]', spar: '[data-spar-button]' };
const focusOpener = (kind: PracticeFight['kind']) => document.querySelector<HTMLElement>(OPENER[kind])?.focus({ preventScroll: true });

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
  /** ⚔ Spar a copy: a new fight with the owner's current build against a card's copy. */
  spar(copy: PracticeSide): void;
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
  /** The kind of the last fight shown: its opener takes the focus back. */
  const opener = useRef<PracticeFight['kind']>('dummy');
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
  const cancel = useCallback(() => { opener.current = 'dummy'; setDialogOpen(false); setFocusRequest(n => n + 1); }, []);

  /** Shows a new fight over the camp in a history entry of its own (none while one is shown). */
  const begin = useCallback((kind: PracticeFight['kind'], opponent: () => PracticeSide) => {
    const current = ownerRef.current;
    if (!current || token.current !== null) return;
    let next: PracticeFight;
    try { next = practiceFight(kind, ownSide(current), opponent()); } catch { return; }
    token.current = practiceSeed();
    leaving.current = false;
    opener.current = kind;
    window.history.pushState({ [MARK]: token.current }, '');
    setDialogOpen(false);
    setFight(next);
  }, []);
  const start = useCallback(() => {
    if (setup && fightable(setup)) begin('dummy', () => dummySide(setup));
  }, [setup, begin]);
  const spar = useCallback((copy: PracticeSide) => begin('spar', () => copy), [begin]);
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
  useEffect(() => { if (focusRequest) focusOpener(opener.current); }, [focusRequest]);
  // Another owner (a sign-out, another account): nothing of the last one's practice stays open.
  const shownFor = useRef(ownerId);
  useEffect(() => {
    if (shownFor.current === ownerId) return;
    shownFor.current = ownerId;
    setDialogOpen(false);
    reopen.current = false;
    close();
  }, [ownerId, close]);

  // A dummy goes back to My gladiator, and its end card offers Change dummy; a spar goes back to the camp (its card), both ways.
  const sparring = fight?.kind === 'spar';
  const back = useMemo(() => ({ label: sparring ? 'Camp' : 'My gladiator', go: close }), [sparring, close]);
  const change = useMemo(() => (sparring ? { label: '← Camp', go: close } : { label: 'Change dummy', go: () => { reopen.current = true; close(); } }), [sparring, close]);
  return { setup, dialogOpen, fight, open, edit, cancel, start, spar, again, back, change };
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
