'use client';

// Public tournament bouts share the replay controller/bar. The tournament and settled looks survive chapter replacements;
// only the addressed, decided bout asks for a log, through the gateway's session cache. No owner summary is read here.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BattleLog } from '@contracts/events';
import type { Appearance } from '@domain/appearance';
import type { TournamentView } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import { loadLooks, lookIdsFor, type LookMap } from '../../game/replay-looks';
import { processingRetryDelay, renderTournament, tournamentRevealMarks, withTournamentLogs, withoutTournamentLogs } from '../../game/tournament-stage';
import { tournamentEndsAtMs, tournamentReplayKept } from '../../lib/replay-retention';
import { BattleReplay } from '../arena/BattleReplay';
import type { TitleLookup } from '../titles/title-text';
import { bracketChapter, upNextText } from '../bouts/bout-text';
import { useClockMode } from '../../lib/clock-setting';

type Reads = Pick<GameGateway, 'tournament' | 'tournamentLog'> & Partial<Pick<GameGateway, 'looks'>>;
type Props = {
  reads: Reads; tournamentId: string; boutId: string; clock: DisplayClock | null; viewerId: string | null; known: LookMap | null;
  /** The fighters' worn titles (the camp's world actors); none shown without it. */
  titles?: TitleLookup;
  back: { label: string; go(): void } | null; takeFocus?: boolean; heldAtMs?: number | null; onChapter(boutId: string): void;
};
type Source = { reads: Reads; tournamentId: string };
type Loaded = { source: Source; view: TournamentView | null; failed: boolean };
type Selected = { source: Source; boutId: string; attempt: number; log: BattleLog | null; looks: LookMap | null; failed: boolean };

