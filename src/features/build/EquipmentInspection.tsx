'use client';

import { useId, useRef, useState, type ComponentPropsWithRef, type MouseEvent, type PointerEvent, type ReactNode, type Ref } from 'react';
import type { Equipment, EquipmentSlot } from '@contracts/commands';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import type { BuildInput } from '@domain/types';
import { validateBuild } from '@domain/build';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V1 } from '@domain/rules-v1';
import { deriveStats } from '@domain/stats';
import { ItemIcon, ItemStats } from '../inventory/ItemPresentation';
import styles from './EquipmentInspection.module.css';

const slotNames = { weapon: 'Weapon', offHand: 'Off hand', head: 'Head', body: 'Body', feet: 'Feet' } satisfies Record<EquipmentSlot, string>;
export const equipmentSlots = Object.keys(slotNames) as EquipmentSlot[];

const itemName = (item: ItemInstance) => CATALOG_V1.items[item.catalogId]?.name ?? item.catalogId;
const itemMeta = (item: ItemInstance) => `Level ${item.tier} · ${item.rarity}`;
const twoHanded = (item: ItemInstance | undefined) => !!item && CATALOG_V1.items[item.catalogId]?.hands === 2;
const slotItem = (equipment: Equipment, inventory: ItemInstance[], slot: EquipmentSlot) => inventory.find(item => item.id === equipment[slot]);
const slotItemName = (item: ItemInstance | undefined, id: string | null) => item ? itemName(item) : id ? 'Unavailable' : 'Empty';

function instanceLabel(item: ItemInstance | undefined, inventory: ItemInstance[]) {
  if (!item) return undefined;
  const name = itemName(item);
  const peers = inventory.filter(other => other.tier === item.tier && other.rarity === item.rarity && itemName(other) === name);
  return peers.length > 1 ? `Item ${peers.findIndex(other => other.id === item.id) + 1}` : undefined;
}

function revealOnTouch(event: MouseEvent<HTMLButtonElement>, reveal: () => void) {
  if ('pointerType' in event.nativeEvent && event.nativeEvent.pointerType === 'touch') requestAnimationFrame(reveal);
}

function EquipmentTile({ item, missing, title, subtitle, ...props }: ComponentPropsWithRef<'button'> & {
  item?: ItemInstance; missing?: boolean; title: string; subtitle?: string;
}) {
  return <button {...props} type="button" className={styles.tile}>
    <span className={styles.icon} data-rarity={item?.rarity}>
      {item || missing ? <ItemIcon catalogId={item?.catalogId ?? ''} /> : <span aria-hidden="true">—</span>}
    </span>
    <span className={styles.tileName}>{title}</span>
    {subtitle && <span className={styles.tileMeta}>{subtitle}</span>}
  </button>;
}

function EquipmentDetails({ label, item, instance, empty, note, detailsRef, children }: {
  label: string; item?: ItemInstance; instance?: string; empty: string; note?: string;
  detailsRef: Ref<HTMLDivElement>; children?: ReactNode;
}) {
  return <div ref={detailsRef} role="group" aria-label={label} className={styles.details}>
    <div aria-live="polite" aria-atomic="true">
      {item ? <>
        <div className={styles.detailTitle}>
          <ItemIcon catalogId={item.catalogId} />
          <div><strong>{itemName(item)}</strong><p>{itemMeta(item)}{instance && ` · ${instance}`}</p></div>
        </div>
        <ItemStats item={item} />
      </> : <p className={styles.empty}>{empty}</p>}
      {note && <p className={styles.note}>{note}</p>}
    </div>
    {children}
  </div>;
}

function buildStats(draft: BuildInput, owner: OwnerState) {
  const result = validateBuild(draft, owner.inventory, owner.progression.earnedAttributePoints, owner.progression.level);
  return result.ok ? deriveStats(result.snapshot, RULES_V1) : null;
}

