import type { ActivityId, Attributes, ClassId, Equipment, GladiatorId, LeagueId, Phase, Schedule, Stance } from './commands.ts';
import type { PublicActivitySummary, ItemRarity, ItemStats, RevealedStage, BattleLog } from './events.ts';

export type BuildView = { version: number; classId: ClassId; stance: Stance; allocations: Attributes; equipment: Equipment };
export type PendingBuildView = { build: BuildView; effectiveSlotIndex: number; reservedMoney: number; reservedItemIds: string[]; operationId: string };
export type ItemInstance = {
  id: string; ownerId: GladiatorId; catalogId: string; catalogVersion: string;
  tier: 1 | 5 | 10; rarity: ItemRarity; stats: ItemStats; quantity: number;
  origin: 'starter' | 'shop' | 'expedition' | 'renown';
  binding: 'bound' | 'tradable';
  reservation: { kind: 'equipment' | 'pending-build' | 'listing'; referenceId: string } | null;
};
export type CurrentActivity = {
  id: ActivityId; kind: 'orientation' | 'training' | 'rest' | 'expedition' | 'arena' | 'tournament';
  status: 'queued' | 'active' | 'processing' | 'completed';
  startsAtMs: number; endsAtMs: number; label: string;
};
/** Authenticated owner-only management DTO. No private activity planning inputs. */
export type OwnerState = {
  gladiatorId: GladiatorId; name: string;
  currentBuild: BuildView; pendingBuild: PendingBuildView | null;
  /** Monotonic queue/replace/cancel revision; currentBuild.version changes only on activation. */
  buildVersion: number;
  schedule: Schedule; scheduleVersion: number;
  wallets: { money: number; renown: number }; reservedFees: { money: number; renown: number };
  inventory: ItemInstance[]; inventoryCapacity: number;
  ownedCosmetics: { catalogId: string; catalogVersion: string; binding: 'bound' }[];
  progression: { level: number; xp: number; earnedAttributePoints: number; unspentAttributePoints: number; league: LeagueId; peakStrength: number; rating: number };
  stamina: { current: number; maximum: number };
  tournamentOptIn: boolean; processedSlotIndex: number;
  currentActivity: CurrentActivity | null;
  /**
   * Task 23.8, the idle rest (`RULES_V1.idle`). At each boundary a character rests at home, with no activity, when its owner's
   * last activity signal (any command, `presence` included; stored at most once an hour) is at least `idle.afterMs` before
   * that boundary's scheduled start. While it rests in its current slot (`processedSlotIndex`, so `currentActivity` is null),
   * this is the slot whose boundary returns it to its schedule: `processedSlotIndex + 1`, once its owner has signalled since
   * it began resting (that next boundary's start minus the owner's last signal is then under `idle.afterMs`).
   * Null otherwise: when it is not resting, and while it rests with no signal since (it would rest at the next boundary too;
   * a `presence` command, then a fresh read, makes it the next slot).
   */
  restingUntilSlot: number | null;
};
/** Whitelisted public projection: never spread an OwnerState into this shape. */
export type CampLocation = 'orientation' | 'camp' | 'training' | 'rest' | 'arena' | 'tournament' | 'expedition:woodland' | 'expedition:outpost' | 'expedition:mountain';
export type EquipmentSilhouette = 'weapon-sword' | 'weapon-axe' | 'weapon-spear' | 'weapon-bow' | 'offhand-shield' | 'armor-light' | 'armor-heavy' | 'head-hood' | 'head-helmet' | 'feet-light' | 'feet-heavy';
export type PublicActor = {
  gladiatorId: GladiatorId; name: string; classId: ClassId; equipmentSilhouettes: EquipmentSilhouette[];
  league: LeagueId; level: number; phase: Phase; location: CampLocation;
  activityId: ActivityId | null; activityStatus: CurrentActivity['status'] | 'idle';
  startsAtMs: number | null; endsAtMs: number | null; visibleStage: RevealedStage | null;
  /**
   * Task 23.8: true while the character rests at home in its current slot (OwnerState.restingUntilSlot): it then has no
   * activity, so `location` is 'camp', `activityId` null, `activityStatus` 'idle', and the times and stage are null. Players
   * see "Resting at home: back when {name}'s owner returns."
   */
  resting: boolean;
};
export type RevisionState = {
  revision: string; serverNowMs: number; slotIndex: number;
  /**
   * Task 23.2 (C5): the latest slot whose boundary is published, from the public revision read (M18); null before the first
   * coordination. A slot with `publishedSlotIndex < slotIndex` is still being prepared. Additive: absent from fixture worlds.
   */
  publishedSlotIndex?: number | null;
};
export type WorldSnapshot = RevisionState & { actors: PublicActor[] };
/**
 * One season award on a public profile (Task 21), oldest season first. `seasonId` is the season index as text (players see
 * "Season index + 1"); `title` is the champion title of a first place, null for second and third.
 */
