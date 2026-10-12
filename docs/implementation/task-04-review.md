# Task 4 independent specification and quality review

Date: 2026-10-12. Fresh `gpt-6-astra` reviewer; resumed its final two focused checks after a usage-limit interruption rather than duplicating the full review.
Range: `b73987048b9b0c7848dfcdcf29b9cd4d688471cc..4a2ee841970747b095e5dcdc3c52a0c7fc3a5fb5`.

## Verdict

**Specification compliant; task quality Approved.** No Critical or Important findings. All specified files and CLI-generated M01 are delivered; extra dependency, Deno, harness and configuration files support required validation rather than unrelated gameplay.

- Verified Google identity supplies actor authority; strict commands cannot submit owner IDs or prepared inventory/stat data. Input is bounded before mutation (`auth.ts:5`, `commands.ts:19`, `http.ts:21`).
- Durable owner-only reads, backend-only SECURITY INVOKER RPCs, rolling limits, account-scoped receipts, normalized-name uniqueness, atomic starters and next-boundary orientation are implemented (`01-identity.sql:9,95,135,153`).
- Local CORS tests satisfy the explicitly documented controller exception: direct Edge exact-origin headers, local gateway wildcard characterization, and forbidden-origin rejection without creation (`identity.test.ts:154`). Hosted parity remains mandatory before launch.

## Strengths and checks

Account advisory locking, uniqueness constraints, exact request comparison and transactional writes are covered by real concurrent/idempotency/name-conflict/rollback tests (`01-identity.sql:164`, `identity.test.ts:22,140`). Actual database privileges, Auth/PostgREST, cross-owner/anonymous denial, RPC denial and rate-limit concurrency/expiry are checked (`identity.test.ts:64,107`). The real 60-item inventory regression proves the aggregate avoids the 50-row API cap (`database.ts:41`, `identity.test.ts:183`). Authentication, parsing, database and HTTP modules remain focused; the generated migration is supported by concise source SQL.

The reviewer read the entire package/report, did not mutate the checkout, spawn reviewers or rerun suites. Two named outside-diff checks: compare owner view against canonical OwnerState (`contracts/reads.ts:19`), and inspect creation allocation validation for exact keys/safe integers/bounds/total (`domain/build.ts:15`). Both match. Reported final evidence: 151 unit tests, 11 actual SQL/Auth/RLS/Edge tests, TypeScript, frozen Deno entrypoint check/runtime smoke, clean M01 reset/replay and SQL lint.

## Informational finding and remaining responsibilities

One advisor unused-index INFO remains for `operation_receipts_gladiator_idx`. Fresh-database statistics are not evidence to remove a required FK index; no correction is required for this gate (`task-04-report.md:93`). Carry this informational observation into final operational review.

Hosted Google OAuth, production grant/configuration parity and hosted exact-origin headers cannot be verified by this local task. Frontend owner loading, public projections, activity processing, retention and release performance belong to later tasks. Exact owner query and setup are recorded in [migrations.md](../operations/migrations.md). The local development-key diagnostic exposure and zero-match tracked/staged scan are documented without values in [the report](task-04-report.md); this is not a claimed rotation or hosted exposure.

Task4 is complete. Controller owns this reviewed checkpoint and push. Next mainline task: Task5 Google sign-in and character creation UI.