export function WornEquipment({ owner }: { owner: OwnerState }) {
  const { currentBuild, inventory } = owner;
  const { equipment } = currentBuild;
  const headingId = useId();
  const detail = useRef<HTMLDivElement>(null);
  const [selected, setInspectedSlot] = useState<EquipmentSlot>();
  const wearing = equipmentSlots.some(slot => equipment[slot] !== null);
  const inspected = selected && slotItem(equipment, inventory, selected);
  const stats = buildStats({ classId: currentBuild.classId, stance: currentBuild.stance, allocation: currentBuild.allocations, equipment }, owner);
  return <section className={styles.worn} aria-labelledby={headingId} data-wearing={wearing || undefined}>
    <div className={styles.heading}>
      <h3 id={headingId}>Worn equipment</h3>
      {stats && <p>Load <strong>{stats.load} / {stats.loadCapacity}</strong></p>}
    </div>
    <div className={styles.slots}>
      {equipmentSlots.map(slot => {
        const item = slotItem(equipment, inventory, slot);
        const name = slotItemName(item, equipment[slot]);
        const instance = instanceLabel(item, inventory);
        return <EquipmentTile key={slot} item={item} missing={!!equipment[slot]} title={slotNames[slot]}
          aria-label={`${slotNames[slot]}: ${name}${instance ? `, ${instance}` : ''}`} aria-pressed={selected === slot}
          subtitle={instance ? `${name} · ${instance}` : name}
          onPointerEnter={event => { if (event.pointerType !== 'touch') setInspectedSlot(slot); }}
          onFocus={() => setInspectedSlot(slot)} onClick={event => {
            setInspectedSlot(slot);
            revealOnTouch(event, () => detail.current?.scrollIntoView({ block: 'nearest' }));
          }} />;
      })}
    </div>
    <EquipmentDetails label="Worn equipment details" item={inspected} instance={instanceLabel(inspected, inventory)} detailsRef={detail}
      empty={selected ? (equipment[selected] ? 'This equipment is unavailable.' : 'No equipment worn in this slot.')
        : wearing ? 'Choose a slot to see its stats and weight.' : 'No equipment worn.'} />
  </section>;
}

function equip(draft: BuildInput, slot: EquipmentSlot, item: ItemInstance | undefined): BuildInput {
  const equipment = { ...draft.equipment, [slot]: item?.id ?? null };
  if (slot === 'weapon' && twoHanded(item)) equipment.offHand = null;
  return { ...draft, equipment };
}

function choiceProblem(item: ItemInstance | undefined, level: number) {
  if (!item) return undefined;
  if (item.tier > level) return `Requires level ${item.tier}`;
  if (item.reservation?.kind === 'listing') return 'Listed for sale';
  return undefined;
}

type Inspection = { slot: EquipmentSlot; optionId?: string | null };

