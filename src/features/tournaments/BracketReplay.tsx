'use client';

// Public tournament bouts share the replay controller/bar. The tournament and settled looks survive chapter replacements;
// only the addressed, decided bout asks for a log, through the gateway's session cache. No owner summary is read here.
import { useEffect, useRef, useState } from 'react';
import type { BattleLog } from '@contracts/events';
import type { Appearance } from '@domain/appearance';
import type { TournamentView } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import { loadLooks, lookIdsFor, type LookMap } from '../../game/replay-looks';
import { renderTournament, withTournamentLogs, withoutTournamentLogs } from '../../game/tournament-stage';
import { tournamentEndsAtMs, tournamentReplayKept } from '../../lib/replay-retention';
import { BattleReplay } from '../arena/BattleReplay';
import { bracketChapter } from '../bouts/bout-text';

type Reads = Pick<GameGateway, 'tournament' | 'tournamentLog'> & Partial<Pick<GameGateway, 'looks'>>;
type Props = {
  reads: Reads; tournamentId: string; boutId: string; clock: DisplayClock | null; viewerId: string | null; known: LookMap | null;
  back: { label: string; go(): void } | null; takeFocus?: boolean; heldAtMs?: number | null; onChapter(boutId: string): void;
};
type Loaded = { reads: Reads; tournamentId: string; view: TournamentView | null; failed: boolean };
type Selected = { source: Loaded; boutId: string; attempt: number; log: BattleLog | null; looks: LookMap | null; failed: boolean };

export function BracketReplay({ reads, tournamentId, boutId, clock, viewerId, known, back, takeFocus, heldAtMs = null, onChapter }: Props) {
  const [, setTick] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const looksCache = useRef<{ source: Loaded; map: Map<string, Appearance | null> } | null>(null);
  useEffect(() => {
    if (!clock || heldAtMs !== null) return;
    const update = () => setTick(n => n + 1);
    const unsubscribe = clock.subscribe(update);
    const timer = window.setInterval(update, 1000);
    return () => { unsubscribe(); window.clearInterval(timer); };
  }, [clock, heldAtMs]);
  const now = heldAtMs ?? clock?.now() ?? null;
  const expiry = tournamentEndsAtMs(tournamentId);
  const expired = now !== null && expiry !== null && !tournamentReplayKept(expiry, now);
  const source = loaded?.reads === reads && loaded.tournamentId === tournamentId ? loaded : null;
  useEffect(() => {
    if (now === null || expired || (source?.view && !source.failed)) return;
    let current = true;
    reads.tournament(tournamentId).then(view => {
      if (current) setLoaded({ reads, tournamentId, view: withoutTournamentLogs(view), failed: false });
    }, () => { if (current) setLoaded({ reads, tournamentId, view: null, failed: true }); });
    return () => { current = false; };
    // Time ticks must not restart a pending tournament read; readiness and retry are the read boundaries.
  }, [reads, tournamentId, now === null, expired, attempt]);
  const result = selected?.source === source && selected.boutId === boutId && selected.attempt === attempt ? selected : null;
  // The loaded log is authoritative for its duration too: a short/missing polled summary never permits early playback.
  const projected = source?.view && result?.log ? withTournamentLogs(source.view, new Map([[boutId, result.log]])) : source?.view;
  const state = projected && now !== null ? renderTournament(projected, now, { viewerId }) : null;
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
    if (looksCache.current?.source !== source) looksCache.current = { source, map: new Map(known) };
    const view = source.view;
    reads.tournamentLog(boutId).then(log => {
      if (!active) return;
      const merged = withTournamentLogs(view, new Map([[boutId, log]]));
      const validated = merged.bouts.find(bout => bout.id === boutId)?.revealedResult?.battleLog;
      if (!validated || validated !== log) {
        setSelected({ source, boutId, attempt, log: null, looks: null, failed: true });
        return;
      }
      setSelected({ source, boutId, attempt, log, looks: null, failed: false });
      const ids = lookIdsFor(log);
      const load = loadLooks({ ids, known: looksCache.current?.map, read: reads.looks?.bind(reads), onSettled: looks => {
        if (!active) return;
        // Missing/timeout looks settle as legacy once for this viewer, including later chapters with the same fighter.
        for (const id of ids) looksCache.current!.map.set(id, looks.get(id) ?? null);
        setSelected({ source, boutId, attempt, log, looks, failed: false });
      } });
      cancelLooks = load.cancel;
    }, () => { if (active) setSelected({ source, boutId, attempt, log: null, looks: null, failed: true }); });
    return () => { active = false; cancelLooks?.(); };
  }, [source, reads, boutId, !!chosen, expired, attempt]);
  const retry = () => setAttempt(n => n + 1);
  if (expired && !playable) return <BattleReplay headingLevel={2} view={{ kind: 'unavailable', reason: 'expired' }} />;
  if (source?.failed || result?.failed) return <BattleReplay headingLevel={2} view={{ kind: 'unavailable', reason: 'unavailable' }} onRetry={retry} />;
  if (state && !chosen) return <BattleReplay headingLevel={2} view={{ kind: 'unavailable', reason: 'not-revealed' }} />;
  if (!playable || !chosen || !state) return <p role="status">Loading the replay…</p>;
  const select = (index: number) => { const next = chapters[index]; if (next) onChapter(next.bout.id); };
  return <BattleReplay key={boutId} headingLevel={2} viewerId={viewerId} league={state.league} takeFocus={takeFocus} back={back}
    looks={{ known: playable.looks }} chapters={{ labels: chapters.map(chapter => chapter.label), current, select }}
    view={{ kind: 'replay', selected: 0, summary: null, battles: [{ log: playable.log!, stage: {
      id: boutId, kind: 'bout', label: `Tournament · ${chosen.roundLabel}`, revealedAtMs: chosen.bout.revealAtMs,
      startedAtMs: chosen.bout.revealAtMs, endsAtMs: chosen.bout.fightEndsAtMs!,
    } }] }} />;
}
