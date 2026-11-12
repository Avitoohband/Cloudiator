import type { ActivityId, Attributes, ClassId, DungeonId, Equipment, GladiatorId, LeagueId, Phase, Schedule, Stance } from './commands.ts';
import type { ActivitySummary, PublicActivitySummary, ItemRarity, ItemStats, RevealedStage, BattleLog } from './events.ts';
import type { Appearance } from '../domain/appearance.ts';

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
  id: ActivityId; kind: 'orientation' | 'training' | 'rest' | 'expedition' | 'arena' | 'tournament' | 'dungeon';
  status: 'queued' | 'active' | 'processing' | 'completed';
  startsAtMs: number; endsAtMs: number; label: string;
};
/** Authenticated owner-only management DTO. No private activity planning inputs. */
export type OwnerState = {
  gladiatorId: GladiatorId; name: string;
  /** The look chosen at creation (M24); null is the legacy look (male body, short hair, colours from the gladiator's id). */
  appearance: Appearance | null;
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
   * this is the slot whose boundary returns it to its schedule, once its owner has signalled since it began resting:
   * normally `processedSlotIndex + 1`, or `processedSlotIndex + 2` when the signal came while the next boundary was being
   * processed and had already rested it (show this value; never derive it).
   * Null otherwise: when it is not resting, and while it rests with no signal since (it would rest at the next boundary too;
   * a `presence` command, then a fresh read, gives the slot).
   */
  restingUntilSlot: number | null;
  /**
   * The account's messages and notifications summary (M25): how many messages are unread, which are read, the cutoff older ones are
   * already read by, and how many of the gladiator's own results are new since the account last saw them.
   */
  inbox: Inbox;
  /** Patch 1.7 (M28): the title worn now (an id of TITLES_V1) or null; every title held, by `earnedAtMs` then id; the counters the titles measure. */
  wornTitle: string | null; titles: EarnedTitle[]; titleProgress: Record<string, number>;
  /**
   * Patch 1.9 (M34): the gear this gladiator sold to the NPCs that it can still buy back: its last 10 gear sales of the current game
   * day (database time of the read), newest first, leaving out those already bought back (a bought-back sale still takes its place
   * among the 10). Salvage is never listed. Absent from an older server's owner read.
   */
  buyBack: BuyBackEntry[];
};
/**
 * One sale that can be bought back (patch 1.9): `item` exactly as it was sold (same id, level, rarity and stats), `price` the gold it
 * was sold for and costs to buy back, `soldAtMs` the database time of the sale, `expiresAtMs` the start of the next game day (a game
 * day is three 80-minute slots, floor(time / 14,400,000)). The `buy-back` command names `saleId`.
 */
export type BuyBackEntry = { saleId: number; item: ItemInstance; price: number; soldAtMs: number; expiresAtMs: number };
/** Patch 1.9: what a piece of feedback is about. */
export type FeedbackCategory = 'bug' | 'idea' | 'balance' | 'other';
/**
 * Patch 1.9: the game details a player may attach to feedback, exactly these keys and nothing else: the patch, the screen (the panel
 * open), the device (browser and OS, phone or desktop) and the window size, each a string of at most 80 characters, and the client's
 * send time in ms.
 */
export type FeedbackDetails = { patch: string; screen: string; device: string; window: string; sentAtMs: number };
/** Patch 1.9: new (sent), read (the team opened it), answered (its one answer was sent as a team-reply message). */
export type FeedbackStatus = 'new' | 'read' | 'answered';
/**
 * Patch 1.9: one of the player's own feedback rows, read through row security from `public.feedback`, which serves these six columns
 * only (`id, category, text, status, created_at_ms, answered_at_ms`). The team's answer arrives as a `team-reply` message whose
 * `publishedAtMs` equals `answeredAtMs`.
 */
export type OwnFeedback = { id: number; category: FeedbackCategory; text: string; status: FeedbackStatus; createdAtMs: number; answeredAtMs: number | null };
/**
 * Patch 1.9: one item of the Game Info editors' feedback list (the game-info Edge function, `{ tab: 'feedback', action: 'list' }`):
 * `gladiatorName` is the name now of the gladiator the account had when it sent the feedback (null without one); `answer` and
 * `answeredAtMs` are null until it is answered.
 */
export type OwnerFeedbackItem = { id: number; category: FeedbackCategory; text: string; details: FeedbackDetails | null; status: FeedbackStatus;
  createdAtMs: number; gladiatorName: string | null; answer: string | null; answeredAtMs: number | null };
