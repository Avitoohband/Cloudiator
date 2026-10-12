# Static scanner hardening — early Task 23 supplement

Date: 2026-10-12 (Asia/Jerusalem). Status: narrow implementation and local verification complete; independent review/integration belongs to the controller. Task 23 as a whole remains incomplete.

## Scope and source

- Workspace: C:\Avi\Studies\Projects\Cloudiator.
- Branch: codex/gladiator-arena; clean starting BASE: 6848f5fe1b73eae594af98354e5b4f2c62e86a10.
- Implementation commit / tested source head: 628e88fdf8312cc05ea860d74d7f9ee9103c257f.
- Requirements: .superpowers/sdd/2026-10-11-gladiator-arena-implementation/static-scan-hardening-brief.md.
- Assigned interfaces: scripts/verify-static.mjs (release-check CLI), tests/static.test.ts (real process/fixture tests), and this report.
- This report is mirrored in the ignored SDD scratch directory and tracked docs/implementation/static-scan-hardening-report.md. The following documentation-only commit contains the tracked report; its hash is available from Git history and the delivery message.
- No helper/reviewer agents, branch changes, push, merge, database operations, or gameplay/scene changes. Claude's active Tasks 8/9/10 worktree was untouched. No HANDOFF/ledger or AGENTS.md change.
- Skills followed: systematic-debugging, test-driven-development (including writing-good-tests reference), verification-before-completion. Read installed Next 16.4 static-export and distDir guides before editing; used existing build configuration.

## Investigation and meaningful RED

The scanner reads every asset as UTF-8 text and applies its forbidden patterns directly. The original property patterns allowed a bare or quoted property immediately before whitespace and a colon/assignment, then a raw quote for string-valued seed. A serialized JSON property in a JavaScript string has a backslash before the closing property quote and before the opening value quote. These backslashes interrupt the original pattern. Nested serialization produces longer backslash runs with the same failure. No JavaScript evaluation or asset import was used to investigate or fix this gap.

Before any production change, added four literal String.raw JavaScript-source fixtures: seed and privateSeed properties, each with one JSON quoting layer (one backslash at the quoted boundaries) and two quoting layers (three backslashes). Each fixture is written to _next/static/chunks/payload.js within a clean temporary four-route export. Each test launches the real CLI and expects exit 1 plus a forbidden-material diagnostic identifying payload.js. The expected result is independent of scanner regexes; the fixtures are synthetic private-input text, not real credentials.

Also added two acceptance fixtures for escaped JSON seed:null at the same two quoting depths. Existing seed:null and seed:identifier acceptance remains exercised.

Command: npm test -- tests/static.test.ts, 21:58:46 local.
Result: exit 1; 4 failed / 17 passed (21 total).
All four denial fixtures failed at the status assertion: expected 1, received 0. Thus the CLI demonstrably accepted the exact prohibited property forms; the failures were not fixture errors or missing routes. Both new harmless cases passed before the fix.

## Minimal change and GREEN

Changed only the two existing seed/private-property patterns and added one explanatory comment. The patterns now permit repeated literal backslashes immediately before their quote delimiters. Zero backslashes preserves the previous raw behavior. The seed pattern still requires a string quote after the colon/assignment, so framework null/identifier values stay accepted. The privateSeed/private_seed and privatePlan/private_plan property pattern retains its existing value-independent denial rule.

No decoding framework, dependency, JS execution/import, new scanner authority, or build/config change was introduced. Other credential and plan patterns remain identical.

Command: npm test -- tests/static.test.ts, 21:59:07 local.
Result: exit 0; 21 passed. All four formerly accepted escaped seed/privateSeed cases now return 1 and identify payload.js; raw forbidden fixtures, missing route/replay checks, production test-key rejection, and harmless framework fixtures still pass.

## Verification commands and actual results

The first full-suite/build attempt ran in the Windows sandbox:

