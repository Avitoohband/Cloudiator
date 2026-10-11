/** Wire values are plain JSON. Boundary validators enforce safe integer ranges and UUIDs. */
export type GladiatorId = string;
export type ActivityId = string;
export type OperationId = string;
export type Phase = 'morning' | 'afternoon' | 'evening';
export type ClassId = 'berserker' | 'guardian' | 'duelist';
export type Stance = 'offensive' | 'balanced' | 'defensive';
export type LeagueId = 'bronze' | 'silver' | 'gold' | 'champion';
export type Attributes = { strength: number; agility: number; vitality: number; endurance: number; precision: number };
export type ActivityChoice = { kind: 'training' | 'rest' | 'arena' } | { kind: 'expedition'; expeditionId: 'woodland' | 'outpost' | 'mountain' };
export type Schedule = Record<Phase, ActivityChoice>;
export type EquipmentSlot = 'weapon' | 'offHand' | 'head' | 'body' | 'feet';
export type Equipment = Record<EquipmentSlot, string | null>;
export type ApiErrorCode = 'unauthenticated' | 'invalid' | 'conflict' | 'processing' | 'insufficient-funds' | 'inventory-full' | 'sold' | 'expired' | 'not-found' | 'rate-limited' | 'unavailable';
export type CommandResult<T> = { ok: true; receiptId: string; value: T } | { ok: false; code: ApiErrorCode; retryAfterMs?: number };

type Operation = { operationId: OperationId };
/** Actor identity is supplied by a verified session, never by any command field. */
export type GameCommand = Operation & (
  | { kind: 'create-character'; name: string; classId: ClassId; allocation: Attributes }
  | { kind: 'edit-schedule'; expectedVersion: number; phase: Phase; choice: ActivityChoice }
  | { kind: 'queue-build'; expectedVersion: number; classId: ClassId; stance: Stance; allocation: Attributes; equipment: Equipment }
  | { kind: 'cancel-build'; expectedVersion: number }
  | { kind: 'buy-shop'; catalogId: string; catalogVersion: string; quantity: number }
  | { kind: 'sell-item'; itemId: string; quantity: number }
  | { kind: 'discard-item'; itemId: string; quantity: number }
  | { kind: 'create-listing'; itemId: string; price: number }
  | { kind: 'cancel-listing'; listingId: string }
  | { kind: 'buy-listing'; listingId: string }
  | { kind: 'set-tournament-opt-in'; enabled: boolean }
);
