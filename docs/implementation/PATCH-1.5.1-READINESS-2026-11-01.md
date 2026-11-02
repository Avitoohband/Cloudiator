> **2026-11-02 verification hold:** Initial NPC 1.5.1 is live at ae9d79d; the two reviewed test fixes at a285381 are not deployed or cleared. The completed UNIT1 gate had eleven stages pass and one development-browser stage fail during startup; units 2,188 and DB 405 passed. Avi's full-Linux-trial versus Windows choice is pending; the local gate of record is unchanged. Do not repost note 7 or record 1.5.1. Read the [current verification hold and exact continuation](PATCH-1.5.1-VERIFICATION-HOLD-2026-11-02.md). Older checkpoints below are historical.

# Patch 1.5.1 verification checkpoint - 2026-11-01

Production is still 1.5. The NPC implementation, reviews, measurements and patch-version test maintenance are complete. The latest full gate on63d1204 failed11/12 on a Windows React-load transport error; publication remains pending. All gate processes and the sampler finished, browser ports are free, and raw evidence is preserved. This document is a recovery checkpoint, not a production-readiness claim.

## Latest failed gate and safe continuation - 13:05 UTC

All `logs/...` references in this section are under C:/Avi/Studies/Projects/Cloudiator/, outside the hotfix checkout.

The fixed-setup run started11:43:08UTC and completed12:31:46UTC at clean63d1204b61ee4f04eb69fa4e14fcf0cac2aab971. All12steps ran,11passed,exit1. Native units2188, typecheck/Edge3, assets, ordinary local-origin build/scan, settled Edge and405DB tests passed. Edge start11:43:42.032479938UTC was unchanged during DB tests. Development:1195passes,50skips,1unexpected. Static:32literal passes,2intentional CSP failures,1212skips; its phase passed. Both inventories and shard unions cover1246/1246identities,0missing/extra/duplicates, no retries/repeats/flaky/run-level errors. An independent raw-report audit reproduced this.

The only unexpected case is mobile trip-replay.spec.ts:774, "plays each camp moment in view with Follow off",12:28:55.245UTC,45,306ms. React DOM failed with ERR_NO_BUFFER_SPACE before expedition state initialized. No NPC behavior defect or underlying socket cause is established. The92valid host samples show no sampled global port/memory exhaustion; their roughly32-second cadence can miss transient or browser/kernel-local limits. IPv4 dynamic range16384ports,760excluded within it; no corresponding System events during the gate. Do not infer a leak or cure.

The earlier10:38-11:27 run at63d1204 failed10/12: another mobile React-load ERR_NO_BUFFER_SPACE plus a missing ignored static-server helper (all static shards executed0cases). These are separate failures. The verified helper was restored byte-for-byte from P15 (SHA2564365A255CB26F6CF35E4C42D3ED638EA8557D8C241F6F1D907AB02F19F4FCDED). Both-mode preflight, supplemental2replay checks and34expected static outcomes passed; the latest full run confirms all static shards work. No results are spliced into a passing gate.

Raw latest evidence was copied to C:/Avi/Studies/Projects/Cloudiator/logs/p151-fixed-setup-gate-20261101-63d1204-d9171dde/,588files independently hash-matched, with a sibling copy manifest. Independent audit: logs/p151-fixed-setup-gate-audit-20261101-6572d833/report.md. The native TEMP original and trace remain. Wrapper session74990 returnedexit1; sampler66636 stopped normally; ports3800/4173 were free12:49:57UTC. Re-identify any PID before a stop; never perform blanket process cleanup.

Approved guidance is committed5d1127f; Friends planning is committeda72994c. These and the following checkpoint are docs-only; application/test source is unchanged from63d1204. Exact63d1204 feature CI41298397101 passed11steps with an explicit development-browser omission; it is not a local12/12pass and does not validate a later docs SHA by identity. Future gate/deployment must record its actual frozen head and matching CI.

Next bounded option: use the existing approved2-32sequential-shard harness with8shorter Chrome shards, retaining all12steps, both exact inventories,workers1,retries0,repeatEach1 and fresh result paths. This is an unverified mitigation, not a Windows fix. Save setup hashes before starting; source remains frozen during that run. If the transport fault recurs, obtain a stable-host/restart choice before another unchanged rerun. New local downloads remain unapproved; no OS/network setting or test assertion/timeout has changed.

