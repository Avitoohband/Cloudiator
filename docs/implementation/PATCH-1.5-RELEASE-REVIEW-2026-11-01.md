# Patch 1.5 — Avi’s production review

## CURRENT BED-CACHE CHECKPOINT — 2026-11-01

The exact note/record drafts below remain unchanged. Production is1.4; actual restart completed at2026-11-01T06:17:55.5000000Z. Postrestart28556a1 passed2170units/405DB and555reported development cases with no reported failures, then root stopped it for independently diagnosed CI maintenance. Both newCI runs failed only unchanged camp-beds113/5000ms; all other executable CI stages passed, development deliberately omitted. Static34expected outcomes include32literal passes and2CSPexpected failures;1208skips, with no uploaded rawstats claim.

Test-only **c1da8eb** caches2immutable images rather than36whole decodes, retaining every pixel/geometry assertion and timeout. Local baseline8pass(pixel1977.89ms), fixed8pass(139.11ms), full2170/122 andtypecheck/Edge3passed. Independent spec/quality review approved; newcandidateCI and complete local12remain required. No new runtime/asset/dependency changes, no permanent host-cure claim, no production write. Normal remote pinned installs and checked routine release already approved; local downloads and separate1.6go requirements unchanged. This current block supersedes older pending-host/CI-execution statements; gate handoff holds exact resume/evidence.

**Release candidate; production remains 1.4. Full gate awaits host recovery; remote pinned installs are approved.** Avi's latest instruction authorizes the planned release after its checks. Runtime fixes: `db386db`; bounded runner `4893378`, static guard `2aa9158` and offline verification `26b824f` are independently approved. Both approved guidance overrides are persisted in AGENTS.md (`9e6acfa`). This checkpoint changes documentation only.

## Exact patch-note draft

Kind: `patch-notes`. Action: none.

**Title:** Watch your Arena bouts more easily

**Preview:** My bouts lists your own Arena and tournament bouts. Watch them one after another, from the camp, Notifications or the Arena menu.

**Body:**

- p: What changed:
- li: My bouts: Results now opens on your own Arena and tournament bouts, by day, with your opponent, whether you won and how your rating moved. Show all of them, or only the ones you won or lost.
- li: A new replay bar, like the whole-trip replay’s: play and pause, a track you can drag, the time, a speed of 1×, 2× or 4× that this device remembers, and ⚑ Result.
- li: When a bout ends, its result shows on the arena with Watch again and Next bout, so you can watch your bouts one after another.
- li: Watch a bout from where it shows up: a button on the camp after your bout, ▶ Watch in Notifications, and your recent bouts in the Arena menu.
- li: Tournament bouts play full screen too, and Next bout steps through the bracket.
- li: The replay no longer shows who won above the fight before it plays.

## Exact patch-record draft

**Number:** 1.5

**Title:** Watch your Arena bouts more easily

**Features (word for word from CHANGELOG):**

- Results opens on My bouts: your Arena and tournament bouts by day, with All, Won and Lost filters, rating changes and a dot until watched on this device.
- The replay bar has play and pause, a track, the time, a remembered speed of 1×, 2× or 4×, and ⚑ Result.
- A bout's result appears on the arena after the victory poses, with Watch again and Next bout, or a button back at the end of your list.
- The replay header keeps the result hidden while the fight plays. On a phone, who won stays in view and Fighters and Combat log fold away.
- Back names where you opened the replay and returns there in one step.
- Next bout follows your list, with a counter and Up next.
- Notifications open your kept Arena and tournament replays with Watch, and expeditions with Watch the trip; Back returns to Notifications.
- The Arena menu shows your three latest bouts with Watch and a link to all your bouts in Results.
- After your Arena bout ends, a camp button names who won, shows rewards once credited and opens the replay; dismiss it for that bout on this device.
- Tournament brackets open the full-screen viewer, with each decided bout as a chapter.

Link the record to the actual new note ID returned by publication. The placeholder below is review-only and is not executable SQL. Generate the real statement with `scripts/patch-statement.mjs 1.5 --message <returned id>` only after the approved note succeeds.

