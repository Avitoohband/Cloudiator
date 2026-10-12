import type { SupabaseClient } from '@supabase/supabase-js';
import type { GameCommand, CommandResult } from '../contracts/commands.ts';
import type { ItemInstance, OwnerState, PendingBuildView } from '../contracts/reads.ts';
import type { Actor } from './auth.ts';
import { CATALOG_V1 } from '../domain/catalog-v1.ts';
import { RULES_V1 } from '../domain/rules-v1.ts';
import { buildChangeFee, validateBuild, validateCreationAllocation } from '../domain/build.ts';
import { deriveStats } from '../domain/stats.ts';

type Creation = Extract<GameCommand, { kind: 'create-character' }>;
export type PlanningCommand = Extract<GameCommand, { kind: 'queue-build' | 'cancel-build' | 'edit-schedule' }>;
export type BuildDraft = PendingBuildView;
export type ScheduleEditValue = { version: number; receivedAtMs: number; effectiveSlotIndex: number; effectiveAtMs: number };
export type PlanningValue = BuildDraft | ScheduleEditValue | { buildVersion: number };
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
    staminaMaximum: deriveStats(build.snapshot, RULES_V1).maxStamina };
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
      const rpc = command.kind === 'queue-build' ? 'queue_build' : command.kind === 'cancel-build' ? 'cancel_build' : 'edit_schedule';
      const { data, error } = await client.rpc(rpc, { actor_id: actor.userId, operation_id: command.operationId, input: { command, prepared } });
      if (error) throw new Error('planning-unavailable');
      return data as CommandResult<PlanningValue>;
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
