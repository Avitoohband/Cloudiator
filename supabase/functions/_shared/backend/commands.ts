import type { GameCommand, Attributes } from '../contracts/commands.ts';
import type { Actor } from './auth.ts';
import type { CommandDatabase, InventoryCommand, MarketCommand, OptInCommand, PlanningCommand } from './database.ts';
import { CATALOG_V1 } from '../domain/catalog-v1.ts';
import { RULES_V1 } from '../domain/rules-v1.ts';
import { validateCreationAllocation } from '../domain/build.ts';
import { jsonResponse, readCommandBody, statusFor } from './http.ts';

const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const oneOf = (v: unknown, values: readonly string[]) => typeof v === 'string' && values.includes(v);
const attributeKeys = ['strength', 'agility', 'vitality', 'endurance', 'precision'];
const allocation = (v: unknown) => exact(v, attributeKeys) && Object.values(v).every(n => integer(n, 0, RULES_V1.attributes.maximumPoints))
  && Object.values(v).reduce<number>((sum, n) => sum + (n as number), 0) <= RULES_V1.attributes.maximumPoints;

/** Parse exact wire shapes. Later command implementations consume these same canonical discriminants. */
export function parseCommand(value: unknown): GameCommand | null {
  if (!record(value) || !uuid(value.operationId)) return null;
  const shape = (...keys: string[]) => exact(value, ['kind', 'operationId', ...keys]);
  let valid = false;
  switch (value.kind) {
    case 'create-character':
      valid = shape('name', 'classId', 'allocation') && typeof value.name === 'string' && value.name === value.name.trim()
        && /^[A-Za-z0-9 _-]{3,20}$/.test(value.name)
        && oneOf(value.classId, Object.keys(RULES_V1.classes)) && validateCreationAllocation(value.allocation as Attributes); break;
    case 'edit-schedule': {
      const choice = value.choice;
      valid = shape('expectedVersion', 'phase', 'choice') && integer(value.expectedVersion, 1) && oneOf(value.phase, RULES_V1.clock.phases)
        && record(choice) && ((exact(choice, ['kind']) && oneOf(choice.kind, ['training', 'rest', 'arena']))
          || (exact(choice, ['kind', 'expeditionId']) && choice.kind === 'expedition' && oneOf(choice.expeditionId, Object.keys(CATALOG_V1.expeditions)))); break;
    }
    case 'queue-build':
      valid = shape('expectedVersion', 'classId', 'stance', 'allocation', 'equipment') && integer(value.expectedVersion, 1)
        && oneOf(value.classId, Object.keys(RULES_V1.classes)) && oneOf(value.stance, Object.keys(RULES_V1.stances)) && allocation(value.allocation)
        && exact(value.equipment, ['weapon', 'offHand', 'head', 'body', 'feet']) && Object.values(value.equipment).every(id => id === null || uuid(id)); break;
    case 'cancel-build': valid = shape('expectedVersion') && integer(value.expectedVersion, 1); break;
    case 'buy-shop': valid = shape('catalogId', 'catalogVersion', 'quantity') && typeof value.catalogId === 'string'
      && (Object.hasOwn(CATALOG_V1.items, value.catalogId) || Object.hasOwn(CATALOG_V1.cosmetics, value.catalogId))
      && value.catalogVersion === CATALOG_V1.version && integer(value.quantity, 1, 999); break;
    case 'sell-item': case 'discard-item': valid = shape('itemId', 'quantity') && uuid(value.itemId) && integer(value.quantity, 1, 999); break;
    // Whole prices from 1 to 1,000,000,000 (Task 18 Decision 2); SQL enforces the same range.
    case 'create-listing': valid = shape('itemId', 'price') && uuid(value.itemId) && integer(value.price, 1, RULES_V1.marketplace.maximumPrice); break;
    case 'cancel-listing': case 'buy-listing': valid = shape('listingId') && uuid(value.listingId); break;
    case 'set-tournament-opt-in': valid = shape('enabled') && typeof value.enabled === 'boolean'; break;
    // Task 23.8: the owner's activity signal; no payload.
    case 'presence': valid = shape(); break;
  }
  return valid ? value as GameCommand : null;
}

const PLANNING_KINDS: readonly string[] = ['edit-schedule', 'queue-build', 'cancel-build'];
const INVENTORY_KINDS: readonly string[] = ['buy-shop', 'sell-item', 'discard-item'];
const MARKET_KINDS: readonly string[] = ['create-listing', 'cancel-listing', 'buy-listing'];
export type CommandDependencies = {
  verifyActor(request: Request): Promise<Actor>;
  database: Pick<CommandDatabase, 'consumeRateLimit' | 'createGladiator' | 'plan' | 'inventory' | 'market' | 'setTournamentOptIn'>;
  allowedOrigins: readonly string[];
};
export async function handleCommand(request: Request, deps: CommandDependencies): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && !deps.allowedOrigins.includes(origin)) return jsonResponse({ ok: false, code: 'invalid' }, 403, null);
  if (request.method === 'OPTIONS') return jsonResponse(null, 204, origin);
  if (request.method !== 'POST') return jsonResponse({ ok: false, code: 'invalid' }, 405, origin);
  let actor: Actor;
  try { actor = await deps.verifyActor(request); } catch { return jsonResponse({ ok: false, code: 'unauthenticated' }, 401, origin); }
  // All authenticated attempts count, including malformed bodies. Creation's separate budget is charged after parsing its kind.
  try {
    const retry = await deps.database.consumeRateLimit(actor, false);
    if (retry !== null) return jsonResponse({ ok: false, code: 'rate-limited', retryAfterMs: retry }, 429, origin);
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return jsonResponse({ ok: false, code: 'invalid' }, 415, origin);
    let body: unknown;
    try { body = await readCommandBody(request); }
    catch (error) { return jsonResponse({ ok: false, code: 'invalid' }, error instanceof RangeError ? 413 : 400, origin); }
    if (record(body) && body.kind === 'create-character') {
      const retryCreation = await deps.database.consumeRateLimit(actor, true);
      if (retryCreation !== null) return jsonResponse({ ok: false, code: 'rate-limited', retryAfterMs: retryCreation }, 429, origin);
    }
    const command = parseCommand(body);
    if (!command) return jsonResponse({ ok: false, code: 'invalid' }, 400, origin);
    if (![...PLANNING_KINDS, ...INVENTORY_KINDS, ...MARKET_KINDS, 'create-character', 'set-tournament-opt-in', 'presence'].includes(command.kind)) return jsonResponse({ ok: false, code: 'unavailable' }, 503, origin);
    // Task 23.8: the rate check above recorded the owner's activity signal (consume_command_rate). Presence writes nothing
    // else: no operation receipt, which would be permanent.
    if (command.kind === 'presence') return jsonResponse({ ok: true }, 200, origin);
    const result = command.kind === 'create-character' ? await deps.database.createGladiator(actor, command)
      : command.kind === 'set-tournament-opt-in' ? await deps.database.setTournamentOptIn(actor, command as OptInCommand)
        : INVENTORY_KINDS.includes(command.kind) ? await deps.database.inventory(actor, command as InventoryCommand)
          : MARKET_KINDS.includes(command.kind) ? await deps.database.market(actor, command as MarketCommand)
            : await deps.database.plan(actor, command as PlanningCommand);
    return jsonResponse(result, result.ok ? 200 : statusFor(result.code), origin);
  } catch { return jsonResponse({ ok: false, code: 'unavailable' }, 503, origin); }
}
