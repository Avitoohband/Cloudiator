import type { Appearance } from '../domain/appearance.ts';

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
/**
 * Task 23.8: the owner's activity signal, with no payload. Its operation id is checked like every command's but never stored:
 * it writes no operation receipt. The Edge function charges the command rate limit, which records the owner's signal (every
 * command records it, at most once an hour per owner), and answers `PresenceResult`. A character rests at home after
 * `RULES_V1.idle.afterMs` without a signal (OwnerState.restingUntilSlot); the signed-in game sends this once after sign-in or
 * page load, then at most every 6 hours while the page is open.
 */
export type PresenceCommand = Operation & { kind: 'presence' };
/** The answer to a `PresenceCommand`: no receipt and no value. */
export type PresenceResult = { ok: true } | { ok: false; code: ApiErrorCode; retryAfterMs?: number };
/**
 * The answer to an `edit-day-schedule` command: the one new schedule version, the server time the save was received, and for
 * each part the slot its new choice takes effect in (`null` = that part's choice is unchanged and nothing was written).
 */
export type DayScheduleValue = { version: number; receivedAtMs: number; parts: Record<Phase, { effectiveSlotIndex: number; effectiveAtMs: number } | null> };
/** The answer to a `change-appearance` command: the look the gladiator now has and the server time the change was received. */
export type ChangeAppearanceValue = { appearance: Appearance; receivedAtMs: number };
/** The message a `read-message` command marked read. */
export type ReadMessageValue = { messageId: number };
/**
 * The answer to a `read-message` command: the message now marked read for the caller's account, with no receipt (a read mark
 * writes none, like `presence`: receipts are permanent, and one per opened message would pile up), or a refusal (`not-found` for
 * a hidden or missing message).
 */
export type ReadMessageResult = { ok: true; value: ReadMessageValue } | { ok: false; code: ApiErrorCode; retryAfterMs?: number };
/** Where a `see-notifications` command left the account's "seen up to" mark (it never moves back, and a future time is cut to now). */
export type SeeNotificationsValue = { seenMs: number };
/**
 * The answer to a `see-notifications` command: the mark as it now stands, with no receipt (like a read mark: receipts are permanent,
 * and one per opening would pile up), or a refusal.
 */
export type SeeNotificationsResult = { ok: true; value: SeeNotificationsValue } | { ok: false; code: ApiErrorCode; retryAfterMs?: number };
/** Actor identity is supplied by a verified session, never by any command field. */
export type GameCommand = Operation & (
  // `appearance` is the look chosen at creation (supabase/functions/_shared/domain/appearance.ts). Absent (an older open tab): the
  // gladiator is stored with no appearance, the legacy look.
  | { kind: 'create-character'; name: string; classId: ClassId; allocation: Attributes; appearance?: Appearance }
  | { kind: 'edit-schedule'; expectedVersion: number; phase: Phase; choice: ActivityChoice }
  | { kind: 'edit-day-schedule'; expectedVersion: number; day: Schedule }
  | { kind: 'queue-build'; expectedVersion: number; classId: ClassId; stance: Stance; allocation: Attributes; equipment: Equipment }
  | { kind: 'cancel-build'; expectedVersion: number }
  | { kind: 'buy-shop'; catalogId: string; catalogVersion: string; quantity: number }
  | { kind: 'sell-item'; itemId: string; quantity: number }
  | { kind: 'discard-item'; itemId: string; quantity: number }
  | { kind: 'create-listing'; itemId: string; price: number }
  | { kind: 'cancel-listing'; listingId: string }
  | { kind: 'buy-listing'; listingId: string }
  | { kind: 'set-tournament-opt-in'; enabled: boolean }
  // Change look: free and unlimited for now. The look replaces the caller's own gladiator's (the command names no gladiator).
  | { kind: 'change-appearance'; appearance: Appearance }
  // Mark a message read for the caller's own account (the command names no account); no receipt, a repeat is a no-op.
  | { kind: 'read-message'; messageId: number }
  // Mark the account's own settled results seen up to a time (`upToMs`, server time in ms); no receipt, it never moves the mark back.
  | { kind: 'see-notifications'; upToMs: number }
  | { kind: 'presence' }
);
