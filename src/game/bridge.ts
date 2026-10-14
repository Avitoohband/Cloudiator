// Typed event bridge between the Phaser scenes and React management panels.
// Scenes emit user intent (select, open merchant, view replay...); panels send camera commands.
export type SceneEvents = {
  'select-character': { gladiatorId: string };
  'open-merchant': { merchant: 'weapons' | 'armor' };
  'view-expedition': { activityId: string };
  'view-replay': { activityId: string };
  'return-camp': Record<string, never>;
  'follow-character': { gladiatorId: string | null };
  /** UI to scene: zoom buttons and character search. */
  'camera-zoom': { direction: 'in' | 'out' | 'reset' };
  'camera-pan': { dx: number; dy: number };
  'find-character': { gladiatorId: string };
  /** Scene to UI: who is away on an expedition and who is visible in camp. */
  roster: { inCamp: string[]; away: { gladiatorId: string; name: string; location: string }[] };
  /** Scene to UI: the camp view could not start (no WebGL or failed assets). */
  'scene-unavailable': { reason: 'webgl' | 'assets' | 'error'; message: string };
  /** Scene or keyboard UI to the page: open the Arena card for an entrant's activity (an NPC opens its entrant's). */
  'open-arena': { activityId: string; gladiatorId: string | null };
  /** Scene to UI: the revealed bouts in the arena's sparring rings now, for keyboard selection. Names are public. */
  'arena-fights': { fights: ArenaFightSummary[] };
};
export type ArenaFightSummary = {
  battleId: string;
  /** In participant order; an NPC side has no gladiator and opens its entrant's activity. */
  sides: [ArenaFightSide, ArenaFightSide];
  status: 'entering' | 'fighting' | 'result';
};
export type ArenaFightSide = { gladiatorId: string | null; name: string; activityId: string; npc: boolean };
export type SceneEventName = keyof SceneEvents;
export type Listener<E extends SceneEventName> = (payload: SceneEvents[E]) => void;

export type SceneBridge = {
  on<E extends SceneEventName>(event: E, listener: Listener<E>): () => void;
  emit<E extends SceneEventName>(event: E, payload: SceneEvents[E]): void;
  listenerCount(): number;
  destroy(): void;
};

export function createSceneBridge(): SceneBridge {
  const listeners = new Map<SceneEventName, Set<(payload: never) => void>>();
  let destroyed = false;
  return {
    on(event, listener) {
      if (destroyed) return () => {};
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (payload: never) => void);
      listeners.set(event, set);
      return () => { set.delete(listener as (payload: never) => void); };
    },
    emit(event, payload) {
      if (destroyed) return;
      for (const listener of [...(listeners.get(event) ?? [])]) (listener as (p: typeof payload) => void)(payload);
    },
    listenerCount() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
    destroy() {
      destroyed = true;
      listeners.clear();
    },
  };
}
