'use client';

import { useEffect, useRef, useState } from 'react';
import type { ActivityChoice, GameCommand, Phase } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { nextPhaseStart } from '@domain/clock';
import { RULES_V1 } from '@domain/rules-v1';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';

const phases = ['morning', 'afternoon', 'evening'] as const;
const choiceKey = (choice: ActivityChoice) => choice.kind === 'expedition' ? `expedition:${choice.expeditionId}` : choice.kind;
type Edit = Extract<GameCommand, { kind: 'edit-schedule' }>;
const SLOT_MS = RULES_V1.clock.slotMs;
/** How often the panel checks the shared clock for a slot boundary while the tab is visible. */
const TICK_MS = 1000;

/**
 * The repeating schedule. The estimated next start of each phase comes from the shared display clock (estimated server
 * time), and follows it: past a slot boundary, or when the clock is held or moved, the estimates move with it, so the
 * panel never shows a start that has already passed (the Task 6 stale-clock gate).
 */
export function SchedulePanel({ owner, gateway, refresh, clock }: { owner: OwnerState; gateway: GameGateway; refresh(): Promise<void>; clock: DisplayClock }) {
  const [draft, setDraft] = useState(owner.schedule);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The slot the shared clock is in; the estimates depend on nothing else. Null until mounted. */
  const [slot, setSlot] = useState<number | null>(null);
  const sending = useRef(false), mounted = useRef(false);
  const attempt = useRef<Edit | null>(null);
  const draftVersion = useRef(owner.scheduleVersion);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const update = () => setSlot(Math.floor(clock.now() / SLOT_MS));
    update();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') update(); }, TICK_MS);
    const off = clock.subscribe(update);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); off(); document.removeEventListener('visibilitychange', update); };
  }, [clock]);
  useEffect(() => {
    if (draftVersion.current !== owner.scheduleVersion) {
      draftVersion.current = owner.scheduleVersion; setDraft(owner.schedule); attempt.current = null;
    }
  }, [owner.scheduleVersion, owner.schedule]);
  async function save(phase: Phase) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(''); setMessage('');
    const command = attempt.current?.phase === phase ? attempt.current : {
      kind: 'edit-schedule' as const, operationId: crypto.randomUUID(), expectedVersion: owner.scheduleVersion, phase, choice: draft[phase],
    };
    attempt.current = command;
    try {
      const result = await gateway.command<{ effectiveAtMs: number }>(command);
      if (!mounted.current) return;
      if (result.ok) {
        await refresh();
        if (mounted.current) { attempt.current = null; setMessage(`Effective ${new Date(result.value.effectiveAtMs).toLocaleString()} for ${phase} and future occurrences.`); }
      } else {
        setError(result.code === 'processing' ? 'The world is processing previous results. Retry shortly.'
          : result.code === 'conflict' ? 'Your schedule changed. The latest plan has been loaded; review and save again.'
            : result.code === 'unavailable' ? 'This change could not be confirmed. Retry to confirm the same request.' : `Schedule change rejected: ${result.code}.`);
        if (!['processing', 'unavailable', 'rate-limited'].includes(result.code)) attempt.current = null;
        if (result.code === 'conflict') await refresh();
      }
    } catch { if (mounted.current) setError('This change could not be confirmed. Retry to confirm the same request.'); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="planning-form">
    <h2>Repeating schedule</h2>
    <p className="muted">Edits apply to the next occurrence that has not started. Your current activity continues.</p>
    <div className="schedule-grid">{phases.map((phase, index) => <article className={`schedule-slot slot-${index}`} key={phase}>
      <h3>{phase}</h3>
      <label htmlFor={`schedule-${phase}`}>{phase} activity</label>
      <select id={`schedule-${phase}`} value={choiceKey(draft[phase])} disabled={busy} onChange={event => {
        const value = event.target.value;
        const choice: ActivityChoice = value.startsWith('expedition:') ? { kind: 'expedition', expeditionId: value.split(':')[1] as 'woodland' | 'outpost' | 'mountain' }
          : { kind: value as 'rest' | 'training' | 'arena' };
        attempt.current = null; setDraft({ ...draft, [phase]: choice }); setError(''); setMessage('');
      }}>
        <option value="training">Training</option><option value="rest">Rest</option><option value="arena">Arena</option>
        {Object.values(CATALOG_V1.expeditions).map(entry => <option key={entry.id} value={`expedition:${entry.id}`} disabled={owner.progression.level < entry.requiredLevel}>{entry.name} · Level {entry.requiredLevel}</option>)}
      </select>
      {slot !== null && <p>Estimated next start: {new Date(nextPhaseStart(phase, slot * SLOT_MS)).toLocaleString()}</p>}
      <button onClick={() => void save(phase)} disabled={busy}>Save {phase}</button>
    </article>)}</div>
    <p className="muted">The server confirms the effective time when you save.</p>
    {message && <p role="status">{message}</p>}{error && <p role="alert" className="form-error">{error}</p>}
  </div>;
}
