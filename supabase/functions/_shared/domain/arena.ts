import type { LeagueId } from '../contracts/commands.ts';
import type { BattleLog, CreditedRewards } from '../contracts/events.ts';
import type { DeepReadonly, FighterSnapshot, Rules, Seed } from './types.ts';
import { freezeDomain } from './types.ts';
import { criticalProbability, decimal, type Fraction, fractionValue, hitProbability, multiply, validFighter } from './combat.ts';
import { RULES_V1 } from './rules-v1.ts';
import { seededRandom } from './random.ts';

/** Retained rules by version. A fighter frozen under an unknown version fails closed. */
const RETAINED_RULES: Readonly<Record<string, Rules>> = Object.freeze({ [RULES_V1.version]: RULES_V1 });

function rulesFor(fighter: FighterSnapshot): Rules {
  const version = fighter?.rulesVersion;
  const rules = typeof version === 'string' && Object.hasOwn(RETAINED_RULES, version) ? RETAINED_RULES[version] : null;
  let valid = false;
  try { valid = rules !== null && validFighter(fighter, rules); } catch { valid = false; }
  if (!valid) throw new RangeError('Invalid arena fighter snapshot');
  return rules!;
}

/** The one retained rules version shared by a non-empty set of fighters, each validated against it. Mixed versions fail. */
function sharedRules(fighters: readonly FighterSnapshot[]): Rules {
  if (new Set(fighters.map(fighter => fighter?.rulesVersion)).size !== 1) throw new RangeError('Arena fighters must share one rules version');
  return fighters.map(rulesFor)[0];
}

/** Spec §8.1 league order, lowest first. */
const LEAGUES: readonly LeagueId[] = Object.freeze(['bronze', 'silver', 'gold', 'champion']);

/**
 * Spec §8.1 placement: `2 × level + floor(earned points / 5) + floor(historical gear / 10)`, then the thresholds
 * (v1: below 25 Bronze, 25–59 Silver, 60–119 Gold, 120 and above Champion). `earnedPoints` is every allocatable point the
 * character ever earned, including the starting 10 and banked (unallocated) points; `gearHistory` is the monotonic
 * Task 8 `historicalGearScore`. None of the inputs ever decreases, so placement never drops through equipment removal,
 * sale, discard or respec. The current loadout is deliberately not an input. `rules` is the character's retained
 * rules version (default v1); weights, thresholds and input limits all come from it.
 */
export function leagueFor(level: number, earnedPoints: number, gearHistory: number, rules: Rules = RULES_V1): LeagueId {
  const { attributes, leagues } = rules;
  if (!Number.isSafeInteger(level) || level < 1 || level > attributes.maximumLevel
    || !Number.isSafeInteger(earnedPoints) || earnedPoints < attributes.creationPoints || earnedPoints > attributes.maximumPoints
    || !Number.isFinite(gearHistory) || gearHistory < 0) throw new RangeError('Invalid league progression input');
  const index = leagues.levelWeight * level + Math.floor(earnedPoints / leagues.earnedPointsDivisor)
    + Math.floor(gearHistory / leagues.historicalGearDivisor);
  return index >= leagues.champion ? 'champion' : index >= leagues.gold ? 'gold' : index >= leagues.silver ? 'silver' : 'bronze';
}

/** Nominal Elo changes for one human bout: the winner gains `winner`, the loser receives `loser` (its negative). */
export type RatingDelta = { winner: number; loser: number };
/** Ratings after applying a human bout, clamped at the rules minimum (v1: 0), and the change actually applied to each. */
export type RatingUpdate = { winner: number; loser: number; applied: RatingDelta };

function validRating(rating: number, rules: Rules): void {
  if (!Number.isSafeInteger(rating) || rating < rules.rating.minimum) throw new RangeError('Invalid arena rating');
}

/**
 * Spec §8.1 Elo (v1: K = 24, scale 400): the winner's expectation is `1 / (1 + 10^((loser − winner) / 400))` and its
 * gain is `round(24 × (1 − expectation))`; the loser receives the negative. Only human bouts call this; NPC bouts never
 * change a rating. `ratingDelta(1000, 1000)` is `{ winner: 12, loser: -12 }`. `rules` defaults to v1.
 */
