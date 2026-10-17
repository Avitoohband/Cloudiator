'use client';

// Battle replay panel: the close-up scene, both fighters' health, consistent controls, the
// fighters' revealed snapshots, the result and a readable combat log. Everything shown comes from
// the revealed log; rewards come only from the activity summary. Names render as React text.
import { useCallback, useEffect, useId, useReducer, useRef, useState, type HTMLAttributes, type KeyboardEvent } from 'react';
import type { ActivitySummary, RevealedCombatant } from '@contracts/events';
import rawManifest from '../../../public/assets/manifest.json';
import {
  battleEndMs, createReplayController, loadReplayView, replayBattles, replayLines, type ReplayBattle, type ReplayController, type ReplaySpeed, type ReplayView,
} from '../../game/replay';
import type { DisplayClock } from '../../game/display-clock';
import type { GameGateway } from '../../lib/api/gateway';
import { creatureFor, type Creature } from '../../game/battle-stage';
import { createSceneBridge, type SceneBridge } from '../../game/bridge';
import { BattleViewport } from '../../game/BattleViewport';
import { prefersReducedMotion } from '../../game/webgl';
import styles from './BattleReplay.module.css';

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): browser tests read and drive playback. */
export type ReplayTestHook = {
  state(): {
    battleId: string; positionMs: number; endMs: number; playing: boolean; speed: ReplaySpeed; autoPaused: boolean; reducedMotion: boolean;
    hp: number[]; groupIndex: number; finished: boolean; winnerId: string | null;
  };
  /** Bridge plus controller listeners. */
  listeners(): number;
  /** Playback loops running on this page. */
  loops(): number;
  seek(positionMs: number): void;
  pause(): void;
};
declare global {
  interface Window { __cloudiatorReplay?: ReplayTestHook }
}

