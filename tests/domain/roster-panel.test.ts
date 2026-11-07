import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicActor, WorldSnapshot } from '@contracts/reads';
import { RosterPanel, type Roster } from '@/features/character/RosterPanel';
import { countLine, matchLine, playerCounts } from '@/features/character/actor-text';
import { createSceneBridge } from '@/game/bridge';
import { worldFixture } from '../fixtures/domain';

const noop = () => {};
const actor = (name: string, location: PublicActor['location']): PublicActor =>
  ({ ...worldFixture.actors[0], gladiatorId: `id-${name}`, name, location, activityId: null });
const WORLD: WorldSnapshot = { ...worldFixture, actors: [actor('Aster', 'training'), actor('Brutus', 'tournament'), actor('Corvina', 'expedition:woodland')] };
const ROSTER: Roster = { inCamp: ['id-Aster'], away: [{ gladiatorId: 'id-Corvina', name: 'Corvina', location: 'expedition:woodland' }] };
const panel = (props: Partial<Parameters<typeof RosterPanel>[0]> = {}) => renderToStaticMarkup(createElement(RosterPanel, {
  world: WORLD, ownerId: null, roster: ROSTER, sceneStatus: 'ready', following: null, bridge: createSceneBridge(), onDone: noop, onProfile: noop, ...props,
}));
const button = (html: string, label: string) => new RegExp(`<button([^>]*)aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? '';

describe('Gladiators', () => {
  it('gives a gladiator who is neither drawn in the camp nor away a reason for its disabled Find and Follow', () => {
    const html = panel();
    for (const label of ['Find Brutus', 'Follow Brutus']) {
      const b = button(html, label);
      expect(b, label).toContain('disabled');
      const id = /aria-describedby="([^"]+)"/.exec(b)?.[1];
      expect(id, label).toBeTruthy();
      const reason = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1];
      expect(reason).toBe('Not in the camp right now.');
    }
    // A gladiator drawn in the camp has working buttons and no such reason.
    expect(button(html, 'Find Aster')).not.toContain('disabled');
    expect(button(html, 'Find Aster')).not.toContain('aria-describedby');
    // While the camp view is unavailable, every row names that reason instead.
    const unavailable = panel({ sceneStatus: 'unavailable' });
    const id = /aria-describedby="([^"]+)"/.exec(button(unavailable, 'Find Brutus'))![1];
    expect(new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(unavailable)![1]).toContain('The camp view is unavailable');
  });

  it('offers an away gladiator’s expedition to watch over the camp (Task 13.8)', () => {
    const away = { ...actor('Corvina', 'expedition:woodland'), activityId: 'expedition-1' };
    const html = panel({ world: { ...WORLD, actors: [WORLD.actors[0], away] } });
    expect(button(html, 'Watch Corvina&#x27;s expedition')).not.toBe('');
    expect(html).not.toContain('aria-label="Find Corvina"');
    // Without a public activity there is nothing to open: it only says where they are.
    const unknown = panel();
    expect(unknown).not.toContain('Watch Corvina');
    expect(unknown).toContain('On an expedition');
  });

  // Task 23.9 (Task 23.8's PublicActor.resting, the approved copy): a resting gladiator is listed, not drawn in the camp.
  it('shows everyone "Resting at home: back when {name}\'s owner returns." in a resting gladiator\'s row', () => {
    const otho: PublicActor = { ...actor('Otho', 'camp'), activityStatus: 'idle', startsAtMs: null, endsAtMs: null, resting: true };
    const line = "Resting at home: back when Otho's owner returns.";
    const html = panel({ world: { ...WORLD, actors: [...WORLD.actors, otho] } }).replace(/&#x27;/g, "'");
    const row = /<li[^>]*>(?:(?!<\/li>).)*aria-label="Profile: Otho"(?:(?!<\/li>).)*<\/li>/.exec(html)![0];
    expect(row).toContain(line);
    // It is said once: the class line names no other place, and the row does not add "Not in the camp right now."
    expect(row.split(line)).toHaveLength(2);
    expect(row).toContain('Guardian · Level 1 · Bronze league<');
    expect(row).not.toContain('Not in the camp right now.');
    // Its Find and Follow stay, disabled, with that sentence as their reason.
    for (const label of ['Find Otho', 'Follow Otho']) {
      const b = button(html, label);
      expect(b, label).toContain('disabled');
      const id = /aria-describedby="([^"]+)"/.exec(b)![1];
      expect(new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)![1]).toBe(line);
    }
    // Even a stale roster that still lists it as drawn does not offer to find it.
    const stale = panel({ world: { ...WORLD, actors: [...WORLD.actors, otho] }, roster: { ...ROSTER, inCamp: [...ROSTER.inCamp, otho.gladiatorId] } });
    expect(button(stale, 'Find Otho')).toContain('disabled');
    // While the camp view is unavailable the rows name that reason, and the resting sentence still says where it is.
    const unavailable = panel({ world: { ...WORLD, actors: [otho] }, sceneStatus: 'unavailable' }).replace(/&#x27;/g, "'");
    expect(unavailable).toContain(line);
    const reason = /aria-describedby="([^"]+)"/.exec(button(unavailable, 'Find Otho'))![1];
    expect(new RegExp(`id="${reason}"[^>]*>([^<]*)<`).exec(unavailable)![1]).toContain('The camp view is unavailable');
  });

  // Fix round 1 (review Important 1): the returning owner sees its own line, never "back when Aster's owner returns."
  it('shows the owner its own resting line in its row and as the reason Find and Follow my gladiator are off', () => {
    const rest = { location: 'camp' as const, activityStatus: 'idle' as const, startsAtMs: null, endsAtMs: null, resting: true };
    const me: PublicActor = { ...actor('Aster', 'camp'), ...rest };
    const otho: PublicActor = { ...actor('Otho', 'camp'), ...rest };
    const own = 'Resting at home: back on your schedule at 4:20 AM';
    const world = { ...WORLD, actors: [me, otho] };
    const html = panel({ world, ownerId: me.gladiatorId, roster: { inCamp: [], away: [] }, ownPlace: own }).replace(/&#x27;/g, "'");
    const row = (name: string) => new RegExp(`<li[^>]*>(?:(?!</li>).)*aria-label="Profile: ${name}"(?:(?!</li>).)*</li>`).exec(html)![0];
    expect(row('Aster')).toContain(' (you)');
    expect(row('Aster')).toContain(own);
    expect(html).not.toContain("back when Aster's owner returns.");
    // Everyone else keeps the public sentence.
    expect(row('Otho')).toContain("Resting at home: back when Otho's owner returns.");
    // Find and Follow my gladiator say why they are off with the same line, not "away from the camp".
    for (const label of ['Find my gladiator', 'Follow my gladiator']) {
      const b = new RegExp(`<button([^>]*)>${label}</button>`).exec(html)![1];
      expect(b, label).toContain('disabled');
      const id = /aria-describedby="([^"]+)"/.exec(b)![1];
      expect(new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)![1]).toBe(own);
    }
    expect(html).not.toContain('Your gladiator is away from the camp.');
    // A stale roster that still lists the owner as drawn does not enable them; before its return is known: "Resting at home."
    const stale = panel({ world, ownerId: me.gladiatorId, roster: { inCamp: [me.gladiatorId], away: [] }, ownPlace: 'Resting at home.' });
    expect(/<button([^>]*)>Find my gladiator<\/button>/.exec(stale)![1]).toContain('disabled');
    expect(stale).toContain('Resting at home.');
    // An owner away on an expedition still reads "away from the camp".
    const away = panel({ ownerId: 'id-Corvina', ownPlace: null });
    expect(away).toContain('Your gladiator is away from the camp.');
  });

  it('opens each gladiator’s profile card from its name (the keyboard path of a camp click)', () => {
    const html = panel();
    for (const name of ['Aster', 'Brutus', 'Corvina']) expect(html).toContain(`aria-label="Profile: ${name}"`);
  });
});

// Patch A item 8: a line over the Gladiators list says how many players there are and where they are now.
describe('players count', () => {
  const four = [actor('Aster', 'training'), actor('Brutus', 'orientation'), actor('Corvina', 'expedition:woodland'), { ...actor('Otho', 'camp'), resting: true }];
  it('counts every gladiator and where they are now', () => {
    expect(playerCounts(four)).toEqual({ total: 4, inCamp: 2, away: 1, resting: 1 });
    expect(countLine(playerCounts(four), false)).toEqual(['4 players', ' · 2 in camp · 1 on an expedition · 1 resting at home']);
    expect(countLine({ total: 50, inCamp: 43, away: 6, resting: 1 }, false)).toEqual(['50 players', ' · 43 in camp · 6 on expeditions · 1 resting at home']);
    expect(countLine({ total: 50, inCamp: 43, away: 6, resting: 1 }, true)).toEqual(['50 players', ' · 43 in camp · 6 away · 1 resting at home']);
  });
  it('leaves out a zero part, never the total', () => {
    expect(countLine({ total: 1, inCamp: 1, away: 0, resting: 0 }, false)).toEqual(['1 player', ' · 1 in camp']);
    expect(countLine({ total: 2, inCamp: 0, away: 2, resting: 0 }, true)).toEqual(['2 players', ' · 2 away']);
  });
  it('says how many match a filter', () => {
    expect(matchLine(4, 50, 'ar')).toEqual(['4 of 50 players', ' match “ar”']);
  });
  it('shows the count over the list, and no count while the world loads', () => {
    expect(panel()).toContain('data-testid="players-count"');
    expect(panel({ world: null })).not.toContain('players-count');
  });
});

// Patch A item 2: newcomers (in orientation) are listed first under NEW IN CAMP, each with a NEW pill, then everyone else under
// EVERYONE; a newcomer is listed once. The eyebrows come below the count line and only while someone is new.
describe('newcomers in the list', () => {
  const ursa: PublicActor = { ...actor('Ursa', 'orientation'), startsAtMs: 3_000 };
  const nero: PublicActor = { ...actor('Nero', 'orientation'), startsAtMs: 2_000 };
  const world = (...extra: PublicActor[]): WorldSnapshot => ({ ...WORLD, actors: [...WORLD.actors, ...extra] });
  const rows = (html: string) => [...html.matchAll(/aria-label="Profile: ([^"]+)"/g)].map(m => m[1]);

  it('lists newcomers first with a NEW pill, once', () => {
    const html = panel({ world: world(ursa) });
    const eyebrow = html.indexOf('NEW IN CAMP'), row = html.indexOf('Profile: Ursa'), everyone = html.indexOf('EVERYONE');
    expect(eyebrow).toBeGreaterThan(html.indexOf('data-testid="players-count"'));
    expect(row).toBeGreaterThan(eyebrow);
    expect(everyone).toBeGreaterThan(row);
    // The pill sits in Ursa's row, after her name; the other rows have none.
    const ursaRow = /<li[^>]*>(?:(?!<\/li>).)*aria-label="Profile: Ursa"(?:(?!<\/li>).)*<\/li>/.exec(html)![0];
    expect(ursaRow).toMatch(/>NEW<\/span>/);
    expect(html.match(/>NEW<\/span>/g)).toHaveLength(1);
    // Listed once, and everyone else follows in the second part.
    expect(html.match(/Profile: Ursa/g)).toHaveLength(1);
    expect(rows(html)).toEqual(['Ursa', 'Aster', 'Brutus', 'Corvina']);
  });
  it('lists several newcomers newest first, then everyone by name', () => {
    expect(rows(panel({ world: world(nero, ursa) }))).toEqual(['Ursa', 'Nero', 'Aster', 'Brutus', 'Corvina']);
  });
  it('shows neither eyebrow with nobody new, nor for a resting or settled gladiator', () => {
    for (const w of [WORLD, world({ ...ursa, resting: true }), world({ ...ursa, location: 'camp' })]) {
      const html = panel({ world: w });
      expect(html).not.toContain('NEW IN CAMP');
      expect(html).not.toContain('EVERYONE');
      expect(html).not.toMatch(/>NEW<\/span>/);
    }
  });
  it('keeps the owner’s own row and buttons in the new part', () => {
    const html = panel({ world: world(ursa), ownerId: ursa.gladiatorId, roster: { ...ROSTER, inCamp: [...ROSTER.inCamp, ursa.gladiatorId] } });
    expect(html).toContain('Ursa</button> (you)');
    expect(button(html, 'Find Ursa')).not.toContain('disabled');
  });

  // Patch 1.7 (spec "Where a title shows"; ruling D2): the title after the name (and "(you)" or NEW), in its own italic element; the list
  // shows the plain title name ("Champion"), never the profile card's season words; an id this client does not know shows nothing.
  it('shows the worn title after the name and "(you)", in its own element', () => {
    const wearing = (a: PublicActor, title: unknown) => ({ ...a, title }) as PublicActor;
    const html = panel({ world: { ...WORLD, actors: [wearing(actor('Aster', 'training'), 'founder'), wearing(actor('Brutus', 'tournament'), 'champion'), wearing(actor('Corvina', 'camp'), 'lion')] }, ownerId: 'id-Aster' });
    expect(html).toContain('Aster</button> (you) <em');
    expect(/<em[^>]*>Founder<\/em>/.test(html)).toBe(true);
    expect(/<em[^>]*>Champion<\/em>/.test(html)).toBe(true);
    expect(/<em[^>]*>Lion of the Arena<\/em>/.test(html)).toBe(true);
    expect(html).not.toContain('Champion ·');
    // The title follows a NEW pill too.
    const fresh = panel({ world: world(wearing({ ...ursa }, 'tiro')) });
    expect(fresh).toMatch(/>NEW<\/span> <em[^>]*>Tiro<\/em>/);
  });
  it('shows no title for none, for an id this client does not know, or for junk, and never throws', () => {
    for (const title of [undefined, null, 'outfitter', '', 42, {}]) {
      const html = panel({ world: { ...WORLD, actors: [{ ...actor('Aster', 'training'), title } as unknown as PublicActor] } });
      expect(html, String(title)).not.toContain('<em');
      expect(html, String(title)).toContain('Profile: Aster');
    }
  });
});
