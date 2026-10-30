import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EquipmentSlot } from '@contracts/commands';
import type { PublicActor, WorldSnapshot } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { ProfileRead, PublicBuild, PublicGear } from '@/lib/api/reads';
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
const PROFILE: ProfileRead = { actor: ACTOR, combatStrength: 41, rating: 1042, prestige: [], build: null, joinedAtMs: null, arenaRecord: null };
/** The card's clock: 10 Oct 2026, noon UTC. */
const NOW = Date.UTC(2026, 9, 10, 12);
type Props = Parameters<typeof ProfileCard>[0];
const card = (props: Partial<Props> = {}) => renderToStaticMarkup(createElement(ProfileCard, {
  actor: ACTOR, profile: null, own: false, nowMs: NOW, onFollow: noop, onOpenMenu: noop, ...props,
}));
const gear = (id: string): PublicGear => {
  const item = CATALOG_V1.items[id];
  return { catalogId: id, catalogVersion: 'v1', tier: item.tier, rarity: item.rarity, stats: structuredClone(item.stats) as PublicGear['stats'] };
};
const NONE: Record<EquipmentSlot, PublicGear | null> = { weapon: null, offHand: null, head: null, body: null, feet: null };
const LUCILLA_BUILD: PublicBuild = { stance: 'defensive', allocations: { strength: 5, agility: 1, vitality: 9, endurance: 4, precision: 3 },
  equipment: { ...NONE, weapon: gear('spear:5:uncommon'), head: gear('iron-helmet:5:common'), body: gear('heavy-armor:1:rare') } };
const LUCILLA: PublicActor = { ...worldFixture.actors[0], name: 'Lucilla', classId: 'guardian', league: 'silver', level: 6, location: 'arena', activityId: 'arena-activity',
  equipmentSilhouettes: ['weapon-spear', 'head-helmet', 'armor-heavy'] };
const LUCILLA_PROFILE: ProfileRead = { actor: LUCILLA, combatStrength: null, rating: 1040, prestige: [], build: LUCILLA_BUILD,
  joinedAtMs: Date.UTC(2026, 9, 2, 12), arenaRecord: { wins: 9, losses: 5 } };
