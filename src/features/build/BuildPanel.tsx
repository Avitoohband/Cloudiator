'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Attributes, ClassId, EquipmentSlot, GameCommand, Stance } from '@contracts/commands';
import type { BuildView, ItemInstance, OwnerState } from '@contracts/reads';
import type { BuildInput } from '@domain/types';
import { buildChangeFee, validateBuild } from '@domain/build';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V1 } from '@domain/rules-v1';
import { deriveStats, preserveStamina } from '@domain/stats';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import { slotTimeText } from '../schedule/slot-time';
import { useMinuteNow } from '../schedule/use-minute-now';
import { useOutcomeFocus } from '../shell/focus-lost';
import { buildRefusal } from './build-refusal';

const attributes = ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const;
const slots: EquipmentSlot[] = ['weapon', 'offHand', 'head', 'body', 'feet'];
const input = (build: BuildView): BuildInput => ({ classId: build.classId, stance: build.stance, allocation: { ...build.allocations }, equipment: { ...build.equipment } });
/** Which fields a build validation reason names (Task 23.5): the attribute points, or the equipment. */
const EQUIPMENT_REASONS = new Set(['item', 'slot', 'level', 'reserved', 'two-handed']);
/** An attribute value the build rules accept: a whole number from 0 to the cap (`validateBuild`'s bounded integer). */
const wholePoints = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= RULES_V1.attributes.maximumPoints;
type BuildCommand = Extract<GameCommand, { kind: 'queue-build' | 'cancel-build' }>;
function BuildSummary({ build, inventory }: { build: BuildView; inventory: ItemInstance[] }) {
  return <><p>{build.classId} · {build.stance}</p><dl>{attributes.map(key => <div key={key}><dt>{key}</dt><dd>{build.allocations[key]}</dd></div>)}
    {slots.map(slot => { const item = inventory.find(item => item.id === build.equipment[slot]); return <div key={slot}><dt>{slot}</dt><dd>{item ? CATALOG_V1.items[item.catalogId]?.name ?? item.catalogId : 'None'}</dd></div>; })}</dl></>;
}