```sql
select private.record_patch(
  '1.5',
  $t$Watch your Arena bouts more easily$t$,
  array[$f$Results opens on My bouts: your Arena and tournament bouts by day, with All, Won and Lost filters, rating changes and a dot until watched on this device.$f$, $f$The replay bar has play and pause, a track, the time, a remembered speed of 1×, 2× or 4×, and ⚑ Result.$f$, $f$A bout's result appears on the arena after the victory poses, with Watch again and Next bout, or a button back at the end of your list.$f$, $f$The replay header keeps the result hidden while the fight plays. On a phone, who won stays in view and Fighters and Combat log fold away.$f$, $f$Back names where you opened the replay and returns there in one step.$f$, $f$Next bout follows your list, with a counter and Up next.$f$, $f$Notifications open your kept Arena and tournament replays with Watch, and expeditions with Watch the trip; Back returns to Notifications.$f$, $f$The Arena menu shows your three latest bouts with Watch and a link to all your bouts in Results.$f$, $f$After your Arena bout ends, a camp button names who won, shows rewards once credited and opens the replay; dismiss it for that bout on this device.$f$, $f$Tournament brackets open the full-screen viewer, with each decided bout as a chapter.$f$],
  <new note id returned by post_message>
) as number;
```

## For Avi at the go

- Three planned production writes: client release, the exact note above, then the linked 1.5 patch record. Avi's latest release instruction covers these after their checks; he has approved normal pinned remote CI/Pages dependency installs and CI container pulls. New local package downloads remain unapproved. This patch has no schema or Edge change.
- The full 12-step gate is PENDING. Runtime source db386db; scoped review found no Critical/Important issue. Unit 2,102/119 and TypeScript passed; affected union 488pass/5fail/3existing skips, then the 16-case covering run resolved all five failures. Real local PostgREST/owner/filter/RLS and cached-only Deno checks passed.
- Phone chapter bars use the recorded 118px exception; ordinary bars are at most 100px, buttons at least 44×44 and slider at most 32px. Final desktop and360 captures were inspected; see local final-scoped-2 evidence.
- Expedition encounter overlays omit reward chips; their lower Result retains whole-trip rewards. This is the recorded design carry for Avi’s disposition in the go.
- Two Minor residuals are parked: Up next uses plural Quarterfinals/Semifinals rather than the approved singular examples; the clock test helper observes periodic polls but does not attest overlapping manual-command refresh completion. No client runtime code is affected by the latter. All current helper callsites were inspected and their covering cases passed; a held direct-command case remains future work.
- Inherited Phaser texture warnings remain unexplained; original Task 9 RED raw traces were lost (logs and later traces retained). The separate 1.4 GitHub bed-image timeout decision remains pending. No warning/trace restoration/CI-green claim.
- At execution time recheck release window and open boundaries. After shipping, remind Avi about the 1.5 patch clip and feature posts.

All controller rulings and their costs: [rulings](PATCH-1.5-RULINGS-2026-11-01.md).

## Validation checkpoint — 2026-11-01

Runtime source remains `db386db`; test-only maintenance `c2a7603` passed independent spec/quality review and fresh root TypeScript (exit0). The full gate is still pending.

- Attempt1: local worker configuration absent in p15; DB7 failed/398 passed. Existing local file copied byte-identically to the ignored p15 path; targeted real worker check passed, then fresh full DB405/30 passed. No secret contents or hashes printed.
- Attempt2: units2,102/119 and DB405/30 passed. Development browser1,185 passed/7 failed/50 skipped. Four verification assumptions were corrected; the fifth distinct scenario is a preserved Windows ERR_NO_BUFFER_SPACE camp-startup failure. Static was interrupted at82 observed cases (1 pass marker/13 failure markers/68 skip markers) after proving new development-only groups lacked their proper guard. This was not a completed12-step gate.
- Maintenance: targeted56 passed/2 counter-instrumentation failures/4 existing mode skips; after counter correction, both retry cases passed. Static loader verified28 newly guarded development-only cases and retained valid static eligibility. This is not a claim of a clean62-case run or a static runtime pass. Application code and phone-bar test remain unchanged.
- Next: one fresh complete gate on the current host after these corrections. An optional environment preference remains unanswered; no reboot approval is inferred, and no host recovery is claimed. A recurring resource fault needs a stable-host decision.

