'use client';

// The corner chip, top right. A player sees their name, stamina, gold, renown and the time to the next slot boundary
// (on touch only the name and the countdown), and the chip opens a small menu: on touch the bar behind the name (the same
// items in one row, the stamina line over its bar), then the Clock switch (12/24-hour, Patch A), the patch this build is ("Patch 1.4",
// with "Patch history ›" for a player, and "Patch 1.5 is out" with Reload while the server is ahead; Patch A, "Patch numbers and the
// changelog") and "Sign out". A visitor's chip starts
// Google sign-in: the "G" mark and "Sign in with Google to join" ("Sign in to join" on touch). Signed in without a
// gladiator, it offers "Create your gladiator" beside the account button (Task 13.6). Names render as React text. A player also has the
// messages button left of the pill (Task 6): the chip shows one popover at a time, the account menu or the messages panel.
import { useEffect, useId, useRef, useState, type Ref } from 'react';
import type { OwnerState } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import type { Rules } from '@domain/types';
import { signOut, type SessionState } from '../../lib/api/session';
import { GoogleMark, SIGN_IN_NOT_STARTED, useGoogleSignIn } from '../auth/SignIn';
import type { DisplayClock } from '../../game/display-clock';
import { saveClockMode, useClockMode } from '../../lib/clock-setting';
import { PATCH, isBehind } from '../../lib/patch';
import { xpView } from '../character/xp-progress';
import type { Viewer } from '../character/useGameState';
import { GameInfoPanel } from '../game-info/GameInfoPanel';
import { useNewFeedback } from '../game-info/new-feedback';
import { CurrencyIcon } from '../shops/ShopArt';
import { MessagesButton } from '../messages/MessagesButton';
import { badgeText, type MessagesRequest, type MessagingActions } from '../messages/messages';
import type { NoticeTitles } from '../messages/TitleNotices';
import { ClockSwitch } from './ClockSwitch';
import { reloadPage } from './PatchNotice';
import type { MenuId } from './menus';
import styles from './shell.module.css';

const SLOT_MS = RULES_V1.clock.slotMs;
const TICK_MS = 1000;

/**
 * Whole seconds to the next slot boundary of the display clock, ticking while the tab is visible and `on` (the chip shows an owner).
 * The chip runs one for both of its countdowns, the one on the name and the one in the bar behind it, so the two never differ.
 */
function useSlotCountdown(clock: DisplayClock, on: boolean) {
  const read = () => Math.ceil((SLOT_MS - (((clock.now() % SLOT_MS) + SLOT_MS) % SLOT_MS)) / 1000);
  const [seconds, setSeconds] = useState(read);
  useEffect(() => {
    if (!on) return;
    const update = () => setSeconds(read());
    update();
    const off = clock.subscribe(update);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') update(); }, TICK_MS);
    return () => { off(); window.clearInterval(timer); };
  }, [clock, on]);
  return seconds;
}

/**
 * The thin XP line along the foot of the chip, with no label (Patch 1.9 Task 10; the My gladiator panel says what it is): the XP into the level,
 * and the next expedition's XP as the same hatched ghost segment (gold where it can finish the level). Decorative; the panel's bar is the readout.
 */
function XpLine({ owner, rules, nowMs, location }: { owner: OwnerState; rules: Rules; nowMs: number; location: string | null }) {
  const view = xpView(owner, rules, nowMs, location);
  return <span className={styles.chipXp} aria-hidden="true" data-testid="chip-xp">
    <i className={styles.chipXpFill} data-testid="chip-xp-fill" style={{ width: `${view.fill * 100}%` }} />
    {view.ghost > 0 && <i className={`${styles.chipXpGhost} ${view.crosses ? styles.chipXpUp : ''}`} data-testid="chip-xp-ghost" data-crosses={view.crosses || undefined} style={{ width: `${view.ghost * 100}%` }} />}
  </span>;
}

function Countdown({ seconds, testId = 'chip-countdown' }: { seconds: number; testId?: string }) {
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <span title="Next slot starts in">
    <span aria-hidden="true">⏱ </span><span data-testid={testId} aria-hidden="true">{text}</span>
    <span className={styles.sr}>Next slot in {Math.ceil(seconds / 60)} min</span>
  </span>;
}

