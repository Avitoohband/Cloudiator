// The words of watching an expedition (Patch A Task 9, spec "The live view" and "The whole-trip replay"): the named marks under the
// live view's 0-80 strip, and the camp chapters of the whole-trip replay, as the phase text under the scene and the banner over it.
// Pure: every time of day is a slot time against the view's display time (`slotTimeText`, in the form the clock setting asks for),
// and nothing here reads a clock. A mark tells only what the state at the display time holds: a fight still being fought is
// "now", never won or lost, and a fight not yet revealed is its due time.
import type { ClockMode } from '../../lib/clock-setting';
import { ENCOUNTER_INTERVAL_MS, EXPEDITION_ENCOUNTERS, EXPEDITION_MS, type ExpeditionSceneState } from '../../game/expedition-stage';
import { slotTimeText } from '../schedule/slot-time';

/**
 * One named mark: `id` is the chapter it stands at ('leaving', 'fight-1' … 'fight-4', 'back'), `fight` its fight's number, and
 * `replay` whether it is a button into the whole-trip replay at that fight (a revealed fight whose log is still kept).
 */
export type TripMark = { id: string; text: string; fight: 1 | 2 | 3 | 4 | null; replay: boolean };

/** A camp chapter of the replay: leaving through the gate, back through it, and the rest after it. */
export type CampKind = 'leaving' | 'back' | 'resting';

const named = (label: string, time: string) => (time ? `${label} · ${time}` : label);

/**
 * The marks of a trip departed at `departureMs`, as the live view shows them at `state.displayNowMs`: "Left camp · 12:20 AM",
 * each fight ("▶ Fight 1 · won", "▶ Fight 2 · lost", "Fight 2 · now", "Fight 2 · 1:00 AM" while it is due, "Fight 3 · not fought"
 * after a revealed defeat, and "Fight 1 · won" as plain text once its log is no longer kept), and "Back in camp · 1:40 AM".
 */
export function tripMarks(state: ExpeditionSceneState, departureMs: number, clock: ClockMode): TripMark[] {
  const at = (ms: number) => slotTimeText(ms, state.displayNowMs, clock);
  const defeated = state.stages.some(stage => stage.outcome === 'defeat' || (stage.kind === 'return' && !stage.final));
  const fights = Array.from({ length: EXPEDITION_ENCOUNTERS }, (_, i): TripMark => {
    const n = (i + 1) as 1 | 2 | 3;
    const id = `fight-${n}`;
    const stage = state.stages.find(candidate => candidate.encounter === n);
    if (!stage) return { id, fight: n, replay: false, text: defeated ? `Fight ${n} · not fought` : named(`Fight ${n}`, at(departureMs + n * ENCOUNTER_INTERVAL_MS)) };
    if (stage.inProgress) return { id, fight: n, replay: false, text: `Fight ${n} · now` };
    const result = stage.outcome === 'victory' ? 'won' : stage.outcome === 'defeat' ? 'lost' : null;
    const text = result ? `Fight ${n} · ${result}` : named(`Fight ${n}`, at(stage.startedAtMs));
    return { id, fight: n, replay: stage.replay, text: stage.replay ? `▶ ${text}` : text };
  });
  return [
    { id: 'leaving', fight: null, replay: false, text: named('Left camp', at(departureMs)) },
    ...fights,
    { id: 'back', fight: null, replay: false, text: named('Back in camp', at(departureMs + EXPEDITION_MS)) },
  ];
}

/**
 * The phase text under the scene in a camp chapter. The rest's stamina (`gain`) is the owner's, and only while that rest is its
 * current activity; anyone else gets null and the line without it.
 */
export function campPhase(kind: CampKind, expedition: string, outcome: 'success' | 'failure' | null, gain: number | null): { title: string; detail: string } {
  if (kind === 'leaving') return { title: 'Leaving camp', detail: `Through the gate and onto the ${expedition}.` };
  if (kind === 'back') return { title: 'Back in camp', detail: outcome === 'failure' ? 'Home through the gate, with all gear kept.' : 'Home through the gate with the loot.' };
  return { title: 'Resting in camp', detail: `Sleeps through the next slot.${gain === null ? '' : ` Stamina refills to full when it ends: +${gain}.`}` };
}

/**
 * The banner over the scene in a camp chapter: "Leaving camp", "Back in camp", and "Resting until 3:00 AM · stamina refills to 104"
 * ("Resting · stamina to 104" in the touch layout, `compact`). `restEndMs` is when the rest ends, shown against `nowMs`; `maximum`
 * is the owner's stamina maximum while that rest is its current activity, null for anyone else (and then the stamina is left out).
 */
export function campBanner(kind: CampKind, restEndMs: number, nowMs: number, clock: ClockMode, maximum: number | null, compact: boolean): string {
  if (kind === 'leaving') return 'Leaving camp';
  if (kind === 'back') return 'Back in camp';
  if (compact) return maximum === null ? 'Resting' : `Resting · stamina to ${maximum}`;
  const until = slotTimeText(restEndMs, nowMs, clock);
  return `Resting${until ? ` until ${until}` : ''}${maximum === null ? '' : ` · stamina refills to ${maximum}`}`;
}