/** Patch 1.9: the editors' list, newest first, at most 100 items, and how many are new in all (the Feedback tab's badge). */
export type OwnerFeedbackList = { items: OwnerFeedbackItem[]; newCount: number };
/** Where an earned title came from: the release back-fill, a result, a season award, a shop, a market buy, an NPC sale, creation or the Game Master's hand (patch 1.7.1). */
export type TitleSource = 'history' | 'result' | 'season' | 'shop' | 'market' | 'sale' | 'joined' | 'award';
/** One title a gladiator holds; `detail` names the season place of a season title, null otherwise. */
export type EarnedTitle = { id: string; earnedAtMs: number; activityId: string | null; source: TitleSource;
  detail: { seasonIndex: number; league: LeagueId; place: 1 | 2 | 3 } | null };
/**
 * The owner read's inbox. `unread`: the visible messages published after the gladiator was created (`sinceMs`) that the account
 * has not read (a new player starts at no badge). `readIds`: the ids of the visible messages the account has read, ascending,
 * whichever device read them. `sinceMs`: the gladiator's creation time; the client lists a message published at or before it as
 * already read. `newNotifications`: how many of the gladiator's own results (a completed, revealed activity other than a rest) settled
 * after `notificationsSeenMs`, the later of the account's "seen up to" mark and the gladiator's creation (a `see-notifications`
 * command moves it, on every device).
 */
export type Inbox = { unread: number; readIds: number[]; sinceMs: number; newNotifications: number; notificationsSeenMs: number };
/**
 * One of the owner's own settled results, as a notification (owner-only: read from the owner's `activities`, never public). `summary`
 * is the credited summary the result screens show; `destination` names an expedition's destination (null for any other kind);
 * `levelAfter` is the level the gladiator reached with this result, set only when the result raised its level and when that can be
 * proved from stored data (the XP credited by this and later results and the level now); otherwise null, never a guess.
 */
export type GameNotification = {
  activityId: string; kind: 'training' | 'expedition' | 'arena' | 'tournament' | 'dungeon'; settledAtMs: number; summary: ActivitySummary;
  destination: string | null; levelAfter: number | null;
};
/** One block of a message body: a paragraph or a bullet item, plain text only (never markup). */
export type MessageBlock = { p: string } | { li: string };
/**
 * One game message from the public `game_messages` table (visible rows only), shown as plain text. `action` names a button the
 * message offers: `change-look` opens the look picker. `publishedAtMs` is the database time of posting (never back-dated).
 * Patch 1.9 (M34): `team-reply` is the team's answer to one account's feedback; row security shows it to that account only (its
 * `recipient_id`; every other kind is for everyone), and the owner read's unread count counts it for that account only.
 */
export type GameMessage = {
  id: number; kind: 'patch-notes' | 'admin' | 'team-reply'; title: string; preview: string; body: MessageBlock[]; action: 'change-look' | null; publishedAtMs: number;
};
/** Whitelisted public projection: never spread an OwnerState into this shape. */
export type CampLocation = 'orientation' | 'camp' | 'training' | 'rest' | 'arena' | 'tournament'
  | 'expedition:woodland' | 'expedition:outpost' | 'expedition:mountain' | `dungeon:${DungeonId}`;
export type EquipmentSilhouette = 'weapon-sword' | 'weapon-axe' | 'weapon-spear' | 'weapon-bow' | 'offhand-shield' | 'armor-light' | 'armor-heavy' | 'head-hood' | 'head-helmet' | 'feet-light' | 'feet-heavy';
export type PublicActor = {
  gladiatorId: GladiatorId; name: string; classId: ClassId; equipmentSilhouettes: EquipmentSilhouette[];
  /** The public team marker is present only for a registered Ludus Nimbus actor. */
  botTeam?: 'ludus-nimbus';
  botDuty?: 'on-duty' | 'off-duty';
  botReturnsAtMs?: number | null;
  /** Patch 1.7 (M28): the title worn now, an id of TITLES_V1, or null; absent from an older server's row. A client shows nothing for an id it does not know. */
  title?: string | null;
  /** The look chosen at creation (M24), as OwnerState.appearance; null is the legacy look. Cosmetic only, public like the gear. */
  appearance: Appearance | null;
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
/**
 * A season of 28 days (504 slots). `seasonId` is its index as text; `closedAtMs` is null until the season is closed. `rulesVersion` (Patch
 * 1.6, M27's `seasons.rules_version`) is the rules version that opened it, whose prizes it pays; absent means v1.
 */
export type SeasonView = { seasonId: string; startsAtMs: number; endsAtMs: number; closedAtMs: number | null; rulesVersion?: string };
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
