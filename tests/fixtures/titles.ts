import type { EarnedTitle, OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import { worldFixture } from './domain';

// Patch 1.7: the fixture owner's titles (spec "Client": Aster wears Founder, 8 earned), shared by the fixture preview
// (src/lib/api/fixture-gateway.ts), the picker's unit tests and the live-routed browser specs.

/** Aster's 8 earned titles, all counted from her history at one time (the release's back-fill). */
export const ASTER_TITLES: readonly EarnedTitle[] = ['founder', 'wanderer', 'tiro', 'bloodied', 'finalist', 'collector', 'rare-find', 'moneyed']
  .map(id => ({ id, earnedAtMs: worldFixture.serverNowMs, activityId: null, source: 'history' as const, detail: null }));

/**
 * Patch 1.7.1: the one hand-given title the fixture owner can hold (source `award`, no activity). Aster's own 8 stay the non-holder path;
 * a holder test adds this one (`withAsterAward`, or the browser specs' `extra`).
 */
export const ASTER_AWARD: EarnedTitle = { id: 'game-master', earnedAtMs: worldFixture.serverNowMs + 60_000, activityId: null, source: 'award', detail: null };

/** The mockup's progress toward the rest (spec "Progress"); counters the owner read leaves out count 0. */
export const ASTER_TITLE_PROGRESS: Readonly<Record<string, number>> = { 'expeditions-won': 34, 'outpost-won': 13, 'woodland-won': 21, trainings: 46,
  'arena-wins': 18, 'arena-best-streak': 3, 'tournament-finals': 1, 'items-owned': 14, 'tiers-of-one': 2, 'rarities-of-one': 2, 'gold-earned': 1240,
  'days-in-camp': 21 };

/** `owner` with Aster's titles and progress, wearing Founder (a copy: the owner's own arrays are never shared). */
export const withAsterTitles = (owner: OwnerState, wornTitle: string | null = 'founder'): OwnerState =>
  ({ ...owner, wornTitle, titles: structuredClone([...ASTER_TITLES]), titleProgress: { ...ASTER_TITLE_PROGRESS } });

/**
 * The title notices the server counts in `inbox.newNotifications` (Task 4): the distinct source and time among the titles with no
 * activity and a source other than `joined`, after the "seen up to" mark. The fixture preview's inbox adds them (Task 11).
 */
export const titleNoticeCount = (titles: readonly EarnedTitle[], seenMs: number): number =>
  new Set(titles.filter(t => t.activityId === null && t.source !== 'joined' && t.earnedAtMs > seenMs).map(t => `${t.source}:${t.earnedAtMs}`)).size;

/** `owner` as a holder of Aster's hand-given title as well (Earned 9, All 32). */
export const withAsterAward = (owner: OwnerState): OwnerState => ({ ...owner, titles: [...owner.titles, structuredClone(ASTER_AWARD)] });
