import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicActor, PublicProfile, WorldSnapshot } from '@contracts/reads';
import { ProfileCard, ProfileLayer, placeCard } from '@/features/character/ProfileCard';
import { worldFixture } from '../fixtures/domain';

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
/** React escapes an apostrophe in text. */
const unescaped = (html: string) => html.replace(/&#x27;/g, "'");
const ACTOR: PublicActor = {
  ...worldFixture.actors[0], name: 'Aster', classId: 'duelist', league: 'bronze', level: 4, location: 'training',
  equipmentSilhouettes: ['weapon-sword', 'offhand-shield', 'head-helmet'],
};
const PROFILE: PublicProfile = { actor: ACTOR, combatStrength: 41, rating: 1042, prestige: [] };
type Props = Parameters<typeof ProfileCard>[0];
const card = (props: Partial<Props> = {}) => renderToStaticMarkup(createElement(ProfileCard, {
  actor: ACTOR, profile: null, own: false, onFollow: noop, onOpenMenu: noop, ...props,
}));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1]);

describe('profile card', () => {
  it('renders the public actor at once, before the profile loads', () => {
    const html = text(card());
    expect(html).toContain('Aster');
    expect(html).toContain('Duelist · Level 4 · Bronze league');
    expect(html).toMatch(/Now\s+Training/);
    expect(html).toMatch(/Equipped\s+Sword, shield, helmet/);
    expect(html).toMatch(/Rating\s+Loading…/);
  });

  it('adds the rating from the loaded profile, and the record when the caller knows it', () => {
    expect(text(card({ profile: PROFILE }))).toMatch(/Rating\s+1042/);
    expect(text(card({ profile: PROFILE, record: { wins: 6, losses: 4 } }))).toMatch(/Rating · record\s+1042 · 6–4/);
    expect(text(card({ profileFailed: true }))).toMatch(/Rating\s+Not available/);
  });

  it('shows only public fields, and the management shortcuts only on the viewer’s own card', () => {
    const other = card({ profile: PROFILE });
    expect(buttons(other)).not.toContain('My gladiator');
    expect(buttons(other)).not.toContain('Schedule');
    const own = card({ profile: PROFILE, own: true });
    expect(buttons(own)).toEqual(expect.arrayContaining(['My gladiator', 'Schedule', 'Follow']));
    for (const html of [other, own]) expect(text(html)).not.toMatch(/Money|Stamina|Renown|Inventory|wallet|combat strength/i);
  });

  it('offers Watch bout for an Arena entrant, and gives Follow its reason when it is unavailable', () => {
    expect(buttons(card({ onWatch: noop }))).not.toContain('Watch bout');
    const entrant = { ...ACTOR, location: 'arena' as const, activityId: 'arena-activity' };
    expect(buttons(card({ actor: entrant, onWatch: noop }))).toContain('Watch bout');
    const html = card({ followReason: 'Aster is not in the camp right now.' });
    const follow = /<button([^>]*)>Follow<\/button>/.exec(html)![1];
    expect(follow).toContain('disabled');
    const described = /aria-describedby="([^"]+)"/.exec(follow)![1];
    expect(html).toContain(`id="${described}"`);
    expect(text(html)).toContain('Aster is not in the camp right now.');
    expect(/<button([^>]*)>Follow<\/button>/.exec(card({ following: true }))![1]).toContain('aria-pressed="true"');
  });

  // Task 21.4: season prestige (plan Decision 8, the approved mockup).
  it('shows the latest champion title under the name and a badge chip per season award, newest first', () => {
    const champion = card({ profile: { ...PROFILE, prestige: [{ seasonId: '0', league: 'silver', place: 1, badge: 'gold', title: 'champion' }] } });
    expect(champion).toMatch(/<h2[^>]*>Aster<\/h2><p[^>]*>Champion · Season 1 Silver<\/p>/);
    expect(champion).toMatch(/<ul[^>]*aria-label="Season badges"[^>]*><li[^>]*>🥇 Season 1 · Silver<\/li><\/ul>/);
    const career = card({ profile: { ...PROFILE, prestige: [
      { seasonId: '0', league: 'bronze', place: 1, badge: 'gold', title: 'champion' },
      { seasonId: '2', league: 'silver', place: 1, badge: 'gold', title: 'champion' },
      { seasonId: '3', league: 'gold', place: 3, badge: 'bronze', title: null }] } });
    expect(text(career)).toContain('Champion · Season 3 Silver');
    expect(text(career)).not.toContain('Champion · Season 1 Bronze');
    expect([...career.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map(m => m[1])).toEqual(['🥉 Season 4 · Gold', '🥇 Season 3 · Silver', '🥇 Season 1 · Bronze']);
    // A third place only: its badge and no title.
    const third = card({ profile: { ...PROFILE, prestige: [{ seasonId: '0', league: 'bronze', place: 3, badge: 'bronze', title: null }] } });
    expect(text(third)).toContain('🥉 Season 1 · Bronze');
    expect(text(third)).not.toContain('Champion ·');
  });

  it('shows nothing about seasons for a gladiator without prestige, or before the profile loads', () => {
    for (const html of [card({ profile: PROFILE }), card(), card({ profileFailed: true })]) {
      expect(html).not.toContain('Season badges');
      expect(text(html)).not.toMatch(/Season \d|Champion/);
    }
  });

  it('is a labelled dialog with a close button, from the world actor or, outside the world, once the profile loads', () => {
    const layer = (world: WorldSnapshot | null, name = 'Aster') => renderToStaticMarkup(createElement(ProfileLayer, {
      target: { gladiatorId: ACTOR.gladiatorId, name, screen: null, record: { wins: 6, losses: 4 }, focus: false },
      world, reads: null, ownerId: null, roster: null, sceneStatus: 'ready', following: null,
      onFollow: noop, onWatch: noop, onOpenMenu: noop, onClose: noop,
    }));
    const html = layer({ ...worldFixture, actors: [ACTOR] });
    expect(html).toMatch(/role="dialog"[^>]*aria-label="Profile: Aster"/);
    expect(html).toContain('aria-label="Close profile"');
    expect(text(html)).toMatch(/Rating · record\s+Loading… · 6–4/);
    // Not in the world (a standings row): the row's name and record until the profile arrives.
    const pending = text(layer({ ...worldFixture, actors: [] }, 'Cassia'));
    expect(pending).toContain('Cassia');
    expect(pending).toMatch(/Record\s+6–4/);
    expect(pending).toContain('Loading the profile…');
  });

  // Task 23.9 (Task 23.8's PublicActor.resting, the approved copy): anyone sees where a resting gladiator is.
  it('shows everyone "Resting at home: back when {name}\'s owner returns." as where a resting gladiator is now', () => {
    const resting: PublicActor = { ...ACTOR, name: 'Otho', location: 'camp', activityId: null, activityStatus: 'idle', startsAtMs: null, endsAtMs: null, resting: true };
    const line = "Resting at home: back when Otho's owner returns.";
    for (const props of [{ actor: resting }, { actor: resting, profile: { ...PROFILE, actor: resting } }, { actor: resting, own: true }]) {
      expect(unescaped(card(props))).toContain(`<dt>Now</dt><dd>${line}</dd>`);
    }
    // Not drawn in the camp, so Follow gives its reason (the scene's roster lists only those it draws).
    const layer = text(renderToStaticMarkup(createElement(ProfileLayer, {
      target: { gladiatorId: resting.gladiatorId, name: 'Otho', screen: null, record: null, focus: true },
      world: { ...worldFixture, actors: [resting] }, reads: null, ownerId: null, roster: { inCamp: [], away: [] }, sceneStatus: 'ready', following: null,
      onFollow: noop, onWatch: noop, onOpenMenu: noop, onClose: noop,
    })));
    expect(unescaped(layer)).toContain(`Now ${line}`);
    expect(unescaped(layer)).toContain('Otho is not in the camp right now.');
    // A gladiator who is not resting reads its place as before.
    expect(text(card())).not.toContain('Resting at home');
  });

  it('sits above a clicked gladiator, or below when there is no room, right of the rail and below the chip', () => {
    const size = { width: 260, height: 200 }, view = { width: 1280, height: 720 };
    expect(placeCard({ x: 640, y: 400 }, size, view)).toEqual({ left: 510, top: 136 });
    expect(placeCard({ x: 640, y: 200 }, size, view)).toEqual({ left: 510, top: 244 });
    expect(placeCard({ x: 20, y: 700 }, size, view)).toEqual({ left: 66, top: 436 });
    expect(placeCard({ x: 1270, y: 400 }, size, view)).toEqual({ left: 1008, top: 136 });
    // Opened from a list row: beside the open menu panel.
    expect(placeCard(null, size, view)).toEqual({ left: 458, top: 64 });
    expect(placeCard(null, size, { width: 600, height: 720 })).toEqual({ left: 328, top: 64 });
  });
});
