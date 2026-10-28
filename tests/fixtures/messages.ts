import type { ActivitySummary } from '../../supabase/functions/_shared/contracts/events.ts';
import type { GameMessage, GameNotification, Inbox } from '../../supabase/functions/_shared/contracts/reads.ts';

/**
 * Sample game messages for the fixture preview (`?mode=fixture`), newest first, as `GameGateway.messages()` lists them: an
 * admin note, a patch note with the Change look action and an older patch note. They are sample text for the preview, not the
 * release's patch notes (those are posted at release time with `private.post_message`).
 */
export const FIXTURE_MESSAGES: readonly GameMessage[] = [
  { id: 3, kind: 'admin', title: 'A note from the game master', preview: 'Thanks for playing: tell us what you would like to see next.',
    body: [{ p: 'Thanks for playing the preview.' }, { p: 'Tell us what you would like to see next.' }], action: null, publishedAtMs: 1_791_590_000_000 },
  { id: 2, kind: 'patch-notes', title: 'New: choose your gladiator\'s look', preview: 'Pick a body, hair and colours. Changing your look is free for now.',
    body: [{ li: 'Gladiators now have their own look.' }, { li: 'New gladiators choose a look when they are created.' }], action: 'change-look', publishedAtMs: 1_791_580_000_000 },
  { id: 1, kind: 'patch-notes', title: 'Evening Arena and clearer menus', preview: 'Arena and tournaments move to the evening.',
    body: [{ p: 'What changed:' }, { li: 'Arena runs in the evening part of the day only.' }, { li: 'Menus are easier to read.' }], action: null, publishedAtMs: 1_791_570_000_000 },
];

/**
 * Sample notifications for the fixture preview, newest first, as `GameGateway.notifications()` lists them: an Arena victory, an
 * expedition (with a Rare item and extra items sold), a training and an expedition lost. Sample data for the preview, not any player's
 * results. The preview's gladiator is level 1 (`ownerFixture`, through ARENA_OWNER), and a result can claim a level-up only to a level
 * the gladiator has reached, so none does here (`levelAfter` is null throughout; the live Notifications tab's "Level up!" line is
 * tested with an owner whose level and XP prove it, tests/browser/messages.spec.ts).
 */
const sample = (n: number, resolvedKind: ActivitySummary['resolvedKind'], result: ActivitySummary['result'], settledAtMs: number,
  rewards: Partial<ActivitySummary['rewards']>, extra: Partial<ActivitySummary> = {}): ActivitySummary => ({
  activityId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, resolvedKind, result, success: result !== 'defeat',
  rewards: { money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0, ...rewards }, receiptId: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
  settledAtMs, replayExpiry: { state: 'expired' }, ...extra,
});
const note = (summary: ActivitySummary, destination: string | null, levelAfter: number | null): GameNotification => ({
  activityId: summary.activityId, kind: summary.resolvedKind as GameNotification['kind'], settledAtMs: summary.settledAtMs, summary, destination, levelAfter,
});
export const FIXTURE_NOTIFICATIONS: readonly GameNotification[] = [
  note(sample(4, 'arena', 'victory', 1_791_589_000_000, { renown: 30 }, { ratingDelta: 12 }), null, null),
  note(sample(3, 'expedition', 'victory', 1_791_588_000_000, { money: 120, xp: 250, overflowMoney: 35,
    items: [{ catalogId: 'sword:5:rare', catalogVersion: 'v1', tier: 5, rarity: 'rare', quantity: 1 }] }), 'Ruined Outpost', null),
  note(sample(2, 'training', 'completed', 1_791_587_000_000, { attributePoints: 1 }), null, null),
  note(sample(1, 'expedition', 'defeat', 1_791_586_000_000, {}), 'Woodland Path', null),
];

/**
 * What the owner's inbox says of the samples above: `FIXTURE_MESSAGES` when message 1 has been read and the gladiator is older than
 * all of them, and `FIXTURE_NOTIFICATIONS` when the two newest settled after the account last saw them.
 */
const SINCE_MS = 1_791_500_000_000, READ = [1], SEEN_MS = 1_791_587_500_000;
export const FIXTURE_INBOX: Inbox = { unread: FIXTURE_MESSAGES.filter(m => m.publishedAtMs > SINCE_MS && !READ.includes(m.id)).length, readIds: READ, sinceMs: SINCE_MS,
  newNotifications: FIXTURE_NOTIFICATIONS.filter(n => n.settledAtMs > SEEN_MS).length, notificationsSeenMs: SEEN_MS };
