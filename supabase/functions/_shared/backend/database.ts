import type { SupabaseClient } from '@supabase/supabase-js';
import type { GameCommand, CommandResult, DayScheduleValue } from '../contracts/commands.ts';
import type { ItemInstance, OwnerState, PendingBuildView } from '../contracts/reads.ts';
import type { Actor } from './auth.ts';
import { CATALOG_V1 } from '../domain/catalog-v1.ts';
import { RULES_V1 } from '../domain/rules-v1.ts';
import { buildChangeFee, validateBuild, validateCreationAllocation } from '../domain/build.ts';
import { deriveStats } from '../domain/stats.ts';
import { applyXp, historicalGearScore, npcSaleValue, planInventoryGrant, shopOffer } from '../domain/inventory.ts';
import type { ExpeditionRewards } from '../domain/expedition.ts';
import type { InventoryGrantPlan, ShopOffer } from '../domain/inventory.ts';
import type { TournamentGraph } from '../domain/tournament.ts';
import type { CoordinatorReport, JobKind, JobLease } from '../domain/types.ts';

type Creation = Extract<GameCommand, { kind: 'create-character' }>;
export type PlanningCommand = Extract<GameCommand, { kind: 'queue-build' | 'cancel-build' | 'edit-schedule' | 'edit-day-schedule' }>;
export type BuildDraft = PendingBuildView;
export type ScheduleEditValue = { version: number; receivedAtMs: number; effectiveSlotIndex: number; effectiveAtMs: number };
export type PlanningValue = BuildDraft | ScheduleEditValue | DayScheduleValue | { buildVersion: number };
/** Each planning kind's RPC; every one is `private.planning_command` under that kind (SQL checks the kind matches). */
const PLANNING_RPC: Record<PlanningCommand['kind'], string> = {
  'queue-build': 'queue_build', 'cancel-build': 'cancel_build', 'edit-schedule': 'edit_schedule', 'edit-day-schedule': 'edit_day_schedule' };
/** Canonical validation result with the exact server-read baseline SQL must lock and compare. */
export function prepareBuild(command: Extract<PlanningCommand, { kind: 'queue-build' }>, state: OwnerState) {
  const validation = validateBuild(command, state.inventory, state.progression.earnedAttributePoints, state.progression.level);
  if (!validation.ok) return null;
  return { baseline: { currentBuild: state.currentBuild, pendingBuild: state.pendingBuild, buildVersion: state.buildVersion,
    earnedPoints: state.progression.earnedAttributePoints, level: state.progression.level,
    inventory: [...state.inventory].sort((a, b) => a.id.localeCompare(b.id)) },
    fee: buildChangeFee({ ...state.currentBuild, allocation: state.currentBuild.allocations }, command),
    staminaMaximum: deriveStats(validation.snapshot, RULES_V1).maxStamina,
    snapshot: validation.snapshot };
}
export type InventoryCommand = Extract<GameCommand, { kind: 'buy-shop' | 'sell-item' | 'discard-item' }>;
export type ShopPurchaseValue = { itemIds: string[]; catalogId: string; catalogVersion: string; quantity: number;
  currency: ShopOffer['currency']; moneyDebit: number; renownDebit: number; bound: boolean; peakStrength: number };
export type CosmeticPurchaseValue = { cosmeticId: 'banner'; catalogVersion: 'v1'; moneyDebit: 0; renownDebit: number; bound: true };
export type ItemSaleValue = { itemId: string; quantity: number; remainingQuantity: number; moneyCredit: number };
export type ItemDiscardValue = { itemId: string; quantity: number; remainingQuantity: number };
export type InventoryValue = ShopPurchaseValue | CosmeticPurchaseValue | ItemSaleValue | ItemDiscardValue;
/**
 * The locked identity a prepared grant was computed from: each owned item ID with its quantity, plus historical strength.
 * Stats and origin are immutable in SQL. Reservation changes are checked separately for each changed salvage stack.
 */
