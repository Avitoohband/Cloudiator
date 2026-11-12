import { describe, expect, it } from 'vitest';
import { ownerFixture } from '../fixtures/domain';
import {
  DUMMY_LOOK, DUMMY_NAME, comparisonRows, dummyFighter, dummyLoad, dummySide, ownSide, practiceFight, presetSetup, runPractice, type DummySetup,
} from '@/features/practice/practice';
import {
  GEAR_CHOICES, PRESET_ORDER, changeLevel, dummySubline, fightable, footerText, gearLevels, overloadText, pointsHelp, pointsText, presetLabel,
  summaryLine, withGear, withGearLevel, withPoint, withPreset, withStance,
} from '@/features/practice/practice-setup';

// Patch 1.9 Task 18: the dummy dialog's edits and words (additions spec section 3, the mockup's `dialogHTML`).
const balanced = presetSetup('balanced', 1);

describe('presets and Custom', () => {
  it('lists the presets in the mockup order with their labels', () => {
    expect(PRESET_ORDER.map(presetLabel)).toEqual(['Balanced', 'Tank', 'Glass cannon', 'Custom']);
  });
  it('applies a preset at the current level, and Custom only renames the setup', () => {
    const tank = withPreset(changeLevel(balanced, 7), 'tank');
    expect(tank).toEqual(presetSetup('tank', 7));
    expect(withPreset(tank, 'custom')).toEqual({ ...tank, preset: 'custom' });
  });
  it('makes any other change Custom', () => {
    expect(withStance(balanced, 'offensive')).toMatchObject({ preset: 'custom', stance: 'offensive' });
    expect(withGear(balanced, 'feet', 'heavy-boots')).toMatchObject({ preset: 'custom', gear: { ...balanced.gear, feet: 'heavy-boots' } });
    expect(withGear(balanced, 'head', null).gear.head).toBeNull();
    expect(withPoint(balanced, 'precision', 1)).toMatchObject({ preset: 'custom', allocations: { ...balanced.allocations, precision: 3 } });
    expect(withGearLevel(changeLevel(balanced, 10), 5)).toMatchObject({ preset: 'custom', gearLevel: 5 });
  });
  it('never takes an attribute below 0 or above the top level\'s points', () => {
    let setup: DummySetup = { ...balanced, allocations: { ...balanced.allocations, agility: 0 } };
    setup = withPoint(setup, 'agility', -1);
    expect(setup.allocations.agility).toBe(0);
    setup = { ...setup, allocations: { ...setup.allocations, agility: 130 } };
    expect(withPoint(setup, 'agility', 1).allocations.agility).toBe(130);
  });
  it('keeps a gear level the level allows, and refuses one it does not', () => {
    expect(withGearLevel(balanced, 10).gearLevel).toBe(1);
    expect(gearLevels(1)).toEqual([1]);
    expect(gearLevels(5)).toEqual([1, 5]);
    expect(gearLevels(30)).toEqual([1, 5, 10]);
  });
});

describe('the level stepper (Review Focus 3)', () => {
  it('re-makes a preset at the new level, its gear level the highest allowed', () => {
    const tank10 = changeLevel(presetSetup('tank', 1), 10);
    expect(tank10).toEqual(presetSetup('tank', 10));
    expect(tank10.gearLevel).toBe(10);
    const tank4 = changeLevel(tank10, 4);
    expect(tank4).toEqual(presetSetup('tank', 4));
    expect(tank4.gearLevel).toBe(1);
    expect(changeLevel(tank4, 10).gearLevel).toBe(10);
  });
  it('keeps Custom\'s points and drops its gear level to the highest allowed', () => {
    const custom = withGearLevel(presetSetup('tank', 10), 5);
    const low = changeLevel(custom, 4);
    expect(low).toMatchObject({ preset: 'custom', level: 4, gearLevel: 1, allocations: custom.allocations });
    expect(pointsText(low)).toEqual({ text: '24 points too many for level 4', over: true });
    expect(fightable(low)).toBe(false);
    expect(changeLevel(low, 10).gearLevel).toBe(1);
    expect(fightable(changeLevel(low, 10))).toBe(true);
  });
  it('stays within 1 to 30 and ignores a level that is not a number', () => {
    expect(changeLevel(balanced, 0).level).toBe(1);
    expect(changeLevel(presetSetup('tank', 30), 31).level).toBe(30);
    expect(changeLevel(balanced, Number.NaN)).toBe(balanced);
  });
});

