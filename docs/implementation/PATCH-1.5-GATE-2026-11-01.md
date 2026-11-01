# Patch 1.5 gate — bounded-lifetime candidate

**2026-11-01: fresh 12/12 still required; production remains 1.4.** The complete c04e0d0 gate passed 11 steps and failed only six unsupported static scenarios. Their guard `2aa9158` and offline verification `26b824f` are independently approved. No production write or push occurred. Two earlier npm metadata status lines do not establish completed transfers or package archive downloads; the new verification path is tested cache-only.

## Current checkout and commits

- Worktree: `C:/Avi/Studies/Projects/Cloudiator/p15-arena`, branch `claude/p15-arena-replays`. Runtime fixes: `db386db1ca43a873882e4d545b10f0317828af1f`.
- Reviewed test-only maintenance: `c2a7603c03d5f1c62786ae099bd6cc15cd105fb6`; interrupted gate candidate: `7fe6f75fdcbfcf87102bef1ff5c4dd39fe6e6e3c`. Bounded runner: `48933789f85698907bab78b8b4187de087e90c00`; later checkpoint commits change documentation only.
- Complete bounded-run candidate: `c04e0d00ecde2a1d285af7f062e7f3e4d50c637c`. New static applicability guard: `2aa9158195311c6758f505c8d7682664c05127a8`; offline command/CI preparation: `26b824fb512cc63dfca80d246a517620f1000788`. Only later checkpoint commits are documentation-only.
- Source tree was clean when the gate stopped. All owned test runners are stopped; port 3800 has no listener. Do not reuse old process IDs after reboot.

## Verified results and limits

- Before the new bounded-runner commit, the fresh full unit step passed **2,102 tests/119 files** and Database/Auth/Edge capacity passed **405 tests/30 files**. Root’s separate final maintenance TypeScript command exited0 with an explicit exit file. These are not a full-suite claim for4893378.
- Maintenance independent spec/quality review approved. Targeted maintenance run: 56 passed/2 counter-instrumentation failures/4 existing skips; corrected retry scenario then 2 passed. The two counters were in test interception, not replay behavior. This is not a clean 62-case claim.
- Earlier complete development step on 0a2cd93:1,185 passed/7 failed/50 skipped. Stale future-version fixture and inline-viewer locator were repaired; readiness/settled-opacity waits retained all original assertions. Precise guards restore the established development-only applicability of 28 camp scenarios. No application or phone-bar implementation changed in maintenance.
- Earlier static run was interrupted after 82 observed cases (1 pass marker/13 failure markers/68 skip markers) established missing development-only setup guards. Loader evidence verifies applicability, not a static-runtime pass.
- Latest fresh run on 7fe6f75 reached 579 development cases before root stopped it after a second positive Windows resource fault. The complete browser and static phases were not attested. No12/12 gate or 1.5 production go is claimed.

## Host evidence and current environment

The earlier mobile phone-bar failure stopped before camp readiness/Clock interaction with `ERR_NO_BUFFER_SPACE` loading React-DOM. On the fresh run, the same resource fault recurred in desktop `tournament.spec.ts:680`, “rechecks the loaded fight duration before offering the selected chapter”. The new trace contains `ERR_NO_BUFFER_SPACE` and `Probable host fault`; root independently confirmed two trace-error records with these markers. No warning suppression, skipped host-fault test, timeout increase, forced click or test retry was used.

Latest trace: `C:/Users/Avi_OP_PC/AppData/Local/Temp/Cloudiator-Codex-p15-gate-20261101-retry2/test-results/development/tournament-the-live-Tourna-51a4d-fering-the-selected-chapter-desktop/trace.zip`.

Local Supabase is project Cloudiator, M01–M26. Edge source is p15-arena; the previous launcher 48536 uses the existing absolute claude env-file. The ignored p15 `.env.edge.local` now exists as a byte-identical copy of that local configuration, so the test runner and runtime agree. Never print these files or values. The initial missing-file mismatch caused 7 DB failures, then the exact worker diagnostic and subsequent full 405-case suites passed. After reboot verify actual processes/mounts; restart Edge from p15 using its local env-file if needed. No reset/volume deletion, linked command or download is authorized.

The latest read-only diagnosis also confirmed actual `snapshot.response._failureText=net::ERR_NO_BUFFER_SPACE`, status−1, on local React-DOM chunk GETs in both traces. Current socket counts do not establish global port exhaustion; no host settings or user apps were changed. Playwright's worker-scoped browser lifetime is one hypothesis, not an established leak.

A bounded 1/4 diagnostic on clean `c8b9dc8` completed exit 0: 302 passed/11 existing skips of 313, no unexpected/flaky/run errors or host faults. All 16 recorded owned processes exited and port 3800 was free. Its report/log, resource snapshots, process identities and cleanup proof remain in Temp/Cloudiator-Codex-p15-shard-diag-20261101. This does not attest the new orchestration or full-suite recovery.