export function ratingDelta(winnerRating: number, loserRating: number, rules: Rules = RULES_V1): RatingDelta {
  validRating(winnerRating, rules);
  validRating(loserRating, rules);
  const { k, expectationScale } = rules.rating;
  const expected = 1 / (1 + 10 ** ((loserRating - winnerRating) / expectationScale));
  const gain = Math.round(k * (1 - expected));
  // `0 - gain` keeps a zero loss as positive zero in JSON-equal and Object.is comparisons.
  return { winner: gain, loser: 0 - gain };
}

/**
 * Applies `ratingDelta`, then clamps each rating at the rules minimum (v1: zero). `applied` is the change each rating
 * actually received. `rules` defaults to v1.
 */
export function applyRatingDelta(winnerRating: number, loserRating: number, rules: Rules = RULES_V1): RatingUpdate {
  const delta = ratingDelta(winnerRating, loserRating, rules);
  const minimum = rules.rating.minimum;
  const winner = Math.max(minimum, winnerRating + delta.winner);
  const loser = Math.max(minimum, loserRating + delta.loser);
  if (!Number.isSafeInteger(winner) || !Number.isSafeInteger(loser)) throw new RangeError('Arena rating exceeds the safe integer range');
  return { winner, loser, applied: { winner: winner - winnerRating, loser: loser - loserRating } };
}

/**
 * Significant digits that recover the exact decimal of an engine probability. The v1 coefficients have at most three
 * decimals and effective attributes at most hundredths, so an exact probability has at most five decimals, while the
 * engine's floating-point sum can be off by about 1e-16 (Precision 17: .7699999999999999 for the exact .77).
 */
const PROBABILITY_DIGITS = 12;
/** The engine's own probability formula, normalised to the exact decimal its rule arithmetic defines. */
const exactProbability = (probability: number): Fraction => decimal(Number(probability.toPrecision(PROBABILITY_DIGITS)));

/**
 * Spec §8.1 strength estimate: `max health × expected outgoing damage per second` for a frozen **arena** fighter (its base
 * damage already carries the bound arena weapon modifier). Expected damage per attack is base damage × efficiency ×
 * outgoing stance × the engine's hit probability against the reference Agility 5 × the expected critical multiplier
 * `1 + (1.5 − 1) × critical probability`, against a reference target with armor 0 and incoming stance 1, so the
 * fighter's own armor never matters; the frozen attack interval already includes efficiency. The hit and critical
 * probabilities come from the engine's formulas, normalised to 12 significant digits to remove their floating-point
 * error; every factor is then an exact decimal, and the product is rounded once, half-up, to hundredths.
 * The estimate orders opponents only; the seeded combat engine still decides bouts with its own probabilities.
 */
export function estimateArenaStrength(fighter: FighterSnapshot): number {
  return strengthOf(fighter, rulesFor(fighter));
}

/** `estimateArenaStrength` for a fighter already validated against `rules`. */
function strengthOf(fighter: FighterSnapshot, rules: Rules): number {
  const precision = fighter.attributes.precision;
  const criticalBonus = decimal(rules.combat.criticalDamage);
  const extra = multiply({ numerator: criticalBonus.numerator - criticalBonus.denominator, denominator: criticalBonus.denominator },
    exactProbability(criticalProbability(precision, rules)));
  const expectedCritical: Fraction = { numerator: extra.denominator + extra.numerator, denominator: extra.denominator };
  const perSecond: Fraction = { numerator: 1000n, denominator: BigInt(fighter.attackIntervalMs) };
  const hit = exactProbability(hitProbability(precision, rules.leagues.referenceAgility, rules));
  const total = [fighter.maxHealth, fighter.baseDamage, fighter.efficiency, rules.stances[fighter.stance].outgoing].map(decimal)
    .reduce(multiply, multiply(multiply(expectedCritical, perSecond), hit));
  const cents = (200n * total.numerator + total.denominator) / (2n * total.denominator);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Arena strength exceeds the safe integer range');
  return Number(cents) / 100;
}

/**
 * Spec §7 NPC fallback template, generated from the entrant's frozen arena fighter: the same effective attributes,
 * (arena) armor, attack interval, efficiency and visible equipment; Balanced stance; no class; maximum health
 * (floored, at least 1) and pre-stance base damage at 85% of the player's. The interval already contains efficiency and
 * base damage does not, so the engine applies overload efficiency exactly once to each; nothing re-applies class,
 * arena-damage or overload modifiers. The template carries no rewards; callers retain it with the activity.
 */
