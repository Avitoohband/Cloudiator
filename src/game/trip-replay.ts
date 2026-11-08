// Pure planner for the whole-trip replay (Patch A Task 7). A trip is 80 minutes of display time; the replay shows all of it in
// about 1¼ minutes by playing each part at its own speed: the camp's gate at its ends (5 s each, and the rest 6 s), every fight
// at its real speed with its result poses, every walk between spots at x8, and only the searching and waiting around the walks
// compressed (x150 for the stretch they sit in, shared out in proportion to their length). The plan cuts the trip into
// chapters, and maps a replay position (ms into the replay) to the display time the expedition scene draws, and back.
// It reads a revealed timeline at the viewer's display clock (`nowMs`, always given) and says nothing the clock has not
// revealed: a stage that is not revealed yet is not read, a fight not yet revealed is an empty chapter and so is everything after
// it, and a fight still being fought is not decided, whatever its log says. It never reads the real clock and uses no Phaser,
// React or randomness, so the same inputs always give the same plan.
import type { RevealedTimeline } from '@contracts/events';
import { ENCOUNTER_INTERVAL_MS, EXPEDITION_ENCOUNTERS, EXPEDITION_MS, encounterOutcome, isFinal, stageWalks, type JourneyPoint, type StageWalk } from './expedition-stage';
import { REPLAY_OUTRO_MS } from './replay';

/**
 * How the replay is paced: the trail plays `travel` times faster than it happened, a walk `walk` times, and the camp's
 * bookends and the rest last `campMs` and `restMs` of replay time.
 */
export const TRIP_PACE = { travel: 150, walk: 8, campMs: 5_000, restMs: 6_000 } as const;

export type TripChapterId = 'leaving' | 'trail' | 'fight-1' | 'fight-2' | 'fight-3' | 'fight-4' | 'heading-home' | 'safe-point' | 'back' | 'resting';

/**
 * One chapter: `startMs` to `endMs` of replay time, which show `displayFromMs` to `displayToMs` of display time. A camp
 * chapter (`vignette`) shows one display time, the departure (leaving) or the end of the slot (back, resting). A chapter whose
 * stage the timeline does not hold yet (`revealed: false`) has no length and shows the one display time it will start at.
 */
export type TripChapter = {
  id: TripChapterId;
  label: string;
  startMs: number;
  endMs: number;
  vignette: 'leaving' | 'back' | 'resting' | null;
  displayFromMs: number;
  displayToMs: number;
  revealed: boolean;
};

/**
 * `displayFromMs` to `displayToMs` of display time played in `startMs` to `endMs` of replay time, at `rate` display ms per
 * replay ms (Infinity when the stretch is skipped, with no replay time). The planner's own: read the chapters instead.
 */
export type TripPiece = { readonly fromMs: number; readonly toMs: number; readonly startMs: number; readonly endMs: number; readonly rate: number };

/** `endMs` is the end of the 80-minute slot, `departureMs` its start; `totalMs` the length of the replay. */
export type TripPlan = { chapters: TripChapter[]; totalMs: number; departureMs: number; endMs: number; readonly pieces: readonly TripPiece[] };

export type TripPlanOptions = {
  /** How long the gladiator takes to walk a leg, in display ms (at the walking speed over the map's path). */
  walkMs(from: JourneyPoint, to: JourneyPoint): number;
  /** The gladiator's next activity really was a Rest: the replay ends with it. */
  resting: boolean;
  /**
   * The viewer's display clock (estimated server time), required: a finished trip passes it too, with the same result. The
   * plan reads only the stages revealed by then (`revealedAtMs <= nowMs`, as `renderExpeditionStage` does, so an uncut timeline
   * plans like a cut one), and a fight that has not ended by then is not decided yet, however much its log says: it is a fight
   * with the rest to come, not a defeat, so the chapters do not give away the result of a fight being fought. A clock that is
   * not a number reveals nothing (no plan).
   */
  nowMs: number;
};

const finite = (ms: number) => (Number.isFinite(ms) && ms > 0 ? ms : 0);

