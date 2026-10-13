# Task 8 independent review

Date: 2026-10-13. Reviewer: fresh GPT-6 Astra subagent, read-only.
Range: `8195ff5f7e319ee2d5959db35906344759544a59..28d1fee5b2093fc91693d15ddf371b905dafb1e8`.
The five-commit package includes the original Claude WIP, preserved import, completed source and report.

## Spec compliance

**Spec compliant within Task 8's binding scope; quality Approved.** Capacity,
reserved-stack protection, canonical pricing, bound equipment/banner behavior,
immutable receipts, historical gear score, XP, owner projection and live UI
are implemented. No unrequested feature expansion found.

Runtime results and the 228-entry replay comparison are recorded implementation
evidence, not independently reproduced by this review. The report correctly
distinguishes the 82/83 run from the subsequent 36/36 affected run.

## Strengths

- `supabase/sql/04-inventory-shops.sql:99`: Transactions replay account-scoped receipts before processing/preparation checks, serialize mutations, subtract held fees, and commit item changes, currency and ledger atomically.
- `supabase/functions/_shared/domain/inventory.ts:59`: Capacity and salvage planning preserve reservations, distinguish retained rewards from overflow, and prohibit purchase conversion into money.
- `supabase/functions/_shared/domain/inventory.ts:138`: Historical scoring selects compatible slots, handles two-handed weapons and preserves the previous maximum.
- `supabase/sql/04-inventory-shops.sql:5`: Cosmetics are separately stored, owner-readable and immutable, with no inventory/combat contribution.
- `tests/db/shops.test.ts:106`: Integration coverage includes injected rollback, purchase/reservation races, receipt replay, held fees, numeric limits and denial.
- `src/features/inventory/InventoryPanel.tsx:26`: Explicit retry preserves the operation ID; native discard confirmation focuses the safe action.

## Findings and controller disposition

**Critical:** none. **Important:** none.

**Minor:** `docs/implementation/task-08-report.md:242` records an existing color
environment warning alongside intentional authentication/context-loss
diagnostics. Unexpected output is harder to identify. Remove the conflicting
color configuration and explicitly capture/assert expected diagnostics.

Controller disposition: carry this into Task 23/final harness triage with the
existing Task 1 color warning. It does not block Task 8; no unnecessary fix loop
or duplicate suite run was dispatched.

## Focused checks and limits

- Reviewed the complete five-commit diff in bounded passes; no Git commands, mutations or suite reruns.
- Recovered only the omitted middle of `GameShell` (`src/app/game/page.tsx:21`) to check account scoping and refresh integration. Existing account/revision protections remain.
- Checked unchanged `public.item_instances` constraint (`supabase/sql/01-identity.sql:43`) for salvage quantity enforcement; it bounds integer quantities to 1–999.
- Confirmed the earlier reservation test still checks deletion denial, release and successful post-release deletion. Its earlier-trigger error correction does not weaken coverage.
- M01–M04 have no diff entries. M05 contains the new function ACLs, invoker-view setting, trigger dependencies and history initialization.

The established authority/concurrency boundaries are preserved. Settlement,
marketplace, league and hosted launch integration remain their owning tasks.
No heavy validation was required solely to repeat the recorded runs.