export function BracketReplay({ reads, tournamentId, boutId, clock, viewerId, known, titles, back, takeFocus, heldAtMs = null, onChapter }: Props) {
  const [, setTick] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const identity = useMemo(() => ({ reads, tournamentId }), [reads, tournamentId]);
  const clockMode = useClockMode();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const looksCache = useRef<{ source: Source; map: Map<string, Appearance | null> } | null>(null);
  const schedule = useRef({ source: identity, marks: [] as number[], lastRead: -Infinity, retries: 0, pending: false });
  useEffect(() => {
    if (!clock || heldAtMs !== null) return;
    const update = () => setTick(n => n + 1);
    const unsubscribe = clock.subscribe(update);
    const timer = window.setInterval(update, 1000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { unsubscribe(); window.clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [clock, heldAtMs]);
  const now = heldAtMs ?? clock?.now() ?? null;
  const expiry = tournamentEndsAtMs(tournamentId);
  const expired = now !== null && expiry !== null && !tournamentReplayKept(expiry, now);
  const source = loaded?.source === identity ? loaded : null;
  useEffect(() => {
    if (now === null || expired) return;
    if (schedule.current.source !== identity) schedule.current = { source: identity, marks: [], lastRead: -Infinity, retries: 0, pending: false };
    const timing = schedule.current;
    timing.lastRead = now; timing.pending = true;
    let current = true;
    reads.tournament(tournamentId).then(view => {
      if (current) { timing.pending = false; setLoaded({ source: identity, view: withoutTournamentLogs(view), failed: false }); }
    }, () => { if (current) { timing.pending = false; setLoaded(previous => ({ source: identity,
      view: previous?.source === identity ? previous.view : null, failed: true })); } });
    return () => { current = false; timing.pending = false; };
    // Chapter changes and time ticks do not restart reads; only reveal/retry refreshes do.
  }, [identity, now === null, expired, refresh]);
  const result = selected?.source === identity && selected.boutId === boutId && selected.attempt === attempt ? selected : null;
  // The loaded log is authoritative for its duration too: a short/missing polled summary never permits early playback.
  const projected = source?.view && result?.log ? withTournamentLogs(source.view, new Map([[boutId, result.log]])) : source?.view;
  const state = projected && now !== null ? renderTournament(projected, now, { viewerId }) : null;
  useEffect(() => {
    if (heldAtMs !== null || expired || !state || document.visibilityState !== 'visible') return;
    const timing = schedule.current, t = state.displayNowMs;
    if (timing.source !== identity || timing.pending) return;
    if (t < timing.lastRead) timing.lastRead = t;
    const processing = state.status === 'processing' || state.rounds.some(round => round.delayed) || source?.failed;
    if (!processing) timing.retries = 0;
    const boundary = timing.marks.some(mark => mark <= t);
    const retry = processing && t - timing.lastRead >= processingRetryDelay(timing.retries);
    timing.marks = tournamentRevealMarks(state);
    if (!boundary && !retry) return;
    if (!boundary) timing.retries += 1;
    // Mark the request before scheduling the render so concurrent ticks cannot enqueue another one.
    timing.pending = true;
    setRefresh(n => n + 1);
  });
  const chapters = state?.rounds.flatMap(round => round.bouts.filter(bout => bout.status === 'decided').map(bout => ({
    bout, label: bracketChapter(round.label, bout.position, round.bouts.length), roundLabel: round.label,
  }))) ?? [];
  const current = chapters.findIndex(chapter => chapter.bout.id === boutId);
  const chosen = chapters[current];
  // A log already loaded keeps playing through retention expiry; no new chapter log is read after expiry.
  const playable = result?.log && result.looks !== null ? result : null;
  useEffect(() => {
    if (!source?.view || !chosen || expired) return;
    let active = true;
    let cancelLooks: (() => void) | undefined;
    if (looksCache.current?.source !== identity) looksCache.current = { source: identity, map: new Map(known) };
    const view = source.view;
    reads.tournamentLog(boutId).then(log => {
      if (!active) return;
      const merged = withTournamentLogs(view, new Map([[boutId, log]]));
      const validated = merged.bouts.find(bout => bout.id === boutId)?.revealedResult?.battleLog;
      if (!validated || validated !== log) {
        setSelected({ source: identity, boutId, attempt, log: null, looks: null, failed: true });
        return;
      }
      setSelected({ source: identity, boutId, attempt, log, looks: null, failed: false });
      const ids = lookIdsFor(log);
      const load = loadLooks({ ids, known: looksCache.current?.map, read: reads.looks?.bind(reads), onSettled: looks => {
        if (!active) return;
        // Missing/timeout looks settle as legacy once for this viewer, including later chapters with the same fighter.
        for (const id of ids) looksCache.current!.map.set(id, looks.get(id) ?? null);
        setSelected({ source: identity, boutId, attempt, log, looks, failed: false });
      } });
      cancelLooks = load.cancel;
    }, () => { if (active) setSelected({ source: identity, boutId, attempt, log: null, looks: null, failed: true }); });
    return () => { active = false; cancelLooks?.(); };
  }, [identity, !!source?.view, boutId, !!chosen, expired, attempt]);
  const retry = () => { if (!source?.view) setRefresh(n => n + 1); else setAttempt(n => n + 1); };
  if (expired && !playable) return <BattleReplay headingLevel={2} view={{ kind: 'unavailable', reason: 'expired' }} />;
  if ((source?.failed && !source.view) || result?.failed) return <BattleReplay headingLevel={2} view={{ kind: 'unavailable', reason: 'unavailable' }} onRetry={retry} />;
  if (state && !chosen) return <BattleReplay headingLevel={2} view={{ kind: 'unavailable', reason: 'not-revealed' }} />;
  if (!playable || !chosen || !state) return <p role="status">Loading the replay…</p>;
  const select = (index: number) => { const next = chapters[index]; if (next) onChapter(next.bout.id); };
  const next = chapters[current + 1];
  const pair = next?.bout.sides;
  return <BattleReplay key={boutId} headingLevel={2} viewerId={viewerId} titles={titles} league={state.league} takeFocus={takeFocus} back={back}
    nav={{ previous: current > 0 ? () => select(current - 1) : null, counter: null,
      next: next ? { opponent: null, upNext: pair?.[0] && pair[1] ? upNextText({ a: pair[0].name, b: pair[1].name, chapter: next.roundLabel }, clockMode) : null,
        go: () => select(current + 1) } : null }}
    looks={{ known: playable.looks }} chapters={{ labels: chapters.map(chapter => chapter.label), current, select }}
    view={{ kind: 'replay', selected: 0, summary: null, battles: [{ log: playable.log!, stage: {
      id: boutId, kind: 'bout', label: `Tournament · ${chosen.roundLabel}`, revealedAtMs: chosen.bout.revealAtMs,
      startedAtMs: chosen.bout.revealAtMs, endsAtMs: chosen.bout.fightEndsAtMs!,
    } }] }} />;
}
