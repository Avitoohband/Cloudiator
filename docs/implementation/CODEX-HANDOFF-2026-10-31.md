# Handoff to Codex — Cloudiator, 2026-10-31

Claude hands off to you because its credits are running low. Everything below is on this PC. The branches are local, not pushed:
they are worktrees of the same repository, so `git branch -a` from your checkout shows them. Read `AGENTS.md` first. It holds the
binding project rules: TDD, the migration workflow, the build/browser output separation, the database-test rule and the React
async-state rule.

## Ground rules (Avi's, all still in force)
- **Production writes need Avi's explicit go in chat**, each time. That covers `db push`, the `release` branch fast-forward,
  `functions deploy`, posting a patch note and `record_patch`. Production is `djkblzbnritgbmctsvob`. The live site is
  https://cloudiator-arena.pages.dev. It currently runs release `b1e9bb7`, patch 1.3.1, with migrations M01-M25.
- Deploy outside Wednesday and Saturday 17:20-20:00 UTC, and never while a boundary is open.
- **Never print** keys, JWTs, `supabase status`, `.env.edge.local` or `pooler-url`. `claude/supabase/.temp` is linked to
  PRODUCTION: use `--linked` only for approved release steps.
- No package downloads without Avi's permission. No force push. Push only when a release step needs it.
- Only one worktree may use the local Supabase stack at a time. Right now the stack is on a clean M01-M26 replay, and the local
  Edge function is served from `p14-patchnum`, whose functions match `claude/task-24`.
- Avi wants short replies. Ask every decision through a question form with your recommendation first. He approves UI only from a
  clickable mockup over real screenshots. When a patch goes live, remind him about the patch clip and its feature posts.
- Record every player-visible feature under its patch in `docs/CHANGELOG.md` and `docs/FEATURES.md`. The "Rules for agents"
  section at the top of the changelog says how.

## The patch map (Avi decided all of it; specs and plans are in docs/superpowers/)
1.4 Patch A (ready) · 1.5 Arena replays · 1.5.1 camp guards + NPCs · 1.6 economy · 1.7 wearable titles · 1.8 party dungeons +
the bot team · later: the skins shop with dyes, the gear wave, the bigger camp, the Deep, in-game guide, class quests (ideas
list: `docs/superpowers/specs/2026-10-29-next-patch-ideas.md`, items 1-35).

## Where each stream stands (each has a ledger at .superpowers/sdd/<plan>/progress.md in its worktree)

### 1. Patch 1.4 — READY FOR THE GATE (do this first)
- **Where:** worktree `C:\Avi\Studies\Projects\Cloudiator\claude`, branch `claude/task-24` @ `7362b53`.
- **Ledger:** `.superpowers/sdd/2026-10-29-patch-a/progress.md`. Read its last FINAL REVIEW, FIX WAVE and PAUSE POINT entries.
- **What it holds:** Tasks 1-11c are done and reviewed, with the final review's fix wave applied. M26
  (`supabase/migrations/20261030055918_patch_1_4.sql`) is the only migration. It holds patch numbers and the richer profile card.
  There is no Edge change.
- **Next steps:**
  1. Run the 12/12 gate on a quiet host: `node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs`.
     Before the database step, move the Edge serve back to this worktree. Known flakes under load: `arrivals.spec:149`,
     `tests/assets/camp-beds`. Rerun them serialized before you call either a failure.
  2. Show Avi the patch note draft (`.superpowers/sdd/2026-10-29-patch-a/patch-note-1.4-draft.md`) together with the points
     the ledger lists "For Avi at the go":
     - the note-number buttons are 24 px on a phone;
     - the reload notice and the arrival banner step aside under the account menu and messages;
     - the desktop account menu is 240 px wide, against the mockup's 268;
     - the welcome banner says "NEW ARRIVAL";
     - a replay has no upper length bound;
     - a chapter name can wrap on a phone.

     Ask for his go.
  3. Release, in order. Follow plan Task 12 in `docs/superpowers/plans/2026-10-29-patch-a.md` and the "Patch 1.4 (M26)" record
     in `docs/operations/migrations.md`:
     1. Pre-push guards: the migration list ends at M25; `db push --dry-run` lists only the M26 file; read production's
        patch-note titles.
     2. `db push`.
     3. Read back `public.patches` (1.1→1, 1.2→2, 1.3→3, 1.3.1→4), and check that the null-profile count is 0.
     4. Fast-forward `release` to the gate commit, with the 1.4 CHANGELOG section dated and PATCH = 1.4.
     5. Wait for Cloudflare Pages.
     6. Run the deployed checks (22 probes).
     7. Post the patch note (`private.post_message`).
     8. `private.record_patch('1.4', …, <note id>)`.
  4. Then remind Avi about the clip. It covers 1.3.1 and 1.4. Write the WhatsApp and YouTube feature posts.