export type InventoryBaseline = { items: Record<string, number>; peakStrength: number };
/** Backend-only grant envelope applied by `private.apply_inventory_plan`; Task 9 settlement builds the same shape. */
export type PreparedGrant = { baseline: InventoryBaseline; plan: InventoryGrantPlan; peakStrength: number };
export function inventoryBaseline(state: OwnerState): InventoryBaseline {
  return { items: Object.fromEntries(state.inventory.map(item => [item.id, item.quantity])), peakStrength: state.progression.peakStrength };
}
/** Canonical grant: capacity/stacking/overflow plan plus the acquisition's new historical strength. */
export function prepareGrant(state: OwnerState, grants: Parameters<typeof planInventoryGrant>[1]): PreparedGrant {
  const plan = planInventoryGrant(state.inventory, grants, CATALOG_V1);
  return { baseline: inventoryBaseline(state), plan, peakStrength: historicalGearScore([...state.inventory, ...plan.retained], state.progression.peakStrength) };
}
/** Exact versioned merchant offer and its grant; null for anything the NPC shops do not sell. SQL decides level, funds and capacity under lock. */
export function prepareShopPurchase(command: Extract<InventoryCommand, { kind: 'buy-shop' }>, state: OwnerState) {
  if (command.catalogId === CATALOG_V1.cosmetics.banner.id && command.catalogVersion === CATALOG_V1.version) {
    return { cosmetic: true, offer: { catalogId: command.catalogId, catalogVersion: CATALOG_V1.version,
      currency: 'renown', unitPrice: CATALOG_V1.cosmetics.banner.renownPrice, requiredLevel: 1 } };
  }
  const offer = shopOffer(command.catalogId, CATALOG_V1);
  if (!offer || command.catalogVersion !== offer.catalogVersion) return null;
  return { offer, ...prepareGrant(state, [{ catalogId: offer.catalogId, catalogVersion: offer.catalogVersion, quantity: command.quantity,
    origin: offer.currency === 'renown' ? 'renown' : 'shop' }]) };
}
/** NPC unit value for the server-read item; null when it is absent or unsellable (bound or renown origin). */
export function prepareItemSale(command: Extract<InventoryCommand, { kind: 'sell-item' }>, state: OwnerState) {
  const item = state.inventory.find(candidate => candidate.id === command.itemId);
  const unitValue = item ? npcSaleValue(item, CATALOG_V1) : null;
  return item && unitValue !== null ? { catalogId: item.catalogId, catalogVersion: item.catalogVersion, unitValue } : null;
}
export type MarketCommand = Extract<GameCommand, { kind: 'create-listing' | 'cancel-listing' | 'buy-listing' }>;
/** `create-listing`: the new listing and when it expires (seven days of database time after it is listed). */
export type ListingCreateValue = { listingId: string; expiresAtMs: number };
/** `cancel-listing`: the closed listing and the item returned to its seller. */
export type ListingCancelValue = { listingId: string; itemId: string };
/** `buy-listing`: the bought listing, its item, the price the buyer paid and the fee kept from the seller's credit. */
export type ListingPurchaseValue = { listingId: string; itemId: string; price: number; fee: number };
export type MarketValue = ListingCreateValue | ListingCancelValue | ListingPurchaseValue;
/** The buyer's historical strength before and after acquiring the listed item. SQL compares the baseline under its locks. */
export type ListingPurchasePreparation = { baselinePeakStrength: number; nextPeakStrength: number };
/**
 * Task 18 Decision 8: the buyer's new historical strength over its server-read inventory plus the listed item, read from the
 * public offer (its catalog fields and stats are copied from the item when it is listed and never change). A listed item is
 * never renown gear (SQL refuses to list one), so it scores without the Arena modifier. Without an open offer (sold,
 * cancelled, expired or unknown) nothing is acquired: the baseline stands, and SQL answers `sold`, `expired` or `not-found`
 * from the listing itself.
 */
export function prepareListingPurchase(state: OwnerState, listed: Pick<ItemInstance, 'catalogId' | 'catalogVersion' | 'stats'> | null): ListingPurchasePreparation {
  const baseline = state.progression.peakStrength;
  if (!listed) return { baselinePeakStrength: baseline, nextPeakStrength: baseline };
  const item = { catalogId: listed.catalogId, catalogVersion: listed.catalogVersion, stats: listed.stats, origin: 'shop' as const };
  return { baselinePeakStrength: baseline, nextPeakStrength: historicalGearScore([...state.inventory, item], baseline) };
}
/**
 * PostgreSQL aborted the transaction as a deadlock victim (40P01) or a serialization failure (40001). It rolled back whole: no
 * receipt was written and no money or item moved, so the same operation can simply be sent again. A purchase takes both
 * account locks in `boundary_start`'s order, but a boundary does not always take its locks in global order (Task 18.1
 * review), so a residual deadlock is answered as a retryable `processing`.
 */
