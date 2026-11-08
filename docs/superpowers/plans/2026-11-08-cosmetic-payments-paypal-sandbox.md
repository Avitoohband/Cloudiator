# Cloudiator Cosmetic Payments PayPal Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a signed-in player can buy, equip, and lose access on refund for each of the two approved cosmetics in the PayPal sandbox.

**Architecture:** Keep Next.js static on Cloudflare Pages. Supabase Edge creates and captures account-bound orders, receives PayPal-signed webhooks, and reconciles missed deliveries. Postgres atomically tracks orders, events and paid entitlements and exposes a small player-facing read model.

**Tech Stack:** TypeScript, Next.js static export, Supabase Edge/Deno and Postgres, PayPal Orders v2 and Webhooks, Phaser, Vitest, Playwright.

**Spec:** [Cloudiator cosmetic payments](../specs/2026-11-08-cosmetic-payments-design.md)

## Global Constraints

- Build both one-time, account-bound cosmetics: Supporter Banner and a visual pet with zero gameplay bonuses. Founder and existing in-game banner ownership are separate. Weapon and armor dyes and skins are follow-ups.
- Keep this separate from 1.8 and M31. Select the next free SQL source slot and generate the migration only when the sandbox branch's base is settled. Never edit a committed migration. No production writes, live merchant access, account creation, package downloads, or public checkout activation in this plan.
- Use a branch and isolated worktree with installed tools. Use `npx --offline --no-install` when a binary is needed. Use existing auth and Fetch APIs. Use only local test doubles until an existing PayPal sandbox, server-side credentials, and an isolated callback origin have been approved and supplied. Keep test credentials, seller responses and buyer data out of Git, logs and screenshots.
- `supporter-banner` and `camp-pet` are internal SKU keys. Tests use fixture-only prices of 199 and 399 in USD minor units. The sale prices, currency and pet species are still open. Treat any preview prices and pet art as examples for Avi’s decision.
- Checkout starts disabled. A pause stops new checkout while trusted processing continues for existing orders and refunds. Reject live provider mode in this sandbox branch. Before coding any player-facing UI, obtain Avi’s approval of the clickable desktop and mobile mockup over real app screenshots.
- Follow [verification gates](../../operations/verification-gates.md) and [migration rules](../../operations/migrations.md). Serve local Edge from the testing worktree and record its container StartedAt before and after every guarded DB run. Run no builds, browser tests or edits in that worktree during the run. Independently review and commit each task after its own verification.

## Review Focus

1. A retry during order creation or capture keeps the original amount and provider request key even if the catalog price changes. Task 2.
2. A browser return with a real provider order that belongs to someone else never captures or reveals it. Task 2.
3. A refund delivered before its capture event never yields a visible paid item. Task 3.
4. A second provider charge is recorded for review, and refunding that charge does not revoke the legitimate grant. Task 3.
5. A player who changes accounts with an earlier shop or equip request in flight never sees the other account’s results. Task 5.

---

### Task 1: Define the sandbox catalog and lock down order storage

**Files:** Create `supabase/functions/_shared/payments/contracts.ts`, `supabase/sql/<next-source>-cosmetic-payments.sql`, `tests/db/payments.test.ts`, and `tests/backend/payments.deno.ts`. Extend `package.json` to include the new Deno tests in `typecheck`. Use `supabase/sql/01-identity.sql`, `04-inventory-shops.sql` and `tests/db/access-matrix.test.ts` as references.

**Interfaces:** Export `Sku = 'supporter-banner' | 'camp-pet'`, `Money = { amountMinor: number; currency: string }`, and `OrderStatus = 'pending' | 'paid' | 'cancelled' | 'refunded' | 'review'`. Provide privileged `reserve_payment_order(actor_id uuid, sku text)` and an owner-only `read_payment_order(order_id uuid)` returning `{ orderId, sku, money, status }`. Internal orders store the provider and environment, owner, price snapshot, request keys and provider identifiers.

- [ ] **Red.** Add `reserve_order_reuses_snapshot` for each SKU, `denies_order_access_by_other_owner_and_anon`, `requires_owned_gladiator`, and `blocks_direct_payment_table_access`. Verify that sending an amount, currency or owner in checkout input fails validation and that fixture reads expose only the order fields above.
- [ ] **Run red.** `deno test --cached-only --frozen --config supabase/functions/deno.json tests/backend/payments.deno.ts`, then `npm run test:db -- tests/db/payments.test.ts` under the DB guard. Expect failures for missing contract/storage.
- [ ] **Green.** Add the catalog and account-bound private orders with one open order per account and SKU. Make concurrent reservations converge on the same order and restrict privileges and search paths as in existing trusted RPCs. The player read derives its actor from the session.
- [ ] **Verify and review.** Repeat both commands. Audit explicit grants and confirm the existing in-game banner tests are unaffected. Commit the reviewed catalog, source and order isolation.

