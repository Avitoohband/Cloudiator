# Task 11 independent specification and quality review

Date: 2026-10-12. Reviewer: a fresh Claude reviewer subagent, read-only on the worktree. It did not run the browser. It ran anything that writes files in `git archive` copies under its scratch directory. The same reviewer did the scoped rounds 2 and 3, so it verified its own findings.

## Verdict

**Specification compliant; code quality Pass; ready to merge.**
- Final range: `b739870..` the commit recorded in the READY TO MERGE post.
- Art commits: `edd78ab`, `6f99f50`, `bc5b4d6`, `3051531`, `e5eb8fc`, plus the final follow-up.

## Rounds

| Round | Range | Spec | Quality | Outcome |
| --- | --- | --- | --- | --- |
| 1, full review | `b739870..6f99f50` | Fail | Fail | With fixes: 1 Critical (pixel anchors stored under `anchor`), 7 Important, 10 Minor. Fixed in `bc5b4d6`. |
| 2, scoped | `bc5b4d6` | Fail | Pass | Arena wall segments unsliced (10 tiles wrong); close-up deferral not durable; 7 Minors. Fixed in `3051531`. |
| 2b, scoped | `3051531`, `ddb9bec` | Fail | Pass | 4 tiles still wrong (edge slices took depth from a column 32px away), and the test skipped exactly that case. 5 Minors, including the tie bias on one-tile props, a stale `depthRule`, and the border test missing row 62. Fixed in `e5eb8fc`. |
| 3, scoped | `e5eb8fc` | **Pass** | **Pass** | **Yes.** Two cosmetic Minors, addressed in the final follow-up. |

## Round 3 evidence (reviewer)

- **Commands:** `npm test` 217 passed, `npm run typecheck` clean, and `build-assets --check` up to date (26 files).
- **Review sheets:** `review-sheets.mjs` was re-run in a clean archive of `e5eb8fc`, and all 13 evidence PNGs are pixel-identical to the committed copies.
- **Arena depth, verified three ways:**
  - The reviewer's independent pixel checker reports 0 wrong tiles across 179 tiles and four silhouettes.
  - With the `ddb9bec` `map.json` restored, the new test fails ("23,17 vs arena-wall-12 at column 194"). It passes with the fixed data.
  - The depth probe shows the inside walkers fully over the back wall.
- **Other fixes confirmed:**
  - the tie bias in both depth files;
  - the `depthRule` and README text;
  - the border test on all four inner edges (no actor frame has art on row 62);
  - the dropped axe head whole;
  - the troll's club visible in front of the fallen body;
  - the document rows.

## Round 3 Minors and resolution

1. **The 2px lift left unarmoured lying bodies about 1px above the ground line.** The lift is now 1px. Bare lying bodies end at row 58, the ground line, and heavy armour at row 61, still clear of the border test. Measured; all 33 asset tests pass.
2. **The gate beam still overdraws the near pillar's top corner** (51 pixels, down from 96). The beam stays seated at the pillar's hidden face, and the generator comment and the `art-review.md` row now say it meets the top corner at 1×. Accepted as cosmetic.

## Remaining limitations (accepted)

- The close-up battle view is deferred to Task 14, with the acceptance criteria in `art-review.md` and `task-11-report.md`.
- NE frames exist only for idle and walk. Boots have no layer.
- The smith's beard reads as a block only at 8× zoom. In victory, the troll grips its club just under the head.
- The fps targets belong to Task 23.

Ownership: Codex owns integration into `codex/gladiator-arena`, HANDOFF and the push.