const RETRYABLE_ABORTS: readonly string[] = ['40P01', '40001'];
export type OptInCommand = Extract<GameCommand, { kind: 'set-tournament-opt-in' }>;
/** The saved automatic-entry setting and the database time it was received (Task 19). */
export type OptInValue = { enabled: boolean; receivedAtMs: number };
export type CreationValue = { gladiatorId: string };
/** Server-computed catalog rolls and derived values; never accepted by the HTTP parser. */
export function prepareCreation(command: Creation) {
  if (!validateCreationAllocation(command.allocation)) throw new Error('invalid');
  const items: ItemInstance[] = ['sword:1:common', 'light-armor:1:common'].map((id, index) => {
    const entry = CATALOG_V1.items[id];
    return { id: `starter-${index}`, ownerId: 'new-gladiator', catalogId: id, catalogVersion: CATALOG_V1.version,
      tier: entry.tier, rarity: entry.rarity, stats: structuredClone(entry.stats), quantity: 1, origin: 'starter', binding: entry.binding, reservation: null };
  });
  const build = validateBuild({ classId: command.classId, stance: 'balanced', allocation: command.allocation,
    equipment: { weapon: items[0].id, body: items[1].id, offHand: null, head: null, feet: null } }, items, RULES_V1.attributes.creationPoints, 1);
  if (!build.ok) throw new Error('invalid');
  // PostgreSQL UUID parameters normalize casing; receipts must use that same identity representation.
  return { command: { ...command, operationId: command.operationId.toLowerCase() },
    starterItems: items.map(({ catalogId, catalogVersion, tier, rarity, stats, binding }) => ({ catalogId, catalogVersion, tier, rarity, stats, binding })),
    staminaMaximum: deriveStats(build.snapshot, RULES_V1).maxStamina, peakStrength: historicalGearScore(items, 0) };
}
export function createDatabase(client: SupabaseClient) {
  return {
    async consumeRateLimit(actor: Actor, isCreation: boolean): Promise<number | null> {
      const { data, error } = await client.rpc('consume_command_rate', { actor_id: actor.userId, is_creation: isCreation });
      if (error) throw new Error('rate-limit-unavailable');
      return data as number | null;
    },
    async createGladiator(actor: Actor, command: Creation): Promise<CommandResult<CreationValue>> {
      const { data, error } = await client.rpc('create_gladiator', { actor_id: actor.userId, operation_id: command.operationId, input: prepareCreation(command) });
      if (error) throw new Error('creation-unavailable');
      return data as CommandResult<CreationValue>;
    },
    async plan(actor: Actor, original: PlanningCommand): Promise<CommandResult<PlanningValue>> {
      const command = { ...original, operationId: original.operationId.toLowerCase() };
      let prepared = null;
      if (command.kind === 'queue-build') {
        const { data, error } = await client.from('owner_state').select('state').eq('owner_id', actor.userId).maybeSingle();
        if (error) throw new Error('build-unavailable');
        if (data) prepared = prepareBuild(command, data.state as OwnerState);
      }
      // Even invalid/stale preparation reaches SQL: a committed operation must replay first.
      const { data, error } = await client.rpc(PLANNING_RPC[command.kind], { actor_id: actor.userId, operation_id: command.operationId, input: { command, prepared } });
      if (error) throw new Error('planning-unavailable');
      return data as CommandResult<PlanningValue>;
    },
    async inventory(actor: Actor, original: InventoryCommand): Promise<CommandResult<InventoryValue>> {
      const command = { ...original, operationId: original.operationId.toLowerCase(), ...('itemId' in original ? { itemId: original.itemId.toLowerCase() } : {}) } as InventoryCommand;
      let prepared = null;
      if (command.kind !== 'discard-item') {
        const { data, error } = await client.from('owner_state').select('state').eq('owner_id', actor.userId).maybeSingle();
        if (error) throw new Error('inventory-unavailable');
        // Malformed stored items cannot produce a canonical plan; SQL still replays a committed receipt first.
        try { if (data) prepared = command.kind === 'buy-shop' ? prepareShopPurchase(command, data.state as OwnerState) : prepareItemSale(command, data.state as OwnerState); }
        catch { prepared = null; }
      }
      const rpc = command.kind === 'buy-shop' ? 'buy_shop' : command.kind === 'sell-item' ? 'sell_item' : 'discard_item';
      const { data, error } = await client.rpc(rpc, { actor_id: actor.userId, operation_id: command.operationId, input: { command, prepared } });
      if (error) throw new Error('inventory-unavailable');
      return data as CommandResult<InventoryValue>;
    },
    /**
     * Task 18: create, cancel and buy a fixed-price listing. Ids are canonical lowercase, as SQL compares them. A purchase is
     * prepared from the buyer's owner state and the public offer; even a missing or stale preparation reaches SQL, which
     * replays a committed receipt first. A deadlock or serialization abort is a retryable `processing`.
     */
    async market(actor: Actor, original: MarketCommand): Promise<CommandResult<MarketValue>> {
      const command = { ...original, operationId: original.operationId.toLowerCase(),
        ...('itemId' in original ? { itemId: original.itemId.toLowerCase() } : { listingId: original.listingId.toLowerCase() }) } as MarketCommand;
      let prepared: ListingPurchasePreparation | null = null;
      if (command.kind === 'buy-listing') {
        // The owner aggregate holds all 60 items in one row; the offer row carries the listed item's catalog fields and stats.
        const [owner, offer] = await Promise.all([client.from('owner_state').select('state').eq('owner_id', actor.userId).maybeSingle(),
          client.from('market_offers').select('item').eq('id', command.listingId).maybeSingle()]);
        if (owner.error || offer.error) throw new Error('market-unavailable');
        // Malformed stored items cannot be scored; SQL still replays a committed receipt first.
        try { if (owner.data) prepared = prepareListingPurchase(owner.data.state as OwnerState, offer.data ? offer.data.item as ItemInstance : null); }
        catch { prepared = null; }
      }
      const rpc = command.kind === 'create-listing' ? 'create_listing' : command.kind === 'cancel-listing' ? 'cancel_listing' : 'buy_listing';
      const { data, error } = await client.rpc(rpc, { actor_id: actor.userId, operation_id: command.operationId, input: { command, prepared } });
      if (error) {
        if (RETRYABLE_ABORTS.includes(error.code)) return { ok: false, code: 'processing', retryAfterMs: 1000 };
        throw new Error('market-unavailable');
      }
      return data as CommandResult<MarketValue>;
    },
    /** Task 19: the automatic tournament entry flag. SQL replays receipts first and answers `processing` while the world is behind. */
    async setTournamentOptIn(actor: Actor, original: OptInCommand): Promise<CommandResult<OptInValue>> {
      const command = { ...original, operationId: original.operationId.toLowerCase() };
      const { data, error } = await client.rpc('set_tournament_opt_in', { actor_id: actor.userId, operation_id: command.operationId, input: { command } });
      if (error) throw new Error('opt-in-unavailable');
      return data as CommandResult<OptInValue>;
    },
    /** Future build commands must use this actor-scoped inventory, never a player-supplied owned list. */
    async loadOwnedInventory(actor: Actor): Promise<ItemInstance[]> {
      // The owner aggregate contains all 60 items in one row; a base-table read is capped at 50 by the Data API.
      const { data, error } = await client.from('owner_state').select('state').eq('owner_id', actor.userId).maybeSingle();
      if (error) throw new Error('inventory-unavailable');
      return (data?.state.inventory ?? []) as ItemInstance[];
    },
  };
}
export type CommandDatabase = ReturnType<typeof createDatabase>;

