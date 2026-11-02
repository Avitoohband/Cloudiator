# Patch 1.5.1 — native32 continuation, 2026-11-02

This checkpoint records a **complete failed verification attempt**, not a release go. Resume the actual execution checkout at `C:/Avi/Studies/Projects/Cloudiator/hotfix`, branch `claude/p151-camp-npcs`, candidate `002d83522ff15a4b97c4c18e3468d7d15be1e256`. This document's separate handoff branch does not move that checkout or the production branch.

## Current outcome

The fresh durable native Chrome gate ran13:43:19.200–14:38:00.018UTC. **Eleven stages passed, development browsers failed, exit1, notRun empty.** Entry and wrapper receipts agree. All132 raw/identity reports are present; both32-shard unions exactly cover1,246 identities, with no missing, extra, duplicate or flaky outcomes. Workers1, retries0, repeat1,90-second outer per-test deadline, whole-run globalTimeout0; existing individual waits and CPU budgets unchanged.

| Check | Actual result |
| --- | --- |
| Native unit suite |2,203 passed /124 unique files; all upfront identities/hashes match; includes15 added unit executions |
| Typecheck, Deno, assets, builds, scans, whitespace | Passed |
| Database/Auth/Edge |405 passed /30 modules; accepted unchanged Edge timestamp13:06:04.434378139UTC; no discard marker |
| Development browser |1,195 literal passes,1 unexpected failure,50 skips |
| Static browser |32 literal passes,2 intentional expected CSP failures,1,212 skips;0 unexpected |
| Changed live-camp test at line38 | Desktop and mobile each passed once, retry0 |
| Final guards | Exact clean candidate;869/869 setup hashes;124/124 unit hashes/physical files; ledger unchanged throughout gate |
| Shutdown | All62 recorded PID/creation identities absent; ports3800/4173 free; sampler stopped; entry/wrapper exited1 |

The sole unexpected case is desktop `inventory.spec.ts:646`, “keeps the keyboard focus on the page through Wear, Undo and Cancel changes.” Its local React DOM script request failed with `ERR_NO_BUFFER_SPACE` approximately137ms before the first rail-reveal interaction. The rail then remained `data-revealed=false` through its5-second expectation; later Wear/Undo/Cancel actions were not reached. This establishes a missing runtime prerequisite, not the underlying Windows cause or an exclusive hydration-causality proof.

The independent audit preserved787 files /149,842,127 bytes with before/copy/after equality and a fresh787-file rehash,0 mismatches. Manifest SHA256: `F5448E40F275D2D9D0EA501939C306947D7E989B45935F212AAF13A994F09E28`.

## Ordinary CI is green, with its explicit omission

