import { describe, expect, it } from 'vitest';
import { statHelp } from '../../src/features/character/profile-card';
import { attributeNumbers, loadHelp, staminaHelp, statNumbers } from '../../src/features/character/stat-numbers';

// The second line of each help tooltip, written out from the approved mockup (the rules' numbers as of Patch 1.9).
describe('help numbers', () => {
  it('words the stats', () => {
    expect(statNumbers).toEqual({
      Health: 'Base 50, plus 10 for each Vitality.',
      Damage: 'Each Strength adds 0.5 damage.',
      'Attack speed': 'Each Agility speeds attacks by 1%; never faster than every 0.25 s.',
      Armor: 'Each armor point blocks 2% of a hit, up to 70%.',
      Critical: 'Base 5%, plus 0.3% for each Precision, up to 40%.',
      'Critical damage': 'A critical hit deals 1.5 times the damage of a normal hit.',
      Stamina: 'Base 90, plus 2 for each Endurance.',
      Load: 'Capacity is 10, plus 2 for each Endurance.',
    });
  });
  it('words the help sentences, with the Arena bonus of renown gear and the extra damage of a critical hit', () => {
    expect(statHelp.Critical).toBe('Chance for a landed hit to be a critical hit, which deals 50% more damage. Precision raises it.');
    expect(statHelp['Critical damage']).toBe('How much more a critical hit deals than a normal hit.');
    expect(statHelp.Armor).toBe('Equipped armor reduces the damage you take from landed hits. Renown armor counts 10% more in the Arena.');
    expect(statHelp.Damage).toBe('Damage from a normal hit before the target’s defenses. Weapon damage, Strength, stance, and gear overload affect it. A renown weapon deals 10% more in the Arena.');
  });
  it('words the attributes', () => {
    expect(attributeNumbers).toEqual({
      strength: 'Each point adds 0.5 damage.',
      agility: 'Each point speeds attacks by 1% and lowers enemies’ chance to hit you by 0.3%.',
      vitality: 'Each point adds 10 health.',
      endurance: 'Each point adds 2 stamina and 2 load capacity.',
      precision: 'Each point adds 0.5% to hit and 0.3% to critical chance.',
    });
  });
  it('words stamina and load', () => {
    expect(staminaHelp).toBe('What your activities spend; resting gives it back. Endurance raises it.');
    expect(loadHelp).toBe('How much your worn gear weighs against what you can carry. Over the limit you fight at lower efficiency (down to 50%).');
  });
});