### 2. Patch 1.5 Arena replays
- **Where:** worktree `C:\Avi\Studies\Projects\Cloudiator\p15-arena`, branch `claude/p15-arena-replays` @ `a3242f2`.
- **Plan:** `docs/superpowers/plans/2026-10-29-arena-replays.md`.
- **Ledger:** `.superpowers/sdd/2026-10-29-arena-replays/progress.md`. It has the carries for every remaining task.
- **Status:**
  - Tasks 1-4 are done and reviewed.
  - **Task 5 (the viewer) was stopped mid-way.** Its uncommitted work, 12 files, is in the tree. Continue it and don't discard
    it; it was updating `replay.spec.ts`.
  - Then Tasks 6-9, the final review, the gate, Avi's go, the release (no migration) and the clip.
- **Merge:** merge 1.4 into this branch after 1.4 ships.

### 3. Patch 1.5.1 camp guards + NPCs
- **Where:** worktree `C:\Avi\Studies\Projects\Cloudiator\hotfix`, branch `claude/p151-camp-npcs` @ `a18ffc8`.
- **Ledger:** `.superpowers/sdd/2026-10-30-camp-npcs/progress.md`.
- **Status:** built, reviewed and fixed. Next:
  1. A short re-review of `a18ffc8`.
  2. Show Avi the new art: `.superpowers/sdd/2026-10-30-camp-npcs/shots/closeup-porter-herald-4x.png` and the gate shots. The
     palisade now hides the south guard's legs; ask whether that is OK.
  3. Release after 1.5. It is app-only.

### 4. Patch 1.6 economy
- **Where:** worktree `C:\Avi\Studies\Projects\Cloudiator\design`, branch `claude/p16-economy` @ `5919fa1`.
- **Plan:** `docs/superpowers/plans/2026-10-30-economy-1-6.md`.
- **Ledger:** `.superpowers/sdd/2026-10-30-economy-1-6/progress.md`.
- **Status:** Tasks 1-3 are done (RULES_V2, the domain, the worker). Next:
  1. **Hold** until 1.4 ships. Then merge 1.4 into this branch, and 1.5 before Tasks 8-9.
  2. Fit Avi's newest decision into the plan: **at most 2 Training slots per game day**, on top of the cap of
     10 + 4 × level. It is appended to the end of the spec and the plan.
  3. Then Tasks 4-9. M27 comes from `21-economy.sql`, and the quarter gold cut runs through an owner-only switch with Avi's go.

### 5. Patch 1.7 titles — planned, not started
- Spec `docs/superpowers/specs/2026-10-30-titles-1-7-design.md`, plan `docs/superpowers/plans/2026-10-30-titles-1-7.md`.
- M28 comes from `22-titles.sql`. Its back-fill must reach production **before 23 Jan 2027**.

### Designs waiting (git-ignored folders in `claude/.superpowers/design/`)
- `2026-10-29-economy`, `2026-10-29-gear`, `2026-10-29-bot-team`, `2026-10-30-titles` and `2026-10-30-camp-expansion`.
- Each proposal ends with Avi's answers.
- Party dungeons + bots (1.8): spec and plan in `docs/superpowers/`; its migration is M29.

## Open questions for Avi (ask with a question form)
- Should the in-game guide (idea 34) ship with 1.6? This is recommended. Or as its own patch, or later.
- Should the Champion title be one title or one per season? This can wait until Season 2 ends.
- His in-game checks (messages, Change look, notifications, the points fix) are still to come.

## Local runtime
- **Ports:** claude 3200, p14-patchnum 3700, p15-arena 3800, hotfix 3400, design 3500. Each worktree has its own private
  Playwright config in `node_modules/.cache/`.
- **Mockup servers:** the static mockup servers on 8765-8768 may be down. Restart them with
  `python -m http.server <port> --bind 127.0.0.1` inside the design folders.
- **After a PC restart:** start Docker Desktop, then run `node node_modules/supabase/dist/supabase.js start` (local). Then start
  `functions serve --env-file .env.edge.local` from the worktree that runs the database tests.