No1.5.1production write has occurred. Actual-production-origin build/scan, release push/Pages proof, deployed harness, note/record, fresh anonymous probe and next-completed-boundary health all remain. The three-feature payload and read-only baseline/readback generators are prepared and statically reviewed, not executed: logs/p151-release-prep-63d1204-20261101/ and logs/p151-readback-prep-20261101-f05ff5f0/ (including supplemental-20261101-ad637b7e/). Never print the private inbox baseline or generated private fingerprint SQL. Use the ACTUAL returned note ID; none is preset. Fresh anonymous probe revision2 is prepared in native TEMP Cloudiator-Codex-p151-anon-prep-20261101-vAWK0x/, independently reviewed,0live samples; runtime GO remains pending. Canonical Pages baseline/UUID checks are documented in the deployment guide.

Avi asked to be notified when all remaining1.5.xwork is shipped and fully verified. Send that milestone only after the pending production and boundary-health checks. Then continue1.6, preserving its separate filled-warning approval,24-hour notice and explicit irreversible quarter-gold activation go. One combined1.4+1.5video is authorized during1.6's notice period; social posting and other new clips are not authorized. Gear-hover45/art37, standalone Friends46after1.6 and per-device Music/SFX47 are future planning, not current patch implementation.

The1.6read-only reviews found additional plan requirements, not implemented defects: fence character creation against the one-time wallet population, and reconcile immutable cut audit/receipts/ledger rather than equating totals with an earlier live precheck (logs/p16-switch-plan-review-20261101-fe6f12ba/report.md). Trusted daily Training history can use permanent private.settled_slots; daily-limit Rest is separate from zero-point capped Training, and exact client forecasts need anchored history or honest unknowns (logs/p16-training-plan-review-20261101-settled-history-a83f2/report.md). Fold these and Avi's automatic-Rest/warn decision plus free v2 tournaments into the tracked spec/plan after1.5.1ships, before Task4.

## Exact source and scope

- Worktree: C:/Avi/Studies/Projects/Cloudiator/hotfix; branch claude/p151-camp-npcs.
- NPC parent a18ffc886862237706c001c68aff53a1736050a4; released parent 15e009b82e8d8191319d4c7230b56db359ff3258.
- Integration ccb8b5097a729bb2c660f330902d322620c8e744; current runtime 7d4514a1a411a72695495be1542b4f3e810ded32. The following checkpoint commit changes documentation only.
- Eight additional ambient NPCs: fourteen total, five guards. Two wall patrols carry evening torch looks/lights. Today's map, original six rounds, stations, beds, gate and replay road remain unchanged.
- Avi accepted guard (41,25) with partly hidden lower legs; the porter redraw is fulfilled. Preserve the reviewed posts/art. New atlas is content-named npcs.7e743ff82c.png, 1536x832, 67,807 bytes; generator/provenance checks pass. No backend path differs from released 1.5.

## Integration and independent reviews

Baseline native units on a18ffc8 passed 1,980/1,980. Merge touched three overlapping files; CHANGELOG was the only textual conflict. Keep unreleased 1.5.1 above exact released 1.5/1.4; retain both camp test contributions and all live feature rows. Native units observed the existing PATCH/changelog invariant RED (2,187/2,188); candidate PATCH=1.5.1 then passed 6/6 targeted and 2,188/2,188 across 124 files. TypeScript, cached/frozen function checks, Edge 3/3 and asset --check (28 files) passed. Managed-sandbox failures are retained separately, not product clearance.

Fresh independent integration review: spec PASS, quality APPROVED; complete 855-path merge preservation independently reproduced. Fresh most-capable whole-branch NPC review: spec PASS, quality APPROVED, no actionable Critical/Important/Minor findings. It read the complete 25-path / 205,601-byte diff, all atlas semantics and relevant named callers. Original NPC/fix-round RED evidence was not independently established; historical 1,980 units/149 browsers are not a fresh integrated gate.

Ignored reports: .superpowers/sdd/2026-10-30-camp-npcs/{integration-report-2026-11-01.md,integration-review-2026-11-01.md,final-review-2026-11-01.md,fix-rereview-2026-11-01.md}. Integration artifacts: integration-20261101T085309Z/ in that workspace. The approved asynchronous-probe guidance is durable in AGENTS.md at 7d4514a; vendor caches unchanged.

