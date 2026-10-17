// Scenes over the camp in the address (plan Decision 4): a replay or an expedition opened over the camp is a history
// entry on the camp's own route, `?view=replay&activity=<id>[&stage=<id>]` or `?view=expedition&activity=<id>`, so a
// shared link opens it straight over the camp and the browser's Back closes it. The /replay/ and /expedition/ pages stay
// as deep links. Nothing here touches the history; `useSceneHistory` does.
import type { PublicActivitySummary } from '@contracts/events';

export type SceneView = { kind: 'replay'; activityId: string; stageId?: string } | { kind: 'expedition'; activityId: string };

const SCENE_PARAMS = ['view', 'activity', 'stage'] as const;

/** The scene an address names, or null. */
export function sceneOf(search: Pick<URLSearchParams, 'get'>): SceneView | null {
  const view = search.get('view');
  const activityId = search.get('activity');
  if (!activityId) return null;
  if (view === 'expedition') return { kind: 'expedition', activityId };
  if (view !== 'replay') return null;
  const stageId = search.get('stage');
  return stageId ? { kind: 'replay', activityId, stageId } : { kind: 'replay', activityId };
}

/** `href` (an absolute address) with its scene replaced by `view`: the same route and options, as a path and search. */
export function sceneHref(href: string, view: SceneView): string {
  const url = new URL(href);
  for (const name of SCENE_PARAMS) url.searchParams.delete(name);
  url.searchParams.set('view', view.kind);
  url.searchParams.set('activity', view.activityId);
  if (view.kind === 'replay' && view.stageId) url.searchParams.set('stage', view.stageId);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `href` (an absolute address) without its scene: the camp. */
export function campHref(href: string): string {
  const url = new URL(href);
  for (const name of SCENE_PARAMS) url.searchParams.delete(name);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The scene a recent result opens: an expedition its expedition, an Arena or tournament bout its battle replay. Training
 * and Rest have no replay (Tasks 7, 9), so none.
 */
export function sceneForResult(activityId: string, kind: PublicActivitySummary['resolvedKind']): SceneView | null {
  if (kind === 'expedition') return { kind: 'expedition', activityId };
  return kind === 'arena' || kind === 'tournament' ? { kind: 'replay', activityId } : null;
}