/** Fenced job RPC results. `replayed` marks an idempotent retry of an already-committed outcome. `operator`: settlement
 * found an inconsistency (an Arena side's frozen rating differs from its live row) and retained the job for operator action. */
export type JobOutcome = { ok: true; replayed?: boolean; newGrants?: number; receiptId?: string; [key: string]: unknown }
  | { ok: false; code: 'conflict' | 'invalid' | 'not-found' | 'processing' | 'stale-preparation' | 'operator' };
export type RenewOutcome = { ok: true; expiresAtMs: number } | { ok: false; code: 'conflict' | 'not-found' };
/**
 * `public.tournament_bout_input` (Task 19): under the bout job's current lease (locked first, then checked against
 * database time sampled after the lock) the stored tournament graph, every stored bout result and the frozen entrant
 * names; never a seed. Otherwise the fence's refusal.
 */
export type TournamentBoutRead = { ok: true; graph: TournamentGraph; names: Readonly<Record<string, string>> }
  | { ok: false; code: 'invalid' | 'not-found' | 'conflict' | 'processing' };
/** Service-role RPC port used only by the private game-worker; every call is fenced by its lease token in SQL. */
export type WorkerDatabase = {
  coordinate(): Promise<CoordinatorReport>;
  claim(workerId: string, kind: JobKind, limit: number): Promise<JobLease[]>;
  renew(jobId: string, token: string): Promise<RenewOutcome>;
  complete(jobId: string, token: string, result: unknown): Promise<JobOutcome>;
  settle(activityId: string, token: string): Promise<JobOutcome>;
  fail(jobId: string, token: string, code: string): Promise<JobOutcome>;
  tournamentBoutInput(jobId: string, token: string): Promise<TournamentBoutRead>;
};
/** The fenced reads an executor may make for its own claimed job (a tournament bout reads its parents' stored winners). */
export type ExecutorIo = { database: Pick<WorkerDatabase, 'tournamentBoutInput'> };
/** Versioned executors keyed by the job's persisted rules version. Settlement is SQL-side and never an executor. */
export type JobExecutor = (job: JobLease, io?: ExecutorIo) => unknown | Promise<unknown>;
export type ExecutorRegistry = Readonly<Record<string, Partial<Record<Exclude<JobKind, 'settlement'>, JobExecutor>>>>;
/** `sleep` waits between coordination retries (default: a real timer) and `random` draws their jitter in [0, 1) (default: Math.random); tests inject both. */
export type WorkerDependencies = { database: WorkerDatabase; workerId: string; executors?: ExecutorRegistry; now?: () => number; cpuNow?: () => number;
  sleep?: (ms: number) => Promise<void>; random?: () => number };