[Run41427623906, attempt2](https://github.com/Avitoohband/Cloudiator/actions/runs/41427623906/attempts/2) succeeded on the exact candidate, feature ref and push event; job completed14:58:36UTC. Its first attempt had been cancelled when the Linux trial began; this rerun introduced no source change.

All11 executed stages passed. The development browser suite was **explicitly not run on CI**. Units2,193 passed plus10 Windows-only skips /124 files; Deno3; DB405/30; static32 literal passes plus2 expected CSP failures and1,212 skips. This is ordinary CI success, not a substitute for the failed native full gate. The artifact ZIP digest was supplied by GitHub metadata, not independently recomputed; structured controller evidence and logs were parsed.

## Specific upstream hypothesis; Avi's choice is pending

Windows is11 Pro/build26300. The exact Chrome156.0.8078.74 source declares `TcpPortRandomizationWin` enabled by default from Windows11 22H2. Installed Playwright1.64.0's17 default disabled features omit it. A native read-only observation of an owned test Chrome at14:34:27UTC found one17-name disable list, without that feature.

[Playwright PR43605](https://github.com/microsoft/playwright/pull/43605), merged October25, disables the feature after loopback10055 reports despite available ports. [The Chromium report](https://issuetracker.google.com/issues/572515601) describes the matching pattern. These support a **specific hypothesis**, not a demonstrated cause or cure on this host. No feature flag has been changed.

Root asked Avi to choose: test the upstream workaround in test Chrome only, preserving the existing17 disabled features and all test limits, or retain default Chrome and collect socket logs. **No answer has arrived at this checkpoint. Do not infer approval from elapsed time or the recommended/preselected option.** No package download or Windows-setting change is proposed. Do not launch another unchanged full gate.

Read-only fault-window event checks found no TCPIP4227/4231 or exhaustion2004 events; after-fault snapshots do not identify the exhausted resource. They do not rule out transient socket/queue faults. No unrelated process was stopped and no Windows setting was changed.

## Production and next stream

NPC1.5.1 is already live at `ae9d79d47525c1cbc4194fea84805c2e5644f160`, Pages `1660af43-ee66-46f4-b318-1480bcb9719b`. Its initial clean8 gate, real-origin build, deployed checks, publication and next-boundary health are historical completed evidence. **Never repost note7 or record1.5.1 again.**

The current candidate differs from that live source in exactly10 test/CI/documentation files; all847 other tracked entries are identical by recursive Git tree comparison. This does not prove a new artifact or waive a gate. No new production write, real-origin build, deployment or following-boundary health was performed for this candidate. Never set `fullGateGreen=true` for this failed run. No one-off maintenance exception is authorized; any such policy change would need Avi's explicit approval of concrete evidence and named gaps, and could not carry into economy/runtime changes.

Economy remains preparation only; design checkout is `5919fa1`. Adopt the reviewed v5 amendments only after the required release-line integration. Keep max2 actual Training slots/day→ordinary Rest plus save warning, free eligible v2 tournaments/paid regular Arena, immutable history/receipts, population fencing, and `--skip-vault` for both migration-only pushes. D-1 text/time approval,24-hour notice and separate irreversible activation go remain mandatory.

The independent future-roadmap/approved-geometry branch remains `codex/future-patch-ideas-20261102` at `87371c47a911454e69c6a0464815d0cdabcda731`; it has not been merged into the candidate. Future level20,100 total base attributes excluding gear/class bonuses, optional free existing-character respec, gear/PvE/schedule/pets/NPC ideas remain future scope. Friends follows economy; audio is per-device. The combined1.4+1.5 video is for the1.6 notice window, with the patch-clip/feature-post reminder retained.

## Local evidence and continuation

Paths are under `C:/Avi/Studies/Projects/Cloudiator/` unless stated. Preserve original failed/partial runs; never splice them into a pass. Raw configs, reports, private baselines and NetLog may contain fixture/private values: never print keys or secrets.

- `logs/CONTROLLER-LIVE-20261102-NATIVE32-RECONCILIATION.md`: controller continuation; read its latest appended state.
- `logs/p151-durable-native32-v2-audit-20261102-7f219a64/report.md`: complete failed gate/audit/archive.
- `logs/p151-ordinary-ci-audit-41427623906-a2-20261102/AUDIT.md`: ordinary CI proof and limits.
- `logs/P151-NATIVE-HOST-READONLY-TRIAGE-20261102-7f219a64.md` and `logs/P151-NATIVE-EVENT-PORT-SUPPLEMENT-20261102-7f219a64.md`: exact failure ordering and bounded counters/events.
- `logs/P151-WINSOCK-PRIMARY-SOURCES-SUPPLEMENT-20261102-07c46d29.md`: exact-version feature/default-list and upstream findings.
- `logs/P151-INDEPENDENT-NEXT-PATH-REVIEW-20261102-c17e46b2.md`: most-capable advisory; recommends bounded diagnosis before another full gate.
- `logs/p151-netlog-diagnostic-static-v2-20261102-7f219a64/README-V2.md` and `REPORT.md`: default-only single-case NetLog preparation, not imported/listed/captured. Parser-only controlled RED exposed3 false-complete cases; identical GREEN fixtures4/4 and8 privacy checks passed. No browser/flag test is implied. Raw fixture/harness output stays in private native TEMP.
- `logs/p16-static-mockup-qa-v5-control-20261102-1bd23749-c4d56a38/RESULTS.json`: independent offline candidate3 mockup run20/20,552 assertions,0 failure/events,89 unchanged inputs, browser closed/listeners0. Root inspected all4 new profile PNGs and the additional changed Registration page;77/82 PNGs match previously reviewed V4 bytes. Source gaps/Avi approval remain unaccepted. No client implementation or media permission is implied.

This is a documentation-only handoff. Its own CI is intentionally skipped; no skipped checkpoint workflow is used as candidate acceptance evidence. The execution checkout/index/HEAD and production ref remain unchanged.