export type PrestigeAward = { seasonId: string; league: LeagueId; place: 1 | 2 | 3; badge: 'gold' | 'silver' | 'bronze'; title: 'champion' | null };
export type PublicProfile = { actor: PublicActor; combatStrength: number | null; rating: number; prestige: PrestigeAward[] };
/** Producers enforce <= 50 rows. Cursors are opaque strings. */
export type CursorPage<T> = { rows: T[]; nextCursor: string | null };
/** One open fixed-price offer from the public projection: never the item's id, owner, origin, binding or reservation. */
export type MarketListing = {
  listingId: string; seller: Pick<PublicActor, 'gladiatorId' | 'name'>;
  item: Pick<ItemInstance, 'catalogId' | 'catalogVersion' | 'tier' | 'rarity' | 'stats' | 'quantity'>;
  price: number;
  /** Database time the listing was created; pages run newest first by it, then by listing id. */
  listedAtMs: number;
  expiresAtMs: number;
};
export type MarketPage = CursorPage<MarketListing>;
export type StandingRow = {
  rank: number; gladiatorId: GladiatorId; name: string; rating: number;
  humanWins: number; humanLosses: number; promoted: boolean; inactive: boolean; rewardEligible: boolean;
  /** The place (1 to 3) the row's award took when its season closed; always null for an open season. */
  awardPlace: 1 | 2 | 3 | null;
};
/**
 * One league's standings page of one season. `archived` is true for a closed season, whose rows are the frozen archive
 * (flags and award places as fixed at the close); an open season's rows are live. The cursor `season:rank` stays in its season.
 */
export type StandingsPage = CursorPage<StandingRow> & { league: LeagueId; seasonId: string; archived: boolean };
/** A season of 28 days (504 slots). `seasonId` is its index as text; `closedAtMs` is null until the season is closed. */
export type SeasonView = { seasonId: string; startsAtMs: number; endsAtMs: number; closedAtMs: number | null };
export type TournamentEntrant = { gladiatorId: GladiatorId; name: string; classId: ClassId };
/** A fought bout's public facts from its log: how long it plays and how its winner won (Task 19 phase 2b review I1). */
export type TournamentFightSummary = Pick<BattleLog, 'durationMs' | 'victoryReason' | 'tieBreakReason'>;
export type TournamentBout = {
  id: string; round: number; position: number; parentBoutIds: string[];
  /**
   * Null means not revealed, including participants in future rounds. A polled tournament read carries a fought bout's
   * `fight` summary and never its `battleLog`, which loads on demand (`GameGateway.tournamentLog`); a bye has neither.
   */
  revealedResult: { participants: TournamentEntrant[]; winnerId: GladiatorId; bye: boolean; fight?: TournamentFightSummary; battleLog?: BattleLog } | null;
};
/**
 * The bracket's shape and its seeded first round, public from the start (no result): `slots` has `size` seats in bracket
 * order, round-one bout p seating `slots[2p]` against `slots[2p + 1]`; `null` is an empty seat, a bye for the other.
 */
export type TournamentBracket = { size: number; rounds: number; slots: (GladiatorId | null)[] };
/**
 * One settled entrant's public place, with Task 10's safe completion fields only. Never rewards or receipts: an owner reads
 * its own rewards from its own activity timeline (`completion.activityId`), under RLS.
 */
export type TournamentPlacement = { gladiatorId: GladiatorId; place: number; completion: PublicActivitySummary };
export type TournamentView = {
  id: string; league: LeagueId; slotIndex: number; startsAtMs: number; endsAtMs: number;
  status: 'scheduled' | 'active' | 'processing' | 'completed' | 'insufficient-entrants';
  /** Null before the start and for a league below the minimum. */
  bracket: TournamentBracket | null;
  entrants: TournamentEntrant[]; bouts: TournamentBout[];
  /** Empty until every entrant has settled at minute 80. */
  placements: TournamentPlacement[];
};
export type ResultRow = { gladiatorId: GladiatorId; name: string; summary: PublicActivitySummary };
export type ResultsPage = CursorPage<ResultRow>;
