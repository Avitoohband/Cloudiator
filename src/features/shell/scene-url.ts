// Scenes over the camp in the address (plan Decision 4): a replay, an expedition or a tournament bout opened over the camp is a
// history entry on the camp's own route, `?view=replay&activity=<id>[&stage=<id>]`, `?view=expedition&activity=<id>[&play=trip]`
// (`play=trip` opens the expedition as the whole-trip replay, Patch A) or `?view=bout&tournament=<id>&bout=<id>` (a bracket's
// bout, which has no activity: Arena replays Task 3), so a shared link opens it straight over the camp and the browser's Back
// closes it. A `from=<origin>` parameter names the menu the scene was opened from, so Back says where it goes and, after a
// reload, opens that menu again (Arena replays Task 3). The /replay/ and /expedition/ pages stay as deep links. Nothing here
// touches the history; `useSceneHistory` does.
import type { PublicActivitySummary } from '@contracts/events';
import type { BoutFilter } from '../../lib/api/reads';
import { TOURNAMENT_BOUT_ID, TOURNAMENT_ID } from '../../lib/tournament-id';
import { isActivityId } from '../character/expedition-query';

/**
 * Where a scene was opened from, so that "Back" can name it and the shell can open it again: a row of My bouts (`bouts`, and
 * `bouts-won` / `bouts-lost` for the chip it was under), of Everyone's results, the Arena card, a notification, a tournament
 * bracket or the Gladiators list. No origin: the camp itself (a camp button, a shared link, a clicked gladiator).
 */
export type SceneFrom = 'bouts' | 'bouts-won' | 'bouts-lost' | 'results' | 'arena' | 'notifications' | 'tournaments' | 'gladiators';
export type SceneView =
  | { kind: 'replay'; activityId: string; stageId?: string; from?: SceneFrom }
  | { kind: 'expedition'; activityId: string; play?: 'trip'; from?: SceneFrom }
  | { kind: 'bout'; tournamentId: string; boutId: string; from?: SceneFrom };
/**
 * A scene the address names. As on the expedition page (`expeditionQuery`), its activity id must be UUID-shaped, and a
 * bout's tournament and bout ids must be as the server writes them: a malformed one (a mangled shared link) names nothing,
 * so the scene says "not found" and reads nothing (final review Minor 6).
 */
export type SceneAddress = SceneView | { kind: SceneView['kind']; activityId: null };

const ORIGINS: readonly SceneFrom[] = ['bouts', 'bouts-won', 'bouts-lost', 'results', 'arena', 'notifications', 'tournaments', 'gladiators'];
const SCENE_PARAMS = ['view', 'activity', 'stage', 'play', 'tournament', 'bout', 'from'] as const;

/** The address names no scene's parts: a malformed activity or bout. */
const unnamed = (view: SceneAddress): view is { kind: SceneView['kind']; activityId: null } => 'activityId' in view && view.activityId === null;

/** The scene with every part it needs, or null when the address names a malformed one (the scene then says "not found"). */
export const namedScene = (view: SceneAddress): SceneView | null => (unnamed(view) ? null : view);

/** The origin the address names, or none for anything that is not one of ours. */
const originOf = (search: Pick<URLSearchParams, 'get'>): { from?: SceneFrom } => {
  const from = search.get('from');
  const known = ORIGINS.find(origin => origin === from);
  return known ? { from: known } : {};
};

/** The origin a scene was opened from, if any (a scene whose address names nothing has none). */
export const sceneFromOf = (view: SceneAddress): SceneFrom | undefined => ('from' in view ? view.from : undefined);

/** The scene an address names, or null. */
export function sceneOf(search: Pick<URLSearchParams, 'get'>): SceneAddress | null {
  const view = search.get('view');
  if (view === 'bout') {
    const tournamentId = search.get('tournament');
    const boutId = search.get('bout');
    if (!tournamentId && !boutId) return null;
    // The bout must belong to that tournament: its id is the tournament's, then ":" and the round and place.
    return tournamentId && boutId && TOURNAMENT_ID.test(tournamentId) && TOURNAMENT_BOUT_ID.test(boutId) && boutId.startsWith(`${tournamentId}:`)
      ? { kind: 'bout', tournamentId, boutId, ...originOf(search) } : { kind: 'bout', activityId: null };
  }
  const activityId = search.get('activity');
  if (!activityId || (view !== 'replay' && view !== 'expedition')) return null;
  if (!isActivityId(activityId)) return { kind: view, activityId: null };
  // Only `play=trip` names the whole-trip replay; any other value is ignored, so a mangled link still opens the live view.
  if (view === 'expedition') return search.get('play') === 'trip' ? { kind: 'expedition', activityId, play: 'trip', ...originOf(search) } : { kind: 'expedition', activityId, ...originOf(search) };
  const stageId = search.get('stage');
  return stageId ? { kind: 'replay', activityId, stageId, ...originOf(search) } : { kind: 'replay', activityId, ...originOf(search) };
}

