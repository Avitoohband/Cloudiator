import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { InventoryPanel } from '../../src/features/inventory/InventoryPanel';
import { slotTimeText } from '../../src/features/schedule/slot-time';
import { createDisplayClock } from '../../src/game/display-clock';
import type { GameGateway } from '../../src/lib/api/gateway';
import { itemFixture, ownerFixture } from '../fixtures/domain';

// Launch feedback, note 9: the gear view as the Inventory panel lays it out, read from its static markup (what the browser spec
// cannot reach: a preview with gear already queued, and a queued time that cannot be shown). The behaviour with a real page
// (commands, badges, focus) is tests/browser/inventory.spec.ts.
const SLOT = 4_800_000;
const NOW = 1_791_592_800_000;
const NEXT = Math.floor(NOW / SLOT) + 1;
const piece = (catalogId: string, id: string, overrides: Partial<ItemInstance> = {}): ItemInstance => ({ ...itemFixture(CATALOG_V1.items[catalogId]), id, ...overrides });
const sword = piece('sword:1:common', 'sword-a'), sword2 = piece('sword:1:uncommon', 'sword-b'), spear = piece('spear:1:common', 'spear-a');
const shield = piece('round-shield:1:common', 'shield-a'), helmet = piece('iron-helmet:1:common', 'helmet-a');
const salvage: ItemInstance = { ...piece('sword:1:common', 'salvage-a'), catalogId: 'salvage', quantity: 4, origin: 'expedition' };

/** The player wears the sword and the shield; `next` is the queued weapon, if any (its off-hand follows the spear's two hands). */
function owner(next: { weapon?: ItemInstance; effectiveSlotIndex?: number } = {}): OwnerState {
  const state = structuredClone(ownerFixture);
  state.currentBuild.equipment = { weapon: sword.id, offHand: shield.id, head: null, body: null, feet: null };
  state.inventory = [sword, sword2, spear, shield, helmet, salvage].map(entry => structuredClone(entry));
  if (next.weapon) {
    const equipment = { ...state.currentBuild.equipment, weapon: next.weapon.id, offHand: next.weapon.id === spear.id ? null : shield.id };
    state.pendingBuild = { build: { ...state.currentBuild, version: 2, equipment }, effectiveSlotIndex: 'effectiveSlotIndex' in next ? next.effectiveSlotIndex! : NEXT,
      reservedMoney: 0, reservedItemIds: Object.values(equipment).filter((id): id is string => id !== null), operationId: 'op-1' };
  }
  return state;
}
function render(state: OwnerState, preview = false): string {
  const clock = createDisplayClock();
  clock.freeze(NOW);
  // (React's static markup separates adjacent text with `<!-- -->`; it is read as nothing.)
  return renderToStaticMarkup(createElement(InventoryPanel, { owner: state, gateway: {} as GameGateway, refresh: async () => {}, clock, preview })).replaceAll('<!-- -->', '');
}
/** The opening tag of the button with this accessible name, or fails. */
function button(html: string, name: RegExp): string {
  const tags = [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).filter(tag => name.test(/aria-label="([^"]*)"/.exec(tag)?.[1] ?? ''));
  expect(tags, String(name)).toHaveLength(1);
  return tags[0];
}
const disabled = (tag: string) => / disabled(="")?[ >]/.test(tag);

describe('the gear view in a preview', () => {
  it('disables Wear, Undo and Cancel changes and says why in words', () => {
    const html = render(owner({ weapon: sword2 }), true);
    for (const name of [/^Wear Sword, level 1 common$/, /^Undo wearing Sword, level 1 uncommon$/, /^Wear Iron helmet/]) {
      const tag = button(html, name);
      expect(disabled(tag), String(name)).toBe(true);
      expect(tag, String(name)).toMatch(/aria-describedby="[^"]*-preview"/);
    }
    expect(/<button\b[^>]*>Cancel changes<\/button>/.exec(html)?.[0]).toMatch(/ disabled/);
    expect(html).toContain('Gear changes are unavailable in this preview.');
  });

  it('leaves them enabled outside a preview', () => {
    const html = render(owner({ weapon: sword2 }));
    expect(disabled(button(html, /^Wear Sword, level 1 common$/))).toBe(false);
    expect(disabled(button(html, /^Undo wearing Sword, level 1 uncommon$/))).toBe(false);
    expect(disabled(button(html, /^Wear Iron helmet/))).toBe(false);
    expect(/<button\b[^>]*>Cancel changes<\/button>/.exec(html)?.[0]).not.toMatch(/ disabled/);
    expect(html).not.toContain('unavailable in this preview');
  });
});

describe('the gear view', () => {
  it('shows no Cancel changes and no note while nothing is queued', () => {
    const html = render(owner());
    expect(html).not.toContain('Cancel changes');
    expect(html).not.toContain('Gear changes start');
    expect(html).toContain('Wearing now');
  });

  it('offers no Wear on salvage', () => {
    const html = render(owner());
    expect(html).not.toMatch(/aria-label="[^"]*[Ww]ear[^"]*Salvage/);
    expect(html.match(/<button\b[^>]*aria-label="Wear /g)).toHaveLength(3);
  });

  it('shows the queued time on its badges and its note, against the shared clock', () => {
    const html = render(owner({ weapon: sword2 }));
    const time = slotTimeText(NEXT * SLOT, NOW);
    expect(time).not.toBe('');
    expect(html).toContain(`Wears from ${time}</span>`);
    expect(html).toContain(`Off at ${time}</span>`);
    expect(html).toContain(`Gear changes start at the next slot, ${time}.`);
  });

  it('words the badges and the note without a time when the effective slot cannot be shown', () => {
    for (const bad of [NaN, undefined as unknown as number]) {
      const html = render(owner({ weapon: sword2, effectiveSlotIndex: bad }));
      expect(html, String(bad)).toContain('Wears from the next slot</span>');
      expect(html, String(bad)).toContain('Off at the next slot</span>');
      expect(html, String(bad)).toContain('Gear changes start at the next slot. Anything already running');
    }
  });

  it('says a shield needs a free hand under a two-handed weapon and disables its Wear', () => {
    const html = render(owner({ weapon: spear }));
    expect(disabled(button(html, /^Wear Round shield/))).toBe(true);
    expect(button(html, /^Wear Round shield/)).toMatch(/aria-describedby="[^"]*-blocked"/);
    expect(html).toContain('Needs a free hand');
    expect(disabled(button(html, /^Wear Sword, level 1 common/))).toBe(false);
  });
});
