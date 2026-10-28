import type { GameMessage, Inbox } from '../../supabase/functions/_shared/contracts/reads.ts';

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

/** What the owner's inbox says of `FIXTURE_MESSAGES` when message 1 has been read and the gladiator is older than all of them. */
const SINCE_MS = 1_791_500_000_000, READ = [1];
export const FIXTURE_INBOX: Inbox = { unread: FIXTURE_MESSAGES.filter(m => m.publishedAtMs > SINCE_MS && !READ.includes(m.id)).length, readIds: READ, sinceMs: SINCE_MS };