describe('words', () => {
  it('says the points left or how many too many', () => {
    expect(pointsText(balanced)).toEqual({ text: 'Points left: 0 of 14', over: false });
    expect(pointsText(withPoint(balanced, 'agility', -1))).toEqual({ text: 'Points left: 1 of 14', over: false });
    expect(pointsText(withPoint(balanced, 'agility', 1))).toEqual({ text: '1 point too many for level 1', over: true });
    expect(pointsText(withPoint(withPoint(balanced, 'agility', 1), 'agility', 1))).toEqual({ text: '2 points too many for level 1', over: true });
  });
  it('explains the level\'s points', () => {
    expect(pointsHelp(1)).toBe('14 attribute points: the most a level 1 gladiator can have from Training (10 + 4 per level). Levels 5 and 10 open better gear.');
    expect(pointsHelp(4)).toBe('26 attribute points: the most a level 4 gladiator can have from Training (10 + 4 per level). Levels 5 and 10 open better gear.');
  });
  it('names the dummy\'s level, class and stance', () => {
    expect(dummySubline(balanced)).toBe('Level 1 · no class bonus · balanced stance');
    expect(dummySubline(presetSetup('tank', 3))).toBe('Level 3 · no class bonus · defensive stance');
  });
  it('lists the shop pieces by slot, a two-handed weapon so named', () => {
    expect(GEAR_CHOICES.weapon).toEqual([
      { id: 'sword', label: 'Sword' }, { id: 'axe', label: 'Axe' }, { id: 'spear', label: 'Spear (two hands)' }, { id: 'bow', label: 'Bow (two hands)' }]);
    expect(GEAR_CHOICES.offHand.map(choice => choice.label)).toEqual(['Round shield']);
    expect(GEAR_CHOICES.head.map(choice => choice.label)).toEqual(['Leather hood', 'Iron helmet']);
    expect(GEAR_CHOICES.body.map(choice => choice.label)).toEqual(['Light armor', 'Heavy armor']);
    expect(GEAR_CHOICES.feet.map(choice => choice.label)).toEqual(['Light boots', 'Heavy boots']);
  });
  it('says the footer for the owner\'s build, short on a phone', () => {
    expect(footerText(ownerFixture, false)).toBe('You fight with your current build (Guardian, level 1). Arena rules: renown gear counts 10% more.');
    expect(footerText(ownerFixture, true)).toBe('Your current build, Arena rules.');
  });
  it('says the phone preview\'s numbers from the comparison', () => {
    const rows = comparisonRows(ownSide(ownerFixture).snapshot, dummyFighter(balanced));
    expect(summaryLine(rows)).toBe(`Health ${rows[0][2]} · Damage ${rows[1][2]} · every ${rows[2][2]} · blocks ${rows[3][2]} · Critical ${rows[4][2]}`);
  });
});

describe('overload', () => {
  it('says nothing while the dummy carries what it can', () => {
    expect(overloadText(presetSetup('glass-cannon', 1))).toBeNull();
    expect(overloadText(presetSetup('tank', 1))).toBeNull();
  });
  it('says the load and the share it fights at, as the mockup', () => {
    let heavy = withGear(withGear(withGear(presetSetup('glass-cannon', 1), 'body', 'heavy-armor'), 'head', 'iron-helmet'), 'feet', 'heavy-boots');
    expect(dummyLoad(heavy)).toEqual({ load: 24, capacity: 20, efficiency: 0.9 });
    expect(overloadText(heavy)).toBe('Overloaded: load 24 of 20, fighting at 90%.');
    heavy = withGear(heavy, 'body', null);
    expect(overloadText(heavy)).toBeNull();
  });
  it('does not count an off hand under a two-handed weapon', () => {
    const spear = withGear(withGear(presetSetup('glass-cannon', 1), 'offHand', 'round-shield'), 'body', 'heavy-armor');
    expect(dummyLoad(spear).load).toBe(18);
  });
});

describe('sides and fights', () => {
  it('fights the owner\'s current build against the dummy, a new roll each time', () => {
    const you = ownSide(ownerFixture), dummy = dummySide(balanced);
    expect(you).toMatchObject({ gladiatorId: ownerFixture.gladiatorId, name: 'Aster', look: ownerFixture.appearance });
    expect(dummy).toMatchObject({ gladiatorId: null, name: DUMMY_NAME, look: DUMMY_LOOK });
    const fight = practiceFight('dummy', you, dummy, 'abc');
    expect(fight).toMatchObject({ kind: 'dummy', you, opponent: dummy, seed: 'abc' });
    expect(fight.log).toEqual(runPractice(you, dummy, 'abc'));
    const again = practiceFight('dummy', you, dummy);
    expect(again.seed).toMatch(/^[0-9a-f]{16}$/);
    expect(again.seed).not.toBe(fight.seed);
  });
});
