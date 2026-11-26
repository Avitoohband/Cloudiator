# Cloudiator 1.9.4 Front Door Implementation Plan

> Implement in order with RED and GREEN unit evidence. Author browser cases before their implementation and leave browser execution to Claude.

**Goal** Give campaign visitors a phone-first welcome over the existing camp and retain the first approved source for the 2.0 handoff.

**Architecture** A finite, shared slug registry feeds a statically generated `/game/p/[source]/` route and the browser-only source capture. A shared `GameEntry` renders the existing Suspense camp for both regular and campaign routes. The camp gates the nonmodal welcome on a canonical entry pathname and confirmed anonymous Auth. It reuses the existing Google flow.

**Spec** [1.9.4 front door](../specs/2026-11-26-front-door-design.md). The promotion can proceed with source paths and without a central counter if the live Pages project cannot count requests by path. The approved trailer and profile have separate codes.

## Constraints

- Work in `design-i` on `claude/1.9.4`. Leave its shared dependency junction alone. No installs, network, Docker, Playwright execution, `.env` reads, SQL, migration, Edge, deployment or commit.
- Preserve static export, trailing slashes, existing OAuth callback, CSP and no third-party request on a campaign arrival. Keep browser and build outputs separate.
- Preserve the approved labels **Build your gladiator**, **Sign in with Google to play.**, **Play free in your browser**, and **Explore the camp**. Use the existing sign-in busy and error copy.

## Tasks

### 1. Source registry and 2.0 handoff

- [x] Write `tests/domain/promo-source.test.ts` first. Assert the exact approved registry, rejection of an unknown or noncanonical path, first-touch preservation across repeat entries and reload, replacement at the 30-day boundary, malformed and future timestamp rejection and storage-denial fallback. Capture RED before building the helper.
- [x] Implement `src/features/promo/source.ts`. Export `PROMO_SOURCES`, `PromoSource`, `promoSourceForPath(pathname)` and `rememberPromoSource(code, nowMs?, storage?)`. Accept the exact `/game/p/<code>/` path for a known slug. Keep `cloudiator.promo.source.v1` as the tab record with `{v:1,code,capturedAtMs}`. Mirror the earliest valid record into Pioneer’s `cloudiator.signup-source.v1` local record `{code,capturedAtMs}` with a 30-day maximum age from the original capture. Storage may be denied independently. The promo never shares this record outside the browser.
- [x] Rerun the focused tests for GREEN. Write `docs/operations/promo-sources.md` with public links for profile, trailer, Instagram, TikTok, Reddit communities and ads, itch.io, and IndieDB. Include issuance rules, shared trailer limits and optional host request reporting.

### 2. Static pages and welcome

- [x] Author `tests/browser/front-door.spec.ts` against the public behavior. A static-only group verifies actual exported HTML paths, working assets/CSP, unavailable Auth suppression and the unknown-path 404. A separately guarded routed group covers 1280×720 and 360×740, first arrival, dismissal and focus, signed-in owners and users awaiting a gladiator, Google success/cancel, storage agreement and no third-party arrival traffic.
- [x] Write `tests/domain/promo-welcome.test.ts` for the welcome region and exact actions, precedence and ineligible Auth states. Record RED before building the component and policy.
- [x] Move the reusable query-aware entry to `src/app/game/GameEntry.tsx`. Add `src/app/game/p/[source]/page.tsx` with `generateStaticParams()` over `PROMO_SOURCES` and `dynamicParams = false`. Pass the route source to the camp. Keep the plain game route and root unchanged from the player’s perspective.
- [x] Integrate `src/features/promo/PromoWelcome.tsx`, `promo.module.css` and `usePromoWelcome.ts` with `CampShell`, `CornerChip`, and the Auth session hook. The welcome owns the single join surface while visible. Dismissal is scoped to the tab and returns focus to the restored join button. Existing sheets and scene controls have priority.
- [x] Rerun the focused welcome tests for GREEN. Build an offline production export, verify each issued document and the exact static headers, and leave Playwright to Claude.

### 3. Patch metadata and handoff

- [x] Record RED with `tests/domain/patch.test.ts` against an undated 1.9.4 section and the expected build patch. Set `PATCH` to `1.9.4` and add the plain patch note and corresponding `docs/FEATURES.md` row.
- [x] Run patch tests for GREEN, then the side-worktree unit suite with named exclusions and `npm run typecheck`. Report exact totals, omissions, and the browser specs (including the static group).

## Local evidence and browser handoff

- RED: the new source and welcome suites reached collection before their modules existed. The patch invariant failed with the new changelog at `1.9.4` and the old client at `1.9.3`.
- GREEN: 28 source cases, 6 welcome cases, and 6 patch cases. The undated Camp Life entry from the unreleased 1.9.3 development base moved into 1.9.4 with the welcome.
- Side-worktree unit suite: 2,838 passed across 181 files. Three existing cases relied on US formatting and were skipped after the initial run reproduced the mismatch with the host’s `en-IL` default. The Git-dependent restore check passed with process-scoped `safe.directory`.
  - “is the short slot time against the display time, with its exact instant as the machine-readable time” in `tests/domain/expedition-view.test.ts`
  - “is written in the 24-hour form when the clock setting asks for it” in `tests/domain/expedition-view.test.ts`
  - “shows the queued time on its badges and its note, against the shared clock” in `tests/domain/gear-panel.test.ts`
- Side-worktree file exclusions: `tests/deployed.test.ts` and `tests/scripts/browser-case-reporter.test.ts` (invoke Playwright), `tests/scripts/deno-offline.test.ts`, `tests/scripts/game-info-mcp.test.ts` and `tests/scripts/serve-static.test.ts` (loopback fixtures), `tests/scripts/build-headers.test.ts` and `tests/scripts/set-worker-secret.test.ts` (synthetic environment files), and `tests/scripts/verify.test.ts` (junction and gate fixtures). Vitest used the installed runner, disabled caches and an env-disabled wrapper.
- Typecheck: client TypeScript and three cached Deno entrypoint checks passed. Four existing Edge smoke tests passed as part of the typecheck command.
- Static export: native Windows Turbopack could not resolve Next across the dependency junction. The installed Next `build --webpack` in isolated production mode exported all nine campaign documents and the default 404. The static scan passed for six fixed routes and 169 files. Offline inspection confirmed that the campaign scripts resolve locally and the campaign documents use the existing CSP. Keep logs and temp files outside the entire `.next` tree because the build clears that tree even for a nested browser export.
- Browser gate: run `tests/browser/front-door.spec.ts` in both development and static modes on desktop and mobile. Include `tests/browser/visitor.spec.ts`, `tests/browser/identity.spec.ts`, and `tests/browser/game-info.spec.ts` for adjacent regressions. Serialize the development server and static build. Actual HTTP status and browser behavior remain browser-gate checks.
