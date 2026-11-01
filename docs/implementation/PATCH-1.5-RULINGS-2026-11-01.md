# Rulings I made — 1.5 release candidate

In ledger order. Full gate and production approval remain pending. This list includes every Ruling entry, including the two older em-dash entries.

1. **118px chapter bar exception:** Keep the chapter name on its own phone row; ordinary bars≤100px. Cost if wrong: Move the chapter name into row 1 if rejected.
2. **Task 4 implementation concerns:** Accept wrapping, dimming, no inferred stranger round, All/StrictMode read behavior and fixture changes; its Important owner-loading bug was separately fixed. Cost if wrong: Rework layout/copy/read expectations if these choices are wrong.
3. **1.5 bookkeeping during Task 5:** Maintain honest in-progress CHANGELOG/FEATURES/PATCH metadata and patch-record integration after merging 1.4. Cost if wrong: Metadata rework.
4. **Pagination success result:** Internal more() returns whether that invocation actually applied a page/termination; no server API change. Cost if wrong: Local type/caller adjustment.
5. **Held sample projection:** Keep fixture heldAtMs authoritative; adapt old retention tests to live shared-clock behavior. Cost if wrong: Fixture/test time-control adaptation.
6. **Historical trace evidence:** Accept retained initial RED logs with explicitly lost raw Task 9 traces; later semantic failures/traces are preserved. Cost if wrong: Reduced reconstruction of that initial failure.
7. **Final review range/order:** Compare against shipped 1.4, finish review fixes before one complete frozen-source gate. Cost if wrong: Review/gate sequencing only; no check omitted.
8. **Private gate config parity:** One worker and canonical deployed-only exclusion; dedicated deployed checks follow the approved release. Cost if wrong: Deployed-probe discovery timing; no local case omitted.
9. **Ordered settled deep links:** The spec’s unsettled-current anchor exception overrides an unconditional prepend helper; locate settled bookmarks in the ordered filtered list. Cost if wrong: Bounded discovery reads/position handling.
10. **Live bracket publication:** Cache across mere chapter changes while refreshing publication boundaries with bounded retries and preserving selection/logs/looks. Cost if wrong: Extra lightweight reads while publication is pending.
11. **Minor round wording:** Park plural Up next round labels for Avi’s go disposition; safe navigation is functional. Cost if wrong: Small formatter/copy/exact-test cleanup.
12. **Minor test-helper boundary:** Poll observation is not proof of overlapping manual-command refresh completion; current consumers/covering checks were inspected. Cost if wrong: Future command-adjacent tests need an explicit completion wait and held-refresh regression.
