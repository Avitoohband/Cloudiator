import { freezeDomain } from './types.ts';

/** Approved launch balance. Later versions get separate immutable modules. */
export const RULES_V1 = freezeDomain({
  version: 'v1',
  clock: { slotMs: 4_800_000, phases: ['morning', 'afternoon', 'evening'] as const },
  // Launch feedback (2026-10-25): Arena may be scheduled only in these parts of the day. Edge parseCommand and SQL
  // planning_command enforce it at command time; the boundary does not re-check it.
  schedule: { arenaPhases: ['evening'] as const },
  attributes: { base: 5, creationPoints: 10, maximumPoints: 1_000_000_000, maximumLevel: 1_000_000_000 },
  classes: {
    berserker: { strength: 1.1, agility: 1, vitality: 1, endurance: 1, precision: 1 },
    guardian: { strength: 1, agility: 1, vitality: 1.05, endurance: 1.05, precision: 1 },
    duelist: { strength: 1, agility: 1.05, vitality: 1, endurance: 1, precision: 1.05 },
  },
  resources: { healthBase: 50, healthPerVitality: 10, staminaBase: 90, staminaPerEndurance: 2,
    capacityBase: 10, capacityPerEndurance: 2, overloadPenalty: 0.5, minimumEfficiency: 0.5 },
  activityStamina: { training: 20, expedition: 30, arena: 25, tournament: 25, rest: 0 },
  progression: { trainingPoints: 1, xpPerCurrentLevel: 100, levelAttributePoints: 0, levelStaminaRefill: 0 },
  // Launch feedback (2026-10-25): the market fee is the 5% rate floored but at least marketMinimum, and the lowest listing price is
  // minimumPrice (2), so a seller always receives something. SQL market_command restates both: greatest(1, price*5/100), price from 2.
  fees: { classChange: 100, respec: 100, marketRate: 0.05, marketMinimum: 1, listing: 0 },
  tiers: { 1: { stats: 1, moneyPrice: 1, renownPrice: 1 }, 5: { stats: 1.5, moneyPrice: 3, renownPrice: 2 }, 10: { stats: 2, moneyPrice: 6, renownPrice: 3 } },
  rarities: { common: { stats: 1, lootChance: 0.7 }, uncommon: { stats: 1.15, lootChance: 0.25 }, rare: { stats: 1.3, lootChance: 0.05 } },
  inventory: { capacity: 60, salvageStack: 999, salvageSellValue: 10 },
  shops: { npcSellRate: 0.25, minimumSellValue: 1, renownArenaMultiplier: 1.1, bannerRenownPrice: 50 },
  marketplace: { maximumListings: 5, expiryMs: 604_800_000, minimumPrice: 2, maximumPrice: 1_000_000_000 },
  stances: { offensive: { outgoing: 1.15, incoming: 1.1 }, balanced: { outgoing: 1, incoming: 1 }, defensive: { outgoing: 0.9, incoming: 0.85 } },
  combat: { strengthDamage: 0.5, agilityRate: 0.01, minimumIntervalMs: 250,
    hitBase: 0.7, hitPrecision: 0.005, hitDefenderAgility: 0.003, minimumHit: 0.1, maximumHit: 0.95,
    criticalBase: 0.05, criticalPrecision: 0.003, minimumCritical: 0.05, maximumCritical: 0.4, criticalDamage: 1.5,
    armorReductionPerPoint: 0.02, maximumArmorReduction: 0.7, minimumDamage: 1, maximumDurationMs: 120_000,
    unarmedDamage: 0, unarmedIntervalMs: 1000 },
  arena: { humanWinRenown: 10, humanLossRenown: 2, npcWinRenown: 3, npcLossRenown: 0,
    npcHealthDamageMultiplier: 0.85, revealAfterMs: 3_600_000 },
  leagues: { silver: 25, gold: 60, champion: 120, levelWeight: 2, earnedPointsDivisor: 5, historicalGearDivisor: 10,
    gearDamageWeight: 4, gearArmorWeight: 2, referenceAgility: 5 },
  matchmaking: { maximumStrengthRatio: 2, recentPairingSlots: 18 },
  rating: { initial: 1000, k: 24, expectationScale: 400, minimum: 0 },
  // hourUtc/minuteUtc: the 18:40 UTC evening slot, the one part Arena may be scheduled in (launch feedback, 2026-10-25; it
  // was the afternoon's 17:20 UTC). durationMs: one 80-minute slot; round r of R reveals at durationMs × r / (R + 1) and every reward settles at durationMs.
  tournament: { utcWeekdays: [3, 6], hourUtc: 18, minuteUtc: 40, minimumEntrants: 2, durationMs: 4_800_000,
    placements: { winner: { money: 100, renown: 50 }, runnerUp: { money: 60, renown: 30 }, semifinal: { money: 30, renown: 15 }, other: { money: 0, renown: 5 } } },
  seasons: { durationSlots: 504, durationMs: 2_419_200_000, minimumHumanBouts: 5,
    placements: [{ money: 500, renown: 100, title: 'champion', badge: 'gold' }, { money: 300, renown: 60, title: null, badge: 'silver' }, { money: 200, renown: 40, title: null, badge: 'bronze' }] },
  retention: { replayMs: 604_800_000, summaryMs: 7_776_000_000 },
  // Task 23.8 (Avi's decision, 2026-10-19): a character rests at home at a boundary whose scheduled start is at least
  // afterMs (14 days, 252 slots) after its owner's last activity signal. SQL restates it as private.idle_rules().
  idle: { afterMs: 1_209_600_000 },
});
