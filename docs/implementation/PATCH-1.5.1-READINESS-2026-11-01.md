# Patch 1.5.1 verification checkpoint - 2026-11-01

Production is still 1.5. The NPC implementation is integrated and reviewed. The first full-gate attempt on862af6e was stopped with three stale browser expectations; its reports are retained. Test maintenance, a fresh complete gate and publication remain pending. This document is a recovery checkpoint, not a production-readiness claim.

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

    node scripts/verify.mjs --config node_modules/.cache/pw-p151-gate.config.mjs --browser-shards 4 --results <fresh-directory> --json <summary-file>

Run all12steps, no omitted development phase. Audit each actual inventory against its four disjoint shard manifests; keep expected CSP controls distinct from literal passes. Source remains frozen. Run CI and an ordinary real-production-origin build/scan too. No passing claim for these pending steps.

Static payload audit passed: exact CHANGELOG title and three feature strings, first feature as preview, three ordered li blocks, null action. Limits: title37/80, preview126/140, body448/2000; features126/106/216 each <=240. Draft/audit live in the NPC workspace. Do not assume a message ID or publication time. After exact client/Pages success, settling and automatic deployed checks, publish once, use actual returned note ID, record1.5.1, compare exact linked history/unread/revision and run a fresh final-snapshot anonymous probe. No migration or Edge deployment.

Routine specified release/remote pinned installs are authorized. New local package downloads are not. Remind Avi about the patch clip and feature posts after shipping; no media/post creation is authorized. Then design/1.6: integrate released line, reconcile canonical max-two-Training/day and free-v2-tournament amendments, Tasks4-9. The day-ahead warning go, >=one-day notice and separate irreversible quarter-gold activation go remain mandatory. Read canonical scope before turning the older read-only preflight into implementation.

## Completed production1.5 follow-up and retained records

At09:22:11.417UTC required post-boundary health passed with alerts0, publishedSlot373651 and openBoundaries0. Existing verified projectlink, exact read-only health SELECT,142 hosted rows; evidence C:/Users/Avi_OP_PC/AppData/Local/Temp/Cloudiator-Codex-p15-boundary-health-20261101-ba79c1ae/. This closes1.5's health follow-up, not human attestation.

Ruling: use released-P15 as the before baseline, preserving the same UI/world while isolating NPC additions - cost if wrong: limited attribution; raw setup/source facts remain available.
Ruling: make no performance optimization from display-capped measurements - cost if wrong: slower devices remain unmeasured; no physical-phone claim is made.
Ruling: retain the ignored historical workspace/artifacts for cross-agent handoff - cost if wrong: disk usage until deliberate cleanup. Do not delete another stream's recovery records.

## First full-gate attempt and subsequent owner decisions

Attempt862af6e started09:40:21.313UTC and was stopped10:19:09UTC after the second development shard reported three unexpected desktop cases in patches.spec.ts. They look for playingPatch1.5; all three retained YAML snapshots correctly show1.5.1. No ERR_NO_BUFFER_SPACE or socket-denial marker occurs in those failures. First shard303expected/11skipped, second302expected/5skipped/3unexpected. Native unit2188 and DB405 summaries were retained, but this stopped attempt has no final consolidated gate JSON and is not a completed or passing12-step gate. Later partial work is not spliced into a new run. Raw evidence: C:/Users/Avi_OP_PC/AppData/Local/Temp/Cloudiator-Codex-p151-gate-20261101-862af6e-400373cd/. Owned gate46256 creation09:40:21.3366480UTC was re-identified before session61725 was stopped; matching gate processes and ports3800/4173 were absent at10:20:24UTC. Edge remains separately owned by hotfix.

Fresh CI41294056960 passed on862af6e:11gate phases plus explicit development-browser omission. Units2178pass+10verified Windows-only skips/124files, Edge3, DB405/30files, static1246cases=32literal passes+2expected CSP controls+1212skips. CI omitted development, so its success did not cover these failures. Private audit: C:/Users/Avi_OP_PC/AppData/Local/Temp/Cloudiator-p151-ci-audit-835ff5a9715b440f8c7bd732def4b1fb/ci-audit-41294056960.md.

Avi approved the benchmark-provenance project guidance; it is now in AGENTS.md, with the untested upfront guard distinguished from observed missing initial provenance. Avi also resolved1.6's third-Training policy: automatically Rest, including existing plans, and warn before saving. Carry this into that stream's tracked spec/plan after NPC ships.

Video scope correction: ONE combined1.4+1.5 update video. Do not describe it as a separate1.5-only clip. Its scheduling question is pending; current inventory found no matching brief. Earlier film format/voice/music are historical options, not new-film approvals. No package download, recording, generation or rendering has occurred for this new video. Feature-post reminders remain; publication is not inferred.