/** What tells two scenes of one kind and activity apart: a replay's stage, an expedition's whole-trip `play` (undefined for none). */
export const sceneDetail = (view: SceneAddress): string | undefined => (unnamed(view) || view.kind === 'bout' ? undefined : view.kind === 'replay' ? view.stageId : view.play);

/**
 * The scene's identity without its origin: `replay|<activity>|<stage>`, `expedition|<activity>|<play>`, `bout|<tournament>` (a
 * bracket's bouts are chapters of one scene), `<kind>|null` for an address that names nothing.
 */
export function sceneKeyOf(view: SceneAddress): string {
  if (unnamed(view)) return `${view.kind}|null`;
  return view.kind === 'bout' ? `bout|${view.tournamentId}` : `${view.kind}|${view.activityId}|${sceneDetail(view) ?? ''}`;
}

/**
 * Whether the scene the address shows (if any) is `view`, so that opening it again would add nothing. The origin is not part of
 * it: the same scene opened from elsewhere is still the one on screen. A bracket's bout is told apart by its bout id.
 */
export function sameScene(shown: SceneAddress | null, view: SceneView): boolean {
  if (!shown || unnamed(shown) || shown.kind !== view.kind) return false;
  if (shown.kind === 'bout') return view.kind === 'bout' && shown.tournamentId === view.tournamentId && shown.boutId === view.boutId;
  return view.kind !== 'bout' && shown.activityId === view.activityId && sceneDetail(shown) === sceneDetail(view);
}

/** A pending step still belongs to this exact source, including its origin/filter, before replacing the live address. */
export function sameSceneSource(shown: SceneAddress | null, source: SceneView): boolean {
  return shown !== null && sameScene(shown, source) && sceneFromOf(shown) === sceneFromOf(source);
}

/** `href` (an absolute address) with its scene replaced by `view`: the same route and options, as a path and search. */
export function sceneHref(href: string, view: SceneView): string {
  const url = new URL(href);
  for (const name of SCENE_PARAMS) url.searchParams.delete(name);
  url.searchParams.set('view', view.kind);
  if (view.kind === 'bout') {
    url.searchParams.set('tournament', view.tournamentId);
    url.searchParams.set('bout', view.boutId);
  } else {
    url.searchParams.set('activity', view.activityId);
    if (view.kind === 'replay' && view.stageId) url.searchParams.set('stage', view.stageId);
    if (view.kind === 'expedition' && view.play === 'trip') url.searchParams.set('play', 'trip');
  }
  if (view.from) url.searchParams.set('from', view.from);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `href` (an absolute address) without its scene: the camp. */
export function campHref(href: string): string {
  const url = new URL(href);
  for (const name of SCENE_PARAMS) url.searchParams.delete(name);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The name on a scene's back button: the menu it goes back to, or the camp. */
export function backLabel(from: SceneFrom | undefined): 'My bouts' | 'Results' | 'Arena' | 'Notifications' | 'Tournaments' | 'Gladiators' | 'Camp' {
  switch (from) {
    case 'bouts': case 'bouts-won': case 'bouts-lost': return 'My bouts';
    case 'results': return 'Results';
    case 'arena': return 'Arena';
    case 'notifications': return 'Notifications';
    case 'tournaments': return 'Tournaments';
    case 'gladiators': return 'Gladiators';
    default: return 'Camp';
  }
}

/** The My bouts chip a scene's origin was under, which Back (and a reload) opens again; null for any other origin. */
export function boutFilterOf(from: SceneFrom | undefined): BoutFilter | null {
  return from === 'bouts' ? 'all' : from === 'bouts-won' ? 'won' : from === 'bouts-lost' ? 'lost' : null;
}

/** The origin a My bouts row opens its scene with: its chip, which Back (and a reload) opens again (`boutFilterOf` reads it back). */
export function boutsFrom(filter: BoutFilter): Extract<SceneFrom, 'bouts' | 'bouts-won' | 'bouts-lost'> {
  return filter === 'won' ? 'bouts-won' : filter === 'lost' ? 'bouts-lost' : 'bouts';
}

/**
 * The scene a recent result opens: an expedition its whole-trip replay (Patch A), an Arena or tournament bout its battle
 * replay. Training and Rest have no replay (Tasks 7, 9), so none.
 */
export function sceneForResult(activityId: string, kind: PublicActivitySummary['resolvedKind']): SceneView | null {
  if (kind === 'expedition') return { kind: 'expedition', activityId, play: 'trip' };
  return kind === 'arena' || kind === 'tournament' ? { kind: 'replay', activityId } : null;
}