export function makeFallback(fighter: FighterSnapshot): FighterSnapshot {
  return fallbackOf(fighter, rulesFor(fighter));
}

/** `makeFallback` for a fighter already validated against `rules`. */
function fallbackOf(fighter: FighterSnapshot, rules: Rules): FighterSnapshot {
  const factor = decimal(rules.arena.npcHealthDamageMultiplier);
  const health = multiply(decimal(fighter.maxHealth), factor);
  const a = fighter.attributes;
  return freezeDomain({ rulesVersion: fighter.rulesVersion, classId: null, stance: 'balanced',
    attributes: { strength: a.strength, agility: a.agility, vitality: a.vitality, endurance: a.endurance, precision: a.precision },
    maxHealth: Math.max(1, Number(health.numerator / health.denominator)), armor: fighter.armor, weaponDamage: fighter.weaponDamage,
    baseDamage: fractionValue(multiply(decimal(fighter.baseDamage), factor)), attackIntervalMs: fighter.attackIntervalMs,
    efficiency: fighter.efficiency, equipmentSilhouettes: [...fighter.equipmentSilhouettes] });
}

/** One regular-Arena entrant, frozen at the slot cutoff before pairing (spec §4.1 step 7). */
export type ArenaEntrant = DeepReadonly<{
  gladiatorId: string;
  /** The entrant's activity; its private snapshot holds the frozen build that `fighter` was derived from. */
  activityId: string;
  seasonId: string; league: LeagueId; slotIndex: number;
  /** The entrant's rating for this league and season before the bout. */
  rating: number;
  /** `makeFighter(snapshot.build, 'arena', rules)` of the frozen activity build. */
  fighter: FighterSnapshot;
}>;
/** One earlier human regular-Arena bout between two characters (any league or season), identified by its slot. */
export type PairingHistory = DeepReadonly<{ slotIndex: number; gladiatorIds: [string, string] }>;
/** One entrant's side of an assignment. In the bout's battle log a human side's participant id is its `gladiatorId`. */
export type ArenaSide = DeepReadonly<{ gladiatorId: string; activityId: string; rating: number; strength: number; fighter: FighterSnapshot }>;
type AssignmentScope = { battleId: string; seasonId: string; league: LeagueId; slotIndex: number };
/**
 * One regular bout for one season, league and slot, referencing each entrant's activity and frozen arena fighter.
 * Both sides of a human bout share its `battleId`. An NPC bout's opponent is the entrant's fallback template, generated
 * once here; its battle participant id is `opponent.id` (`npc:<entrant gladiatorId>`) with a null `gladiatorId`.
 */
export type ArenaAssignment = DeepReadonly<
  | (AssignmentScope & { kind: 'human'; sides: [ArenaSide, ArenaSide] })
  | (AssignmentScope & { kind: 'npc'; sides: [ArenaSide]; opponent: { id: string; snapshot: FighterSnapshot } })>;

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pairKey = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);
function copyFighter(f: FighterSnapshot): FighterSnapshot {
  const a = f.attributes;
  return { rulesVersion: f.rulesVersion, classId: f.classId, stance: f.stance,
    attributes: { strength: a.strength, agility: a.agility, vitality: a.vitality, endurance: a.endurance, precision: a.precision },
    maxHealth: f.maxHealth, armor: f.armor, weaponDamage: f.weaponDamage, baseDamage: f.baseDamage,
    attackIntervalMs: f.attackIntervalMs, efficiency: f.efficiency, equipmentSilhouettes: [...f.equipmentSilhouettes] };
}

/**
 * Spec §8.1 regular pairing, league by league (never across leagues). Entrants are ordered by current strength
 * estimate, then rating (both highest first), then a seeded per-entrant tie-break. The first unpaired entrant takes the
 * eligible opponent with the nearest strength, then the fewest pairings in the preceding 18 slots, then the nearest
 * rating, then the seeded tie-break; both are removed and pairing continues. A pair is ineligible when its larger
 * estimate exceeds twice the smaller (exactly twice is allowed). Any entrant left without an opponent gets an NPC bout.
 * All entrants share one season and slot. Deterministic for the same inputs and seed, independent of input order.
 */
