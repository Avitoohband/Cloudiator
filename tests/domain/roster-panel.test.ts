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

  it('opens each gladiator’s profile card from its name (the keyboard path of a camp click)', () => {
    const html = panel();
    for (const name of ['Aster', 'Brutus', 'Corvina']) expect(html).toContain(`aria-label="Profile: ${name}"`);
  });
});
