'use client';

import { useEffect, useId, useRef, type MouseEvent } from 'react';
import type { OwnerState, PublicActor } from '@contracts/reads';
import { ActorPortrait } from '../character/ActorPortrait';
import { title } from '../character/actor-text';
import { ItemIcon } from '../inventory/ItemPresentation';
import { AtlasIcon, CurrencyIcon } from '../shops/ShopArt';
import type { AwaySummary } from './away-summary';
import styles from './AwaySummaryDialog.module.css';

export type AwaySummaryAction = 'dismiss' | 'acknowledge' | 'gladiator' | 'results' | 'messages' | 'schedule';

type PortraitActor = Pick<PublicActor, 'gladiatorId' | 'appearance' | 'equipmentSilhouettes'>;
type SummaryLine = AwaySummary['lines'][number];

const icons = {
  arena: 'arena',
  tournament: 'tournament',
  expedition: 'expedition',
  dungeon: 'expedition',
  training: 'training',
  overflow: 'inventory',
} as const satisfies Record<SummaryLine['kind'], string>;

const count = (number: number) => number.toLocaleString('en-US');

function isBackdrop(event: MouseEvent<HTMLDialogElement>): boolean {
  if (event.target !== event.currentTarget) return false;
  const { top, right, bottom, left } = event.currentTarget.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

function ItemTiles({ items, compact }: { items: AwaySummary['items']; compact: boolean }) {
  const limit = compact ? 7 : 8;
  const shown = items.slice(0, limit);
  const names = shown.map(item => item.name).join(', ');
  const hiddenRare = items.slice(limit).filter(item => item.rarity === 'rare');
  const rareCount = hiddenRare.reduce((total, item) => total + item.quantity, 0);
  return <div className={styles.items}>
    <p className={styles.eyebrow}>New items · {count(items.length)}</p>
    <div className={styles.itemTiles}>
      {shown.map((item, index) => <span key={`${item.catalogId}-${index}`} role="img" aria-label={item.quantity > 1 ? `${item.label}, quantity ${count(item.quantity)}` : item.label}
        title={item.label} className={styles.itemTile} data-rarity={item.rarity} data-testid="away-summary-item">
        <ItemIcon catalogId={item.catalogId} />
        {item.catalogId !== 'salvage' && <span aria-hidden="true" className={styles.tier}>{item.tier}</span>}
        {item.quantity > 1 && <span aria-hidden="true" className={styles.quantity}>×{count(item.quantity)}</span>}
      </span>)}
    </div>
    <p className={styles.itemNames}>
      <span title={names}>{names}</span>
      {items.length > limit && <strong aria-label={hiddenRare.length ? `${count(items.length - limit)} more items, including ${hiddenRare.map(item => item.label).join(', ')}` : undefined}
        title={hiddenRare.length ? hiddenRare.map(item => item.label).join(', ') : undefined}>
        {' · +'}{count(items.length - limit)} more{rareCount > 0 && `, ${count(rareCount)} Rare`}</strong>}
    </p>
  </div>;
}

export function AwaySummaryDialog({ summary, owner, actor, compact, onClose }: {
  summary: AwaySummary;
  owner: OwnerState;
  actor?: PortraitActor;
  compact: boolean;
  onClose(action: AwaySummaryAction): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const finished = useRef(false);
  const backdropPress = useRef(false);
  const id = useId();
  const classId = owner.currentBuild.classId;
  const levelBefore = summary.levelBefore;
  const levelUp = levelBefore !== null;
  const overflow = summary.lines.find(line => line.kind === 'overflow');
  const dense = summary.lines.length + summary.titles.length > 8 || summary.items.length > 5;
  const titles = dense ? summary.titles.slice(0, 2) : summary.titles;
  const otherTitles = summary.titles.length - titles.length;
  const lines = summary.lines.filter(line => line.kind !== 'overflow');
  const displayedLines = dense ? [...lines.filter(line => line.label), ...(overflow ? [overflow] : []), ...lines.filter(line => !line.label)] : lines;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    }
    heading.current?.focus({ preventScroll: true });
  }, []);

  function finish(action: AwaySummaryAction) {
    if (finished.current) return;
    finished.current = true;
    dialog.current?.close();
    if ((action === 'dismiss' || action === 'acknowledge') && previousFocus.current !== document.body) {
      previousFocus.current?.focus({ preventScroll: true });
    }
    onClose(action);
  }

  return <dialog ref={dialog} className={styles.dialog} data-compact={compact || undefined} data-dense={dense || undefined}
    data-testid="away-summary" aria-labelledby={id}
    onCancel={event => { event.preventDefault(); finish('dismiss'); }} onClose={() => finish('dismiss')}
    onMouseDown={event => { backdropPress.current = event.button === 0 && isBackdrop(event); }}
    onClick={event => {
      const dismiss = backdropPress.current && isBackdrop(event);
      backdropPress.current = false;
      if (dismiss) finish('dismiss');
    }}>
    <header className={styles.header}>
      <span className={styles.grab} aria-hidden="true" />
      <p className={styles.eyebrow}>Welcome back</p>
      <h2 id={id} ref={heading} tabIndex={-1}>While you were away</h2>
      <p className={styles.duration}><strong>{summary.duration}</strong> · {count(summary.resultCount)} {summary.resultCount === 1 ? 'result' : 'results'}</p>
      <button type="button" className={styles.close} aria-label="Close" onClick={() => finish('dismiss')}>×</button>
    </header>

    <div className={styles.body} data-testid="away-summary-body">
      <section aria-labelledby={`${id}-gladiator`}>
        <div className={styles.gladiator}>
          <div className={styles.portrait} aria-hidden="true">
            <ActorPortrait actor={actor ?? { gladiatorId: owner.gladiatorId, appearance: owner.appearance, equipmentSilhouettes: [] }} />
            <span className={styles.classIcon}><AtlasIcon frame={classId} size={16} /></span>
          </div>
          <div className={styles.identity}>
            <h3 id={`${id}-gladiator`}>{owner.name}</h3>
            <p>{title(classId)} · {title(owner.progression.league)} league</p>
          </div>
          <div className={styles.level} data-level-up={levelUp || undefined}>
            {levelUp && <span>Level up</span>}
            <strong>{levelUp ? `Level ${count(levelBefore)} → ${count(summary.level)}` : `Level ${count(summary.level)}`}</strong>
          </div>
        </div>

        <div className={styles.xp}>
          <div className={styles.xpText}>
            {summary.xpGained > 0 && <strong><AtlasIcon frame="xp" size={16} />+{count(summary.xpGained)} XP</strong>}
            <span>{summary.xp.valueText}</span>
          </div>
          {!summary.xp.max && <div className={styles.xpBar} aria-hidden="true">
            <span className={styles.previousXp} style={{ width: `${summary.xp.previousFill * 100}%` }} />
            <span className={styles.gainedXp} style={{ width: `${summary.xp.gainedFill * 100}%` }} />
          </div>}
        </div>

        {(summary.gold > 0 || summary.renown > 0) && <div className={styles.currencies}>
          {summary.gold > 0 && <div className={styles.currency}>
            <CurrencyIcon currency="money" size={20} /><strong>+{count(summary.gold)}</strong> <span>gold</span>
          </div>}
          {summary.renown > 0 && <div className={styles.currency}>
            <CurrencyIcon currency="renown" size={20} /><strong>+{count(summary.renown)}</strong> <span>renown</span>
          </div>}
        </div>}

        {(summary.lines.length > 0 || summary.titles.length > 0) && <ul className={styles.lines}>
          {displayedLines.map((line, index) => <li key={`${line.kind}-${index}`} data-full-width={!line.label || undefined}>
            <AtlasIcon frame={icons[line.kind]} size={16} />
            <span title={dense ? `${line.label ? `${line.label}: ` : ''}${line.main}${line.detail ?? ''}` : undefined}>
              {line.label && `${line.label}: `}<strong>{line.main}</strong>{line.detail}
            </span>
          </li>)}
          {dense && titles.length > 0 ? <li data-full-width="">
            <span className={styles.star} aria-hidden="true">✦</span>
            <span title={summary.titles.map(row => `${row.name}${row.detail ? `: ${row.detail}` : ''}`).join('\n')}>
              {summary.titles.length === 1 ? 'New title: ' : 'New titles: '}
              {titles.map((row, index) => <span key={row.id}>{index > 0 && ', '}<em>{row.name}</em></span>)}
              {otherTitles > 0 && <> · {count(otherTitles)} more {otherTitles === 1 ? 'title' : 'titles'}</>}
            </span>
          </li> : titles.map(row => <li key={row.id}>
            <span className={styles.star} aria-hidden="true">✦</span>
            <span>New title: <em>{row.name}</em>{row.detail && <> · <span className={styles.dim}>{row.detail}</span></>}</span>
          </li>)}
          {!dense && overflow && <li>
            <AtlasIcon frame={icons.overflow} size={16} /><span>{overflow.label}: {overflow.main}</span>
          </li>}
        </ul>}

        {summary.rested && <button type="button" className={styles.rest} onClick={() => finish('schedule')}
          aria-label="Open schedule" aria-describedby={`${id}-rest`}>
          <AtlasIcon frame="rest" size={16} />
          <span><span id={`${id}-rest`}>{summary.rested}</span> <strong>Open schedule</strong></span>
        </button>}

        {summary.items.length > 0 && <ItemTiles items={summary.items} compact={compact} />}
      </section>

      {summary.messageCount > 0 && <div className={styles.messages}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" />
        </svg>
        <p><strong>{count(summary.messageCount)} new {summary.messageCount === 1 ? 'message' : 'messages'}</strong>
          {summary.teamReply && (summary.messageCount === 1 ? ', the team’s answer to your feedback' : ', one is the team’s answer to your feedback')}</p>
        <button type="button" className={styles.secondary} onClick={() => finish('messages')}>Read</button>
      </div>}
    </div>

    <div className={styles.actions}>
      <button type="button" className={styles.secondary} onClick={() => finish('gladiator')}>{compact ? 'My gladiator' : 'Open My gladiator'}</button>
      <button type="button" className={styles.secondary} onClick={() => finish('results')}>{compact ? 'All results' : 'See all results'}</button>
      <button type="button" className={styles.primary} onClick={() => finish('acknowledge')}>Got it</button>
    </div>
  </dialog>;
}