export function planTrip(timeline: RevealedTimeline, options: TripPlanOptions): TripPlan | null {
  const { nowMs } = options;
  const stages = timeline.stages.filter(stage => stage.revealedAtMs <= nowMs);
  const departure = stages.find(stage => stage.kind === 'depart');
  if (!departure) return null;
  const departureMs = departure.startedAtMs;
  const endMs = departureMs + EXPEDITION_MS;
  const fights = stages.filter(stage => stage.kind === 'encounter').slice(0, EXPEDITION_ENCOUNTERS);
  const walks = stageWalks({ ...timeline, stages });
  /** The display time fight `n` is due at, when its stage is not revealed. */
  const dueAt = (n: number) => departureMs + n * ENCOUNTER_INTERVAL_MS;
  const startOf = (n: number) => fights[n - 1]?.startedAtMs ?? dueAt(n);
  const overAt = (n: number) => fights[n - 1].endsAtMs + REPLAY_OUTRO_MS;
  const outcomeOf = (n: number) => {
    const stage = fights[n - 1];
    const outcome = encounterOutcome(stage, stages[stages.indexOf(stage) + 1]);
    return stage.endsAtMs <= nowMs ? outcome : null;
  };

  const chapters: TripChapter[] = [];
  const pieces: TripPiece[] = [];
  let cursor = 0;
  const piece = (fromMs: number, toMs: number, lengthMs: number) => {
    const startMs = cursor;
    cursor += lengthMs;
    pieces.push({ fromMs, toMs, startMs, endMs: cursor, rate: lengthMs > 0 ? (toMs - fromMs) / lengthMs : Infinity });
  };
  /** A fight from its start to the end of its result poses, at real speed (`toMs` cuts it short at the next chapter). */
  const fight = (n: number, toMs = overAt(n)) => { const from = fights[n - 1].startedAtMs; piece(from, toMs, toMs - from); };
  /**
   * The display time `fromMs` to `toMs` between two fights, in `(toMs - fromMs) / TRIP_PACE.travel` of replay time: each walk
   * of `stageWalks` takes what it takes at x8, the searching and waiting around the walks share what is left in proportion to
   * their length (nothing when the walks use it up). The steps a search takes around its spot are not walks: they are part of
   * the search, as `stageWalks` says.
   */
  const stretch = (fromMs: number, toMs: number) => {
    if (toMs <= fromMs) return;
    const parts: { from: number; to: number; walking: boolean }[] = [];
    const legs = walks.filter(walk => walk.atMs >= fromMs && walk.atMs < toMs);
    let at = fromMs;
    legs.forEach((leg: StageWalk, i) => {
      if (leg.atMs > at) parts.push({ from: at, to: leg.atMs, walking: false });
      const next = i + 1 < legs.length ? legs[i + 1].atMs : toMs;
      const end = Math.min(leg.atMs + finite(options.walkMs(leg.from, leg.to)), next);
      if (end > leg.atMs) parts.push({ from: leg.atMs, to: end, walking: true });
      at = Math.max(leg.atMs, end);
    });
    if (toMs > at) parts.push({ from: at, to: toMs, walking: false });
    const walking = parts.filter(part => part.walking).reduce((sum, part) => sum + (part.to - part.from) / TRIP_PACE.walk, 0);
    const waiting = parts.filter(part => !part.walking).reduce((sum, part) => sum + (part.to - part.from), 0);
    const left = Math.max(0, (toMs - fromMs) / TRIP_PACE.travel - walking);
    for (const part of parts) {
      const length = part.to - part.from;
      piece(part.from, part.to, part.walking ? length / TRIP_PACE.walk : waiting > 0 ? left * (length / waiting) : 0);
    }
  };

  const chapter = (id: TripChapterId, label: string, displayFromMs: number, displayToMs: number, play: () => void, revealed = true) => {
    const startMs = cursor;
    if (revealed) play();
    chapters.push({ id, label, startMs, endMs: cursor, vignette: null, displayFromMs, displayToMs, revealed });
  };
  const camp = (id: 'leaving' | 'back' | 'resting', label: string, displayMs: number, lengthMs: number, revealed = true) => {
    const startMs = cursor;
    if (revealed) cursor += lengthMs;
    chapters.push({ id, label, startMs, endMs: cursor, vignette: id, displayFromMs: displayMs, displayToMs: displayMs, revealed });
  };

  camp('leaving', 'Leaving camp', departureMs, TRIP_PACE.campMs);
  chapter('trail', 'On the trail', departureMs, startOf(1), () => stretch(departureMs, startOf(1)));

  // The fights in order, until one is lost or one is not decided: what follows is not known yet. `over` is where the last
  // fight's result poses end, the display time the walk home (or to the safe point) starts at.
  let ahead: 'home' | 'lost' | 'unknown' = 'home';
  let over = endMs;
  for (let n = 1; n <= EXPEDITION_ENCOUNTERS; n += 1) {
    const id = `fight-${n}` as TripChapterId;
    if (ahead === 'lost') break;
    if (ahead === 'unknown' || !fights[n - 1]) {
      ahead = 'unknown';
      chapter(id, `Fight ${n}`, dueAt(n), dueAt(n), () => undefined, false);
      continue;
    }
    const outcome = outcomeOf(n);
    if (outcome === 'defeat') {
      chapter(id, `Fight ${n} ✗`, startOf(n), overAt(n), () => fight(n));
      ahead = 'lost';
      over = overAt(n);
      continue;
    }
    // A won fight runs on to the next one's minute, with the walking and searching in between; the last one, to its end.
    const to = n < EXPEDITION_ENCOUNTERS ? startOf(n + 1) : overAt(n);
    chapter(id, `Fight ${n}`, startOf(n), to, () => { fight(n, Math.min(overAt(n), to)); stretch(overAt(n), to); });
    if (outcome === null) ahead = 'unknown';
    else if (n === EXPEDITION_ENCOUNTERS) over = overAt(n);
  }

  if (ahead === 'lost') chapter('safe-point', 'Safe point', over, endMs, () => stretch(over, endMs));
  else if (ahead === 'home') chapter('heading-home', 'Heading home', over, endMs, () => stretch(over, endMs));
  else chapter('heading-home', 'Heading home', endMs, endMs, () => undefined, false);

  // The gate is there once the arrival is revealed, and the rest only after it, when the caller knows the next slot was a Rest.
  const arrived = ahead !== 'unknown' && stages.some(isFinal);
  camp('back', 'Back in camp', endMs, TRIP_PACE.campMs, arrived);
  if (arrived && options.resting) camp('resting', 'Resting', endMs, TRIP_PACE.restMs);

  return { chapters, totalMs: cursor, departureMs, endMs, pieces };
}