1. npm test, 21:59:43 local: exit 1; 10 failed suites / 4 passed suites, 89 passed tests. The failed suites errored during imports with ENOENT reading Vitest-generated ssr modules in the sandbox temporary directory, before their test bodies ran. Failed suites: tests/api/fixture-gateway.test.ts; tests/assets/manifest.test.ts; tests/assets/png-tools.test.ts; tests/backend/commands.test.ts; tests/backend/worker.test.ts; tests/domain/battle-stage.test.ts; tests/domain/clock.test.ts; tests/domain/combat.test.ts; tests/domain/replay-fixtures.test.ts; tests/domain/rules.test.ts.
2. Isolated npm run build: exit 1 loading next.config.ts. SWC failed to canonicalize the workspace jsc.baseUrl with Access is denied (Windows os error 5).

These are retained as failed verification attempts, not treated as passing evidence. Authorized sandbox-escalated retries used identical product/test source and build settings:

- npm test, 22:00:22 local: exit 0; 14 files / 317 tests passed, duration 3.51 seconds. No failing tests omitted.
- Build shell settings: CLOUDIATOR_BROWSER_TEST=true, NEXT_PUBLIC_FIXTURE_ENABLED=false, NEXT_PUBLIC_SUPABASE_URL empty, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY empty; npm run build: exit 0. Next 16.4 optimized compilation, its TypeScript phase, and static generation passed. Routes /, /_not-found, /auth/callback, /game, /replay were static.
- After build completion, npm run verify:static -- .next/browser-test: exit 0; 4 fixed routes / 80 assets scanned / no forbidden backend material found by the configured patterns.
- git diff --check and git diff --cached --check: exit 0, no whitespace errors.
- Post-build Git status contained only the two assigned implementation files; no package/config/generated tracked-file changes.
- Implementation commit exact-staged only scripts/verify-static.mjs and tests/static.test.ts.

The fresh export came from the successful isolated build, not stale out/. Existing CLOUDIATOR_BROWSER_TEST isolation keeps normal .next preview output separate. No preview/service process was stopped or restarted. The port-3000 listener query showed no listener in this tool context; no claim is made that a preview was running or that an interactive preview was tested.

A standalone typecheck was not required by this plain-JavaScript scanner/test-fixture change; Next's normal build TypeScript phase still passed. No database reset, database/Edge tests, browser suite, or public launch was attempted.

## Self-review and owning interfaces

- Real CLI denial tests catch removing backslash-aware quote recognition. They do not import private scanner internals or duplicate its matching logic.
- The one-layer and nested fixtures cover both seed and privateSeed. Escaped seed:null acceptance catches over-broad rejection of framework navigation data; existing seed:identifier acceptance remains.
- The nested JavaScript asset fixtures prove these checks are not limited to route HTML. The existing traversal still reads all files, including JSON, source maps and embedded binary strings; no file-extension filter was added.
- Route list is unchanged: index.html, game/index.html, auth/callback/index.html, replay/index.html.
- Symlink rejection branch is unchanged; credential patterns and encounter/future-opponent/private-fixture plan patterns are unchanged. The shared private-property pattern now recognizes escaped privatePlan quotes as well; no separate plan behavior was introduced.
- No global/stateful regex flags, repeated decode loop, runtime JS parser, or arbitrary code execution. Diagnostics still identify the offending file without printing content.
- Existing raw forms remain accepted/rejected by the same rules because quote prefixes may contain zero backslashes.
- No additional skill guidance update identified: the applied skills already require reproduction, real behavior regressions, minimal scope and fresh verification. Environment-specific retries are recorded here rather than generalized as a verified universal mitigation.

## Limits and concerns

This closes the named backslash-quoted JSON property gap only. It is a heuristic textual release check, not exhaustive secret detection, JavaScript/JSON semantic analysis, or proof of public-launch readiness. Unicode/hex escapes, concatenated/computed property names, encoded/encrypted content and other obfuscation remain outside the assigned scope. The pattern deliberately recognizes any backslash run at a quote boundary rather than validating serialization grammar.

No actual exported private material was found; all denial fixtures use synthetic text. The successful fresh-artifact scan proves only that the configured patterns found none in that artifact.

Independent review remains for the controller. Task 23 remains incomplete. The initial environment failures passed on elevated retries; this is observed evidence for these attempts, not a general root-cause diagnosis of Vitest or a durable environment fix.