## Measured fixture frame intervals

Compare released-P15 runtime (p15-arena HEAD15e009b) with candidate 7d4514a1a411a72695495be1542b4f3e810ded32, same public world, phase, viewport, camera, warmup and sampler. Installed headed Chrome156 on i9-13900K / RTX4090; requested DPR1, actual1.00000002980232. Desktop1280x720 and narrow360x740; CPU1x three paired repeats per day/evening overview and evening torch-focus condition, plus one CPU4x stress pair per condition.

48 usable ten-second samples / 81,513 intervals; 49 raw rows include one explicitly excluded camera-interfered row. All primary condition medians are5.880ms; all primary/stress p95 values6.000ms. CPU4x paired mean deltas range -0.003467 to +0.035251ms. Those positive measured deltas are retained; one stress pair cannot attribute the differences. Display-capped intervals do not establish zero added render cost, and the desktop narrow viewport is not a physical phone. No optimization was made. Future larger-map phone verification remains separate.

The first18 usable rows have endpoint camera checks only; later30 add unchanged trusted-input counts. Protocol changes/cohorts and the health pause are explicit. The initial sampler hash is missing and is not reconstructed as proven provenance; later attempt hashes are retained. One replaced camera-interfered row remains separately preserved. Two setup-only failures (sandbox socket permission; exact DPR comparison) produced no samples. Measurement definitions remained fixed.

Root independently parsed all49 rows plus the explicit id/timestamp exclusion, checked48 unique cells/eight six-cell groups, recomputed all mean/p95 values and81,513 intervals, and checked zero page-error/request-failure/external-request arrays. Mean calculation error <3e-15; p95 error0. There are28 zoom2.44 day/evening desktop/narrow art PNGs with state/QA. Source/index were clean at completion and all owned benchmark runtimes stopped, ports3801/3802 free.

Raw evidence and reproducible sampler: C:/Avi/Studies/Projects/Cloudiator/logs/p151-perf-2026-11-01/, principally evidence-native-setup2/. Complete limits/table: .superpowers/sdd/2026-10-30-camp-npcs/performance-report-2026-11-01.md.

## Gate, stack and publication next

Local Edge now serves hotfix using the existing byte-identical private local env and cached runtime. Owned launcher session65360 / native PID20872, created2026-11-01T09:01:39.9189610Z; initial container start09:01:41.916594682UTC. Re-identify before any stop; never dump env/status/secrets. One stack only. The gate must stabilize Edge source access and compare container start time around DB tests; no concurrent edits/builds/browser in this worktree during that phase.

Prepared ignored gate config: node_modules/.cache/pw-p151-gate.config.mjs. Imported metadata verified two Chrome projects (desktop/mobile), workers1, retries0, repeatEach1, port3800 and deployed.spec.ts excluded. It copies the known full-gate config, remapping only its outputDir label; private values were never printed. Use installed tools, no new local downloads:

    node scripts/verify.mjs --config node_modules/.cache/pw-p151-gate.config.mjs --browser-shards 8 --results <fresh-directory> --json <summary-file>

Run all12steps, no omitted development phase. Audit each actual inventory against its eight disjoint shard manifests; keep expected CSP controls distinct from literal passes. Source remains frozen. Run CI and an ordinary real-production-origin build/scan too. No passing claim for these pending steps.

Static payload audit passed: exact CHANGELOG title and three feature strings, first feature as preview, three ordered li blocks, null action. Limits: title37/80, preview126/140, body448/2000; features126/106/216 each <=240. Draft/audit live in the NPC workspace. Do not assume a message ID or publication time. After exact client/Pages success, settling and automatic deployed checks, publish once, use actual returned note ID, record1.5.1, compare exact linked history/unread/revision and run a fresh final-snapshot anonymous probe. No migration or Edge deployment.

Routine specified release/remote pinned installs are authorized. New local package downloads are not. Remind Avi about the patch clip and feature posts after shipping. One combined1.4+1.5video is authorized during1.6's notice period; social posting and other new clips need their own authorization. Then design/1.6: integrate released line, reconcile canonical max-two-Training/day and free-v2-tournament amendments, Tasks4-9. The day-ahead warning go, >=one-day notice and separate irreversible quarter-gold activation go remain mandatory. Read canonical scope before turning the older read-only preflight into implementation.

