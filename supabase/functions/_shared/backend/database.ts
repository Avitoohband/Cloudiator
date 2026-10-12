import type { SupabaseClient } from '@supabase/supabase-js';
import type { GameCommand, CommandResult } from '../contracts/commands.ts';
import type { ItemInstance } from '../contracts/reads.ts';
import type { Actor } from './auth.ts';
import { CATALOG_V1 } from '../domain/catalog-v1.ts';
import { RULES_V1 } from '../domain/rules-v1.ts';
import { validateBuild, validateCreationAllocation } from '../domain/build.ts';
import { deriveStats } from '../domain/stats.ts';

type Creation = Extract<GameCommand, { kind: 'create-character' }>;
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
  return { command, starterItems: items.map(({ catalogId, catalogVersion, tier, rarity, stats, binding }) => ({ catalogId, catalogVersion, tier, rarity, stats, binding })),
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