export function matchArena(entrants: readonly ArenaEntrant[], recent: readonly PairingHistory[], seed: Seed): ArenaAssignment[] {
  if (!Array.isArray(entrants) || !Array.isArray(recent) || !nonEmpty(seed)) throw new RangeError('Invalid arena pairing input');
  // One retained rules version for the whole pairing: window, cap, ratings and strengths all come from it (with no
  // entrants nothing is paired and the window is never read).
  const rules = entrants.length > 0 ? sharedRules(entrants.map(entrant => entrant?.fighter)) : RULES_V1;
  const slot = entrants[0]?.slotIndex, season = entrants[0]?.seasonId;
  const ids = new Set<string>(), activities = new Set<string>();
  const pool = entrants.map(entrant => {
    if (!entrant || !nonEmpty(entrant.gladiatorId) || !nonEmpty(entrant.activityId) || !nonEmpty(entrant.seasonId)
      || !LEAGUES.includes(entrant.league) || !Number.isSafeInteger(entrant.slotIndex) || entrant.slotIndex < 0
      || entrant.slotIndex !== slot || entrant.seasonId !== season || ids.has(entrant.gladiatorId) || activities.has(entrant.activityId)) {
      throw new RangeError('Invalid arena entrant');
    }
    validRating(entrant.rating, rules);
    ids.add(entrant.gladiatorId);
    activities.add(entrant.activityId);
    const strength = strengthOf(entrant.fighter, rules);
    return { entrant, strength, cents: Math.round(strength * 100), tie: seededRandom(`${seed}:arena:${entrant.gladiatorId}`)() };
  });
  const recentPairings = new Map<string, number>();
  for (const pairing of recent) {
    const pair = pairing?.gladiatorIds;
    if (!Array.isArray(pair) || pair.length !== 2 || !nonEmpty(pair[0]) || !nonEmpty(pair[1]) || pair[0] === pair[1]
      || !Number.isSafeInteger(pairing.slotIndex) || pairing.slotIndex < 0 || (slot !== undefined && pairing.slotIndex >= slot)) {
      throw new RangeError('Invalid arena pairing history');
    }
    // Only the preceding window counts: slots S − 18 … S − 1.
    if (slot !== undefined && pairing.slotIndex >= slot - rules.matchmaking.recentPairingSlots) {
      const key = pairKey(pair[0], pair[1]);
      recentPairings.set(key, (recentPairings.get(key) ?? 0) + 1);
    }
  }
  type Candidate = (typeof pool)[number];
  const pairings = (a: Candidate, b: Candidate) => recentPairings.get(pairKey(a.entrant.gladiatorId, b.entrant.gladiatorId)) ?? 0;
  const seeded = (a: Candidate, b: Candidate) => a.tie - b.tie || compareIds(a.entrant.gladiatorId, b.entrant.gladiatorId);
  const order = (a: Candidate, b: Candidate) => b.cents - a.cents || b.entrant.rating - a.entrant.rating || seeded(a, b);
  const nearer = (first: Candidate, a: Candidate, b: Candidate) => Math.abs(first.cents - a.cents) - Math.abs(first.cents - b.cents)
    || pairings(first, a) - pairings(first, b)
    || Math.abs(first.entrant.rating - a.entrant.rating) - Math.abs(first.entrant.rating - b.entrant.rating) || seeded(a, b);
  const eligible = (a: Candidate, b: Candidate) =>
    Math.max(a.cents, b.cents) <= rules.matchmaking.maximumStrengthRatio * Math.min(a.cents, b.cents);
  const side = (c: Candidate): ArenaSide => ({ gladiatorId: c.entrant.gladiatorId, activityId: c.entrant.activityId,
    rating: c.entrant.rating, strength: c.strength, fighter: copyFighter(c.entrant.fighter) });
  const assignments: ArenaAssignment[] = [];
  for (const league of LEAGUES) {
    const open = pool.filter(c => c.entrant.league === league).sort(order);
    const scope = { seasonId: season!, league, slotIndex: slot! };
    while (open.length > 0) {
      const first = open.shift()!;
      let best = -1;
      open.forEach((other, i) => { if (eligible(first, other) && (best < 0 || nearer(first, other, open[best]) < 0)) best = i; });
      const id = first.entrant.gladiatorId;
      if (best < 0) {
        assignments.push(freezeDomain({ kind: 'npc' as const, battleId: `arena:${slot}:${id}:npc`, ...scope, sides: [side(first)] as [ArenaSide],
          opponent: { id: `npc:${id}`, snapshot: fallbackOf(first.entrant.fighter, rules) } }));
      } else {
        const [opponent] = open.splice(best, 1);
        assignments.push(freezeDomain({ kind: 'human' as const, battleId: `arena:${slot}:${id}:${opponent.entrant.gladiatorId}`, ...scope,
          sides: [side(first), side(opponent)] as [ArenaSide, ArenaSide] }));
      }
    }
  }
  return assignments;
}