/**
 * The latest moment by `nowMs` at which the plan can have changed: a stage's reveal or a fight's end (-Infinity before anything is
 * revealed). The plan reads the display clock only through which stages are revealed (`revealedAtMs <= nowMs`) and which fights
 * have ended (`endsAtMs <= nowMs`), so the plan of the timeline cut at this moment, at this moment, is the plan at `nowMs`; a
 * view that keys its plan on it rebuilds the plan each time its clock passes one of them, and at no other time (Patch A Task 9).
 */
export function tripBoundary(timeline: RevealedTimeline, nowMs: number): number {
  let at = -Infinity;
  for (const stage of timeline.stages) {
    if (stage.revealedAtMs > nowMs) continue;
    at = Math.max(at, stage.revealedAtMs);
    if (stage.kind === 'encounter' && stage.endsAtMs <= nowMs) at = Math.max(at, stage.endsAtMs);
  }
  return at;
}

/**
 * What the scene of a camp chapter draws: which one, how far into it, and how long it lasts (replay ms), and the display time the
 * chapter shows (the departure, or the end of the slot: the light of its time of day).
 */
export type TripVignette = { kind: 'leaving' | 'back' | 'resting'; elapsedMs: number; durationMs: number; displayMs: number };
/** The chapter at a replay position and the display time the expedition scene draws there (the camp's vignettes draw none). */
export type TripFrame = { chapter: TripChapter; index: number; displayMs: number; vignette: TripVignette | null };