export function BuildEquipment({ draft, owner, busy, reviewId, onChange }: {
  draft: BuildInput; owner: OwnerState; busy: boolean; reviewId?: string; onChange(next: BuildInput): void;
}) {
  const { inventory, progression } = owner;
  const [activeSlot, setActiveSlot] = useState<EquipmentSlot>();
  const [inspection, setInspection] = useState<Inspection>();
  const [chosenId, setChosenId] = useState<string | null>();
  const choicesId = useId();
  const triggers = useRef<Partial<Record<EquipmentSlot, HTMLButtonElement | null>>>({});
  const detail = useRef<HTMLDivElement>(null);
  const useButton = useRef<HTMLButtonElement>(null);
  const locked = twoHanded(slotItem(draft.equipment, inventory, 'weapon'));
  const openSlot = activeSlot === 'offHand' && locked ? undefined : activeSlot;
  const replacements = openSlot ? inventory.filter(item => CATALOG_V1.items[item.catalogId]?.slot === openSlot
    && (item.id !== draft.equipment[openSlot] || choiceProblem(item, progression.level) !== undefined)) : [];
  const options = [...replacements, ...(openSlot && draft.equipment[openSlot] ? [undefined] : [])];
  const chosen = replacements.find(item => item.id === chosenId);
  const hasChoice = !!openSlot && ((chosen && !choiceProblem(chosen, progression.level)) || (chosenId === null && !!draft.equipment[openSlot]));
  const inspectedSlot = inspection?.slot;
  const inspectingOption = inspection && inspectedSlot === openSlot && inspection.optionId !== undefined;
  const canApply = hasChoice && inspectingOption && inspection.optionId === chosenId;
  const inspected = inspectingOption ? replacements.find(item => item.id === inspection.optionId)
    : inspectedSlot && slotItem(draft.equipment, inventory, inspectedSlot);
  const nextStats = inspectingOption && openSlot && (inspected || inspection.optionId === null) && !choiceProblem(inspected, progression.level)
    ? buildStats(equip(draft, openSlot, inspected), owner) : null;
  const inspectedProblem = inspectingOption ? choiceProblem(inspected, progression.level) : undefined;
  const notes = [inspectedProblem, inspectingOption && twoHanded(inspected) && 'A two-handed weapon uses the off-hand slot.',
    !!nextStats?.overload && 'This would overload your gladiator.'].filter(Boolean);
  const chosenInstance = instanceLabel(chosen, inventory);

  function previewOnPointer(event: PointerEvent<HTMLButtonElement>, next: Inspection) {
    if (event.pointerType === 'touch' || event.currentTarget.disabled || useButton.current === document.activeElement) return;
    setInspection(next);
  }

  function restoreOnPointerLeave(event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerType !== 'touch' && event.currentTarget !== document.activeElement && openSlot && chosenId !== undefined) {
      setInspection({ slot: openSlot, optionId: chosenId });
    }
  }

  function closeChoices(slot: EquipmentSlot, preventScroll: boolean) {
    triggers.current[slot]?.focus({ preventScroll });
    setActiveSlot(undefined);
    setChosenId(undefined);
    setInspection({ slot });
  }

  return <fieldset disabled={busy} onKeyDown={event => {
    if (event.key === 'Escape' && openSlot) {
      event.preventDefault();
      closeChoices(openSlot, false);
    }
  }}><legend>Equipment</legend>
    <div className={styles.slots}>
      {equipmentSlots.map(slot => {
        const item = slotItem(draft.equipment, inventory, slot);
        const name = slotItemName(item, draft.equipment[slot]);
        const instance = instanceLabel(item, inventory);
        return <EquipmentTile key={slot} ref={element => { triggers.current[slot] = element; }} item={item} missing={!!draft.equipment[slot]}
          title={slotNames[slot]} subtitle={instance ? `${name} · ${instance}` : name} aria-label={`${slotNames[slot]}: ${name}${instance ? `, ${instance}` : ''}`}
          data-equipment-slot={slot} aria-expanded={openSlot === slot} aria-controls={openSlot === slot ? choicesId : undefined}
          aria-invalid={reviewId ? true : undefined} aria-describedby={reviewId} disabled={slot === 'offHand' && locked}
          onPointerEnter={event => previewOnPointer(event, { slot })} onPointerLeave={restoreOnPointerLeave}
          onFocus={() => setInspection({ slot })} onClick={() => {
            if (openSlot === slot) closeChoices(slot, true);
            else { setActiveSlot(slot); setChosenId(undefined); setInspection({ slot }); }
          }} />;
      })}
    </div>
    {locked && <p className={styles.note}>This two-handed weapon uses the off-hand slot.</p>}
    <div className={styles.inspection} data-open={openSlot ? true : undefined}>
      {openSlot && <div id={choicesId} className={styles.choices}>
        <h4>{slotNames[openSlot]} options</h4>
        {options.length ? <div className={styles.options}>
          {options.map(item => {
            const optionId = item?.id ?? null;
            const problem = choiceProblem(item, progression.level);
            const name = item ? itemName(item) : 'Remove item';
            const metadata = [item && itemMeta(item), instanceLabel(item, inventory), problem].filter(Boolean).join(' · ');
            const next = { slot: openSlot, optionId };
            return <EquipmentTile key={optionId ?? ''} item={item} title={name} subtitle={metadata}
              data-equipment-option={optionId ?? ''} aria-pressed={chosenId === optionId} aria-disabled={problem ? true : undefined}
              onPointerEnter={event => previewOnPointer(event, next)} onPointerLeave={restoreOnPointerLeave}
              onFocus={() => setInspection(next)} onClick={event => {
                setInspection(next);
                revealOnTouch(event, () => detail.current?.scrollIntoView({ block: 'nearest' }));
                if (problem) return;
                setChosenId(optionId);
                if (event.detail === 0) requestAnimationFrame(() => useButton.current?.focus());
              }} />;
          })}
        </div> : <p className={styles.empty}>No replacement equipment for this slot.</p>}
      </div>}
      <EquipmentDetails label="Build equipment details" item={inspected} instance={instanceLabel(inspected, inventory)} detailsRef={detail} note={notes.join(' ')}
        empty={inspectingOption ? (inspection.optionId === null ? 'Leave this slot empty.' : 'This equipment is unavailable.')
          : inspectedSlot && draft.equipment[inspectedSlot] ? 'This equipment is unavailable.' : 'Choose a slot to inspect or change equipment.'}>
        {hasChoice && <div className={styles.choiceAction}>
          {canApply && openSlot && <button type="button" ref={useButton} className={styles.use} onClick={event => {
            closeChoices(openSlot, event.detail !== 0);
            onChange(equip(draft, openSlot, chosen));
          }}>{chosen ? `Use ${itemName(chosen)}${chosenInstance ? ` · ${chosenInstance}` : ''}` : 'Clear slot'}</button>}
        </div>}
      </EquipmentDetails>
    </div>
  </fieldset>;
}