export function CornerChip({ viewer, session, owner, fixture, previewAs, clock, messaging, messagesRequest, latestPatch = null, onChangeLook, onOpenMenu, onCreate, titles, rules = RULES_V2, location = null,
  hideVisitorJoin = false, visitorJoinRef, onOpenGameInfo }: {
  viewer: Viewer;
  session: SessionState;
  owner: OwnerState | null;
  fixture: boolean;
  previewAs?: 'visitor' | 'player';
  clock: DisplayClock;
  /** The messages button's lists and marks (the shell's); a player without it, or a visitor, has no messages button. */
  messaging?: MessagingActions;
  /** Opens the messages panel on Notifications, or (patch 1.9) on My feedback. */
  messagesRequest?: Pick<MessagesRequest, 'tab' | 'n' | 'row'> | null;
  /** The server's newest patch (the sync's): ahead of this build, the menu offers Reload. */
  latestPatch?: string | null;
  /** Opens the change-look dialog from the look note's Change look button (the messages panel closes first; the shell owns the dialog). */
  onChangeLook(): void;
  onOpenMenu(id: MenuId): void;
  hideVisitorJoin?: boolean;
  visitorJoinRef?: Ref<HTMLButtonElement>;
  onOpenGameInfo?(): void;
  /** Opens the "Create your gladiator" dialog (signed in without a gladiator). */
  onCreate(): void;
  /** The owner's titles and the Wear and "Choose a title" actions for the Notifications tab (patch 1.7; the shell's). */
  titles?: NoticeTitles;
  /** The active rules, for the XP line's next expedition (the shell's `rules`). */
  rules?: Rules;
  /** The owner's world actor's location, which names a running expedition (null while the world is not loaded). */
  location?: string | null;
}) {
  // One popover at a time under the corner controls.
  const [popover, setPopover] = useState<'account' | 'messages' | 'game-info' | null>(null);
  const [infoDirty, setInfoDirty] = useState(false);
  // The messages panel opened from the account menu's "Patch history ›" opens on the history, and gives the focus back to the account
  // button when it closes; opened from its own button, it opens on the lists and gives it back there.
  const [history, setHistory] = useState<{ patch: string | null } | undefined>(undefined);
  const [requestedTab, setRequestedTab] = useState<typeof messagesRequest>(null);
  const handledRequest = useRef<number | null>(null);
  const open = popover === 'account';
  const [signOutError, setSignOutError] = useState(false);
  const google = useGoogleSignIn();
  const chip = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const messagesButton = useRef<HTMLButtonElement>(null);
  const infoButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const messagesId = useId();
  const infoId = useId();
  const staminaLineId = useId();
  const clockMode = useClockMode();
  const signedIn = !fixture && session.status === 'signed-in';
  const account = viewer === 'player' || signedIn;
  const editorAccount = signedIn ? session.userId : null;
  // Final fix wave (notes.md Q5): an editor's count of New feedback on Game Info, read again whenever Game Info closes.
  const newFeedback = useNewFeedback(editorAccount);
  const infoWasOpen = useRef(false);
  useEffect(() => {
    if (infoWasOpen.current && popover !== 'game-info') newFeedback.refresh();
    infoWasOpen.current = popover === 'game-info';
  }, [popover, newFeedback.refresh]);
  // One ticker for the name's countdown and the bar's (the owner's only).
  const seconds = useSlotCountdown(clock, account && owner !== null);

  // Escape (before the shell's own handler, which then leaves an open panel alone) and a press elsewhere close it. While
  // a modal dialog is open (the creation dialog can open over this menu), Escape is the dialog's (13.6 review I1). Escape and
  // the panel's own Close give the focus back to the button that opened it; a press elsewhere takes it where it went.
  const closeMessages = () => { setPopover(null); (history ? toggle : messagesButton).current?.focus(); };
  const allowDiscard = () => !infoDirty || window.confirm('Discard unsaved Game Info edits?');
  const closeInfo = () => { if (allowDiscard()) { setPopover(null); infoButton.current?.focus(); } };
  useEffect(() => {
    if (!infoDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [infoDirty]);
  useEffect(() => {
    if (popover === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog:modal')) return;
      event.preventDefault();
      if (infoDirty) return;
      setPopover(null);
      const trigger = popover === 'game-info' ? infoButton : popover === 'messages' && !history ? messagesButton : toggle;
      trigger.current?.focus();
    };
    const onPress = (event: PointerEvent) => { if (!infoDirty && !chip.current?.contains(event.target as Node)) setPopover(null); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPress, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onPress, true); };
  }, [popover, history, infoDirty]);
  // The messages button belongs to a player with a gladiator whose owner read carries an inbox.
  const inbox = owner?.inbox;
  const showMessages = !!(messaging && inbox);
  useEffect(() => {
    if ((popover === 'account' && !account) || (popover === 'messages' && (!account || !showMessages))) setPopover(null);
  }, [account, popover, showMessages]);

  // Do not consume Back while the owner's inbox is still loading. The shell scopes requests to its owner lifecycle.
  useEffect(() => {
    if (infoDirty || !messagesRequest || handledRequest.current === messagesRequest.n || !account || !showMessages) return;
    handledRequest.current = messagesRequest.n;
    setHistory(undefined);
    setRequestedTab(messagesRequest);
    setPopover('messages');
  }, [messagesRequest, account, showMessages, infoDirty]);

  const infoBadge = badgeText(newFeedback.count);
  const infoToggle = <button ref={infoButton} type="button" className={styles.infoToggle}
    aria-expanded={popover === 'game-info'} aria-controls={popover === 'game-info' ? infoId : undefined} aria-haspopup="dialog"
    aria-label={infoBadge ? `Game Info, ${newFeedback.count} new feedback` : undefined}
    tabIndex={open ? -1 : undefined}
    onClick={() => {
      if (popover === 'game-info') closeInfo();
      else { onOpenGameInfo?.(); setPopover('game-info'); }
    }}>
    Game Info{infoBadge && <span className={styles.infoCount} data-testid="info-feedback-badge" aria-hidden="true">{infoBadge}</span>}
  </button>;
  const infoPanel = popover === 'game-info' && <GameInfoPanel key={editorAccount ?? 'reader'} id={infoId} onClose={closeInfo} fixture={fixture} editorAccount={editorAccount}
    onDirty={setInfoDirty} allowDiscard={allowDiscard} onEditorProbe={newFeedback.probed}
    update={latestPatch && isBehind(latestPatch) ? { number: latestPatch, reload: reloadPage } : undefined} />;

  if (!account) {
    const note = fixture ? (previewAs === 'visitor' ? null : viewer === 'unavailable' ? 'The fixture preview could not be loaded.' : 'Loading local preview…')
      : session.status === 'loading' ? 'Checking your session…' : null;
    // Where sign-in cannot start (the fixture preview, or a build without it configured), My gladiator says why.
    const live = !fixture && session.status === 'signed-out';
    return <div ref={chip} className={styles.chip} data-testid="corner-chip" data-popover={popover ?? undefined}>
      <div className={styles.chipRow}>{note ? <p className={styles.chipNote} role="status">{note}</p>
        : !hideVisitorJoin && <button ref={visitorJoinRef} type="button" className={styles.join} disabled={google.busy} onClick={() => (live ? void google.begin() : onOpenMenu('gladiator'))}>
          <GoogleMark />
          {google.busy ? <span>Opening Google…</span>
            : <><span className={styles.wide}>Sign in with Google to join</span><span className={styles.narrow}>Sign in to join</span></>}
        </button>}{infoToggle}</div>
      {google.failed && !hideVisitorJoin && <p className={styles.chipAlert} role="alert">{SIGN_IN_NOT_STARTED}</p>}
      {infoPanel}
    </div>;
  }
  return (
    <div ref={chip} className={styles.chip} data-testid="corner-chip" data-popover={popover ?? undefined}>
      <div className={styles.chipRow}>
        {viewer === 'no-gladiator' && <button type="button" className={styles.create} data-create-offer="" onClick={() => { if (allowDiscard()) { setPopover(null); onCreate(); } }}>Create your gladiator</button>}
        {messaging && inbox && <MessagesButton key={requestedTab?.n ?? 'ordinary'} initialTab={requestedTab?.tab} initialRow={requestedTab?.row} inbox={inbox} {...messaging}
          watch={messaging.watch ? { kept: messaging.watch.kept, open: note => { setPopover(null); messaging.watch!.open(note); } } : undefined} changeLook={onChangeLook} open={popover === 'messages'} panelId={messagesId}
          onToggle={() => { if (allowDiscard()) { setRequestedTab(null); setHistory(undefined); setPopover(value => (value === 'messages' ? null : 'messages')); } }} onClose={closeMessages} buttonRef={messagesButton}
          history={history} latestPatch={latestPatch} titles={titles} />}
        <button ref={toggle} type="button" className={styles.chipButton} data-account-button="" aria-expanded={open} aria-controls={menuId}
          onClick={() => { if (allowDiscard()) { setHistory(undefined); setPopover(value => (value === 'account' ? null : 'account')); } }}>
          {owner ? <>
            <b data-testid="chip-name">{owner.name}</b>
            <span className={`${styles.wide} ${styles.chipSep}`} aria-hidden="true">|</span>
            <span className={styles.wide} data-testid="chip-stamina" title="Stamina"><span aria-hidden="true">⚡ </span><span className={styles.sr}>Stamina </span>{owner.stamina.current} / {owner.stamina.maximum}</span>
            <span className={styles.wide} data-testid="chip-money" title="Gold"><span aria-hidden="true">💰 </span><span className={styles.sr}>Gold </span>{owner.wallets.money}</span>
            <span className={styles.wide} data-testid="chip-renown" title="Renown"><CurrencyIcon currency="renown" size={14} /> <span className={styles.sr}>Renown </span>{owner.wallets.renown}</span>
            <span className={styles.chipSep} aria-hidden="true">|</span>
            <Countdown seconds={seconds} />
            <XpLine owner={owner} rules={rules} nowMs={clock.now()} location={location} />
          </> : <span>Signed in</span>}
        </button>
        {infoToggle}
      </div>
      {infoPanel}
      {open && (
        <div id={menuId} className={styles.chipMenu} role="group" aria-label="Account">
          {owner && <>
            {/* The bar behind the name (touch layout only, as the chip's own bar is hidden there): the PC bar's items in its order. */}
            <div className={styles.barRow}>
              <span data-testid="bar-stamina"><span aria-hidden="true">⚡ </span><span className={styles.sr}>Stamina </span>{owner.stamina.current} / {owner.stamina.maximum}</span>
              <span data-testid="bar-money"><span aria-hidden="true">💰 </span><span className={styles.sr}>Gold </span>{owner.wallets.money}</span>
              <span data-testid="bar-renown"><CurrencyIcon currency="renown" size={14} /> <span className={styles.sr}>Renown </span>{owner.wallets.renown}</span>
              <span data-testid="bar-countdown"><Countdown seconds={seconds} testId="bar-countdown-time" /></span>
            </div>
            <div className={styles.staminaLine}>
              <span id={staminaLineId}>{`Stamina ${owner.stamina.current} of ${owner.stamina.maximum} · a Rest refills it`}</span>
              <progress className={styles.staminaBar} aria-labelledby={staminaLineId} value={owner.stamina.current} max={owner.stamina.maximum} />
            </div>
          </>}
          <ClockSwitch mode={clockMode} onChange={saveClockMode} />
          <div className={styles.patchRow} data-patch-row="">
            <span>Patch <b>{PATCH}</b></span>
            {/* An account without a gladiator has no messages panel, so no history to open. */}
            {showMessages && <button type="button" className={styles.patchLink} onClick={() => { setRequestedTab(null); setHistory({ patch: null }); setPopover('messages'); }}>
              Patch history<span aria-hidden="true"> ›</span>
            </button>}
          </div>
          {isBehind(latestPatch) && <div className={styles.behindRow} data-patch-behind="">
            <span>Patch {latestPatch} is out</span>
            <button type="button" className={styles.reload} onClick={reloadPage}>Reload</button>
          </div>}
          {signedIn ? <button type="button" onClick={() => {
            setSignOutError(false);
            void signOut().then(() => setPopover(null), () => setSignOutError(true));
          }}>Sign out</button> : <p>Local preview: no account is signed in.</p>}
          {signOutError && <p role="alert">Sign-out could not be completed. Please try again.</p>}
        </div>
      )}
    </div>
  );
}