const within = (ms: number, low: number, high: number) => Math.min(high, Math.max(low, Number.isNaN(ms) ? low : ms));

/** The chapter a replay position falls in: the first that ends after it; past the end, the last one that has a length. */
function chapterAt(plan: TripPlan, positionMs: number): number {
  const index = plan.chapters.findIndex(chapter => positionMs < chapter.endMs);
  if (index >= 0) return index;
  for (let i = plan.chapters.length - 1; i >= 0; i -= 1) if (plan.chapters[i].endMs > plan.chapters[i].startMs) return i;
  return 0;
}

/** The frame at `positionMs` of the replay (held to the replay's first and last moment). */
export function tripFrame(plan: TripPlan, positionMs: number): TripFrame {
  const position = within(positionMs, 0, plan.totalMs);
  const index = chapterAt(plan, position);
  const chapter = plan.chapters[index];
  if (chapter.vignette) {
    // The exact length of the camp chapter, not the difference of two replay times, which carries the sum of every chapter
    // before it (6000.000000000007 ms for a Rest after a long trip).
    const durationMs = chapter.vignette === 'resting' ? TRIP_PACE.restMs : TRIP_PACE.campMs;
    const elapsedMs = position >= chapter.endMs ? durationMs : within(position - chapter.startMs, 0, durationMs);
    return { chapter, index, displayMs: chapter.displayFromMs, vignette: { kind: chapter.vignette, elapsedMs, durationMs, displayMs: chapter.displayFromMs } };
  }
  // The last piece that has started: its display time at this position, never past its end.
  let displayMs = plan.pieces[0]?.fromMs ?? chapter.displayFromMs;
  for (const piece of plan.pieces) {
    if (piece.endMs <= piece.startMs || piece.startMs > position) continue;
    displayMs = Math.min(piece.toMs, piece.fromMs + (position - piece.startMs) * piece.rate);
  }
  return { chapter, index, displayMs, vignette: null };
}

/**
 * The replay position that shows `displayMs`: where the replay is when the trip is that far on. A time before the departure
 * is the start of the trail (the leaving chapter comes before it), one past what the plan shows (the end of the slot, or the
 * last stage a running trip has) is the end of what it shows, and a time inside a stretch the replay skips is where that
 * stretch starts. Position and display time round-trip wherever the replay plays the display time, and never run backwards.
 */
export function tripPositionOf(plan: TripPlan, displayMs: number): number {
  if (Number.isNaN(displayMs)) return plan.pieces[0]?.startMs ?? 0;
  for (const piece of plan.pieces) {
    if (displayMs > piece.toMs) continue;
    if (displayMs === piece.toMs) return piece.endMs;
    if (displayMs <= piece.fromMs || piece.endMs <= piece.startMs) return piece.startMs;
    return piece.startMs + (displayMs - piece.fromMs) / piece.rate;
  }
  return plan.pieces.at(-1)?.endMs ?? 0;
}

/**
 * The index of the first chapter a running trip does not let the replay reach: the first that starts after `capMs` (the
 * position of the display time now, `tripPositionOf`), or whose stage the timeline does not hold yet. A chapter that is not
 * revealed is locked with or without a cap (a trip past minute 80 whose fight never came has nothing to play there).
 * `chapters.length` when nothing is locked (a finished trip, with no cap).
 */
export function firstLocked(plan: TripPlan, capMs: number | null): number {
  const index = plan.chapters.findIndex(chapter => !chapter.revealed || (capMs !== null && chapter.startMs > capMs));
  return index < 0 ? plan.chapters.length : index;
}

/** Elapsed or total replay time as the bar writes it: minutes and seconds, `'1:16'`. */
export function clockText(ms: number): string {
  const seconds = Math.floor((Number.isFinite(ms) && ms > 0 ? ms : 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