## Complete bounded run and corrections

The c04e0d0 run finished all 12 steps, exit 1, with no CI omission: 11 passed, production failed. Units: 2,159/121 files; DB/Auth/Edge: 405/30; development: 1,192 expected/50 existing skips, exact 1,242-case coverage. Production: 34 expected (including CSP failure controls), 1,202 skips/6 unexpected/0 flaky, exact 1,242-case coverage. No host fault occurred across either complete browser mode, including both previously failing resource cases. This is one run's evidence, not proof of a cause or permanent cure.

All six unexpected cases were the signed-in My bouts group on desktop/mobile. Its synthetic session and routed reads need the backend configuration deliberately absent from the isolated export. Guard2aa9158 changes one line only; targeted static verification passed10/skipped54 of64 and development passed6/6. Review approved; the targeted colour warning was observed, not called pristine. The original full gate had zero such colour warnings. Fresh full-gate JSON will supply final mode/outcome/artifact accounting.

The old typecheck emitted two npm package-metadata Download statuses; completed transfers/archive downloads remain unproven. Frozen alone was not offline. In installed Deno2.9.6, even check+cached-only requested local fixture dependencies. Commit26b824f uses the empirically validated no-run test/check path instead, preserving default local type checking. Its114 targeted checks and real typecheck passed, Edge3/3 and zero Download statuses. Cold HTTP/npm misses made zero fixture requests; deliberate type errors fail and top-level code does not execute. Independent review approved with no findings. CI's frozen dependency preparation is written before Supabase/Edge, not executed; remote-install permission remains pending.

## Resume the bounded gate

1. Read this file, current HANDOFF/AGENTS, and `.superpowers/sdd/2026-10-29-arena-replays/progress.md`. Verify branch, HEAD and clean source; preserve all stopped Task 5 backup stashes and existing evidence.
2. Verify Docker/local Cloudiator stack, M01–M26, cached image/dependencies and p15 Edge source. Use only installed tools. If an image/package/cache download is needed, ask Avi first. No keys/status/env/connection strings in output.
3. Keep private `node_modules/.cache/pw-p15-arena.config.mjs` at one worker, Chrome, port 3800 and canonical deployed-only exclusion. Do not weaken coverage/retries. Only this worktree owns the local stack.
4. With the reviewed guard and offline correction included, run a **fresh complete gate** with CLOUDIATOR_CI unset and a new evidence directory: `node scripts/verify.mjs --config node_modules/.cache/pw-p15-arena.config.mjs --browser-shards 4 --results <new-private-dir>/test-results --json <new-private-dir>/verify.json`. Freeze source; do not build or run a second browser outside the gate. Every case must appear exactly once in each mode's complete inventory/union; preserve raw JSON and actual-case companion JSON. A Deno cache miss blocks rather than fetching. Do not add partial runs together to claim12/12.
5. If the resource fault recurs after the environment change, preserve it and diagnose the host; do not loop unchanged full runs. No product defect or host cure is inferred from these interrupted attempts.
6. Only after all12steps pass may the planned release proceed. Avi's latest explicit instruction to review, test and release supersedes the old per-patch fresh-go hold for the reviewed1.5client/note/linked record. The separate remote pinned CI/Pages dependency-install question remains pending: do not push and trigger those installs without its answer. Preserve the exact note/ten features and disclosed Minor/design carries. No schema or Edge release.
7. After 1.5 ships, remind Avi about its clip/feature posts; continue 1.5.1 NPC rereview/art approval, then 1.6 economy (max 2 Training slots per game day, Tasks 4–9). Do not start those streams before 1.5 ships.

## Preserved local evidence

All three Temp attempt directories begin `C:/Users/Avi_OP_PC/AppData/Local/Temp/Cloudiator-Codex-p15-gate-20261101`: base, `-retry1`, `-retry2`. They include original logs, candidate/process identities, screenshots/traces and explicit attempt-status records. They are private local evidence, not tracked by Git. The ignored plan workspace preserves reports and targeted outputs.

The complete bounded run is in the additional `-shards4` directory, with full summary, all eight browser raw/identity report pairs, trace/screenshots and sanitized static diagnosis. Reuse absolute artifact paths returned by the creating process: sandbox and normal Windows TEMP values can differ. Its test process exited1 and port3800 was free at handback.

Pending optional questions remain unapproved: earlier1.4GitHub CI retry with pinned installs; CSS geometry guidance; receipt-key guidance; shared worker-env handoff guidance. The new specific permission for planned releases' remote pinned installs is required and unanswered. Do not infer approval. Rulings15–16 authorize the new bounded-lifetime experiment and exact coverage audit; no reboot permission or host cure is inferred. The1.6irreversible switch and filled-in day-ahead warning retain their separate explicit-go requirements.

See [release review](PATCH-1.5-RELEASE-REVIEW-2026-11-01.md) and [all nineteen rulings](PATCH-1.5-RULINGS-2026-11-01.md).