/** One entrant's regular-Arena result: renown only (no XP, money, points or items); Elo for human bouts only. */
export type ArenaOutcome = DeepReadonly<{
  gladiatorId: string; activityId: string; result: 'victory' | 'defeat'; success: boolean; rewards: CreditedRewards;
  ratingBefore: number; ratingAfter: number; ratingDelta: number;
}>;

/**
 * Pure regular-Arena rewards for an assignment's revealed bout, one outcome per side in assignment order. The winner is
 * the log's `winnerId`, including a seeded simultaneous-defeat winner at zero health. Human bouts credit 10 renown for a
 * win and 2 for a loss and apply clamped Elo from the frozen side ratings; NPC bouts credit 3 or 0 renown and never
 * change rating. No XP or money is ever granted. Rejects a log that is not this assignment's bout: every fighter of the
 * bout (both sides, or the side and the NPC template) must be valid under one retained rules version, and the log's
 * participants must be exactly the bout's, a human logged with its own `gladiatorId` and the NPC with a null one.
 */
export function arenaOutcomes(assignment: ArenaAssignment, log: BattleLog): ArenaOutcome[] {
  const sides = assignment?.sides;
  const npc = assignment?.kind === 'npc' && sides?.length === 1 ? assignment.opponent : null;
  // Each participant's battle-log identity, as `[participant id, logged gladiatorId]`.
  const expected: readonly (readonly [string, string | null])[] | null = assignment?.kind === 'human' && sides?.length === 2
    ? [[sides[0].gladiatorId, sides[0].gladiatorId], [sides[1].gladiatorId, sides[1].gladiatorId]]
    : npc ? [[sides[0].gladiatorId, sides[0].gladiatorId], [npc.id, null]] : null;
  const ids = expected?.map(([id]) => id) ?? [];
  const logged = Array.isArray(log?.participants) ? log.participants : [];
  if (!expected || !ids.every(nonEmpty) || ids[0] === ids[1] || !nonEmpty(assignment.battleId)
    || log.battleId !== assignment.battleId || logged.length !== 2
    || !expected.every(([id, gladiatorId]) => logged.some(p => p?.id === id && p.gladiatorId === gladiatorId))
    || !ids.includes(log.winnerId)) throw new RangeError('Battle log does not belong to the arena assignment');
  const rules = sharedRules([...sides.map(side => side.fighter), ...(npc ? [npc.snapshot] : [])]);
  if (log.rulesVersion !== rules.version) throw new RangeError('Battle log does not belong to the arena assignment');
  sides.forEach(side => validRating(side.rating, rules));
  const { humanWinRenown, humanLossRenown, npcWinRenown, npcLossRenown } = rules.arena;
  const outcome = (side: ArenaSide, won: boolean, renown: number, ratingAfter: number): ArenaOutcome => freezeDomain({
    gladiatorId: side.gladiatorId, activityId: side.activityId, result: won ? 'victory' as const : 'defeat' as const, success: won,
    rewards: { money: 0, renown, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 },
    ratingBefore: side.rating, ratingAfter, ratingDelta: ratingAfter - side.rating });
  if (assignment.kind === 'npc') {
    const won = log.winnerId === sides[0].gladiatorId;
    return [outcome(sides[0], won, won ? npcWinRenown : npcLossRenown, sides[0].rating)];
  }
  const [first, second] = assignment.sides;
  const [winner, loser] = log.winnerId === first.gladiatorId ? [first, second] : [second, first];
  const update = applyRatingDelta(winner.rating, loser.rating, rules);
  return assignment.sides.map(side => side === winner
    ? outcome(side, true, humanWinRenown, update.winner) : outcome(side, false, humanLossRenown, update.loser));
}