const CREATURES = (rawManifest as unknown as { actors: { creatures: Creature[] } }).actors.creatures;
let activeLoops = 0;

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const decimals = (n: number) => `${Math.round(n * 100) / 100}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
/** The viewer's own calendar day, so a date near midnight is never off by one. */
const day = (ms: number) => new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(ms);
/** 'sword:1:common' → 'Sword (tier 1, common)'; public layer ids such as 'weapon-sword' → 'Sword'. */
function itemName(id: string): string {
  const [template, tier, kind] = id.split(':');
  const base = capital(template.replace(/^(weapon|offhand|armor|head|feet)-/, '').replace(/-/g, ' '));
  return tier ? `${base} (tier ${tier}${kind ? `, ${kind}` : ''})` : base;
}
function kindOf(p: RevealedCombatant): string {
  if (p.gladiatorId !== null) return p.classId ? capital(p.classId) : 'Gladiator';
  return creatureFor(p, CREATURES) ? 'Creature' : 'NPC opponent';
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
/** A heading at `level`; its sections use the next level (at most h6). */
function Heading({ level, ...props }: { level: HeadingLevel } & HTMLAttributes<HTMLHeadingElement>) {
  const Tag = `h${level}` as const;
  return <Tag {...props} />;
}
const below = (level: HeadingLevel) => Math.min(6, level + 1) as HeadingLevel;

/**
 * The display time for a replay view, re-rendered when its next battle ends (and when the clock is held or let go), so a
 * fight in progress is offered once it has ended. Without a clock (a view whose battles are already over) it is 0.
 */
function useReplayTime(clock: DisplayClock | null | undefined, view: ReplayView): number {
  const [now, setNow] = useState(() => clock?.now() ?? 0);
  useEffect(() => {
    if (!clock) return;
    let timer: number | undefined;
    const update = () => {
      const t = clock.now();
      setNow(t);
      window.clearTimeout(timer);
      const next = view.kind === 'replay' ? Math.min(...view.battles.map(battleEndMs).filter(end => end > t)) : Infinity;
      // A server time moved forward by a later revision read is caught within a minute.
      if (Number.isFinite(next) && clock.frozen() === null) timer = window.setTimeout(update, Math.min(60_000, next - t + 50));
    };
    update();
    const off = clock.subscribe(update);
    return () => { off(); window.clearTimeout(timer); };
  }, [clock, view]);
  return now;
}

/**
 * `headingLevel` places the replay's title (default h1, as on the replay page) under an embedding page's headings;
 * its Result, Fighters and Combat log sections take the next level. With the shared display `clock` (the replay page
 * and the scene over the camp, Task 13.8) only the battles that ended by its time are offered, and the summary only once
 * settled (Task 15 review Minor 2): a fight still in progress, a later encounter and its server label stay hidden.
 * `viewerId` is the viewer's own gladiator (null for a visitor): only a fighter in the bout is told its rewards are
 * credited when the activity settles; when it is left out, everyone is (Task 13.8 fix round 1).
 */
export function BattleReplay({ view, bridge, headingLevel = 1, clock, viewerId }: {
  view: ReplayView; bridge?: SceneBridge; headingLevel?: HeadingLevel; clock?: DisplayClock | null; viewerId?: string | null;
}) {
  const now = useReplayTime(clock, view);
  if (view.kind === 'summary') return <SavedOutcome summary={view.summary} level={headingLevel} />;
  if (view.kind === 'unavailable') return <ReplayUnavailable reason={view.reason} level={headingLevel} />;
  const battles = clock ? replayBattles(view, now) : view.battles;
  if (!battles.length) return <ReplayUnavailable reason="in-progress" level={headingLevel} />;
  const summary = view.summary && (!clock || view.summary.settledAtMs <= now) ? view.summary : null;
  return <ReplayBattles battles={battles} initial={Math.min(view.selected, battles.length - 1)} summary={summary} bridge={bridge} level={headingLevel} viewerId={viewerId} />;
}

/**
 * One activity's replay, read once (`loadReplayView`) and shown with `BattleReplay`: the replay page and the replay scene
 * over the camp. It waits for `reads` (a fixture preview's load) and for `clock` (null until the shared clock has a
 * server time, so nothing is filtered by the device's own clock).
 */
export function ActivityReplay({ reads, activityId, stageId = null, clock, headingLevel = 1, viewerId }: {
  reads: Pick<GameGateway, 'timeline'> | null;
  activityId: string;
  stageId?: string | null;
  clock: DisplayClock | null;
  headingLevel?: HeadingLevel;
  /** The viewer's own gladiator, or null for a visitor (`BattleReplay`). */
  viewerId?: string | null;
}) {
  const [loaded, setLoaded] = useState<{ reads: object; view: ReplayView } | null>(null);
  useEffect(() => {
    if (!reads) return;
    let active = true;
    loadReplayView(reads, activityId, stageId).then(view => { if (active) setLoaded({ reads, view }); });
    return () => { active = false; };
  }, [activityId, reads, stageId]);
  const view = loaded && loaded.reads === reads ? loaded.view : null;
  return view && clock ? <BattleReplay view={view} headingLevel={headingLevel} clock={clock} viewerId={viewerId} /> : <p role="status">Loading the replay…</p>;
}

function ReplayBattles({ battles, initial, summary, bridge, level, viewerId }: {
  battles: ReplayBattle[]; initial: number; summary: ActivitySummary | null; bridge?: SceneBridge; level: HeadingLevel; viewerId?: string | null;
}) {
  const [chosen, setSelected] = useState(initial);
  // A display clock held back by a test can offer fewer battles than were chosen from.
  const selected = Math.min(chosen, battles.length - 1);
  const battle = battles[selected];
  return <>
    {battles.length > 1 && <div className={styles.encounters} role="group" aria-label="Encounters">
      {battles.map((b, i) => <button key={b.stage.id} type="button" aria-pressed={i === selected} onClick={() => setSelected(i)}>{b.stage.label}</button>)}
    </div>}
    <BattlePlayer key={battle.log.battleId} battle={battle} summary={summary} bridge={bridge} level={level} viewerId={viewerId} />
  </>;
}

/** Re-renders after the controller's discrete changes (group, result, play state, speed). */
function useController(controller: ReplayController) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => controller.subscribe(force), [controller]);
}

function BattlePlayer({ battle, summary, bridge: external, level, viewerId }: {
  battle: ReplayBattle; summary: ActivitySummary | null; bridge?: SceneBridge; level: HeadingLevel; viewerId?: string | null;
}) {
  const { log, stage } = battle;
  // Rewards to come are promised only to a fighter in the bout (or when the viewer is not known).
  const fighter = viewerId === undefined || (viewerId !== null && log.participants.some(p => p.gladiatorId === viewerId));
  const [bridge] = useState(() => external ?? createSceneBridge());
  const [controller] = useState(() => createReplayController(log));
  useController(controller);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [sceneMissing, setSceneMissing] = useState(false);
  const autoPaused = useRef(false);
  const slider = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  const logBox = useRef<HTMLOListElement>(null);
  const resultId = useId();
  const tableId = useId();
  const logId = useId();
  const [a, b] = log.participants;
  const { frame, playing, speed, endMs } = controller;
  const lines = replayLines(log).slice(0, frame.appliedEvents);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  useEffect(() => bridge.on('scene-unavailable', () => setSceneMissing(true)), [bridge]);

  // The one playback clock: animation frames advance the controller; a hidden tab pauses it.
  useEffect(() => {
    let alive = true;
    let last: number | null = null;
    let request = 0;
    activeLoops += 1;
    const step = (now: number) => {
      if (!alive) return;
      // Long gaps (a busy main thread) count as at most a quarter second of viewing.
      if (last !== null) controller.tick(Math.min(250, now - last));
      last = now;
      const input = slider.current;
      if (input && !dragging.current) {
        input.value = String(Math.round(controller.positionMs));
        input.setAttribute('aria-valuetext', `${seconds(Math.min(controller.positionMs, log.durationMs))} of ${seconds(log.durationMs)}`);
      }
      request = requestAnimationFrame(step);
    };
    request = requestAnimationFrame(step);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (controller.playing) { autoPaused.current = true; controller.pause(); }
      } else {
        last = null;
        if (autoPaused.current) { autoPaused.current = false; controller.play(); }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    controller.play();
    return () => {
      alive = false;
      cancelAnimationFrame(request);
      activeLoops -= 1;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [controller, log.durationMs]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorReplay = {
      state: () => ({
        battleId: log.battleId, positionMs: controller.positionMs, endMs: controller.endMs, playing: controller.playing, speed: controller.speed,
        autoPaused: autoPaused.current, reducedMotion: reduced, hp: [...controller.frame.hp], groupIndex: controller.frame.groupIndex,
        finished: controller.frame.finished, winnerId: controller.frame.result?.winnerId ?? null,
      }),
      listeners: () => bridge.listenerCount() + controller.listenerCount(),
      loops: () => activeLoops,
      seek: ms => controller.seek(ms),
      pause: () => controller.pause(),
    };
    return () => { delete window.__cloudiatorReplay; };
  }, [bridge, controller, log.battleId, reduced]);

  // Keep the newest log lines in view inside the log box (never scrolls the page).
  useEffect(() => {
    const box = logBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [frame.appliedEvents]);

  const toggle = useCallback(() => { autoPaused.current = false; if (controller.playing) controller.pause(); else controller.play(); }, [controller]);
  const toggleSpeed = useCallback(() => controller.setSpeed(controller.speed === 'fast' ? 'normal' : 'fast'), [controller]);
  const restart = useCallback(() => { autoPaused.current = false; controller.restart(); }, [controller]);
  const skip = useCallback(() => { autoPaused.current = false; controller.skipToResult(); }, [controller]);
  const position = useCallback(() => controller.positionMs, [controller]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if ((event.target as HTMLElement).tagName === 'INPUT') return;
    const key = event.key.toLowerCase();
    if (key === 'k') toggle();
    else if (key === 'f') toggleSpeed();
    else if (key === 'r') restart();
    else if (event.key === 'End') skip();
    else return;
    event.preventDefault();
  };

  const winner = frame.result ? log.participants.find(p => p.id === frame.result!.winnerId) : undefined;
  const loser = frame.result ? log.participants.find(p => p.id === frame.result!.loserId) : undefined;
  return (
    <section className={styles.player} aria-labelledby={`${resultId}-title`} onKeyDown={onKeyDown}>
      <header className={styles.header}>
        <p className="eyebrow">{stage.kind === 'encounter' ? `Expedition · ${stage.label}` : stage.label}</p>
        <Heading level={level} id={`${resultId}-title`}>{a.name} vs {b.name}</Heading>
      </header>
      <BattleViewport log={log} position={position} reducedMotion={reduced} bridge={bridge}
        label={`Close-up of ${a.name} (left) fighting ${b.name} (right). The combat log below describes every action.`} />
      <div className={styles.health}>
        {log.participants.map((p, i) => {
          const hp = frame.hp[i];
          return <div key={p.id} className={i === 0 ? styles.left : styles.right}>
            <div className={styles.name}><strong>{p.name}</strong> <span className={styles.kind}>{kindOf(p)}</span></div>
            <div className={styles.meter} role="meter" aria-label={`${p.name} health`} aria-valuemin={0} aria-valuemax={p.maxHealth} aria-valuenow={hp} aria-valuetext={`${hp} of ${p.maxHealth} health`}>
              <span className={styles.fill} style={{ width: `${(100 * hp) / p.maxHealth}%` }} />
              <span className={styles.hpText}>{hp} / {p.maxHealth}</span>
            </div>
          </div>;
        })}
      </div>
      <div className={styles.controls} role="group" aria-label="Replay controls">
        <button type="button" onClick={toggle}>{playing ? 'Pause' : 'Play'}</button>
        <button type="button" aria-pressed={speed === 'fast'} onClick={toggleSpeed}>Fast ×4</button>
        <button type="button" onClick={restart}>Restart</button>
        <button type="button" onClick={skip}>Skip to result</button>
      </div>
      <label className={styles.seek}>
        <span>Replay position</span>
        <input ref={slider} type="range" min={0} max={endMs} step={100} defaultValue={0}
          onPointerDown={() => { dragging.current = true; }} onPointerUp={() => { dragging.current = false; }}
          onInput={event => controller.seek(Number(event.currentTarget.value))} />
      </label>
      <p className={styles.hint}>Keys: K play or pause · F fast · R restart · End skip to result</p>

      <div className={styles.columns}>
        <section className={styles.card} role="region" aria-labelledby={resultId}>
          <Heading level={below(level)} id={resultId}>Result</Heading>
          {frame.result && winner && loser ? <div aria-live="polite">
            <p className={styles.verdict}>{winner.name} wins</p>
            <p>{frame.result.victoryReason === 'defeat' ? `${loser.name} is defeated.`
              : frame.result.victoryReason === 'health-fraction' ? `Time ran out and ${winner.name} kept the larger share of health.`
                : frame.result.tieBreakReason === 'simultaneous-defeat' ? `Both fighters fell at the same moment, so a seeded tie-break chose ${winner.name}.`
                  : `Time ran out with equal shares of health, so a seeded tie-break chose ${winner.name}.`}</p>
            {summary ? <Rewards summary={summary} scope={stage.kind === 'encounter' ? 'Credited for the whole expedition' : 'Credited rewards'} />
              : fighter ? <p className={styles.note}>Rewards are credited when the activity settles.</p> : null}
          </div> : <p className={styles.note}>The result appears when the fight ends. Use Skip to result to see it now.</p>}
          {summary?.replayExpiry.state === 'available' && <p className={styles.note}>This replay is kept until {day(summary.replayExpiry.expiresAtMs)}; the result and rewards stay in your history for 90 days.</p>}
        </section>

        <section className={styles.card} aria-labelledby={tableId}>
          <Heading level={below(level)} id={tableId}>Fighters</Heading>
          <Comparison fighters={log.participants} />
        </section>

        <section className={`${styles.card} ${styles.logCard}`} aria-labelledby={logId}>
          <Heading level={below(level)} id={logId}>Combat log</Heading>
          {sceneMissing && <p className={styles.note}>The animation is unavailable here; the log follows the fight instead.</p>}
          {lines.length === 0 && <p className={styles.note}>The first blow lands at {seconds(log.events[0]?.elapsedMs ?? 0)}.</p>}
          <ol ref={logBox} className={styles.log} aria-label="Combat log">
            {lines.map(line => <li key={line.sequence} aria-current={line.groupIndex === frame.groupIndex ? 'true' : undefined}
              className={`${styles[line.kind] ?? ''} ${line.groupIndex === frame.groupIndex ? styles.current : ''}`}>{line.text}</li>)}
          </ol>
        </section>
      </div>
    </section>
  );
}

function Comparison({ fighters }: { fighters: readonly Readonly<RevealedCombatant>[] }) {
  const rows: [string, (p: Readonly<RevealedCombatant>) => string][] = [
    ['Type', kindOf],
    ['Stance', p => capital(p.stance)],
    ['Health at start', p => `${p.initialHealth} / ${p.maxHealth}`],
    ['Weapon damage', p => decimals(p.weaponDamage)],
    ['Armor', p => decimals(p.armor)],
    ['Attack interval', p => seconds(p.attackIntervalMs)],
    ['Efficiency', p => `${p.efficiencyBasisPoints / 100}%`],
    ['Strength', p => decimals(p.attributes.strength)],
    ['Agility', p => decimals(p.attributes.agility)],
    ['Vitality', p => decimals(p.attributes.vitality)],
    ['Endurance', p => decimals(p.attributes.endurance)],
    ['Precision', p => decimals(p.attributes.precision)],
    ['Equipment', p => (p.equipmentSilhouettes.length ? p.equipmentSilhouettes.map(itemName).join(', ') : 'None')],
  ];
  return <table className={styles.table}>
    <caption className={styles.caption}>Fighters at the start of the fight</caption>
    <thead><tr><th scope="col"><span className={styles.hidden}>Detail</span></th>{fighters.map(p => <th key={p.id} scope="col">{p.name}</th>)}</tr></thead>
    <tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th>{fighters.map(p => <td key={p.id}>{value(p)}</td>)}</tr>)}</tbody>
  </table>;
}

function Rewards({ summary, scope }: { summary: ActivitySummary; scope: string }) {
  const r = summary.rewards;
  const parts = [
    r.renown ? `+${r.renown} renown` : null,
    r.money ? `+${r.money} money` : null,
    r.xp ? `+${r.xp} XP` : null,
    r.attributePoints ? `+${r.attributePoints} attribute points` : null,
    ...r.items.map(item => `${itemName(`${item.catalogId.split(':')[0]}:${item.tier}:${item.rarity}`)} ×${item.quantity}`),
    r.overflowMoney ? `+${r.overflowMoney} money for items that did not fit` : null,
  ].filter((p): p is string => !!p);
  const rating = summary.ratingDelta === undefined ? null : summary.ratingDelta === 0 ? 'No rating change' : `Rating ${summary.ratingDelta > 0 ? '+' : ''}${summary.ratingDelta}`;
  return <div className={styles.rewards}>
    <p className={styles.note}>{scope}</p>
    <ul>{parts.length ? parts.map((p, i) => <li key={`${i}-${p}`}>{p}</li>) : <li>No rewards</li>}{rating && <li>{rating}</li>}</ul>
  </div>;
}

function SavedOutcome({ summary, level }: { summary: ActivitySummary; level: HeadingLevel }) {
  const id = useId();
  const result = summary.result === 'victory' ? 'Victory' : summary.result === 'defeat' ? 'Defeat' : 'Completed';
  const kind = summary.resolvedKind === 'expedition' ? 'Expedition' : summary.resolvedKind === 'tournament' ? 'Tournament bout' : summary.resolvedKind === 'arena' ? 'Arena bout' : capital(summary.resolvedKind);
  return <section className={`${styles.card} ${styles.saved}`} role="region" aria-labelledby={id}>
    <p className="eyebrow">{kind} · settled {day(summary.settledAtMs)}</p>
    <Heading level={level} id={id}><span className={styles.hidden}>Saved outcome: </span>{result}</Heading>
    <p>The animation for this fight is no longer kept. Detailed replays are kept for seven days; the result and the credited rewards stay in your history for 90 days.</p>
    <Rewards summary={summary} scope="Credited rewards" />
  </section>;
}

/**
 * No replay to play. A guessed, unrevealed or still-running fight is "not available yet", with no summary, never an
 * error (Review Focus 3); an expired one is no longer kept; a missing link or a build without reads is not available.
 */
function ReplayUnavailable({ reason, level }: { reason: 'not-revealed' | 'in-progress' | 'not-found' | 'unavailable' | 'expired'; level: HeadingLevel }) {
  const later = reason === 'not-revealed' || reason === 'in-progress';
  return <section className={`${styles.card} ${styles.saved}`}>
    <Heading level={level}>{later ? 'This replay is not available yet' : reason === 'expired' ? 'This replay is no longer kept' : 'This replay is not available'}</Heading>
    <p>{reason === 'not-revealed' ? 'The fight has not been revealed yet. Replays appear once the bout is revealed.'
      : reason === 'in-progress' ? 'The fight is still going on. Its replay appears here as soon as it ends.'
        : reason === 'expired' ? 'Detailed replays are kept for seven days. The result stays in the recent results.'
          : reason === 'not-found' ? 'No fight was found for this link.'
            : 'Replays cannot be loaded in this build yet.'}</p>
  </section>;
}