export function createWorkerDatabase(client: SupabaseClient): WorkerDatabase {
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(name, args);
    // Never forward driver/provider messages: they can carry connection details.
    if (error) throw new Error('worker-database-unavailable');
    return data as T;
  }
  return {
    coordinate: () => rpc('coordinate_work', {}),
    claim: (workerId, kind, limit) => rpc('claim_jobs', { worker_id: workerId, kind, batch_limit: limit }),
    renew: (jobId, token) => rpc('renew_job', { job_id: jobId, lease_token: token }),
    complete: (jobId, token, result) => rpc('complete_job', { job_id: jobId, lease_token: token, result }),
    settle: async (activityId, token) => {
      // Shopping may change capacity/reservations after planning. Re-read current state while preserving the
      // immutable reward proposal, then let SQL compare it under the settlement's existing account locks.
      for (let attempt = 0; attempt < 3; attempt++) {
        const input = await rpc<{ state: OwnerState; rewards: ExpeditionRewards; rulesVersion: string; jobId: string } | null>(
          'expedition_settlement_input', { activity_id: activityId, lease_token: token });
        if (!input) return rpc('settle_activity', { activity_id: activityId, lease_token: token });
        if (input.rulesVersion !== 'v1') throw new Error('unsupported-rules');
        const baseline = { level: input.state.progression.level, xp: input.state.progression.xp };
        const prepared = { rewards: input.rewards, grant: prepareGrant(input.state, input.rewards.loot), progressionBaseline: baseline,
          progression: applyXp(baseline.level, baseline.xp, input.rewards.xp) };
        const renewed = await rpc<RenewOutcome>('renew_job', { job_id: input.jobId, lease_token: token });
        if (!renewed.ok) return renewed;
        const result = await rpc<JobOutcome>('settle_expedition', { activity_id: activityId, lease_token: token, prepared });
        if (result.ok || result.code !== 'stale-preparation') return result;
      }
      return { ok: false, code: 'stale-preparation' };
    },
    fail: (jobId, token, code) => rpc('fail_job', { job_id: jobId, lease_token: token, failure_code: code }),
    tournamentBoutInput: (jobId, token) => rpc('tournament_bout_input', { job_id: jobId, lease_token: token }),
  };
}
