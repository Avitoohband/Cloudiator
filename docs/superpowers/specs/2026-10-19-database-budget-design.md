# Database budget: trims, idle characters and the 500 MB limit — Design

**Status:** approved direction. Avi chose "A + C + D" on 2026-10-19 after Task 23.3 measured the database. The same day Avi took the controller's recommendation on the one open question: the structural compactions wait until after launch, when the 400 MB warning appears ("do what u recommend. continue"). Choices marked *controller call* are the controller's, not Avi's.

## Why

The Task 23.3 measurement assumes 50 characters, each with an activity every slot (18 slots a day), and 10 commands per player per day.

| | After 90 days | After one year |
|---|---|---|
| Measured database size | about 395 MB | about 600 MB |

The spec's internal budget is 250 MB. The free plan allows 500 MB.

The largest contributors:

| Contributor | Size | Window |
|---|---|---|
| Background job rows (inputs and results) | 61.7 MiB | 7 days |
| Activity summaries | 69.7 MiB | 90 days |
| The public copy of recent results | 39.1 MiB | 90 days |
| Settled-slot checkpoints | +21 MB a month | permanent |
| Command receipts | +11 MB a month | permanent |

Avi chose three changes:
- **A:** technical trims.
- **C:** idle characters pause.
- **D:** the internal limit rises to 500 MB.

## Goals

- Stay under the 500 MB free plan for at least a year at 50 always-active characters.
- Keep everything players see: 7-day replays, 90-day results history, and season archives.
- Stop idle accounts from growing the database.

**Non-goals:**
- No change to retention windows or to what any player sees, except the idle state (C).
- No paid plan, and no automatic upgrade (spec §11).

**Anti-goals:**
- Never lose a grant guard or a reward.
- Never break catch-up ordering.
- Never pause a player who is actually playing.

## A: technical trims (no visible change)

1. **Empty completed jobs' payloads once their slot has settled.**
   - Cleanup's hourly pass replaces the `input` and `result` of completed jobs in fully settled slots with a small stub, and keeps the row. The 7-day delete still removes it later.
   - A guard allows exactly that one update shape, like the receipt compaction in M16.
   - Expected saving: about 35-40 MiB. The fixed columns, the seed and the seven indexes stay.
2. **Dropped (controller call, after the builder check).** The public recent-results copy already holds only the six public summary fields, so a trim would save only about 10-15 MiB across many read paths. Not worth the risk.

## C: idle characters pause (new game rule)

**Activity signal**
- A new private field holds the owner's last activity time.
- It is updated by:
  - every command, through the Edge function, as today's rate limiting already does per call;
  - a new lightweight **presence** command. The signed-in game sends it once after sign-in or page load, then at most every 6 hours while the page is open.

  Watching the game while signed in therefore counts as activity.

**Idle rule**
- A character is **idle** when its owner has had no activity signal for **14 days** (252 slots). The 14 days are a new constant, `RULES_V1.idle`.

**While idle** (controller calls marked)
- *Controller call:* an idle character leaves the boundary cohort. That means no member row, no preparation job, no snapshot, no activity and no settled-slot row, which is the largest saving.
- At each boundary, the character gets no activity: no training, rest, expedition, Arena or tournament entry, and no stamina, experience or rewards.
- It is excluded from Arena pairing and tournament brackets.
- Its processed-slot checkpoint still advances with everyone else's, so catch-up ordering and publication are unchanged.
- Idle slots write no activity rows and no settled-slot rows, because nothing is granted.
- *Controller call:* a season rating row is created only once the character plays in that season. A character idle for a whole season does not appear in that season's standings.

**In the camp** (small visible change; screenshots at review)
- An idle gladiator is not drawn walking in the camp.
- Its profile card, and the Gladiators list, show "Resting at home: back when [name]'s owner returns."
- The owner sees nothing different: any sign-in or command wakes the character first.

**Waking up**
- The first activity signal ends the idle state.
- The character's schedule applies again from the **next** boundary. Missed idle slots are not back-filled or rewarded, so no catch-up flood is triggered.
- *Controller call:* no separate notice. Until the next boundary, the owner's My gladiator activity line reads "Resting at home: back on your schedule at [next boundary, local time]". This comes from a resting flag in the owner's private state.

**Where it runs**
- One boundary check, in the existing apply-changes and snapshot phases, with no new job kinds.
- The presence command goes through the existing `game-command` Edge function. It is rate-limited like other commands and adds at most about 4 invocations per active player per day, which is well within the invocation budget.

## D: the 500 MB internal limit

- The internal database budget becomes **500 MB** (524,288,000 bytes).
- The health report already warns at 80 %, so it now warns at **400 MB**, and alerts at 100 %.
- The spec (§11, :410), the 24-task plan's global constraint and the health report are updated together.
- The egress (3 GB a month) and invocation (300,000 a month) budgets are unchanged.

## Expected result and remaining risk (corrected after the builder check)

Worst case: 50 characters, all active every slot, 10 commands a day. Physical size can run above these modeled figures until autovacuum reuses space; the health warning reads physical size.

| A + D | After 90 days | After one year |
|---|---|---|
| New-character schedules | about 355 MB (71 %) | about 557 MB (111 %) |
| Busier mixed schedules | about 427 MB (85 %) | about 679 MB (136 %) |

**What drives the year:** the permanent settled-slot checkpoints (+21 MB a month) and command receipts (+11 MB a month).

**How it is handled:**
- Idle pausing (C) lowers real numbers by however many accounts go quiet.
- The 400 MB warning gives notice.
- Two structural compactions, both without visible change, would flatten the growth:
  - store settled slots as compact per-character ranges (the same information);
  - compact command receipts older than 90 days to a fingerprint.

**Avi's decision (2026-10-19): after launch.** Task 23.7 does not build the compactions. They become their own task when the health report's 400 MB warning appears. At the worst-case load the warning would appear:
- about 2 to 3 months after launch with busier mixed schedules;
- about 5 months after launch with new-character schedules.

Real numbers are lower by however many characters are idle or unscheduled.

## Testing

- **Trims:**
  - A completed job's payload is emptied only after its slot settles.
  - A retry or replay of a compacted job still grants nothing new.
  - Recent results show exactly the same fields as before.
- **Idle:**
  - A character with no signal for 14 days, minus 1 ms, still plays; at 14 days it pauses.
  - It is skipped by pairing and brackets.
  - The checkpoint keeps advancing, and catch-up and publication are unchanged.
  - A presence command wakes it from the next boundary.
  - No idle slot writes rows.
  - A character idle for a whole season has no rating row, so it does not appear in that season's standings. A character that played in the season keeps its row and its standing.
- **Budget:**
  - The health report warns at 400 MB and alerts at 500 MB, both on physical database size.
  - The health report counts active characters, meaning those in the boundary cohort. This count is the watch for Task 23.3's boundary-latency risk, which has zero headroom at 50 characters.
  - The capacity report re-measures both scenarios against 500 MB.
  - The 23.6 gate requires both scenarios under 100 % at 90 days. The one-year figures are reported as risk, with the chosen compaction plan.
  - Modeled size is cross-checked against physical size after a `VACUUM FULL` in the test only.

## What is left to the builder

- Table and column names.
- The guard's exact form.
- How the presence timer is scheduled in the client: once per load and every 6 hours while visible.
- The idle copy's final wording within the meaning above.

## Placement

- Task 23.7 runs in lane A (database) as migration **M21**. M19 (boundary latency) and M20 (shared reveal) came first.
- The 23.6 release gate is already built and reports the database budget as its one known blocker. Task 23.7 makes the gate pass against 500 MB.