Evidence and exact commands remain in the local plan ledger/reports and the two preserved Temp gate directories. Production remains1.4; fresh1.5 go still requires the complete gate result.

## Latest gate disposition — 2026-11-01 03:19 UTC

Fresh 7fe6f75: 2,102 unit/119 files and 405 DB/Auth/Edge/30 files passed. Root interrupted Step 8 after recurring Windows ERR_NO_BUFFER_SPACE in tournament.spec:680; 579 development cases were observed, not a completed browser pass. No 12/12 or production go. Stable-host/restart choice is required before another complete gate. Exact evidence/resume steps: [gate handoff](PATCH-1.5-GATE-2026-11-01.md). All note/record wording above remains a draft.

## Current mitigation checkpoint — 2026-11-01

Both failures are independently confirmed in actual trace network response fields, status −1, rather than only classifier text. The host has not rebooted; current system-wide port exhaustion and a specific leak remain unproven. A 313-case sequential-shard diagnostic passed 302 with 11 existing skips, zero unexpected/flaky/run errors or host faults, and all 16 recorded owned process identities exited normally.

Runner `4893378` adds opt-in sequential shards, full unchanged discovery and exact unique actual-case coverage, retaining both raw report forms. Its 107 targeted tests and TypeScript/frozen Deno checks passed; independent spec/quality review approved with no findings. A fresh complete twelve-step gate remains. No application/configuration/test selection, retries, Windows settings or user apps were changed. This is an unproven full-suite mitigation, not a host cure.

The exact note is prepared outside the repository as UTF-8 without BOM: 34 title characters, 129 preview characters, 7 blocks/777 body characters, not executed. The linked patch statement must still use the actual returned note ID. No production write/push/package download has occurred. See rulings 15–17 for the changed gate approach and current release authority.

## Complete bounded-run disposition and final preparation

c04e0d0 completed all12steps, exit1:11passed, only production failed. Units2,159/121, DB405/30, development1,192expected/50skips and production34expected/1,202skips/6unexpected each covered exactly1,242cases. There were no host faults; both earlier resource-failure cases passed. The six failures all require signed-in routed client setup intentionally unavailable in the isolated export. Guard2aa9158 preserves their development assertions; targeted static10passed/54skipped and development6/6 passed. Independent review approved; its minor report wording was corrected, and the targeted colour warning remains disclosed.

Offline verification26b824f passed114targeted checks and real typecheck/Edge3tests, with zero Download statuses; independent review approved. The old run's two npm metadata status lines do not establish completed transfers or archives. The rejected Deno2.9.6 check+cached-only hypothesis and tested no-run alternative are recorded in rulings19 and the gate guide. CI preparation has not been run; its normal remote pinned installs are now approved.

One fresh complete gate on both reviewed corrections remains required. No publication step is authorized to bypass it, and no production write or production-branch push has occurred. The exact note/record drafts above are unchanged.

## Latest stopped gate and approvals

Frozen candidate a68978e passed units2,170/122 files and DB/Auth/Edge405/30 files. Development shard1 passed302/11existing skips; root stopped Step8 after609 observed result markers when a required React DOM chunk failed with net::ERR_NO_BUFFER_SPACE in release.spec.ts:71 desktop. The first art-failure prerequisite, not a Schedule assertion, timed out. Actual trace:29requests/1failed/0actor-art requests, before hydration. Independent diagnosis supports host transport failure; no application fix is justified by this failure. All owned runners are stopped and port3800 is free; no complete browser or12/12 pass. Windows has not rebooted since2026-10-31T19:31:23.9418480Z. Preserve this evidence and recover the host before another full run.

Avi also approved keeping the current1.5.1south-guard placement; the porter redraw was already fulfilled. Both scoped Verification Before Completion guidance changes are applied in9e6acfa, with observed failures, tested corrections and still-required full-gate/CI evidence distinguished. No new local download or automated reboot is authorized. The1.6day-ahead warning and irreversible activation retain their explicit-go requirements. See the gate handoff for exact recovery and release steps.