/** The card's text items in document order: each eyebrow, chip, row (term and value) and line. */
const items = (html: string) => [...html.matchAll(/<(p|li|div|dt)\b[^>]*>((?:(?!<\/?(?:p|li|div|ul|dl|section)\b)[\s\S])*?)<\/\1>/g)]
  .map(m => text(m[2]).trim()).filter(Boolean);
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
    // Task 11c: the season's record from a standings row has its own row; "Rating · record" is gone.
    const season = text(card({ profile: PROFILE, record: { wins: 6, losses: 4 } }));
    expect(season).toMatch(/Rating\s+1042/);
    expect(season).toMatch(/This season\s+6–4/);
    expect(season).not.toContain('Rating · record');
    expect(text(card({ profileFailed: true }))).toMatch(/Rating\s+Not available/);
  });

  it('shows only public fields, and the management shortcuts only on the viewer’s own card', () => {
    const other = card({ profile: PROFILE });
    expect(buttons(other)).not.toContain('My gladiator');
    expect(buttons(other)).not.toContain('Schedule');
    const own = card({ profile: PROFILE, own: true });
    expect(buttons(own)).toEqual(expect.arrayContaining(['My gladiator', 'Schedule', 'Follow']));
    for (const html of [other, own]) expect(text(html)).not.toMatch(/Gold|Money|Stamina|Renown|Inventory|wallet|combat strength/i);
    for (const html of [card({ actor: LUCILLA, profile: LUCILLA_PROFILE }), card({ actor: LUCILLA, profile: LUCILLA_PROFILE, own: true })]) {
      expect(text(html)).not.toMatch(/Stamina|Gold|Money|Renown|Inventory|wallet|combat strength/i);
    }
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
    // The badge list's own items (Task 11c added the class chips, another list, to the head).
    const badges = /<ul[^>]*aria-label="Season badges"[^>]*>(.*?)<\/ul>/.exec(career)![1];
    expect([...badges.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map(m => m[1])).toEqual(['🥉 Season 4 · Gold', '🥇 Season 3 · Silver', '🥇 Season 1 · Bronze']);
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
      world, reads: null, ownerId: null, roster: null, sceneStatus: 'ready', following: null, nowMs: NOW,
      onFollow: noop, onWatch: noop, onOpenMenu: noop, onClose: noop,
    }));
    const html = layer({ ...worldFixture, actors: [ACTOR] });
    expect(html).toMatch(/role="dialog"[^>]*aria-label="Profile: Aster"/);
    expect(html).toContain('aria-label="Close profile"');
    expect(text(html)).toMatch(/Rating\s+Loading…/);
    expect(text(html)).toMatch(/This season\s+6–4/);
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
    // Another player's card, before and after its profile loads (an owner's line is for its own card only).
    for (const props of [{ actor: resting }, { actor: resting, profile: { ...PROFILE, actor: resting } }, { actor: resting, ownPlace: 'Resting at home.' }]) {
      expect(unescaped(card(props))).toContain(`<dt>Now</dt><dd>${line}</dd>`);
    }
    // Not drawn in the camp, so Follow gives its reason (the scene's roster lists only those it draws).
    const layer = text(renderToStaticMarkup(createElement(ProfileLayer, {
      target: { gladiatorId: resting.gladiatorId, name: 'Otho', screen: null, record: null, focus: true },
      world: { ...worldFixture, actors: [resting] }, reads: null, ownerId: null, roster: { inCamp: [], away: [] }, sceneStatus: 'ready', following: null, nowMs: NOW,
      onFollow: noop, onWatch: noop, onOpenMenu: noop, onClose: noop,
    })));
    expect(unescaped(layer)).toContain(`Now ${line}`);
    expect(unescaped(layer)).toContain('Otho is not in the camp right now.');
    // A gladiator who is not resting reads its place as before.
    expect(text(card())).not.toContain('Resting at home');
  });

  // Fix round 1 (review Important 1): the returning owner's own card says when it is back, never "back when Aster's owner returns."
  it('shows the owner its own resting line as its own card\'s Now', () => {
    const me: PublicActor = { ...ACTOR, location: 'camp', activityId: null, activityStatus: 'idle', startsAtMs: null, endsAtMs: null, resting: true };
    const own = 'Resting at home: back on your schedule at 4:20 AM';
    const html = unescaped(card({ actor: me, own: true, ownPlace: own }));
    expect(html).toContain(`<dt>Now</dt><dd>${own}</dd>`);
    expect(html).not.toContain("Aster's owner returns");
    // Before its return is known: "Resting at home."
    expect(unescaped(card({ actor: me, own: true, ownPlace: 'Resting at home.' }))).toContain('<dt>Now</dt><dd>Resting at home.</dd>');
    // The layer hands the owner's line to its own card only.
    const layer = (gladiator: PublicActor, ownerId: string | null) => unescaped(text(renderToStaticMarkup(createElement(ProfileLayer, {
      target: { gladiatorId: gladiator.gladiatorId, name: gladiator.name, screen: null, record: null, focus: false },
      world: { ...worldFixture, actors: [gladiator] }, reads: null, ownerId, roster: { inCamp: [], away: [] }, sceneStatus: 'ready', following: null, nowMs: NOW,
      ownPlace: own, onFollow: noop, onWatch: noop, onOpenMenu: noop, onClose: noop,
    }))));
    expect(layer(me, me.gladiatorId)).toContain(`Now ${own}`);
    expect(layer(me, null)).toContain("Now Resting at home: back when Aster's owner returns.");
    // Not resting: its place as before, whatever the owner's line.
    expect(layer({ ...ACTOR }, ACTOR.gladiatorId)).toContain('Now Training');
  });

  // Fix round 1 (review Minor 2): Follow trusts the resting flag, not a scene roster that may be stale.
  it('never offers to follow a resting gladiator, even while a stale roster still lists it as drawn', () => {
    const resting: PublicActor = { ...ACTOR, name: 'Otho', location: 'camp', activityId: null, activityStatus: 'idle', startsAtMs: null, endsAtMs: null, resting: true };
    const html = renderToStaticMarkup(createElement(ProfileLayer, {
      target: { gladiatorId: resting.gladiatorId, name: 'Otho', screen: null, record: null, focus: false },
      world: { ...worldFixture, actors: [resting] }, reads: null, ownerId: null, roster: { inCamp: [resting.gladiatorId], away: [] }, sceneStatus: 'ready',
      following: null, nowMs: NOW, onFollow: noop, onWatch: noop, onOpenMenu: noop, onClose: noop,
    }));
    const follow = /<button([^>]*)>Follow<\/button>/.exec(html)![1];
    expect(follow).toContain('disabled');
    const described = /aria-describedby="([^"]+)"/.exec(follow)![1];
    expect(new RegExp(`id="${described}"[^>]*>([^<]*)<`).exec(html)![1]).toBe('Otho is not in the camp right now.');
    // A drawn gladiator that is not resting can still be followed.
    const drawn = renderToStaticMarkup(createElement(ProfileLayer, {
      target: { gladiatorId: ACTOR.gladiatorId, name: 'Aster', screen: null, record: null, focus: false },
      world: { ...worldFixture, actors: [ACTOR] }, reads: null, ownerId: null, roster: { inCamp: [ACTOR.gladiatorId], away: [] }, sceneStatus: 'ready',
      following: null, nowMs: NOW, onFollow: noop, onWatch: noop, onOpenMenu: noop, onClose: noop,
    }));
    expect(/<button([^>]*)>Follow<\/button>/.exec(drawn)![1]).not.toContain('disabled');
  });

  // Task 11c (Patch A spec, "A richer profile card"; Avi approved the mockup, 2026-10-29): the card in sections.
  it('shows the look, the class chips, the attributes, the stats, the gear and the record, in that order', () => {
    const html = card({ actor: LUCILLA, profile: LUCILLA_PROFILE });
    const order = ['ATTRIBUTES · 22 POINTS', 'Vitality +5% 9', 'STATS · DEFENSIVE STANCE', 'Health 197', 'Damage 15 a hit', 'Speed every 1.13 s',
      'Armor 12.3 · blocks 25%', 'Critical 7% of hits', 'GEAR', 'Weapon Spear · Level 5 · uncommon', 'Off-hand Two-handed weapon', 'RECORD', 'Rating 1040',
      'Arena record 9–5 · all seasons', 'In camp since 2 Oct · 8 days'];
    const shown = items(html);
    let from = -1;
    for (const line of order) {
      const at = shown.findIndex((item, i) => i > from && item === line);
      expect(at, `"${line}" after the previous line in ${JSON.stringify(shown)}`).toBeGreaterThan(from);
      from = at;
    }
    expect(shown).toEqual(expect.arrayContaining(['Vitality +5%', 'Endurance +5%']));
    expect(html).toMatch(/<[^>]*data-testid="profile-look"[^>]*>/);
    expect(/<[^>]*data-testid="profile-look"[^>]*>/.exec(html)![0]).toContain('aria-hidden="true"');
    for (const section of ['Attributes', 'Stats', 'Gear', 'Record']) expect(html, section).toContain(`aria-label="${section}"`);
    // From a standings row: that row's season record, and no combined row.
    const season = text(card({ actor: LUCILLA, profile: LUCILLA_PROFILE, record: { wins: 7, losses: 4 } }));
    expect(season).toMatch(/This season\s+7–4/);
    expect(season).not.toContain('Rating · record');
    expect(text(card({ actor: LUCILLA, profile: LUCILLA_PROFILE }))).not.toContain('This season');
    // Fix round (Avi, 2026-10-30: "Season 1 · 12–3"): a closed season's standings name that season; "This season" is the current one only.
    const closed = text(card({ actor: LUCILLA, profile: LUCILLA_PROFILE, record: { wins: 12, losses: 3, season: '0' } }));
    expect(closed).toMatch(/Season 1\s+12–3/);
    expect(closed).not.toContain('This season');
    expect(text(card({ actor: LUCILLA, profile: LUCILLA_PROFILE, record: { wins: 12, losses: 3, season: null } }))).toMatch(/This season\s+12–3/);
  });

  it('says Loading… before the profile, Not available when it failed or has no build, and own-card words', () => {
    const before = items(card({ actor: LUCILLA }));
    for (const line of ['ATTRIBUTES', 'STATS', 'Equipped Spear, helmet, heavy armor', 'Rating Loading…']) expect(before, line).toContain(line);
    expect(before.filter(line => line === 'Loading…')).toHaveLength(2);
    const failed = items(card({ actor: LUCILLA, profileFailed: true }));
    expect(failed.filter(line => /Not available/.test(line))).toHaveLength(3);
    expect(failed).toContain('Equipped Spear, helmet, heavy armor');
    const unusable = items(card({ actor: LUCILLA, profile: { ...LUCILLA_PROFILE, build: null } }));
    expect(unusable.filter(line => line === 'Not available')).toHaveLength(2);
    expect(unusable).toContain('Rating 1040');
    // The own card (Aster, nothing worn): what others see, and that they see it.
    const aster: PublicBuild = { stance: 'balanced', allocations: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 }, equipment: NONE };
    const own = items(card({ actor: { ...ACTOR, classId: 'guardian', equipmentSilhouettes: [] }, own: true,
      profile: { ...PROFILE, build: aster, joinedAtMs: Date.UTC(2026, 9, 9, 12), arenaRecord: { wins: 0, losses: 0 } } }));
    for (const line of ['YOUR GLADIATOR', 'Nothing worn yet.', 'Other players see this card too.', 'Arena record No bouts yet', 'In camp since 9 Oct · 1 day']) {
      expect(own, line).toContain(line);
    }
    expect(items(card({ actor: LUCILLA, profile: LUCILLA_PROFILE }))).not.toContain('Other players see this card too.');
  });

  it('sits above a clicked gladiator, or below when there is no room, right of the rail and below the chip', () => {
    const size = { width: 260, height: 200 }, view = { width: 1280, height: 720 };
    expect(placeCard({ x: 640, y: 400 }, size, view)).toEqual({ left: 510, top: 136 });
    expect(placeCard({ x: 640, y: 200 }, size, view)).toEqual({ left: 510, top: 244 });
    expect(placeCard({ x: 20, y: 700 }, size, view)).toEqual({ left: 66, top: 436 });
    expect(placeCard({ x: 1270, y: 400 }, size, view)).toEqual({ left: 1008, top: 136 });
    // Task 11c: the taller card fits neither above nor below a gladiator in the middle of a short window, so it sits beside them:
    // right of the click, or left of it near the right edge, centred on them vertically within the view.
    const tall = { width: 520, height: 540 };
    expect(placeCard({ x: 640, y: 360 }, tall, view)).toEqual({ left: 680, top: 90 });
    expect(placeCard({ x: 1100, y: 360 }, tall, view)).toEqual({ left: 540, top: 90 });
    expect(placeCard({ x: 640, y: 680 }, tall, view)).toEqual({ left: 380, top: 76 });
    // Opened from a list row: beside the open menu panel.
    expect(placeCard(null, size, view)).toEqual({ left: 458, top: 64 });
    expect(placeCard(null, size, { width: 600, height: 720 })).toEqual({ left: 328, top: 64 });
  });
});