### Task 2: Implement authenticated checkout and signed provider intake

**Files:** Create `supabase/functions/_shared/payments/paypal.ts`, `supabase/functions/_shared/payments/handlers.ts`, `supabase/functions/payment-checkout/index.ts`, and `supabase/functions/payment-webhook/index.ts`. Modify `supabase/config.toml`, `package.json` and the new test files. Follow `supabase/functions/game-command/index.ts`, `_shared/backend/auth.ts`, and `_shared/backend/http.ts` for actor verification and allowed-origin handling. Add both entry points to the offline Deno checks.

**Interfaces:** Inject `fetch` into `makePayPalSandboxClient`. Its methods create an order from a trusted local order, fetch the provider order, capture by provider order ID and stable request key, fetch capture/refund details, and verify the webhook. Export `handlePaymentCheckout(request: Request, deps: CheckoutDeps): Promise<Response>` and `handlePaymentWebhook(request: Request, deps: WebhookDeps): Promise<Response>`. Checkout supports `{ action: 'create', sku }` → `{ orderId, approvalUrl }` and `{ action: 'capture', orderId }` → `{ orderId, status }`. The return route trusts only the authenticated local order reference. Provider query parameters carry no authority. Pass normalized `VerifiedPaymentOutcome = { orderId: string; providerEventId?: string; providerOrderId: string; captureId: string; money: Money; kind: 'captured' | 'full-refund' | 'final-reversal' | 'review' }` through an injected settlement dependency, with provider event type and identifiers available for reconciliation.

- [ ] **Red.** Add `retry_preserves_provider_keys_and_snapshot`, `foreign_order_and_missing_session_never_call_provider`, `checkout_pause_blocks_create_only`, `rejects_live_api_and_unapproved_redirect_origins`, `rejects_tampered_webhook_before_side_effect`, and `buyer_return_is_not_evidence_of_payment`. Use fake Fetch responses and local RPC doubles. For each amount, currency, product, order, payee and capture-status mismatch, assert zero settlement calls.
- [ ] **Run red.** Run the Deno command from Task 1. Expect the checkout, capture and signature tests to fail.
- [ ] **Green.** Reuse verified Supabase bearer identity for browser requests. Use approved sandbox PayPal hosts and an exact callback allowlist. Create and capture from stored orders with stable provider request IDs. If a provider retry window has expired and the earlier result is uncertain, reconcile the order or flag it for review before another create or capture. Give the webhook its own route with signature verification as its authentication. Reject invalid signatures before mutation, and emit a verified provider outcome for Task 3 only after server-side provider details match the local order. With no settlement handler or when verification fails, checkout cannot grant ownership.
- [ ] **Verify and review.** Run the Deno command and `npm run typecheck`. Review credential handling and the full redirect/capture/retry sequence. Commit the reviewed handlers with checkout disabled.

### Task 3: Settle, reconcile, refund and prove migration isolation

**Files:** Extend `<next-source>-cosmetic-payments.sql`, `supabase/functions/_shared/payments/contracts.ts`, `handlers.ts`, and both payment test files. Create `supabase/functions/payment-reconcile/index.ts` and generate the sandbox migration under `supabase/migrations/` with pg-delta. Extend `tests/db/access-matrix.test.ts` and the offline entry-point checks.

**Interfaces:** Add privileged `apply_payment_outcome(outcome jsonb)` for `VerifiedPaymentOutcome`. Uniquely record provider event, order and capture identifiers within the environment, including a separate record for each unexpected charge. Tie each grant to its legitimate capture and enforce one active entitlement per account and SKU. Add owner-only `read_paid_cosmetics()` and authenticated `set_paid_cosmetic(sku text, equipped boolean)`. The renderer gets only equipped visual IDs in the public appearance projection. The reconciler uses a server-only credential and retries eligible pending orders in bounded batches.

- [ ] **Red.** Add `same_event_and_parallel_captures_grant_once`, `refund_before_capture_never_equips`, `duplicate_charge_refund_preserves_valid_grant`, `verified_full_refund_removes_equipped_cosmetic`, and `partial_refund_and_open_dispute_route_to_review`. Also test pending recovery after a closed tab or lost delivery, owner/visitor isolation, negative cross-role grants, checkout refusal for already-owned SKUs, pause processing, and zero changes to gold, renown, combat, Founder and existing banner ownership.
- [ ] **Run red.** Run the Deno payment command, then `npm run test:db -- tests/db/payments.test.ts tests/db/access-matrix.test.ts tests/db/shops.test.ts tests/db/titles.test.ts` under the guard. Expect the new settlement and ownership assertions to fail.
- [ ] **Green.** Route trusted capture verification, webhooks and reconciliation through one transactional order transition. Store sanitized facts and process a provider event once. Record reversals even when delivery precedes grant and use authoritative provider state to resolve stale or ambiguous events. Revoke only the entitlement backed by the affected order and clear its equipped state. Reconcile pending orders without a browser return, keep unresolved exceptions visible to operators, and restrict reconciliation credentials to the server.
- [ ] **Verify and review.** Repeat the commands and run `npm run typecheck`. Lint the source-applied schema, generate with pg-delta and reconcile omissions, then clean-replay only the migrations and require a byte-equal schema fingerprint. Repeat lint and access checks. Commit the reviewed settlement, projections and generated sandbox migration.

