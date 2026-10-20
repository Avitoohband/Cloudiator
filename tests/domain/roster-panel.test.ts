import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicActor, WorldSnapshot } from '@contracts/reads';
import { RosterPanel, type Roster } from '@/features/character/RosterPanel';
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
