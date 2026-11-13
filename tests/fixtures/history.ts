// Patch 1.9 Task 27: a gladiator's public history for the fixture preview, as the M37 `gladiator_history_reads` view serves it (one row
// per settled Arena bout, fought tournament bout and expedition; snake_case columns; an opponent and a replay expiry only while the
// replay is kept at the fixture's server time, Sat 10 Oct 2026 00:40 UTC). The fixture gateway pages these rows and reads them through
// the live read's own `historyEntryOf`, so the preview and the live read agree. No battle is run here: every replay a kept row opens is
// a timeline the other fixtures already hold, or one put together here from their engine-generated logs. This module imports no
// JSON (the timelines and tournament views come in through `buildHistoryFixtures`), as tests/fixtures/my-bouts.ts does.
//
// - Aster (the fixture owner, her own card): her My bouts (five kept Arena bouts, an older one, two tournament runs) and five settled
//   expeditions. Her own card adds her own rewards from her owner summaries (`ownRewards`).
// - Varro (another gladiator, every kind, kept and gone): his side of his bout with Aster (kept) and 22 older bouts (23 rows, so Show
//   more pages), the 7 Oct bronze tournament won through three rounds (kept: a gold Final), the 26 Sep one (gone), his Ruined Outpost trip
//   (kept) and an older Woodland Path (gone).
// - Corvina (in the camp): the 7 Oct tournament, lost in the Final (kept), the 26 Sep first round (gone), two older Arena bouts and no
//   expedition (the empty state).
// - Lucilla: her 16 Sep silver tournament win (gone), three older Arena bouts and an older Woodland Path.
// The 7 Oct runs replay the 30 Sep "late" bracket's engine logs (the same eight entrants' pairings) at the 7 Oct evening slot.
import type { BattleLog, RevealedStage, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events.ts';
import type { TournamentView } from '../../supabase/functions/_shared/contracts/reads.ts';
import { ARENA_GLADIATORS, arenaActivityId, fixtureUuid } from './arena-ids.ts';
import { EXPEDITION_FIXTURES } from './expedition-ids.ts';
import { MY_BOUT_IDS } from './my-bouts.ts';
import { REPLAY_FIXTURES } from './replay-ids.ts';
import { tournamentActivityId, type TournamentKey } from './tournament-ids.ts';

/** A row of `public.gladiator_history_reads`, with its `gladiator_id`. */
export type HistoryViewRow = Record<string, unknown> & { gladiator_id: string; kind: 'arena' | 'tournament' | 'expedition'; entry_id: string; fought_at_ms: number };

const MIN = 60_000;
const DAY = 86_400_000;
const SLOT_MS = 4_800_000;
/** The fixture world's server time (tests/fixtures/domain.ts): Sat 10 Oct 2026 00:40 UTC. */
export const HISTORY_NOW = Date.UTC(2026, 9, 10, 0, 40);
const SLOT_START = HISTORY_NOW - (HISTORY_NOW % SLOT_MS);
const KEPT_MS = 7 * DAY;
const TOURNAMENT_MS = 4_800_000;
const { aster, varro, corvina, lucilla } = ARENA_GLADIATORS;
/** The gladiators the preview gives a history, by name. */
export const HISTORY_GLADIATORS = { aster, varro, corvina, lucilla } as const;
/** The 7 Oct evening tournament (bronze), the slot the kept runs are fought in. */
export const HISTORY_TOURNAMENT_STARTS = Date.UTC(2026, 9, 7, 18, 40);
export const HISTORY_TOURNAMENT_ID = `tournament:${HISTORY_TOURNAMENT_STARTS / SLOT_MS}:bronze`;
/** The kept tournament runs' activities (their replays: the late bracket's logs at the 7 Oct times). */
export const HISTORY_RUNS = { varro: fixtureUuid('history-run-varro'), corvina: fixtureUuid('history-run-corvina') } as const;
/** A replay expiry as the view states it at the fixture's time: the time while kept, else null. */
const expiryAt = (expiresAtMs: number | null) => (expiresAtMs !== null && expiresAtMs > HISTORY_NOW ? expiresAtMs : null);

function arenaRow(gladiatorId: string, activityId: string, at: { foughtAtMs: number; settledAtMs: number; expiresAtMs: number | null }, won: boolean, league: string | null,
  opponent: { name: string; npc: boolean } | null, mode: 'unranked' | null = null): HistoryViewRow {
  const expires = expiryAt(at.expiresAtMs);
  return { gladiator_id: gladiatorId, kind: 'arena', entry_id: activityId, activity_id: activityId, fought_at_ms: at.foughtAtMs, settled_at_ms: at.settledAtMs,
    result: won ? 'victory' : 'defeat', success: won, replay_expires_at_ms: expires, arena_mode: mode, league, tournament_id: null, round: null, place: null,
    expedition_id: null, opponent: expires === null ? null : opponent };
}
/** Older Arena bouts whose replays are gone: one every fourth slot back from `daysAgo` days before the fixture's time, W W L repeating. */
function olderBouts(gladiatorId: string, key: string, count: number, daysAgo: number, league: string): HistoryViewRow[] {
  return Array.from({ length: count }, (_, i) => {
    const start = SLOT_START - daysAgo * DAY - i * 4 * SLOT_MS;
    return arenaRow(gladiatorId, fixtureUuid(`history-${key}-arena-${i}`), { foughtAtMs: start + 60 * MIN, settledAtMs: start + 80 * MIN, expiresAtMs: null }, i % 3 !== 2, league, null);
  });
}
function expeditionRow(gladiatorId: string, activityId: string, expeditionId: string, at: { foughtAtMs: number; settledAtMs: number }, success: boolean): HistoryViewRow {
  return { gladiator_id: gladiatorId, kind: 'expedition', entry_id: activityId, activity_id: activityId, fought_at_ms: at.foughtAtMs, settled_at_ms: at.settledAtMs,
    result: success ? 'victory' : 'defeat', success, replay_expires_at_ms: expiryAt(at.settledAtMs + KEPT_MS), arena_mode: null, league: null, tournament_id: null,
    round: null, place: null, expedition_id: expeditionId, opponent: null };
}

const roundLabel = (round: number, rounds: number) =>
  round === rounds ? 'Final' : round === rounds - 1 ? 'Semifinal' : round === rounds - 2 ? 'Quarterfinal' : `Round ${round}`;
/**
 * One entrant's fought bouts of a public tournament view as history rows, and (when every bout still has its log) the run's replay
 * timeline as Task 19 phase 2b publishes it, without the owner summary another reader never gets. `at` moves the run to another slot (the
 * kept 7 Oct runs); by default it is the view's own. The place is the view's, or the one the bracket gives (Final 1 and 2, semifinal 3,
 * quarterfinal 5).
 */
function tournamentRun(view: TournamentView, gladiatorId: string, activityId: string, at?: { id: string; startsAtMs: number }) {
  const rounds = view.bracket!.rounds, startsAtMs = at?.startsAtMs ?? view.startsAtMs, id = at?.id ?? view.id;
  const reveal = (round: number) => startsAtMs + Math.ceil(TOURNAMENT_MS * round / (rounds + 1));
  const settledAtMs = startsAtMs + TOURNAMENT_MS, expires = expiryAt(settledAtMs + KEPT_MS);
  const fought = view.bouts.filter(b => b.revealedResult && !b.revealedResult.bye && b.revealedResult.participants.some(p => p.gladiatorId === gladiatorId))
    .sort((p, q) => p.round - q.round);
  const last = fought.at(-1)!, wonLast = last.revealedResult!.winnerId === gladiatorId;
  const place = view.placements.find(p => p.gladiatorId === gladiatorId)?.place
    ?? (wonLast && last.round === rounds ? 1 : last.round === rounds ? 2 : last.round === rounds - 1 ? 3 : 2 ** (rounds - last.round) + 1);
  const rows: HistoryViewRow[] = fought.map(b => {
    const result = b.revealedResult!, other = result.participants.find(p => p.gladiatorId !== gladiatorId)!;
    return { gladiator_id: gladiatorId, kind: 'tournament', entry_id: `${id}:${b.round}:${b.position}`, activity_id: activityId, fought_at_ms: reveal(b.round),
      settled_at_ms: settledAtMs, result: result.winnerId === gladiatorId ? 'victory' : 'defeat', success: result.winnerId === gladiatorId, replay_expires_at_ms: expires,
      arena_mode: null, league: view.league, tournament_id: id, round: roundLabel(b.round, rounds), place, expedition_id: null,
      opponent: expires === null ? null : { name: other.name, npc: false } };
  });
  const logs = fought.map(b => b.revealedResult!.battleLog);
  if (logs.some(log => !log)) return { rows, timeline: null };
  const stages: RevealedStage[] = [
    { id: `${activityId}:0`, kind: 'staging', revealedAtMs: startsAtMs, startedAtMs: startsAtMs, endsAtMs: reveal(fought[0].round), label: 'Tournament staging' },
    ...fought.map((b, i): RevealedStage => ({ id: `${activityId}:${b.round}`, kind: 'bout', revealedAtMs: reveal(b.round), startedAtMs: reveal(b.round),
      endsAtMs: reveal(b.round) + logs[i]!.durationMs, label: `${roundLabel(b.round, rounds)}: ${b.revealedResult!.winnerId === gladiatorId ? 'victory' : 'defeat'}`,
      battleLog: structuredClone(logs[i]) as BattleLog })),
    { id: `${activityId}:${rounds + 1}`, kind: 'return', revealedAtMs: settledAtMs, startedAtMs: settledAtMs, endsAtMs: settledAtMs, label: 'Results credited' },
  ];
  const timeline: RevealedTimeline = { activityId, serverNowMs: HISTORY_NOW, visibleThroughMs: HISTORY_NOW, stages };
  return { rows, timeline };
}

/** The bout stage of a timeline (an Arena bout's, or a tournament run's of one round). */
const boutStage = (timeline: RevealedTimeline, id?: string) => timeline.stages.find(s => s.kind === 'bout' && s.battleLog && (id === undefined || s.id === id));
/** The other participant of a log, from `gladiatorId`'s side. */
function opponentIn(log: BattleLog | undefined, gladiatorId: string): { name: string; npc: boolean } | null {
  const other = log?.participants.find(p => p.gladiatorId !== gladiatorId);
  return other ? { name: other.name, npc: other.gladiatorId === null } : null;
}

/** Aster's own history: her My bouts (Arena bouts and tournament runs, by bout) and her settled expeditions, from her own timelines. */
function asterRows(pool: Readonly<Record<string, RevealedTimeline>>, views: Readonly<Record<TournamentKey, TournamentView>>): HistoryViewRow[] {
  const rows: HistoryViewRow[] = [];
  for (const id of MY_BOUT_IDS) {
    const timeline = pool[id], summary = timeline.summary!;
    const expires = summary.replayExpiry.state === 'available' ? summary.replayExpiry.expiresAtMs : null;
    if (summary.resolvedKind === 'arena') {
      const stage = boutStage(timeline);
      rows.push(arenaRow(aster.id, id, { foughtAtMs: stage?.startedAtMs ?? summary.settledAtMs - 20 * MIN, settledAtMs: summary.settledAtMs, expiresAtMs: expires },
        summary.result === 'victory', 'bronze', opponentIn(stage?.battleLog, aster.id), summary.arenaMode ?? null));
      continue;
    }
    const key = (['completed', 'pair'] as const).find(k => tournamentActivityId(k, 'aster') === id)!;
    const view = views[key];
    for (const row of tournamentRun(view, aster.id, id).rows) {
      // Her run's own stages hold its times and its kept state (the view's slot), as the server's rows would.
      const round = Number(String(row.entry_id).split(':')[3]), stage = timeline.stages.find(s => s.id === `${id}:${round}`);
      rows.push({ ...row, fought_at_ms: stage?.startedAtMs ?? row.fought_at_ms, settled_at_ms: summary.settledAtMs, replay_expires_at_ms: expiryAt(expires),
        opponent: expiryAt(expires) === null ? null : opponentIn(stage?.battleLog, aster.id) });
    }
  }
  const trips: [string, string][] = [[EXPEDITION_FIXTURES.woodland.activityId, 'woodland'], [EXPEDITION_FIXTURES.mountain.activityId, 'mountain'],
    [EXPEDITION_FIXTURES.laststand.activityId, 'mountain'], [REPLAY_FIXTURES.cleared.activityId, 'woodland'], [EXPEDITION_FIXTURES.expired.activityId, 'woodland']];
  for (const [id, expeditionId] of trips) {
    const summary = pool[id].summary!;
    const foughtAtMs = Math.floor((summary.settledAtMs - MIN) / SLOT_MS) * SLOT_MS;
    const row = expeditionRow(aster.id, id, expeditionId, { foughtAtMs, settledAtMs: summary.settledAtMs }, summary.success);
    rows.push({ ...row, replay_expires_at_ms: summary.replayExpiry.state === 'available' ? expiryAt(summary.replayExpiry.expiresAtMs) : null });
  }
  return rows;
}

/**
 * The preview's history rows of every gladiator, and the replays the other gladiators' kept rows open that no other fixture holds
 * (the 7 Oct runs). `pool` holds the fixture timelines by activity id; `views` the public tournament views by sample key.
 */
export function buildHistoryFixtures(pool: Readonly<Record<string, RevealedTimeline>>, views: Readonly<Record<TournamentKey, TournamentView>>):
  { rows: HistoryViewRow[]; timelines: Record<string, RevealedTimeline> } {
  const at7Oct = { id: HISTORY_TOURNAMENT_ID, startsAtMs: HISTORY_TOURNAMENT_STARTS };
  const varroRun = tournamentRun(views.late, varro.id, HISTORY_RUNS.varro, at7Oct);
  const corvinaRun = tournamentRun(views.late, corvina.id, HISTORY_RUNS.corvina, at7Oct);
  // Varro's side of his bout with Aster, one slot ago (the spectator timeline: no summary).
  const spectator = pool[arenaActivityId('varroSpectator')], stage = boutStage(spectator)!, settled = spectator.stages.at(-1)!.startedAtMs;
  const varroBout = arenaRow(varro.id, spectator.activityId, { foughtAtMs: stage.startedAtMs, settledAtMs: settled, expiresAtMs: settled + KEPT_MS },
    stage.battleLog!.winnerId === varro.id, 'bronze', opponentIn(stage.battleLog, varro.id));
  // His Ruined Outpost trip (the spectator expedition fixture), settled when he arrived back at camp.
  const trip = pool[EXPEDITION_FIXTURES.spectator.activityId];
  const varroTrip = expeditionRow(varro.id, trip.activityId, 'outpost', { foughtAtMs: trip.stages[0].startedAtMs, settledAtMs: trip.stages.at(-1)!.endsAtMs + 45_000 }, false);
  const older = (gladiatorId: string, key: string, expeditionId: string, daysAgo: number, success: boolean) => {
    const start = SLOT_START - daysAgo * DAY;
    return expeditionRow(gladiatorId, fixtureUuid(`history-${key}-expedition`), expeditionId, { foughtAtMs: start, settledAtMs: start + SLOT_MS + 45_000 }, success);
  };
  const rows = [
    ...asterRows(pool, views),
    varroBout, ...olderBouts(varro.id, 'varro', 22, 8, 'bronze'), ...varroRun.rows,
    ...tournamentRun(views.completed, varro.id, tournamentActivityId('completed', 'varro')).rows, varroTrip, older(varro.id, 'varro', 'woodland', 12, true),
    ...corvinaRun.rows, ...tournamentRun(views.completed, corvina.id, tournamentActivityId('completed', 'corvina')).rows, ...olderBouts(corvina.id, 'corvina', 2, 9, 'bronze'),
    ...tournamentRun(views.aged, lucilla.id, fixtureUuid('history-run-lucilla-aged')).rows, ...olderBouts(lucilla.id, 'lucilla', 3, 10, 'silver'),
    older(lucilla.id, 'lucilla', 'woodland', 11, true),
  ];
  return { rows, timelines: { [HISTORY_RUNS.varro]: varroRun.timeline!, [HISTORY_RUNS.corvina]: corvinaRun.timeline! } };
}