### Task 4: Review the two cosmetics in a clickable mockup

**Files:** Create a clickable review artifact at `docs/superpowers/specs/references/2026-11-08-cosmetic-payments-mockup.html` with its screenshot assets alongside it. Use `tests/browser/review-shots.ts` as the capture pattern and follow the project’s existing source and runtime art locations.

- [ ] Capture desktop and phone screenshots of My Gladiator and camp from the actual app with local fixtures. Mask account identifiers if any appear in the capture.
- [ ] Build a clickable overlay with the separate banner and pet offers, the pending/owned/refunded states, and equip/remove previews. Show banner art in the existing visual context and show the pet following a gladiator in camp. Mark placeholder prices, currency and pet choices as sample content.
- [ ] Review clicks, keyboard access and phone layout locally. Show Avi the prototype and get explicit layout and art approval before Task 5. Record any item naming, species, appearance, or price decisions. Commit the reviewed mockup separately.

### Task 5: Implement the approved shop, equipment and camp visuals

**Files:** Create `src/lib/api/payments.ts`, `src/features/cosmetics/CosmeticsPanel.tsx`, `src/app/payments/return/page.tsx`, and `tests/browser/cosmetic-payments.spec.ts`. Integrate through `src/features/shell/CampShell.tsx` and `src/features/character/CharacterPanel.tsx`. Update the relevant `supabase/functions/_shared/contracts/reads.ts` public appearance shape, `src/game/assets.ts` and `src/game/camp-scene.ts` for approved assets and pet rendering. Use existing shell focus and owner refresh patterns.

**Interfaces:** `createCosmeticCheckout(sku: Sku)` returns the approved hosted URL and local ID. `captureCosmeticOrder(orderId: string)` returns the authenticated order status. `readPaidCosmetics()` and `setPaidCosmetic(sku: Sku, equipped: boolean)` use Task 3's owner APIs. Public appearance exposes equipped visual IDs, which the renderer maps only to known approved assets.

- [ ] **Red.** Add Playwright cases for each approved item, checkout pause and disabled access, cancelled and pending return, returning with another account’s order, account switch during a pending request, keyboard access, and equipping/removing both items. Prove a refunded pet disappears in camp after the fresh projection and that an existing title and in-game banner still render. Exercise desktop and mobile.
- [ ] **Run red.** `npm run test:e2e -- --config node_modules/.cache/pw-design-tcp.config.mjs tests/browser/cosmetic-payments.spec.ts`. Expect new controls and projection behavior to be missing.
- [ ] **Green.** Wire the approved views and state to owner APIs and the static return route. Use the existing session refresh and static query-parameter patterns. Reset state on account change and discard stale requests. Render the pet as a camp-only follower using path and depth conventions, separate from game simulation. Only the server's active paid entitlement permits an equipped visual.
- [ ] **Verify and review.** Repeat the browser command and run `npm run typecheck`. Test the same focused spec against the static export using the gate configuration, with a separate or sequential build. Commit the reviewed player interface and art.

### Task 6: Run the isolated PayPal sandbox release test

**Files:** Record non-sensitive evidence under the sandbox branch's local gate results, with a short summary in `docs/implementation/HANDOFF.md`.

- [ ] Run the full local gate using `node scripts/verify.mjs --config node_modules/.cache/pw-design-tcp.config.mjs --browser-shards 32 --results <fresh-dir> --json <file>` from the appropriate serving worktree. Verify the guarded DB stage's Edge StartedAt evidence and all 12 gate results.
- [ ] Use an existing, separately approved PayPal sandbox and a dedicated non-production callback origin with test credentials provided securely. If none is available, retain local proofs and record the real-provider run as pending. Keep checkout unavailable outside the sandbox test audience.
- [ ] With test buyers, complete, cancel and leave pending one purchase for each SKU. Verify capture and delivery after a missed return, duplicate event handling, account isolation, equipping, and provider refund revocation. Verify a checkout pause still accepts valid events for previous purchases.
- [ ] Record the sandbox gate, independent review and remaining live prerequisites. Live provider onboarding, confirmed prices/currency, support and refund terms, payout and tax arrangements, release writes and real-money activation require a separate live plan and Avi’s exact production approvals.