## Completed production1.5 follow-up and retained records

At09:22:11.417UTC required post-boundary health passed with alerts0, publishedSlot373651 and openBoundaries0. Existing verified projectlink, exact read-only health SELECT,142 hosted rows; evidence C:/Users/Avi_OP_PC/AppData/Local/Temp/Cloudiator-Codex-p15-boundary-health-20261101-ba79c1ae/. This closes1.5's health follow-up, not human attestation.

Ruling: use released-P15 as the before baseline, preserving the same UI/world while isolating NPC additions - cost if wrong: limited attribution; raw setup/source facts remain available.
Ruling: make no performance optimization from display-capped measurements - cost if wrong: slower devices remain unmeasured; no physical-phone claim is made.
Ruling: retain the ignored historical workspace/artifacts for cross-agent handoff - cost if wrong: disk usage until deliberate cleanup. Do not delete another stream's recovery records.

## First full-gate attempt and subsequent owner decisions

Attempt862af6e started09:40:21.313UTC and was stopped10:19:09UTC after the second development shard reported three unexpected desktop cases in patches.spec.ts. They look for playingPatch1.5; all three retained YAML snapshots correctly show1.5.1. No ERR_NO_BUFFER_SPACE or socket-denial marker occurs in those failures. First shard303expected/11skipped, second302expected/5skipped/3unexpected. Native unit2188 and DB405 summaries were retained, but this stopped attempt has no final consolidated gate JSON and is not a completed or passing12-step gate. Later partial work is not spliced into a new run. Raw evidence: C:/Users/Avi_OP_PC/AppData/Local/Temp/Cloudiator-Codex-p151-gate-20261101-862af6e-400373cd/. Owned gate46256 creation09:40:21.3366480UTC was re-identified before session61725 was stopped; matching gate processes and ports3800/4173 were absent at10:20:24UTC. Edge remains separately owned by hotfix.

Fresh CI41294056960 passed on862af6e:11gate phases plus explicit development-browser omission. Units2178pass+10verified Windows-only skips/124files, Edge3, DB405/30files, static1246cases=32literal passes+2expected CSP controls+1212skips. CI omitted development, so its success did not cover these failures. Private audit: C:/Users/Avi_OP_PC/AppData/Local/Temp/Cloudiator-p151-ci-audit-835ff5a9715b440f8c7bd732def4b1fb/ci-audit-41294056960.md.

Avi approved the benchmark-provenance project guidance; it is now in AGENTS.md, with the untested upfront guard distinguished from observed missing initial provenance. Avi also resolved1.6's third-Training policy: automatically Rest, including existing plans, and warn before saving. Carry this into that stream's tracked spec/plan after NPC ships.

Video scope correction: ONE combined1.4+1.5 update video. Do not describe it as a separate1.5-only clip. Avi confirmed production during 1.6's player-notice period; current inventory found no matching brief. Earlier film format/voice/music are historical options, not new-film approvals. No package download, recording, generation or rendering has occurred for this new video. Feature-post reminders remain; publication is not inferred.

## Test maintenance reviewed; planning requests recorded

Test-only b40bb2307b28471ad0c4bb28b1cce64796cc11c9 replaces stale current-build expectations with canonical PATCH and keeps genuinely equal/older/newer/later scenarios. Fixed historical records/cursors and behavioral assertions are retained. The full targeted patch spec passed 22/22 (11 desktop, 11 mobile), zero skips/retries/flaky/errors, in 38.1s; root independently parsed every result. Fresh scoped review addressed all three failures and approved spec/quality without findings. Reports: version-test-maintenance-report-2026-11-01.md and version-test-maintenance-review-2026-11-01.md in the NPC workspace. Runtime remains 7d4514a; next is a clean full gate and matching new CI.

Avi's new planning request is recorded as idea 45 in docs/superpowers/specs/2026-10-29-next-patch-ideas.md: gear attributes on hover while switching gear in My gladiator, linked to later inventory item artwork (existing idea 37). This records future UI scope, not a built feature. The combined 1.4+1.5 video is to be produced during 1.6's notice period.
