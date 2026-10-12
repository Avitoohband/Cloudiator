# Task 5 independent review

Reviewed 2026-10-12 by a fresh `gpt-6.1-sol` reviewer at high reasoning effort.
Base: `3d41ae900e5eaa0d2fafff5ab1cfd7b26321b3d5`.
Head: `a003751d8dd1401458a07486a5f6c6697bf2de6a`.
Source `8fcb9c3`, owner-read race fix `5b3c2a5`, report `a003751`.

## Spec Compliance

- ✅ **Spec compliant.** Required files and interfaces are present. Google PKCE uses identity scopes and a fixed callback; query/fragment errors are scrubbed and rendered safely (`src/lib/api/client.ts:16`, `src/lib/api/client.ts:26`, `src/lib/api/client.ts:39`, `src/features/auth/AuthCallback.tsx:11`).
- ✅ Creation validates names/allocation, derives previews through canonical domain functions, persists account-scoped immutable retry payloads, prevents overlapping submissions, and reloads online owner state (`src/features/character/CreateCharacter.tsx:45`, `src/features/character/CreateCharacter.tsx:80`, `src/features/character/CreateCharacter.tsx:82`, `src/features/character/CreateCharacter.tsx:88`, `src/features/character/CreateCharacter.tsx:93`).
- ✅ Owner reads distinguish confirmed absence from failure, use the required protected query, and never substitute fixture authority. Future live methods explicitly fail unavailable (`src/lib/api/gateway.ts:53`, `src/lib/api/gateway.ts:55`, `src/lib/api/gateway.ts:60`).
- ✅ Authorized C1 unions contain the requested machine values and modify only `PublicActor` fields; the fixture location becomes `training` (`supabase/functions/_shared/contracts/reads.ts:31`, `supabase/functions/_shared/contracts/reads.ts:34`, `tests/fixtures/domain.ts:25`).
- ✅ Browser coverage addresses retained drafts, retries, concurrent tabs, expiry, account changes, safe callbacks, keyboard creation, preview values, and mobile overflow (`tests/browser/identity.spec.ts:133`, `tests/browser/identity.spec.ts:147`, `tests/browser/identity.spec.ts:188`, `tests/browser/identity.spec.ts:206`, `tests/browser/identity.spec.ts:231`, `tests/browser/identity.spec.ts:260`).
- ⚠️ **Cannot verify from this diff:** Hosted Google consent, provider configuration, exact-origin/CORS deployment parity, and physical-device performance remain Task 24 checks (`docs/implementation/task-05-report.md:120`).
- ⚠️ **Cannot verify from this diff:** Real database uniqueness, transactional starter creation, server session verification, and RLS remain Task 4 evidence. The local browser harness explicitly characterizes frontend behavior (`tests/browser/identity.spec.ts:7`, `tests/browser/identity.spec.ts:75`, `docs/implementation/task-05-report.md:110`).
- ⚠️ **Cannot verify from this diff:** Task 10 must produce and sanitize the public machine values; this change supplies their contract (`docs/implementation/task-05-report.md:39`).

## Strengths

- Account-tagged owner state, effect cleanup, and request revisions protect against stale responses. Creation confirmation invalidates earlier reads, with a meaningful delayed-response regression test (`src/app/game/page.tsx:40`, `src/app/game/page.tsx:44`, `src/app/game/page.tsx:111`, `tests/browser/identity.spec.ts:280`).
- Retry metadata is restricted to canonical command fields, reconstructed safely from storage, and reused only for the matching account. Commands carry no owner identity or preview authority (`src/features/character/CreateCharacter.tsx:29`, `src/features/character/CreateCharacter.tsx:82`, `tests/browser/identity.spec.ts:78`).
- The browser harness exercises actual components and SDK PKCE exchange, including verifier/challenge matching, rather than bypassing authentication UI (`tests/browser/identity.spec.ts:39`, `tests/browser/identity.spec.ts:49`).
- Production rejects the test identity key, while isolated build/static-root configuration preserves ordinary defaults (`next.config.ts:3`, `playwright.config.ts:20`, `scripts/serve-static.mjs:6`, `tests/static.test.ts:26`).
- Verification reporting distinguishes meaningful RED results, fresh export evidence, intentional skips, and observed environment failures (`docs/implementation/task-05-report.md:58`, `docs/implementation/task-05-report.md:85`, `docs/implementation/task-05-report.md:116`).

## Issues

**Critical:** None found. **Important:** None found.

**Minor — browser output noise:** `docs/implementation/task-05-report.md:118` records the known `NO_COLOR`/`FORCE_COLOR` warning. Resolve the conflicting runner color settings when that harness is next maintained. This is nonblocking environment noise. The sanitized refresh-denial diagnostics are intentional evidence for the expiry branch, whose transport rejects refresh at `tests/browser/identity.spec.ts:51`; they are not an unexplained product failure.

## Focused Checks

- **Risk: preview accepts fractional allocation or misrepresents class bonuses.** Inspected the existing canonical `validateCreationAllocation`/`validateBuild` implementation and `RULES_V1` class/creation values. Whole safe integers and exact ten-point totals are enforced, and current class multipliers are positive bonuses (`supabase/functions/_shared/domain/build.ts:13`, `supabase/functions/_shared/domain/build.ts:75`, `supabase/functions/_shared/domain/rules-v1.ts:7`). The UI consumes these functions (`src/features/character/CreateCharacter.tsx:45`, `src/features/character/CreateCharacter.tsx:51`).
- Reviewed the supplied three-commit package, recovering tool-truncated sections. No checkout mutations, Git commands, helper agents, or test-suite reruns were performed.

## Assessment

**Task quality: Approved.** The implementation satisfies Task 5's frontend scope with explicit failure boundaries and meaningful behavioral coverage. No blocking correctness or maintainability issue was found; hosted identity and release evidence remain clearly assigned to later work.

Controller disposition: accept the clean task gate. Existing color warning remains the already-recorded final harness follow-up; no duplicate fix loop. Task 24 owns hosted Google/CORS/release proof, Task 10 owns protected public projection. This review makes no public-launch claim.