export function BuildPanel({ owner, gateway, refresh, clock }: { owner: OwnerState; gateway: GameGateway; refresh(): Promise<void>; clock: DisplayClock }) {
  /** The shared display clock's time to the minute: the pending build's effective time is shown against it (Task 23.10). */
  const nowMs = useMinuteNow(clock);
  const [draft, setDraft] = useState(() => input(owner.pendingBuild?.build ?? owner.currentBuild));
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const attempt = useRef<BuildCommand | null>(null), sending = useRef(false), mounted = useRef(false);
  const draftVersion = useRef(owner.buildVersion);
  const reviewId = useId();
  // A command sent by keyboard whose control went away (Cancel pending build removes its section) gives the focus to its
  // outcome, never to <body>; a pointer command moves nothing (Task 23.5, `useOutcomeFocus`).
  const { outcome, begin, end, target } = useOutcomeFocus(busy);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (draftVersion.current !== owner.buildVersion) {
      draftVersion.current = owner.buildVersion;
      setDraft(input(owner.pendingBuild?.build ?? owner.currentBuild)); attempt.current = null;
    }
  }, [owner.buildVersion, owner.currentBuild, owner.pendingBuild]);
  const valid = validateBuild(draft, owner.inventory, owner.progression.earnedAttributePoints, owner.progression.level);
  // The review message names its fields: they are marked invalid and described by it (Task 23.5). More points than earned
  // marks every attribute; an attribute that is not a whole number in range (`invalid-input`) marks that one alone, or every
  // attribute when only their sum is over the cap.
  const notWhole = attributes.filter(key => !wholePoints(draft.allocation[key]));
  const pointsInvalid = (key: typeof attributes[number]) => !valid.ok
    && (valid.reason === 'points' || (valid.reason === 'invalid-input' && (notWhole.length ? notWhole.includes(key)
      : attributes.reduce((sum, k) => sum + draft.allocation[k], 0) > RULES_V1.attributes.maximumPoints)));
  const equipmentInvalid = !valid.ok && EQUIPMENT_REASONS.has(valid.reason);
  const reviewed = (invalid: boolean) => (invalid ? { 'aria-invalid': true, 'aria-describedby': reviewId } : {});
  const stats = valid.ok ? deriveStats(valid.snapshot, RULES_V1) : null;
  const fee = valid.ok ? buildChangeFee(input(owner.currentBuild), draft) : null;
  const weapon = owner.inventory.find(item => item.id === draft.equipment.weapon);
  const twoHands = weapon ? CATALOG_V1.items[weapon.catalogId]?.hands === 2 : false;
  /** The pending build's effective time, or '' when it cannot be shown: its line is then left out. */
  const effective = owner.pendingBuild ? slotTimeText(owner.pendingBuild.effectiveSlotIndex * RULES_V1.clock.slotMs, nowMs) : '';
  function update(next: BuildInput) { attempt.current = null; setDraft(next); setError(''); setMessage(''); }
  async function send(kind: BuildCommand['kind']) {
    if (sending.current || (kind === 'queue-build' && !valid.ok)) return;
    begin();
    sending.current = true; setBusy(true); setError(''); setMessage('');
    const command: BuildCommand = attempt.current?.kind === kind ? attempt.current : kind === 'queue-build'
      ? { kind, operationId: crypto.randomUUID(), expectedVersion: owner.buildVersion, ...structuredClone(draft) }
      : { kind, operationId: crypto.randomUUID(), expectedVersion: owner.buildVersion };
    attempt.current = command;
    try {
      const result = await gateway.command(command);
      if (!mounted.current) return;
      if (result.ok) {
        await refresh();
        if (mounted.current) { attempt.current = null; setMessage(kind === 'queue-build' ? 'Build queued. Your current build continues until the boundary.' : 'Pending build canceled. Reservations released.'); }
      } else {
        setError(buildRefusal(result.code));
        if (!['processing', 'unavailable', 'rate-limited'].includes(result.code)) attempt.current = null;
        if (result.code === 'conflict' || result.code === 'invalid') await refresh();
      }
    } catch { if (mounted.current) setError('This change could not be confirmed. Retry to confirm the same request.'); }
    finally { sending.current = false; end(); if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void send('queue-build'); }
  return <div className="planning-form">
    <div className="build-comparison">
      <section data-testid="current-build"><h2>Current build</h2><BuildSummary build={owner.currentBuild} inventory={owner.inventory} /></section>
      {owner.pendingBuild && <section data-testid="pending-build"><h2>Pending build</h2><BuildSummary build={owner.pendingBuild.build} inventory={owner.inventory} />
        {effective && <p>Effective {effective}</p>}
        <p>Reserved: {owner.pendingBuild.reservedMoney} money · {owner.pendingBuild.reservedItemIds.length} equipment items</p>
        <button disabled={busy} onClick={() => void send('cancel-build')}>Cancel pending build</button>
      </section>}
    </div>
    <form onSubmit={submit}>
      <h3>{owner.pendingBuild ? 'Revise pending build' : 'Plan a build'}</h3>
      <fieldset disabled={busy}><legend>Class and stance</legend>
        <label htmlFor="build-class">Class</label><select id="build-class" value={draft.classId} onChange={e => update({ ...draft, classId: e.target.value as ClassId })}>{Object.keys(RULES_V1.classes).map(value => <option key={value}>{value}</option>)}</select>
        <label htmlFor="build-stance">Stance</label><select id="build-stance" value={draft.stance} onChange={e => update({ ...draft, stance: e.target.value as Stance })}>{Object.keys(RULES_V1.stances).map(value => <option key={value}>{value}</option>)}</select>
      </fieldset>
      <fieldset disabled={busy}><legend>Attribute points · {owner.progression.earnedAttributePoints} earned</legend>
        <div className="build-points">{attributes.map(key => <label key={key}>{key}<input type="number" min="0" max={owner.progression.earnedAttributePoints} step="1" value={draft.allocation[key]} {...reviewed(pointsInvalid(key))} onChange={e => update({ ...draft, allocation: { ...draft.allocation, [key]: e.target.value === '' ? 0 : Number(e.target.value) } as Attributes })} /></label>)}</div>
        <p>Adding unspent points is free. Decreasing any current allocation reserves {RULES_V1.fees.respec} money.</p>
      </fieldset>
      <fieldset disabled={busy}><legend>Equipment</legend>
        {slots.map(slot => <label key={slot}>{slot}<select value={draft.equipment[slot] ?? ''} disabled={slot === 'offHand' && twoHands} {...reviewed(equipmentInvalid)} onChange={e => {
          const id = e.target.value || null;
          const entry = owner.inventory.find(item => item.id === id);
          const clearShield = slot === 'weapon' && entry && CATALOG_V1.items[entry.catalogId]?.hands === 2;
          update({ ...draft, equipment: { ...draft.equipment, [slot]: id, ...(clearShield ? { offHand: null } : {}) } });
        }}><option value="">None</option>{owner.inventory.filter(item => CATALOG_V1.items[item.catalogId]?.slot === slot).map(item => <option key={item.id} value={item.id} disabled={item.tier > owner.progression.level || item.reservation?.kind === 'listing'}>{CATALOG_V1.items[item.catalogId].name} · Level {item.tier}</option>)}</select></label>)}
        {twoHands && <p>This two-handed weapon uses the off-hand slot.</p>}
      </fieldset>
      {stats && <div className="creation-preview"><p>Estimated reservation: {fee} money</p><p>Maximum stamina: {stats.maxStamina} · Stamina after change: {preserveStamina(owner.stamina.current, stats.maxStamina)}</p>
        <p>Load: {stats.load} / {stats.loadCapacity} · Combat efficiency: {Math.round(stats.efficiency * 100)}%</p><p>Raising Endurance increases capacity without restoring current stamina.</p></div>}
      {!valid.ok && <p id={reviewId} role="status">Review your build: {valid.reason}.</p>}
      <button className="primary-button" disabled={busy || !valid.ok} type="submit" aria-describedby={!valid.ok ? reviewId : undefined}>Queue build</button>
    </form>
    <p className="muted">Available money: {owner.wallets.money - owner.reservedFees.money}. Reserved fees remain in your wallet until activation.</p>
    {message && <p ref={outcome} role="status" tabIndex={-1} {...target}>{message}</p>}
    {error && <p ref={outcome} role="alert" className="form-error" tabIndex={-1} {...target}>{error}</p>}
  </div>;
}
