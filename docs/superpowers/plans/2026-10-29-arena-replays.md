> **Patch 1.5 LIVE — 2026-11-01:** Tasks 1–10 implemented, independently reviewed and shipped as e570696. Exact local 12/12, both CI runs, deployed nine checks, note 6, linked ten-feature record and fresh anonymous probe passed. Required next-boundary health after 09:20 UTC remains pending. Current planned-release go supersedes old fresh-go wording below. Task 11 media creation is outside current scope; reminder only sent. Original Tasks 1–9 procedural checkboxes remain historical; actual completion/evidence is in the ledger. Next NPC development may proceed with health follow-up retained.

# Arena Replays, More Comfortable to Watch: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution:** subagent-driven (superpowers:subagent-driven-development), already chosen by Avi. The release (Task 10) needs
Avi's go in chat and posts a patch note; the last task (Task 11) makes a players' clip, as Patch A's Task 13 does.

**Goal:** Ship Avi's idea 9 as a small client-only patch right after Patch A: My bouts in Results, one replay viewer with
Patch A's bar and a result card, Next bout through the list, and one tap from the camp, Notifications, the Arena menu and the
tournament brackets.

**Architecture:** Everything is in the static client. Pure modules hold the words (`src/features/bouts/bout-text.ts`), the
queue's stepping (`bout-queue.ts`) and the scene address (`scene-url.ts`); one owner-only read (`readBouts`, the owner's own
`activities` plus one `visible_events` read for the opponents' names) feeds a shared list store; React views sit over them.
Patch A's `TripBar` becomes a wrapper of one shared `ReplayBar`, which the bout viewer uses too. Two per-device localStorage
keys behind try/catch. No migration, no Edge change, no new command.

**Tech Stack:** Next.js 16.4.3 static client, React, Phaser (lazy), Vitest, Playwright (`channel: 'chrome'`, private config).

**Spec:** `docs/superpowers/specs/2026-10-29-arena-replays-design.md` (the approved mockup copy is quoted there word for word;
the mockup page, `.superpowers/design/2026-10-29-arena-replays/mockups.html`, is local and ignored by git). Patch A's spec and
plan (`docs/superpowers/specs/2026-10-29-patch-a-design.md`, `docs/superpowers/plans/2026-10-29-patch-a.md`) name the code
this plan binds to.

## Global Constraints

- **Patch A ships first.** This plan starts from a branch with Patch A merged and binds to its code by name: `TripBar` (Task 9),
  `clockText` (Task 7, `src/game/trip-replay.ts`), the scene address's `play` (Task 8), `away-trip.ts` and `AwayButton`
  (Task 11), `timeOfDay`, `dayText`, `useClockMode` (Task 2), `quietArrivals` (Task 6). It never re-implements them.
- Read the relevant guide in `node_modules/next/dist/docs/` before writing code (AGENTS.md); `pushState` and `replaceState`
  integrate with `useSearchParams` (`01-app/01-getting-started/04-linking-and-navigating.md`, "Native History API").
- No migration, no change under `supabase/`, no Edge change, no new command, no package download.
- Copy is the spec's, word for word (arrows "←" "→", "·" separators, "×", "▶ ⏮ ⏭ ⏸ ⚑ ↺ ●", ellipses "…"). Eyebrows are
  written in capitals in the source. A negative rating change is "Rating −13" with U+2212, as the notifications write it. Times
  carry the formatter's no-break space (`'3:00\xA0AM'`).
- Device keys, each read and written inside try/catch with an in-memory fallback for the page's life:
  `cloudiator.bouts-watched.v1` (JSON array of `[activityId, watchedAtMs]`, marks older than 7 days dropped, newest 200 kept),
  `cloudiator.replay-speed.v1` (`'1' | '2' | '4'`); Patch A's `cloudiator.trip-closed.v1` also holds closed Arena activity ids.
- Every time of day goes through `src/lib/time-format.ts` with `useClockMode()`; `tests/domain/one-clock.test.ts` stays green.
- Owner-only data (the My bouts list, renown, rating changes, the camp button) reaches only the signed-in owner; the bracket
  viewer shows no rewards; a sign-out or account change drops the owner's list.
- React async state (AGENTS.md): only the latest read lands; a slower earlier read never replaces a newer one.
- History: opening a scene pushes one entry (as today); every step inside it (⏮ ⏭ N P, ▶ Next bout, a bracket chapter)
  replaces that entry, so Back leaves in one step.
- TDD: each task's tests fail before its code. Browser tests run with
  `npx playwright test --config node_modules/.cache/pw-p15-arena.config.mjs <spec>`; never build while a browser run is active. New
  browser specs that pin times use `test.use({ timezoneId: 'Etc/GMT-3' })`; fixture-mode specs call `quietArrivals(context)`
  where Patch A's arrival banner could cover a control.
- The phone layout is the shell's touch layout (`COMPACT_QUERY`, `@media (hover: none), (max-width: 480px)`); every new
  surface fits 360 × 740 with `noHorizontalScroll` and 44 px touch targets.
- Gate of record: `node scripts/verify.mjs --config node_modules/.cache/pw-p15-arena.config.mjs`.
- Production writes need Avi's go in chat; deploy outside Wed/Sat 17:20-20:00 UTC with no open boundary.

## Review Focus

1. **Storage that throws** (private mode, blocked site data): a watched dot disappears and stays gone for the page's life, the
   speed changes and holds, a dismissed camp button stays dismissed, and nothing throws. Tasks 4, 5 and 8 each pin their key.
2. **A slower earlier read never replaces a newer one:** the list reopened (a reload of the store) or a page read by ⏭ while an
   older read is still out. Task 4 pins the store's generations with held promises; Task 6 pins ⏭ reading the next page.
3. **Back leaves in one step, to the origin, after any walk:** after ⏭ through three bouts, one "← My bouts" (or one browser
   Back) shows Results again with the same chip, and a reload mid-walk keeps the label and the chip. Tasks 3 and 6 pin it.
4. **No spoiler in the viewer:** a fixture bout whose stage label is "Bout: defeat" never shows "victory" or "defeat" in the
   scene (eyebrow, chapters, titles, accessible names) before its end or ⚑ Result. Task 5 pins it.
5. **Phone at 360 × 740 and 390 × 844:** the Results sheet (tabs, chips, rows), the viewer (who won visible without scrolling,
   the bar at most 100 px), the Notifications Watch buttons and the camp button fit with no sideways scroll. Tasks 4, 5, 7 and
   8 each check theirs.

## Fixture reference

The fixture owner Aster's bouts (`?mode=fixture`; world time Sat 10 Oct 2026 00:40 UTC), as My bouts lists them in
`Etc/GMT-3`, 12-hour, newest first. The five Arena bouts are `ARENA_ACTIVITIES` `ownerHumanWin`, `ownerHumanLoss`,
`ownerNpcWin`, `ownerNpcLoss`, `ownerTieBreak`; then `REPLAY_FIXTURES.expired` and the two `TOURNAMENT_OWNER_TIMELINES`.

| Group | Row | Sub-line (wide) |
| --- | --- | --- |
| TODAY · SAT 10 OCT | W vs Varro | Arena · 2:40 AM · +10 renown · Rating +13 |
| | L vs Cassia | Arena · 1:20 AM · +2 renown · Rating −13 |
| | W vs Iron Warden NPC | Arena · 12:00 AM · +3 renown |
| FRI 9 OCT | L vs Bronze Sentinel NPC | Arena · 10:40 PM |
| | W vs Severus | Arena · 9:20 PM · won on a tie-break · +10 renown · Rating +15 |
| WED 30 SEP | L Arena bout (dimmed) | 4:00 AM · replay no longer kept |
| SAT 26 SEP | L Tournament bout (dimmed) | 9:40 PM · replay no longer kept |
| WED 23 SEP | W Tournament bout (dimmed) | 9:40 PM · replay no longer kept |

Five kept replays (the tab's count is 5); Won holds 4 rows, Lost 4. Varro's bout ended "Varro is defeated."; Severus's is a
simultaneous-defeat tie-break; each stage label is the server's ("Bout: victory" / "Bout: defeat"). The `completed` tournament
sample's decided bouts are QF 1–4, SF 1, SF 2 and the Final (Severus vs Varro).

---

### Task 1: One replay bar for the trip and the bouts

**Files:**
- Exists already (Patch A Task 9 built it with this exact signature, f441348): `src/features/replay/ReplayBar.tsx`, `src/features/replay/ReplayBar.module.css`; this task checks it against the rules below and fills any gap
- Modify: `src/features/character/TripBar.tsx` (renders `ReplayBar`; its own props and behaviour unchanged), the stylesheet that
  holds Patch A's bar rules (Patch A's Task 9 put them in `ExpeditionView.module.css` or beside `TripBar.tsx`; they move to
  `ReplayBar.module.css` unchanged)
- Test: `tests/domain/replay-bar.test.ts` (new); Patch A's `tests/browser/trip-replay.spec.ts` unchanged as the regression

**Interfaces:**
- Consumes: Patch A Task 9's `TripBar`, as merged.
- Produces:

```ts
export type BarStep = { name: string; shortcut?: string; disabled: boolean; onClick(): void };
export type BarChapters = {
  items: readonly { id: string; label: string; disabled?: boolean; title?: string }[];
  current: number;
  onSelect(index: number): void;
};
export function ReplayBar(props: {
  label: string;                 // the role="group" name
  play: { playing: boolean; onToggle(): void; shortcut?: string; buttonRef?: Ref<HTMLButtonElement> };
  previous?: BarStep;            // absent: not rendered
  next?: BarStep;
  chapters?: BarChapters;
  track?: ReactNode;             // the bout's range input; the trip has none
  time: ReactNode;               // "0:07 / 0:23", "0:13 / now"
  tail?: ReactNode;              // speed and ⚑ Result, or Patch A's "● Back to live"
}): JSX.Element;
```

- Rendering: icon buttons ⏮ ▶/⏸ ⏭ carry `aria-label` (the step's `name`; "Play" or "Pause"), `title` `"{name} ({shortcut})"`
  and `aria-keyshortcuts` when a shortcut is given; ▶/⏸ is gold. Chapters are buttons with `aria-current="step"` on the current
  one, disabled with their `title`; in the touch layout they are hidden and one line `"{current + 1} / {count} · {label}"`
  shows instead (Patch A's phone form). Desktop: one row `⏮ ▶ ⏭ track time tail`, chapters on a row below; without a track (the trip) the chapters sit in that row in the track's place, as Patch A's approved mockup shows. Touch layout with a
  track: two rows, `track time`, then `⏮ ▶ ⏭ … tail` (at most 100 px); without a track, Patch A's phone row.

- [ ] **Step 1: Write the failing test** `tests/domain/replay-bar.test.ts` (renderToStaticMarkup):

```ts
const button = (html: string, name: string) => html.match(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`))?.[0] ?? '';
const step = (name: string, shortcut: string, disabled = false) => ({ name, shortcut, disabled, onClick: noop });
const bar = (over = {}) => renderToStaticMarkup(createElement(ReplayBar, {
  label: 'Replay controls', play: { playing: true, onToggle: noop, shortcut: 'K Space' }, time: '0:07 / 0:23', ...over }));
it('names each button with its key', () => {
  const html = bar({ previous: step('Previous bout', 'P'), next: step('Next bout', 'N', true) });
  expect(html).toContain('aria-label="Replay controls"');
  expect(button(html, 'Previous bout')).toContain('title="Previous bout (P)"');
  expect(button(html, 'Previous bout')).toContain('aria-keyshortcuts="P"');
  expect(button(html, 'Next bout')).toContain('disabled');
  expect(button(html, 'Pause')).toContain('aria-keyshortcuts="K Space"');
  expect(button(bar({ play: { playing: false, onToggle: noop } }), 'Play')).not.toBe('');
});
it('leaves out a step it is not given', () => { expect(bar()).not.toContain('aria-label="Previous bout"'); });
it('lists chapters, the current one marked, and says the current one in one line for a phone', () => {
  const html = bar({ chapters: { items: [{ id: 'q', label: 'Quarterfinal' }, { id: 's', label: 'Semifinal' },
    { id: 'f', label: 'Final', disabled: true, title: 'Not yet: plays when it happens' }], current: 1, onSelect: noop } });
  expect(html).toMatch(/aria-current="step"[^>]*>Semifinal</);
  expect(html).toContain('title="Not yet: plays when it happens"');
  expect(html).toContain('2 / 3 · Semifinal');
});
it('keeps the track, the time and the tail in that order', () => {
  const html = bar({ track: createElement('input', { type: 'range', 'aria-label': 'Replay position' }), tail: '⚑ Result' });
  expect(html.indexOf('Replay position')).toBeLessThan(html.indexOf('0:07 / 0:23'));
  expect(html.indexOf('0:07 / 0:23')).toBeLessThan(html.indexOf('⚑ Result'));
});
```

- [ ] **Step 2: Run** `npx vitest run tests/domain/replay-bar.test.ts`; expect FAIL (no module).
- [ ] **Step 3: Implement** `ReplayBar` and make `TripBar` render it: "Previous chapter" / "Next chapter" steps, Patch A's
  chapter items with their locked titles, the time, "● Back to live" as the tail. Move the bar's CSS rules unchanged.
- [ ] **Step 4: Run** the unit test, `npm run typecheck` and `npx playwright test --config node_modules/.cache/pw-p15-arena.config.mjs
  tests/browser/trip-replay.spec.ts tests/browser/expedition.spec.ts`; expect PASS with the trip specs unchanged.
- [ ] **Step 5: Commit** `refactor: one replay bar for the trip and the bouts`.

### Task 2: The owner's bouts read

**Files:**
- Modify: `src/lib/api/reads.ts`, `src/lib/api/gateway.ts` (`bouts`, owner-only through `read`), `src/lib/api/fixture-gateway.ts`,
  `src/lib/tournament-id.ts` (`tournamentRound`), `tests/browser/live-routes.ts` (JSON-path filters; `LiveData.bouts`)
- Create: `tests/fixtures/my-bouts.ts` (the fixture owner's bout timelines of the Fixture reference, by activity id)
- Test: `tests/api/bouts-read.test.ts` (new), `tests/api/fixture-gateway.test.ts`, `tests/domain/tournament-id.test.ts`

**Interfaces:**
- Produces, `reads.ts`:

```ts
export type BoutFilter = 'all' | 'won' | 'lost';
export const BOUTS_PAGE = 20;
export type MyBout = {
  activityId: string; kind: 'arena' | 'tournament'; slotIndex: number;
  /** When it was fought: an Arena slot's start + RULES_V1.arena.revealAfterMs, a tournament's slot start. */
  foughtAtMs: number; settledAtMs: number;
  result: 'victory' | 'defeat' | 'completed'; renown: number;
  /** The owner's rating change; null when the summary has none (an NPC bout). */
  ratingDelta: number | null;
  replayExpiry: ActivitySummary['replayExpiry'];
  /** The run's last bout's opponent, read only while the replay is kept at the read's server time. */
  opponent: { name: string; npc: boolean } | null;
  tieBreak: boolean;
  /** A tournament's last bout's round ("Final", "Semifinal", "Quarterfinal", "Round 1"), else null. */
  round: string | null;
};
export type BoutsPage = { rows: MyBout[]; nextCursor: string | null };
export type LastBout = { label: string; tieBreakReason: string | null; participants: { id: string; gladiatorId: string | null; name: string }[] };
export function parseBoutsCursor(cursor?: string | null): number | null;   // a whole slot index; anything else `unavailable`
export function boutOf(input: { activityId: unknown; gladiatorId: string; slotIndex: unknown; startsAtMs: unknown; kind: unknown;
  summary: unknown; lastBout: LastBout | null }): MyBout | null;          // null for a row it cannot show faithfully
export async function readBouts(client: SupabaseClient, filter: BoutFilter, cursor?: string): Promise<BoutsPage>;
```

- `tournament-id.ts`: `tournamentRound(label: string): string | null` (`'Final: victory'` → `'Final'`, `'Round 2: defeat'` →
  `'Round 2'`, `'Bout: victory'` → null).
- `GameGateway.bouts(filter: BoutFilter, cursor?: string): Promise<BoutsPage>` (the owner's own; needs a session).
- The read (spec "Data"): parse the cursor first; `readRevision`; `activities` with `select('id,gladiator_id,slot_index,
  starts_at_ms,resolved_kind,settled_at_ms,summary')`, `status` eq completed, `resolved_kind` in (arena, tournament), `summary`
  not null, `settled_at_ms` lte now, Won/Lost `summary->>result` eq victory/defeat, cursor `slot_index` lt, order `slot_index`
  desc, limit 20. Then, only for the rows `replayKept` at now, `visible_events` with `select('activity_id,ordinal,
  label:stage->>label,tieBreakReason:stage->battleLog->>tieBreakReason,p0id:stage->battleLog->participants->0->>id,
  p0gladiator:…->0->>gladiatorId,p0name:…->0->>name,p1id:…,p1gladiator:…,p1name:…')`, `activity_id` in the kept ids,
  `stage->>kind` eq bout, `reveal_at_ms` lte now, order `activity_id` then `ordinal`, limit 50, paged with
  `or(activity_id.gt.X,and(activity_id.eq.X,ordinal.gt.N))` until a short page. The highest ordinal per activity is its
  `lastBout`; the opponent is the participant whose gladiator id is not the row's (null gladiator id: an NPC), and none unless
  the row's gladiator is one of the two. `nextCursor` is the last fetched row's slot index when 20 rows were fetched (rows
  left out included).
- The fixture gateway answers from `tests/fixtures/my-bouts.ts` through `boutOf` (start = settled − 80 minutes, the last bout
  stage as `lastBout` only while kept at the fixture's server time), with the same cursor rule and pages of 20.
- `live-routes.ts`: a filter column with `->`/`->>` is read through that path (`summary->>result`, `stage->>kind`).
  `LiveData.bouts?: readonly RevealedTimeline[]` are merged into the timelines and give owner `activities` rows that also carry
  `gladiator_id` (the owner's), `slot_index` (`floor((settledAtMs - 1) / SLOT_MS)`), `starts_at_ms` and `resolved_kind`; one
  `activities` row per activity id.

- [ ] **Step 1: Write the failing tests.** `tests/api/bouts-read.test.ts`, over the fake Data API of
  `tests/api/notifications-read.test.ts` (`api`, `serve`, `SESSION`, `SERVER_NOW`):

```ts
test('reads the owner’s settled Arena and tournament bouts, newest first, 20 a page', async () => {
  const { client, requests } = api(serveBouts([row(1, 'arena', { renown: 10, ratingDelta: 14 }), row(2, 'tournament')], [lastBout(1, 'Bout: victory', 'Varro')]), SESSION);
  const page = await readBouts(client, 'all');
  expect(requests.map(r => r.table)).toEqual(['world_revision', 'activities', 'visible_events']);
  const q = requests[1].query;
  expect(q.get('select')).toBe('id,gladiator_id,slot_index,starts_at_ms,resolved_kind,settled_at_ms,summary');
  expect([q.get('status'), q.get('resolved_kind'), q.get('summary'), q.get('settled_at_ms')])
    .toEqual(['eq.completed', 'in.(arena,tournament)', 'not.is.null', `lte.${SERVER_NOW}`]);
  expect([q.get('order'), q.get('limit'), q.get('summary->>result')]).toEqual(['slot_index.desc', '20', null]);
  expect(page.rows[0]).toMatchObject({ kind: 'arena', foughtAtMs: startOf(1) + 3_600_000, renown: 10, ratingDelta: 14,
    opponent: { name: 'Varro', npc: false }, tieBreak: false, round: null });
});
test('filters Won and Lost on the server and pages by slot', async () => {
  const { client, requests } = api(serveBouts([]), SESSION);
  await readBouts(client, 'lost', '400');
  expect(requests[1].query.get('summary->>result')).toBe('eq.defeat');
  expect(requests[1].query.get('slot_index')).toBe('lt.400');
  await readBouts(client, 'won');
  expect(requests.at(-1)!.query.get('summary->>result')).toBe('eq.victory');
});
test('asks for names only of kept replays, and only the names cross', async () => {
  const { client, requests } = api(serveBouts([row(1, 'arena'), row(2, 'arena', {}, { expired: true })], []), SESSION);
  await readBouts(client, 'all');
  const v = requests.find(r => r.table === 'visible_events')!.query;
  expect(v.get('activity_id')).toBe(`in.(${uuid(1)})`);
  expect(v.get('stage->>kind')).toBe('eq.bout');
  // Only text paths and the two key columns cross: never the stage or the log as a whole.
  expect(v.get('select')!.split(',').every(field => /->>/.test(field) || ['activity_id', 'ordinal'].includes(field))).toBe(true);
  expect((await readBouts(api(serveBouts([row(2, 'arena', {}, { expired: true })]), SESSION).client, 'all')).rows[0].opponent).toBeNull();
});
test('names an NPC, a tie-break and a tournament’s last round', async () => { /* lastBout with gladiatorId null → npc true;
  tieBreakReason 'simultaneous-defeat' → tieBreak true; a run with 'Quarterfinal: victory' (ordinal 1) and 'Semifinal: defeat'
  (ordinal 2) → opponent of ordinal 2, round 'Semifinal' */ });
test('refuses a malformed cursor before any request, and leaves out a row it cannot show', async () => {
  // 20 rows fetched: one with a summary it cannot read, then rows 2..20.
  const { client, requests } = api(serveBouts([row(1, 'arena', {}, { summary: { resolvedKind: 'arena' } }), ...rows(2, 20)]), SESSION);
  await expect(readBouts(client, 'all', 'x')).rejects.toMatchObject({ code: 'unavailable' });
  expect(requests).toHaveLength(0);
  const page = await readBouts(client, 'all');
  expect(page.rows).toHaveLength(19);
  expect(page.nextCursor).toBe(String(slotOf(20)));   // from the rows fetched, the left-out one included
});
test('is the owner’s own read: a visitor is refused before any request', async () => {
  const { requests } = api(serveBouts([]), null);
  await expect(createLiveGateway().bouts('all')).rejects.toMatchObject({ code: 'unauthenticated' });
  expect(requests.filter(r => r.table === 'activities')).toHaveLength(0);
});
```

  (`serveBouts(rows, stages)` answers `world_revision`, `activities` and `visible_events`; `row(n, kind, earned, over)` is one
  `activities` row at slot `slotOf(n)`, kept unless `over.expired`; `rows(from, to)` a run of them; `lastBout(n, label,
  opponent)` one bout stage row of activity `n`.) In `tests/api/fixture-gateway.test.ts`: `bouts('all')` gives
  the Fixture reference's eight rows in order (opponents `['Varro', 'Cassia', 'Iron Warden', 'Bronze Sentinel', 'Severus',
  null, null, null]`, kinds, results), `bouts('won')` four and `bouts('lost')` four, `nextCursor` null, and `bouts('all', 'x')`
  is `unavailable`. In `tests/domain/tournament-id.test.ts`: the `tournamentRound` cases above.
- [ ] **Step 2: Run** `npx vitest run tests/api tests/domain/tournament-id.test.ts`; expect FAIL (`readBouts` not exported).
- [ ] **Step 3: Implement** the read, the gateway method, the fixture module and gateway, and the `live-routes.ts` additions.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`; then `npx playwright test --config
  node_modules/.cache/pw-p15-arena.config.mjs tests/browser/messages.spec.ts tests/browser/read-render.spec.ts` (the live routes
  still serve today's reads); expect PASS.
- [ ] **Step 5: Commit** `feat: read my own Arena and tournament bouts`.

### Task 3: The scene names its origin

**Files:**
- Modify: `src/features/shell/scene-url.ts`, `src/features/shell/useSceneHistory.ts` (`replace`), `src/features/shell/SceneOverlay.tsx`
  (the back label; the solid top bar on a phone; `sceneKeyOf`), `src/features/shell/shell.module.css`, `src/game/bridge.ts`
  (`view-replay` and `view-expedition` carry `from?`), `src/features/arena/ArenaPanel.tsx` (Watch replay: `from: 'arena'`),
  `src/features/character/RosterPanel.tsx` (Watch expedition: `from: 'gladiators'`), `src/features/shell/CampShell.tsx`
  (Everyone's rows open with `from: 'results'`; the origin is opened when a scene closes; `replaceScene` from the hook)
- Test: `tests/domain/scene-url.test.ts`, `tests/browser/scenes.spec.ts`

**Interfaces:**
- Consumes: Patch A Task 8's `SceneView` with `play`.
- Produces:

```ts
export type SceneFrom = 'bouts' | 'bouts-won' | 'bouts-lost' | 'results' | 'arena' | 'notifications' | 'tournaments' | 'gladiators';
export type SceneView =
  | { kind: 'replay'; activityId: string; stageId?: string; from?: SceneFrom }
  | { kind: 'expedition'; activityId: string; play?: 'trip'; from?: SceneFrom }
  | { kind: 'bout'; tournamentId: string; boutId: string; from?: SceneFrom };
export type SceneAddress = SceneView | { kind: SceneView['kind']; activityId: null };
/** The scene's identity without its origin: `replay|<activity>|<stage>`, `expedition|<activity>|<play>`, `bout|<tournament>` (a bracket's bouts are chapters of one scene), `<kind>|null`. */
export function sceneKeyOf(view: SceneAddress): string;
export function backLabel(from: SceneFrom | undefined): 'My bouts' | 'Results' | 'Arena' | 'Notifications' | 'Tournaments' | 'Gladiators' | 'Camp';
export function boutFilterOf(from: SceneFrom | undefined): BoutFilter | null;   // bouts → all, bouts-won → won, bouts-lost → lost
```

- `sceneOf` reads `from` (any other value: none) for every kind, and `view=bout&tournament=<TOURNAMENT_ID>&bout=<TOURNAMENT_BOUT_ID
  starting with that tournament id + ':'>`; a malformed bout address is `{ kind: 'bout', activityId: null }`. `sceneHref` writes
  `from`, `tournament`, `bout` (and Patch A's `play`) and drops the ones the new view lacks; `campHref` drops all of them.
- `useSceneHistory(): { open(view: SceneView): void; replace(view: SceneView): void; close(): void }`; `replace` writes
  `history.replaceState({ [MARK]: markOf(history.state) }, '', sceneHref(location.href, view))`, so the camp entry stays the
  same number of steps back.
- `SceneOverlay`: the back button shows `← {backLabel(from)}` (arrow `aria-hidden`) with the accessible name `Back to
  {label}`; in the touch layout it sits in a `sceneTop` bar, sticky at the top, full width, with an opaque background.
- `CampShell`: when the address goes from a scene with an origin to no scene, it opens that origin if it is not open:
  `bouts*` and `results` → `show('results')` (Task 4 adds the tab and the chip), `arena`, `tournaments`, `gladiators` → that menu
  (`notifications` is Task 7's).

- [ ] **Step 1: Write the failing unit tests** in `tests/domain/scene-url.test.ts`:

```ts
const A = '00000000-0000-4000-8000-000000000001', T = 'tournament:373248:bronze', B = `${T}:3:0`;
const params = (query: string) => new URLSearchParams(query);
it('reads and writes the origin', () => {
  expect(sceneOf(params(`view=replay&activity=${A}&from=bouts-lost`))).toEqual({ kind: 'replay', activityId: A, from: 'bouts-lost' });
  expect(sceneOf(params(`view=replay&activity=${A}&from=elsewhere`))).toEqual({ kind: 'replay', activityId: A });
  expect(sceneHref('http://x/game/?mode=fixture', { kind: 'replay', activityId: A, from: 'arena' })).toBe(`/game/?mode=fixture&view=replay&activity=${A}&from=arena`);
  expect(campHref(`http://x/game/?view=bout&tournament=${T}&bout=${B}&from=tournaments`)).toBe('/game/');
});
it('addresses a tournament bout without an activity', () => {
  expect(sceneOf(params(`view=bout&tournament=${T}&bout=${B}`))).toEqual({ kind: 'bout', tournamentId: T, boutId: B });
  expect(sceneOf(params(`view=bout&tournament=${T}&bout=tournament:1:gold:1:0`))).toEqual({ kind: 'bout', activityId: null });
  expect(sceneHref(`http://x/game/?view=bout&tournament=${T}&bout=${B}`, { kind: 'replay', activityId: A })).toBe(`/game/?view=replay&activity=${A}`);
});
it('names the origin and its chip', () => {
  expect([undefined, 'bouts', 'bouts-won', 'results', 'arena', 'notifications', 'tournaments', 'gladiators'].map(f => backLabel(f as SceneFrom | undefined)))
    .toEqual(['Camp', 'My bouts', 'My bouts', 'Results', 'Arena', 'Notifications', 'Tournaments', 'Gladiators']);
  expect([boutFilterOf('bouts'), boutFilterOf('bouts-won'), boutFilterOf('bouts-lost'), boutFilterOf('arena')]).toEqual(['all', 'won', 'lost', null]);
});
it('keys a scene without its origin, and a bracket without its bout', () => {
  expect(sceneKeyOf({ kind: 'replay', activityId: A, from: 'arena' })).toBe(sceneKeyOf({ kind: 'replay', activityId: A }));
  expect(sceneKeyOf({ kind: 'bout', tournamentId: T, boutId: B })).toBe(sceneKeyOf({ kind: 'bout', tournamentId: T, boutId: `${T}:2:0` }));
});
```

- [ ] **Step 2: Run** `npx vitest run tests/domain/scene-url.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the address, the hook's `replace`, the bridge payloads, the overlay's back button and top bar,
  and the shell's origin rule.
- [ ] **Step 4: Write the browser test** in `scenes.spec.ts`, `'names where the scene goes back to, and opens it after a
  reload'`: fixture; Results' Replay on a bout row opens the scene with a button whose text is `← Results` and name `Back to
  Results`; it returns with Results open; a reload with the scene open still says `← Results`, and Back opens Results; the Arena
  card's Watch replay says `← Arena`; an address without `from` says `← Camp` and opens no menu; `history.length` is one more
  than at the camp while a scene is open. Phone (390 × 844): with the scene scrolled 400 px, the back button's top is ≥ 0, the
  bar spans the viewport width and its computed background alpha is 1. Update the scene specs that read the visible text "Back
  to camp" on a scene button (the name `Back to Camp` still matches their `name: 'Back to camp'` lookups).
- [ ] **Step 5: Run** the unit tests and `npx playwright test --config node_modules/.cache/pw-p15-arena.config.mjs
  tests/browser/scenes.spec.ts tests/browser/arena.spec.ts tests/browser/expedition.spec.ts tests/browser/read-render.spec.ts`;
  expect PASS.
- [ ] **Step 6: Commit** `feat: a scene says where Back goes, and opens it again`.

### Task 4: My bouts in Results

**Files:**
- Create: `src/features/bouts/bout-text.ts`, `src/features/bouts/watched.ts`, `src/features/bouts/bouts-store.ts`,
  `src/features/bouts/BoutRow.tsx`, `src/features/bouts/MyBouts.tsx`, `src/features/bouts/bouts.module.css`
- Modify: `src/features/results/ResultsPanel.tsx` (tabs; Everyone is today's view), `ResultsPanel.module.css`,
  `src/features/shell/CampShell.tsx` (one store per reader and owner; the Results tab and chip as shell state; the origin opens
  them), `src/features/shell/SceneOverlay.tsx` (a player's replay scene marks its activity watched), `tests/browser/shell-helpers.ts`
  (`everyoneResults(page)`: opens Results and selects Everyone)
- Test: `tests/domain/bout-text.test.ts` (new), `tests/domain/my-bouts.test.ts` (new), `tests/domain/results-panel.test.ts`,
  `tests/browser/my-bouts.spec.ts` (new)

**Interfaces:**
- Consumes: Task 2's `MyBout`, `BoutFilter`, `GameGateway.bouts`; Task 3's `SceneFrom`, `boutFilterOf`; `replayKept`,
  `badgeText` (`messages.ts`), `timeOfDay`, `dayText`.
- Produces, `bout-text.ts`:

```ts
export type BoutRowText = { kept: boolean; badge: { letter: 'W' | 'L'; name: 'Won' | 'Lost' } | null; name: string;
  tag: 'NPC' | 'TOURNAMENT' | null; sub: { wide: string; narrow: string }; action: '▶ Watch' | 'Result' | null; label: string };
export function ratingText(delta: number): string;                       // 'Rating +14', 'Rating −13'
export function boutRow(bout: MyBout, nowMs: number | null, clock: ClockMode, timeZone?: string): BoutRowText;
export function dayGroups(bouts: readonly MyBout[], nowMs: number, timeZone?: string): { label: string; bouts: MyBout[] }[];
export function unwatchedCount(bouts: readonly MyBout[], watched: ReadonlySet<string>, nowMs: number | null): number;
export function emptyText(filter: BoutFilter): string;
```

- Produces, `watched.ts`: `WATCHED_KEY = 'cloudiator.bouts-watched.v1'`; `readWatched(): Set<string>`; `markWatched(activityId:
  string, nowMs: number): void` (memory first, marks older than `RULES_V1.retention.replayMs` dropped, newest 200 kept, then
  stored, then listeners); `subscribeWatched(listener: () => void): () => void` (also the `storage` event for the key);
  `useWatched(): ReadonlySet<string>` (`useSyncExternalStore`, a stable set per change).
- Produces, `bouts-store.ts`:

```ts
export type BoutList = { rows: readonly MyBout[]; nextCursor: string | null; status: 'idle' | 'loading' | 'ready' | 'failed';
  loadingMore: boolean; moreFailed: boolean };
export type BoutsStore = {
  list(filter: BoutFilter): BoutList;
  load(filter: BoutFilter): void;          // the first page, unless loaded or loading
  more(filter: BoutFilter): Promise<boolean>; // true only for an applied page; rows kept on failure (Task 6 amendment)
  reload(): void;                          // every list read again; pages of older reads are dropped
  subscribe(listener: () => void): () => void;
};
export function createBoutsStore(reads: Pick<GameGateway, 'bouts'>): BoutsStore;
export function useBoutList(store: BoutsStore, filter: BoutFilter): BoutList;   // loads on first use
```

- Produces, views: `BoutRow({ text, watched, onOpen }: { text: BoutRowText; watched: boolean; onOpen(): void })` (the badge,
  the dot when kept and not watched, the name and tag, the wide and narrow sub-lines, the button named `text.label`);
  `MyBouts({ store, filter, onFilter, nowMs, onOpen }: { store: BoutsStore; filter: BoutFilter; onFilter(f: BoutFilter): void;
  nowMs: number | null; onOpen(bout: MyBout): void })`; `ResultsPanel` gains `bouts: BoutsStore | null` (null: Everyone only,
  no tabs), `view: 'mine' | 'everyone'`, `onView(view)`, `filter: BoutFilter`, `onFilter(filter)`, `onWatchBout(bout: MyBout,
  filter: BoutFilter)`. The tabs are ARIA tabs (arrow keys, Home, End), as the messages panel's.
- Rules: `boutRow` per spec 1 (kept by `replayKept(expiry, nowMs)`; null `nowMs`: the kept form with no button); the narrow
  sub-line drops a leading "Arena" or "Tournament" part; `label` is `"{Watch|Result}: {name}, {dayText}, {time}"`. A row opens
  `{ kind: 'replay', activityId, from: 'bouts' | 'bouts-won' | 'bouts-lost' }`. `MyBouts` calls `store.reload()` when it mounts
  (Results reads once each time it opens). The shell keeps `{ view, filter }` (reset to `{ 'mine', 'all' }` when the owner
  changes) and the origin rule sets them (`results` → Everyone, `bouts*` → My bouts with `boutFilterOf`). `SceneOverlay` marks
  `markWatched(activityId, clock.now())` whenever a player's replay scene shows an activity (so each later step marks its bout).

- [ ] **Step 1: Write the failing unit tests.** `tests/domain/bout-text.test.ts` (`NOW = Date.UTC(2026, 9, 10, 4, 0)`; `bout()`
  an Arena victory fought at `Date.UTC(2026, 9, 10, 3, 0)`, renown 10, rating 14, kept, vs Varro):

```ts
it('writes a kept bout as the mockup does', () => {
  expect(boutRow(bout(), NOW, '12', 'UTC')).toEqual({ kept: true, badge: { letter: 'W', name: 'Won' }, name: 'vs Varro', tag: null,
    sub: { wide: 'Arena · 3:00\xA0AM · +10 renown · Rating +14', narrow: '3:00\xA0AM · +10 renown · Rating +14' },
    action: '▶ Watch', label: 'Watch: vs Varro, Sat 10 Oct, 3:00\xA0AM' });
  expect(boutRow(bout(), NOW, '24', 'UTC').sub.wide).toBe('Arena · 03:00 · +10 renown · Rating +14');
});
it('says a loss, a tie-break, an NPC and leaves out zero parts', () => {
  expect(boutRow(bout({ result: 'defeat', renown: 2, ratingDelta: -13, tieBreak: true, opponent: { name: 'Cassia', npc: false } }), NOW, '12', 'UTC'))
    .toMatchObject({ badge: { letter: 'L', name: 'Lost' }, sub: { wide: 'Arena · 3:00\xA0AM · lost on a tie-break · +2 renown · Rating −13' } });
  expect(boutRow(bout({ tieBreak: true }), NOW, '12', 'UTC').sub.wide).toContain('· won on a tie-break ·');
  expect(boutRow(bout({ opponent: { name: 'Iron Warden', npc: true }, renown: 3, ratingDelta: null }), NOW, '12', 'UTC'))
    .toMatchObject({ name: 'vs Iron Warden', tag: 'NPC', sub: { wide: 'Arena · 3:00\xA0AM · +3 renown' } });
  expect(boutRow(bout({ renown: 0, ratingDelta: 0 }), NOW, '12', 'UTC').sub.wide).toBe('Arena · 3:00\xA0AM');
});
it('starts a tournament row with its round', () => {
  expect(boutRow(bout({ kind: 'tournament', round: 'Final', renown: 60, ratingDelta: 16 }), NOW, '12', 'UTC'))
    .toMatchObject({ tag: 'TOURNAMENT', sub: { wide: 'Final · 3:00\xA0AM · +60 renown · Rating +16', narrow: 'Final · 3:00\xA0AM · +60 renown · Rating +16' } });
  expect(boutRow(bout({ kind: 'tournament', round: null }), NOW, '12', 'UTC').sub.narrow).toBe('3:00\xA0AM · +10 renown · Rating +14');
});
it('dims a bout whose replay is gone, by the server’s time, and names no opponent', () => {
  const gone = boutRow(bout({ replayExpiry: { state: 'expired' } }), NOW, '12', 'UTC');
  expect(gone).toMatchObject({ kept: false, name: 'Arena bout', tag: null, action: 'Result', badge: { letter: 'W', name: 'Won' },
    sub: { wide: '3:00\xA0AM · replay no longer kept', narrow: '3:00\xA0AM · replay no longer kept' }, label: 'Result: Arena bout, Sat 10 Oct, 3:00\xA0AM' });
  const at = bout({ replayExpiry: { state: 'available', expiresAtMs: NOW } });
  expect(boutRow(at, NOW - 1, '12', 'UTC').kept).toBe(true);
  expect(boutRow(at, NOW, '12', 'UTC').kept).toBe(false);
  expect(boutRow(bout(), null, '12', 'UTC').action).toBeNull();
  expect(boutRow(bout({ opponent: null }), NOW, '12', 'UTC').name).toBe('Arena bout');
});
it('groups by day, today first', () => {
  expect(dayGroups([bout(), bout({ activityId: 'b', foughtAtMs: Date.UTC(2026, 9, 10, 1) }), bout({ activityId: 'c', foughtAtMs: Date.UTC(2026, 9, 9, 23) })], NOW, 'UTC')
    .map(g => [g.label, g.bouts.length])).toEqual([['TODAY · SAT 10 OCT', 2], ['FRI 9 OCT', 1]]);
});
it('counts the kept bouts not watched, and says an empty list', () => {
  expect(unwatchedCount([bout(), bout({ activityId: 'b' }), bout({ activityId: 'c', replayExpiry: { state: 'expired' } })], new Set(['b']), NOW)).toBe(1);
  expect([emptyText('all'), emptyText('won'), emptyText('lost')]).toEqual(['No bouts yet. Your Arena and tournament bouts show here with their replays.',
    'No won bouts yet.', 'No lost bouts yet.']);
});
```

  `tests/domain/my-bouts.test.ts` (fresh module per storage test, `throwingStorage` as `time-format.test.ts` does; a fake
  `bouts` whose pages are deferred promises):

```ts
it('reads a list on first use, pages with More, never lists a bout twice', async () => { /* load('all') → 20 rows, cursor;
  more('all') → the next page with one repeated id: 39 rows; list('won') is still 'idle' */ });
it('lands only the latest read: a reload drops the page of the read before it', async () => {
  const store = createBoutsStore(fake); store.load('all'); store.reload();
  first.resolve(page(['old'])); second.resolve(page(['new'])); await settle();
  expect(store.list('all').rows.map(b => b.activityId)).toEqual(['new']);
});
it('keeps the rows and says so when More fails', async () => { /* status ready, moreFailed true, rows unchanged */ });
it('remembers watched bouts on this device, for 7 days and 200 bouts', async () => {
  const w = await fresh(); w.markWatched('a', T); w.markWatched('b', T + 8 * DAY);
  expect([...w.readWatched()]).toEqual(['b']);
  expect(JSON.parse(store.get('cloudiator.bouts-watched.v1')!)).toEqual([['b', T + 8 * DAY]]);
  for (let i = 0; i < 201; i++) w.markWatched(`id-${i}`, T + 8 * DAY);
  expect(w.readWatched().size).toBe(200);
});
it('keeps marks in memory when storage throws', async () => {
  throwingStorage(); const w = await fresh();
  expect(() => w.markWatched('a', T)).not.toThrow(); expect(w.readWatched().has('a')).toBe(true);
});
```

  In `results-panel.test.ts`: `'shows Everyone alone to a visitor, and the tabs to a player'` (no `bouts`: no `role="tablist"`,
  "RECENT RESULTS" as today; with a store and view `everyone`: two tabs, Everyone selected, today's rows).
- [ ] **Step 2: Run** `npx vitest run tests/domain/bout-text.test.ts tests/domain/my-bouts.test.ts tests/domain/results-panel.test.ts`;
  expect FAIL.
- [ ] **Step 3: Implement** the words, the marks, the store, the row, My bouts, the tabs and the shell wiring.
- [ ] **Step 4: Write the browser tests** `tests/browser/my-bouts.spec.ts` (fixture, `Etc/GMT-3`, the Fixture reference):
  - `'opens Results on My bouts, by day, with the result, the opponent and the rating'`: the tab "My bouts" is selected and named
    `My bouts, 5 not watched`; the line `Replays are kept 7 days · ● not watched yet`; the group eyebrows and each row's name and
    sub-line as in the table; five gold dots; the three dimmed rows offer `Result`.
  - `'filters Won and Lost'`: Lost lists Cassia, Bronze Sentinel, Arena bout, Tournament bout; Won lists Varro, Iron Warden,
    Severus, Tournament bout; the chip shows `aria-pressed="true"`.
  - `'Everyone is today’s list one tab away, and a visitor sees only Everyone'` (`as=visitor`: no tablist).
  - `'Watch opens the bout with ← My bouts and marks it watched on this device'`: ▶ Watch on Varro opens the scene with `← My
    bouts` and `&from=bouts`; Back shows Results on My bouts, named `My bouts, 4 not watched`, Varro without a dot; after a reload
    the same, and `cloudiator.bouts-watched.v1` holds Varro's activity id. From Lost the address says `from=bouts-lost`, and a
    reload of the scene then Back opens Results on My bouts with Lost pressed.
  - `'Result opens the saved outcome of a bout whose replay is gone'`.
  - `'keeps working when storage throws'`: an init script makes `getItem` and `setItem` throw; Watch then Back removes Varro's
    dot for the page's life; no `pageerror`.
  - `'phone: tabs, chips and rows fit the sheet'`: at 390 × 844 the sub-lines lack the leading `Arena · `; at 360 × 740
    `noHorizontalScroll` and every row button at least 44 px high.
- [ ] **Step 5: Run** the unit tests and `my-bouts.spec.ts`; expect PASS. Then the whole browser suite with the private config;
  where a player's test reads Everyone (`RECENT RESULTS`, `Replay:` buttons), open it with `everyoneResults(page)` and rerun.
- [ ] **Step 6: Commit** `feat: My bouts in Results`.

### Task 5: The replay viewer: the bar, the result on the arena, no spoiler

**Files:**
- Create: `src/lib/replay-speed.ts`
- Modify: `src/game/replay.ts` (speeds), `src/features/arena/BattleReplay.tsx` (eyebrow, `ReplayBar`, keys, speed, end card,
  chapters on the bar, phone folds, focus, test hook), `src/features/arena/BattleReplay.module.css`, `src/features/bouts/bout-text.ts`
  (viewer words), `src/features/shell/SceneOverlay.tsx` (passes `takeFocus` and `back`); the existing specs that name the old
  controls: `tests/browser/replay.spec.ts`, `scenes.spec.ts`, `release.spec.ts`, `arena.spec.ts`, `retention.spec.ts`,
  `read-render.spec.ts`, `tournament.spec.ts`, `tests/performance/fps.spec.ts`
- Test: `tests/domain/replay.test.ts`, `tests/domain/replay-speed.test.ts` (new), `tests/domain/bout-text.test.ts`,
  `tests/browser/viewer.spec.ts` (new)

**Interfaces:**
- Consumes: Task 1's `ReplayBar`; Patch A's `clockText`; Task 3's `backLabel`; Task 4's `ratingText`; `tournamentRound`;
  `COMPACT_QUERY`.
- Produces:
  - `replay.ts`: `REPLAY_SPEEDS = { normal: 1, double: 2, fast: 4 } as const`; `nextSpeed(speed: ReplaySpeed): ReplaySpeed`
    (normal → double → fast → normal).
  - `replay-speed.ts`: `SPEED_KEY = 'cloudiator.replay-speed.v1'`; `readReplaySpeed(): ReplaySpeed` (a stored `'1' | '2' | '4'`,
    else this page's choice, else `'normal'`); `saveReplaySpeed(speed: ReplaySpeed): void`.
  - `bout-text.ts`: `boutEyebrow(stage: RevealedStage, options: { npc: boolean; league: LeagueId | null; compact: boolean },
    clock: ClockMode, timeZone?: string): string`; `chapterLabel(stage: RevealedStage): string` (the tournament round, else an
    encounter's label, else `'Bout'`); `verdictText(log: BattleLog, compact: boolean): { verdict: string; reason: string }`;
    `rewardChips(summary: ActivitySummary | null, options: { fighter: boolean; npc: boolean; kind: 'arena' | 'tournament' |
    'expedition'; last: boolean }): string[]`; `nextLabel(opponent: string | null, compact: boolean): string`;
    `againLabel(compact: boolean): string`; `RESULT_HINT = 'The result appears when the fight ends, or now with ⚑ Result.'`.
  - `BattleReplay` props (replacing the "Encounters" group): `chapters?: { labels: readonly string[]; current: number;
    select(index: number): void } | null`; `nav?: ReplayNav | null`; `back?: { label: string; go(): void } | null`;
    `takeFocus?: boolean`; `league?: LeagueId | null`, where

```ts
export type ReplayNav = {
  previous: (() => void) | null;                                            // null: ⏮ disabled
  next: { opponent: string | null; upNext: { wide: string; narrow: string } | null; go(): void } | null;  // null: ⏭ disabled, the end card shows `back`
  counter: { wide: string; narrow: string } | null;
};
```

    Without `nav` and without chapters, ⏮ and ⏭ are not rendered. `ActivityReplay` builds a chapters-only `nav` for an activity
    with several bouts and accepts `takeFocus` and `back`; `SceneOverlay` passes `takeFocus` and `back: { label:
    backLabel(from), go: onClose }`. The replay page passes neither (its end card: ↺ Watch again only).
  - `ReplayTestHook.state()` gains `endCard: boolean; chapter: number; chapters: number`; `speed` may be `'double'`.
- Behaviour: the bar per spec 2 (track `<input type="range" aria-label="Replay position">` updated by the animation frame as
  today; time `clockText(position) + ' / ' + clockText(endMs)`; tail: the speed button showing `1×` named `Speed 1×`, title
  `Speed (F)`, and `⚑ Result` named `Skip to the result`, title `Skip to the result (End)`); keys per spec 2 (← → seek by 5000
  ms, also on the track); the controller starts at `readReplaySpeed()` and the speed button saves; the end card shows while
  `positionMs >= endMs` (after the outro), desktop eyebrow "RESULT"; the Restart, Fast ×4 and Skip to result buttons and the
  key line go; in the touch layout Fighters and Combat log are closed `<details>` named "Fighters at the start" and "Combat
  log"; with `takeFocus`, once loaded, ⏸ takes the focus if it is on the scene's back button or the body.

- [ ] **Step 1: Write the failing unit tests.** `replay.test.ts`: `nextSpeed` cycles; a controller at `'double'` ticked 1000
  ms is at 2000. `replay-speed.test.ts`: remembers `'2'`, ignores `'3'`, keeps the choice in memory when storage throws.
  `bout-text.test.ts`:

```ts
const at = Date.UTC(2026, 9, 10, 3, 0), fri = Date.UTC(2026, 9, 9, 23, 0);
it('writes the eyebrow from the kind and the time, never the stage label', () => {
  expect(boutEyebrow(boutStage(at, 'Bout: victory'), { npc: false, league: null, compact: false }, '12', 'UTC')).toBe('ARENA · SAT 10 OCT, 3:00\xA0AM');
  expect(boutEyebrow(boutStage(fri, 'Bout: defeat'), { npc: true, league: null, compact: false }, '12', 'UTC')).toBe('ARENA · FRI 9 OCT, 11:00\xA0PM · NPC OPPONENT');
  expect(boutEyebrow(boutStage(at, 'Bout: victory'), { npc: false, league: null, compact: true }, '12', 'UTC')).toBe('ARENA · SAT 3:00\xA0AM');
  expect(boutEyebrow(boutStage(fri, 'Bout: victory'), { npc: true, league: null, compact: true }, '12', 'UTC')).toBe('ARENA · FRI 11:00\xA0PM · NPC');
  expect(boutEyebrow(boutStage(at, 'Bout: victory'), { npc: false, league: null, compact: false }, '24', 'UTC')).toBe('ARENA · SAT 10 OCT, 03:00');
  expect(boutEyebrow(boutStage(at, 'Final: defeat'), { npc: false, league: 'bronze', compact: false }, '12', 'UTC')).toBe('TOURNAMENT · BRONZE · FINAL');
  expect(boutEyebrow(boutStage(at, 'Final: defeat'), { npc: false, league: null, compact: false }, '12', 'UTC')).toBe('TOURNAMENT · FINAL');
  expect(boutEyebrow(encounterStage('Encounter 1: Dire Wolf'), { npc: false, league: null, compact: false }, '12', 'UTC')).toBe('Expedition · Encounter 1: Dire Wolf');
  expect(chapterLabel(boutStage(at, 'Quarterfinal: victory'))).toBe('Quarterfinal');
});
it('says who won and why', () => {
  expect(verdictText(LOGS.ownerHumanWin, false)).toEqual({ verdict: 'Aster wins', reason: 'Varro is defeated.' });
  expect(verdictText(LOGS.ownerTieBreak, false).reason).toBe('Both fell at the same moment; a seeded tie-break chose Aster.');
  expect(verdictText(LOGS.ownerTieBreak, true).reason).toBe('A tie-break chose Aster.');
  // time-out endings: 'Time ran out and Aster kept more health.', 'Time ran out with equal health; a seeded tie-break chose Aster.'
});
it('lists the credited rewards as chips', () => {
  expect(rewardChips(summary({ renown: 10, ratingDelta: 14 }), { fighter: true, npc: false, kind: 'arena', last: true })).toEqual(['+10 renown', 'Rating +14']);
  expect(rewardChips(summary({ renown: 3 }), { fighter: true, npc: true, kind: 'arena', last: true })).toEqual(['+3 renown', 'NPC: no rating change']);
  expect(rewardChips(summary({ renown: 60, money: 100, ratingDelta: 16 }), { fighter: true, npc: false, kind: 'tournament', last: true })).toEqual(['+60 renown', '+100 gold', 'Rating +16']);
  expect(rewardChips(summary({ renown: 60 }), { fighter: true, npc: false, kind: 'tournament', last: false })).toEqual([]);
  expect(rewardChips(null, { fighter: true, npc: false, kind: 'arena', last: true })).toEqual(['Rewards are credited when the bout settles']);
  expect(rewardChips(null, { fighter: true, npc: false, kind: 'tournament', last: true })).toEqual(['Rewards are credited when the tournament settles']);
  expect(rewardChips(null, { fighter: false, npc: false, kind: 'arena', last: true })).toEqual([]);
});
it('names the end card’s buttons', () => {
  expect([nextLabel('Cassia', false), nextLabel('Cassia', true), nextLabel(null, false), againLabel(false), againLabel(true)])
    .toEqual(['▶ Next bout · vs Cassia', '▶ Next · vs Cassia', '▶ Next bout', '↺ Watch again', '↺ Again']);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/domain/replay.test.ts tests/domain/replay-speed.test.ts tests/domain/bout-text.test.ts`;
  expect FAIL.
- [ ] **Step 3: Implement** the speeds, the device key, the words and the viewer.
- [ ] **Step 4: Write the browser tests** `tests/browser/viewer.spec.ts` (fixture, `Etc/GMT-3`):
  - `'plays a bout with the replay bar, focused on Pause, and remembers the speed'`: My bouts ▶ Watch on Varro; the eyebrow
    `ARENA · SAT 10 OCT, 2:40 AM`; Pause is focused once `__cloudiatorReplay.state()` exists; the bar's buttons Pause (`K
    Space`), Speed 1× (`F`), Skip to the result (`End`); the time matches `/^0:\d\d \/ 0:\d\d$/`; three presses of Speed read
    2×, 4×, 1×; with 4× set, Back, then ▶ Watch on Cassia: the hook's speed is `'fast'` and `cloudiator.replay-speed.v1` is `'4'`.
  - `'ends on the result card over the arena, and Watch again plays it again'`: ⚑ Result shows the card inside the canvas's box
    with `RESULT`, `Aster wins`, `Varro is defeated.`, chips `+10 renown` and `Rating +13`; ↺ Watch again hides it, `playing`
    true, `positionMs` < 1000; the Result card below reads `RESULT_HINT` before the end.
  - `'the keys'`: K toggles; paused at 0, ArrowRight gives 5000 and ArrowLeft 0; End shows the card; R restarts; the text
    `Keys:` is nowhere.
  - `'never shows the result before the end'` (Review Focus 4): Cassia's bout (stage label `Bout: defeat`) while playing: the
    scene's text and every `title`/`aria-label` in it match neither `/victory|defeat/i` nor `Cassia wins`; after End the card says
    `Cassia wins`.
  - `'steps an expedition’s encounters as chapters'`: `/game/?mode=fixture&view=replay&activity=<REPLAY_FIXTURES.expedition>`
    shows three chapter buttons with today's encounter labels; ⏭ selects the second and plays it; `history.length` unchanged.
  - `'phone: who won without scrolling, a bar of at most 100 px, folded details'`: 390 × 844, ⚑ Result: the card's verdict box
    ends above 844 with the scene's `scrollTop` 0; the bar's height ≤ 100; `Fighters at the start` and `Combat log` are closed
    `details`; at 360 × 740 `noHorizontalScroll`.
  - `'keeps the speed for the page when storage throws'`.
  Update the existing specs: `Skip to result` → `Skip to the result`; `Fast ×4` → the speed button (two presses for
  `'fast'`); `Restart` → the R key or ↺ Watch again; a replay scene's focus checks wait for the replay and expect Pause (Escape
  still returns the focus to the opener); the 360 px button list in `replay.spec.ts` becomes Pause, Speed 1×, Skip to the
  result.
- [ ] **Step 5: Run** the unit tests, `viewer.spec.ts` and the updated specs (`replay`, `scenes`, `release`, `arena`,
  `retention`, `read-render`, `tournament`); expect PASS.
- [ ] **Step 6: Commit** `feat: the replay bar, the result on the arena, and no spoiler in the header`.

### Task 6: Next bout: the queue

Controller amendment (2026-11-01): `BoutsStore.more(filter)` and `ReplayQueue.more()` return `Promise<boolean>`.
True means that invocation applied a valid page, including terminal duplicate pagination; false means no-op, failure or
invalidation. Read the current list after true and revalidate the active owner/filter/activity/chapter before stepping.

**Files:**
- Create: `src/features/bouts/bout-queue.ts`
- Modify: `src/features/arena/BattleReplay.tsx` (`ActivityReplay` takes a queue and builds `nav`; the up-next line; the
  counter), `src/features/shell/SceneOverlay.tsx` (`bouts: BoutsStore | null`, `onReplace(view: SceneView)`; builds the queue
  for a player's replay scene), `src/features/shell/CampShell.tsx` (passes the store and `replaceScene`), `src/features/bouts/bout-text.ts`
- Test: `tests/domain/bout-queue.test.ts` (new), `tests/domain/bout-text.test.ts`, `tests/browser/viewer.spec.ts`

**Interfaces:**
- Consumes: Task 4's `BoutsStore`, `BoutList`, `MyBout`; Task 3's `boutFilterOf`, `replace`; Task 5's `ReplayNav`.
- Produces:

```ts
export type ReplayQueue = {
  filter: BoutFilter; list: BoutList; ownerName: string;
  /** The owner's current activity: an own bout not settled yet. */
  currentActivityId: string | null;
  open(activityId: string): void; more(): Promise<boolean>;
};
export type QueueEntries = { entries: readonly MyBout[]; index: number; more: boolean };
/** The kept replays of a ready list, with `current` first when it is own but not listed yet; null when the list is not ready. */
export function queueEntries(list: BoutList, current: string, nowMs: number): QueueEntries | null;
export type StepTarget = { kind: 'chapter'; index: number } | { kind: 'bout'; activityId: string } | { kind: 'more' };
export function nextTarget(chapter: number, chapters: number, queue: QueueEntries | null): StepTarget | null;
export function previousTarget(chapter: number, queue: QueueEntries | null): StepTarget | null;
```

  `bout-text.ts`: `counterText(queue: QueueEntries): { wide: string; narrow: string }`; `upNextText(next: { a: string; b: string |
  null; kind: 'arena' | 'tournament'; foughtAtMs: number } | { a: string; b: string; chapter: string }, clock: ClockMode,
  timeZone?: string): { wide: string; narrow: string }`. `ActivityReplay` prop `queue?: ReplayQueue | null`; `ReplayTestHook`
  gains `queue(): { index: number; count: number; more: boolean; next: string | null; previous: string | null } | null`.
- Rules: the queue exists only for the viewer's own bout (the timeline carries the owner's summary, or its id is
  `queue.currentActivityId`); its filter is `boutFilterOf(from) ?? 'all'`; the up-next line covers a next chapter (from its log)
  and a next bout (from its row, `ownerName` vs its opponent). A step to another bout calls `queue.open(id)`, which
  `SceneOverlay` turns into `onReplace({ kind: 'replay', activityId: id, from })`; `more` reads the next page, then steps. The
  new bout opens playing with ⏸ focused (Task 5's rule: the remount puts the focus on back first).

- [ ] **Step 1: Write the failing unit tests** `tests/domain/bout-queue.test.ts`:

```ts
const list = (ids: string[], over: Partial<BoutList> = {}): BoutList => ({ rows: ids.map(id => bout({ activityId: id })), nextCursor: null, status: 'ready', loadingMore: false, moreFailed: false, ...over });
it('queues the kept replays, with an own bout not listed yet first', () => {
  const l = list(['a', 'b', 'c']); (l.rows[1] as MyBout).replayExpiry = { state: 'expired' };
  expect(queueEntries(l, 'c', NOW)).toMatchObject({ index: 1, more: false });
  expect(queueEntries(l, 'c', NOW)!.entries.map(e => e.activityId)).toEqual(['a', 'c']);
  expect(queueEntries(l, 'new', NOW)!.entries.map(e => e.activityId)).toEqual(['new', 'a', 'c']);
  expect(queueEntries(list([], { status: 'loading' }), 'a', NOW)).toBeNull();
});
it('steps through the chapters first, then the list, then the next page', () => {
  const q = queueEntries(list(['a', 'b']), 'a', NOW)!;
  expect(nextTarget(0, 3, q)).toEqual({ kind: 'chapter', index: 1 });
  expect(nextTarget(2, 3, q)).toEqual({ kind: 'bout', activityId: 'b' });
  expect(nextTarget(0, 1, queueEntries(list(['a'], { nextCursor: '9' }), 'a', NOW))).toEqual({ kind: 'more' });
  expect(nextTarget(0, 1, queueEntries(list(['a']), 'a', NOW))).toBeNull();
  expect(previousTarget(1, q)).toEqual({ kind: 'chapter', index: 0 });
  expect(previousTarget(0, queueEntries(list(['a', 'b']), 'b', NOW))).toEqual({ kind: 'bout', activityId: 'a' });
  expect(previousTarget(0, null)).toBeNull();
});
```

  In `bout-text.test.ts`: `counterText({ entries: five, index: 0, more: false })` is `{ wide: 'Bout 1 of 5 in My bouts', narrow:
  '1 / 5' }`, with `more: true` and 20 entries at index 19 `{ wide: 'Bout 20 of 20+ in My bouts', narrow: '20 / 20+' }`;
  `upNextText({ a: 'Aster', b: 'Cassia', kind: 'arena', foughtAtMs: Date.UTC(2026, 9, 10, 0, 20) }, '12', 'UTC')` is `{ wide:
  'Aster vs Cassia · Arena · Sat 10 Oct, 12:20\xA0AM', narrow: 'Aster vs Cassia · Sat 12:20\xA0AM' }`; a chapter `{ a: 'Aster',
  b: 'Varro', chapter: 'Semifinal' }` gives `'Aster vs Varro · Semifinal'` for both.
- [ ] **Step 2: Run** `npx vitest run tests/domain/bout-queue.test.ts tests/domain/bout-text.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the queue, the nav, the up-next line ("UP NEXT" eyebrow; "⏭ Next bout" button on desktop), the
  counter and the overlay's wiring.
- [ ] **Step 4: Add the browser tests** to `viewer.spec.ts`:
  - `'walks My bouts with ⏭ and Next bout, and one Back returns to the list'` (Review Focus 3): ▶ Watch on Varro: `Bout 1 of 5 in
    My bouts` and `UP NEXT` `Aster vs Cassia · Arena · Sat 10 Oct, 1:20 AM`; ⏭ shows Cassia (`Bout 2 of 5`) playing with Pause
    focused; at its end the card's `▶ Next bout · vs Iron Warden` opens Iron Warden; `history.length` is what it was after the
    first open; one `← My bouts` shows Results with All pressed; the same walk then the browser's Back also lands on the camp in
    one step.
  - `'follows the chip: Lost walks only the losses'`: Lost, ▶ Watch on Cassia: `Bout 1 of 2`; ⏭ Bronze Sentinel; ⏭ disabled and
    the end card shows `← My bouts`; a reload keeps `Bout 2 of 2 in My bouts`, and Back opens Results with Lost pressed.
  - `'someone else’s bout has no ⏮ ⏭ and no counter'`: the address of `ARENA_ACTIVITIES.varroSpectator`.
  - `'phone: 1 / 5 and the up-next line without its button'` (390 × 844).
- [ ] **Step 5: Run** the unit tests and `viewer.spec.ts`, `scenes.spec.ts`, `my-bouts.spec.ts`; expect PASS.
- [ ] **Step 6: Commit** `feat: next bout, up next and the bout counter`.

### Task 7: Watch from Notifications and the Arena menu

**Files:**
- Modify: `src/features/messages/messages.ts` (`MessagingActions.watch`), `src/features/messages/notifications.ts` (`watchLabel`),
  `src/features/messages/MessagesPanel.tsx` (the buttons; `initialTab`), `src/features/messages/MessagesButton.tsx`,
  `src/features/messages/messages.module.css`, `src/features/shell/CornerChip.tsx` (`messagesRequest`; Watch closes the
  popover first), `src/features/shell/CampShell.tsx` (the watch mapping; the `notifications` origin), `src/features/arena/ArenaPanel.tsx`
  and `ArenaMenu.tsx` (`RecentBouts`), `src/features/arena/ArenaPanel.module.css`, `src/features/bouts/bout-text.ts` (`recentRow`)
- Test: `tests/features/notifications.test.ts`, `tests/domain/arena-panels.test.ts`, `tests/domain/bout-text.test.ts`,
  `tests/browser/messages.spec.ts`, `tests/browser/my-bouts.spec.ts`

**Interfaces:**
- Consumes: Task 3's scenes and origin rule; Task 4's store, `BoutRow`, `useWatched`; Patch A Task 8's `play: 'trip'`.
- Produces: `MessagingActions.watch?: { kept(note: GameNotification): boolean; open(note: GameNotification): void }`;
  `watchLabel(note: GameNotification): { wide: string; narrow: string; name: string } | null`; `MessagesPanel` prop `initialTab?:
  'messages' | 'notifications'`; `CornerChip` prop `messagesRequest?: { tab: 'notifications'; n: number } | null` (each new `n`
  opens the panel on that tab with the focus on the tab); `recentRow(bout: MyBout, nowMs: number | null, clock: ClockMode,
  timeZone?: string): BoutRowText`; `RecentBoutsView({ rows, watched, nowMs, onWatch, onAll }: { rows: readonly MyBout[];
  watched: ReadonlySet<string>; nowMs: number | null; onWatch(bout: MyBout): void; onAll(): void })`; `ArenaPanel` and `ArenaMenu`
  props `bouts?: BoutsStore | null; onWatchBout?(bout: MyBout): void; onAllBouts?(): void`.
- Rules: `kept` is `replayKept(note.summary.replayExpiry, clock.now())` once the display clock has the server's time (else
  false). `open`: arena and tournament → `{ kind: 'replay', activityId, from: 'notifications' }`; expedition → `{ kind:
  'expedition', activityId, play: 'trip', from: 'notifications' }`. The `notifications` origin raises `messagesRequest`. The
  Arena menu shows the first three rows of `useBoutList(store, 'all')` under "Your arena bout", above the samples; rows open
  with `from: 'arena'`; "All my bouts in Results →" sets the Results tab to My bouts, the chip to All, and opens Results.

- [ ] **Step 1: Write the failing unit tests.** `notifications.test.ts`:

```ts
expect(watchLabel(arenaNote)).toEqual({ wide: '▶ Watch', narrow: '▶ Watch', name: 'Watch: Arena victory' });
expect(watchLabel(tournamentNote)!.name).toBe('Watch: Tournament defeat');
expect(watchLabel(outpostNote)).toEqual({ wide: '▶ Watch the trip', narrow: '▶ The trip', name: 'Watch the trip: Expedition victory: Ruined Outpost' });
expect(watchLabel(trainingNote)).toBeNull();
```

  `bout-text.test.ts` (`NOW` Sat 10 Oct 04:00 UTC, zone UTC):

```ts
expect(recentRow(bout(), NOW, '12', 'UTC').sub).toEqual({ wide: 'Today, 3:00\xA0AM · Rating +14', narrow: 'Today, 3:00\xA0AM · Rating +14' });
expect(recentRow(bout({ ratingDelta: null, renown: 0, tieBreak: true }), NOW, '12', 'UTC').sub).toEqual({ wide: 'Today, 3:00\xA0AM · won on a tie-break', narrow: 'Today, 3:00\xA0AM · tie-break' });
expect(recentRow(bout({ foughtAtMs: Date.UTC(2026, 9, 9, 23), ratingDelta: null, renown: 3, opponent: { name: 'Iron Warden', npc: true } }), NOW, '12', 'UTC').sub.wide).toBe('Fri, 11:00\xA0PM · +3 renown');
expect(recentRow(bout({ foughtAtMs: Date.UTC(2026, 9, 3, 19), ratingDelta: 0, renown: 0 }), NOW, '12', 'UTC').sub.wide).toBe('Sat 3 Oct, 7:00\xA0PM');
expect(recentRow(bout({ replayExpiry: { state: 'expired' } }), NOW, '12', 'UTC').sub.wide).toBe('Today, 3:00\xA0AM · replay no longer kept');
```

  `arena-panels.test.ts`: `RecentBoutsView` with three rows renders `YOUR RECENT BOUTS`, the three names in order, three `▶
  Watch`, and `All my bouts in Results →` (narrow `All my bouts →`); with no rows it renders nothing.
- [ ] **Step 2: Run** `npx vitest run tests/features/notifications.test.ts tests/domain/bout-text.test.ts tests/domain/arena-panels.test.ts`;
  expect FAIL.
- [ ] **Step 3: Implement** the buttons, the panel request, the shell mapping and the Arena menu section.
- [ ] **Step 4: Add the browser tests.** `messages.spec.ts` (live-routed owner Aster: an Arena victory and a tournament defeat
  with kept replays and their timelines, an expedition with a kept replay and its timeline, an Arena result whose replay is
  gone, a training): `'offers ▶ Watch on kept bouts and ▶ Watch the trip on expeditions, and returns to Notifications'` (Watch
  on the Arena card closes the panel and opens the scene with `← Notifications` and `Bout 1 of …`; Back shows the panel open on
  Notifications with that tab focused; the expired one and the training have no button; Watch the trip opens
  `view=expedition&…&play=trip&from=notifications` with Patch A's `▶ REPLAY · THE WHOLE TRIP`); `'phone: ▶ The trip, and it
  fits'` (390 × 844; 360 × 740 `noHorizontalScroll`). `my-bouts.spec.ts`: `'the Arena menu lists my three latest bouts and
  links to all of them'` (the rows Varro, Cassia, Iron Warden with `Today, 2:40 AM · Rating +13`, `Today, 1:20 AM · Rating
  −13`, `Today, 12:00 AM · +3 renown`; ▶ Watch opens `← Arena` with `Bout 1 of 5 in My bouts`; Back shows the Arena menu; `All
  my bouts in Results →` opens Results on My bouts with All pressed).
- [ ] **Step 5: Run** the unit tests and `messages.spec.ts`, `my-bouts.spec.ts`, `arena.spec.ts`; expect PASS.
- [ ] **Step 6: Commit** `feat: watch a bout from Notifications and the Arena menu`.

### Task 8: The camp button after an Arena bout

**Files:**
- Modify: Patch A's `src/features/shell/away-trip.ts` (the `bout` state), `src/features/shell/AwayButton.tsx` (⚔ and the bout's
  action), `src/features/shell/useAwayTrip.ts` (the bout's candidate and timeline read; the newer state wins),
  `src/features/shell/CampShell.tsx` (passes the shared display clock to the existing hook)
- Test: Patch A's `tests/domain/away-trip.test.ts` and `tests/browser/away-button.spec.ts`

**Interfaces:**
- Consumes: Patch A Task 11's `AwayState`, `awayText`, `readClosedTrips`, `closeTrip`, its notifications read; `boutEndMs`
  (`src/game/replay.ts`); Task 3's scene; Task 6's queue (an own bout not yet listed leads it).
- Shipped 1.4 integration: candidate/read work lives in `useAwayTrip`, not a duplicate in `CampShell`; the hook also receives
  `clock: DisplayClock` for exact bout-end, minute 60 + 1 s and minute 80 boundaries while retaining the shell's minute pulse.
- Produces: `AwayState` gains `| { kind: 'bout'; activityId: string; name: string; opponent: string; won: boolean; rewards: {
  renown: number; ratingDelta: number | null } | null }`; `boutAway(input: { owner: Pick<OwnerState, 'name' | 'gladiatorId'>;
  timeline: RevealedTimeline | null; nowMs: number; closed: ReadonlySet<string> }): AwayState | null`; `awayText` writes the
  `bout` state (spec 4, "The camp").
- Rules: the bout is the timeline's revealed `bout` stage whose log has the owner as a participant; shown from `boutEndMs(stage)`
  until the end of the slot after the bout's slot, never when closed; `rewards` from `timeline.summary` once settled. The shell's
  candidate is the owner's current activity when its kind is `arena`, else the newest Arena notification settled in the display
  clock's current slot; its timeline is read when the candidate appears, at minute 60 + 1 s of its slot and once settled (minute
  80), latest read only. A bout state replaces a trip's `back` state. The button opens `{ kind: 'replay', activityId }` (no
  origin); × closes the activity id with `closeTrip`.

- [ ] **Step 1: Write the failing unit tests** in `away-trip.test.ts` (Varro's bout of the arena fixtures, slot start `S`, the
  bout stage ending at `end`):

```ts
it('says who won the bout from its end until the next slot ends', () => {
  expect(boutAway({ owner, timeline: pending, nowMs: end - 1, closed: new Set() })).toBeNull();
  const s = boutAway({ owner, timeline: pending, nowMs: end, closed: new Set() })!;
  expect(awayText(s, false)).toEqual({ name: 'Aster', title: ' beat Varro in the Arena', sub: 'Rewards are credited at minute 80', action: '▶ Watch the bout' });
  expect(awayText(s, true)).toEqual({ name: 'Aster', title: ' beat Varro', sub: 'Rewards at minute 80', action: '▶ Watch' });
  expect(boutAway({ owner, timeline: pending, nowMs: S + 2 * SLOT_MS, closed: new Set() })).toBeNull();
  expect(boutAway({ owner, timeline: pending, nowMs: end, closed: new Set([pending.activityId]) })).toBeNull();
});
it('shows the owner’s own result once credited, zero parts left out', () => {
  expect(awayText(boutAway({ owner, timeline: settled, nowMs: S + 85 * MIN, closed: new Set() })!, false).sub).toBe('+10 renown · Rating +13');
  expect(awayText(boutAway({ owner, timeline: settled, nowMs: S + 85 * MIN, closed: new Set() })!, true).sub).toBe('Rating +13');
  expect(awayText(boutAway({ owner, timeline: lostToCassia, nowMs: S + 85 * MIN, closed: new Set() })!, false).title).toBe(' lost to Cassia in the Arena');
  expect(awayText(boutAway({ owner, timeline: npcWin, nowMs: S + 85 * MIN, closed: new Set() })!, true).sub).toBe('+3 renown');
  expect(awayText(boutAway({ owner, timeline: npcLoss, nowMs: S + 85 * MIN, closed: new Set() })!, false).sub).toBe('No rewards');
});
it('ignores a bout the owner did not fight', () => { expect(boutAway({ owner, timeline: someoneElses, nowMs: end, closed: new Set() })).toBeNull(); });
```

- [ ] **Step 2: Run** `npx vitest run tests/domain/away-trip.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the state, the text, the button's icon and action, and the shell's candidate and reads.
- [ ] **Step 4: Add the browser tests** to `away-button.spec.ts` (live-routed owner Aster; `buildArenaFixtures` from the log
  files; server time inside `ownerHumanWin`'s slot, its current activity that Arena activity):
  - `'offers my bout from its end, and its rewards once credited'`: at minute 61 the button reads `Aster beat Varro in the
    Arena`, `Rewards are credited at minute 80`, `▶ Watch the bout`; it opens the replay with `← Camp` and `Bout 1 of …` (the
    unsettled bout first); Back; at minute 85 (the next slot, the summary in the notifications and the timeline) the second line
    is `+10 renown · Rating +13`.
  - `'stays until Dismiss, also when storage throws'`: × hides it; a reload keeps it hidden; with throwing storage it stays
    hidden for the page's life and no `pageerror`.
  - `'shows nothing to a visitor, nor while a scene is open'`.
  - `'phone: Aster beat Varro · Rating +13 · ▶ Watch beside ☰'` (390 × 844 after credit; 360 × 740 `noHorizontalScroll`).
- [ ] **Step 5: Run** the unit test and `away-button.spec.ts`, `viewer.spec.ts`; expect PASS.
- [ ] **Step 6: Commit** `feat: a button on the camp after my Arena bout`.

### Task 9: Tournament bouts in the full-screen viewer

**Files:**
- Create: `src/features/tournaments/BracketReplay.tsx`
- Modify: `src/features/tournaments/TournamentPanel.tsx` (Watch replay calls `onWatchBout`; the inline replay, its log loading
  and status, Close replay and Try again go), `src/features/tournaments/TournamentPanel.module.css`,
  `src/features/shell/SceneOverlay.tsx` (the `bout` scene), `src/features/shell/CampShell.tsx` (opens it with `from:
  'tournaments'`; passes the fixture samples' times), `src/features/bouts/bout-text.ts` (`bracketChapter`)
- Test: `tests/domain/tournament-panel.test.ts`, `tests/domain/bout-text.test.ts`, `tests/browser/tournament.spec.ts`

**Interfaces:**
- Consumes: Task 3's `{ kind: 'bout' }` view and `replace`; Task 5's `BattleReplay` (`chapters`, `nav`, `league`, `back`,
  `takeFocus`); `renderTournament`, `tournamentReplayKept`, `GameGateway.tournament`, `tournamentLog`, `looks`.
- Produces: `BracketReplay({ reads, tournamentId, boutId, clock, viewerId, known, back, takeFocus, heldAtMs, onChapter }: {
  reads: Pick<GameGateway, 'tournament' | 'tournamentLog'> & Partial<Pick<GameGateway, 'looks'>>; tournamentId: string; boutId:
  string; clock: DisplayClock | null; viewerId: string | null; known: LookMap | null; back: { label: string; go(): void } | null;
  takeFocus?: boolean; heldAtMs?: number | null; onChapter(boutId: string): void })`; `bracketChapter(roundLabel: string, position: number,
  boutsInRound: number): string`; `TournamentPanel` prop `onWatchBout?(tournamentId: string, boutId: string): void`;
  `TournamentBracketView` loses `replayBoutId`, `replayStatus`, `onCloseReplay` and `onRetryReplay`.
- Rules: the chapters are the decided bouts at the display time (`heldAtMs` when given: the fixture sample's projection time) in
  round, then position order; the shown chapter's log loads through `tournamentLog` (the gateway caches it); the eyebrow comes
  from `boutEyebrow` with the view's league; no counter, no rewards; a chapter step calls `onChapter`, which `SceneOverlay` turns
  into `onReplace({ kind: 'bout', tournamentId, boutId, from })`; the last chapter's end card shows the back button.

- [ ] **Step 1: Write the failing unit tests.** `bout-text.test.ts`:

```ts
expect([bracketChapter('Final', 0, 1), bracketChapter('Semifinal', 1, 2), bracketChapter('Quarterfinal', 2, 4), bracketChapter('Round 1', 4, 8)])
  .toEqual(['Final', 'SF 2', 'QF 3', 'R1 · 5']);
```

  `tournament-panel.test.ts`: `'Watch replay asks for the full-screen bout, never an inline replay'` (the completed bracket at
  minute 85 has four `Watch replay` buttons in the shown round, no `Close replay`, no `Replay · ` heading, no `Combat log`);
  remove the inline-replay cases (headings nested under the card, loading and failed states) that this replaces.
- [ ] **Step 2: Run** `npx vitest run tests/domain/bout-text.test.ts tests/domain/tournament-panel.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `BracketReplay`, the scene, the panel's button and the shell's wiring.
- [ ] **Step 4: Replace the inline-replay browser tests** in `tournament.spec.ts`:
  - `'Watch replay plays the bout full screen with the bracket as chapters, and ← Tournaments returns'`: the `completed` sample,
    Watch replay of Severus vs Varro: the dialog "Replay", the address `view=bout&tournament=…&bout=…:3:0&from=tournaments`, the
    eyebrow `TOURNAMENT · BRONZE · FINAL`, the chapters `QF 1`, `QF 2`, `QF 3`, `QF 4`, `SF 1`, `SF 2`, `Final` with `Final`
    current, no `Bout 1 of`; ⏮ shows `SF 2` and the address's `bout` ends `:2:1` with `history.length` unchanged; a reload
    reopens `SF 2`; `← Tournaments` shows the Tournaments menu.
  - `'loads a bout’s log only when it is shown, and only once'` (live-routed: one log read per chapter shown, none again when
    stepping back).
  - `'an old bracket says its replays are no longer kept'` (the `aged` sample's bout address).
  - `'fits a 360 px phone'` (`noHorizontalScroll`; the bar's compact `7 / 7 · Final`).
  Keep the focus-ring test on Watch replay.
- [ ] **Step 5: Run** the unit tests and `tournament.spec.ts`, `scenes.spec.ts`, `viewer.spec.ts`; expect PASS.
- [ ] **Step 6: Commit** `feat: tournament bouts play full screen, with the bracket as chapters`.

### Task 10: Gate, review and release

Release from p15-arena on port 3800. Finalize docs/CHANGELOG.md and docs/FEATURES.md before the go: built bullets must exactly match the patch-record draft. Present the exact 1.5 title, features and linked-note record draft together with the patch-note draft. Avi must give a fresh explicit 1.5 go; the four-write 1.4 approval is exhausted. This patch changes nothing under supabase/.

- [x] **Step 1:** With the local stack and `supabase functions serve` running, run the gate of record `node scripts/verify.mjs
  --config node_modules/.cache/pw-p15-arena.config.mjs`; expect every step to pass. The DB-test rule applies (AGENTS.md); no build
  or edit during the browser run.
- [x] **Step 2:** A fresh reviewer checks the whole branch against the spec (copy word for word, the Review Focus, owner-only
  data, the formatter guard, history replace-not-push); fix what it finds; rerun the affected tests and the gate.
- [x] **Step 3:** `git diff --stat origin/release -- supabase` must be empty (client-only release). Stop and ask before
  releasing if anything under `supabase/` changed, or if the branch carries other unreleased work (Patch B is planned in
  parallel): choose the commit to release with Avi first.
- [x] **Step 4:** Ask Avi in chat for the go, with the spec's "Patch note draft" for his wording. Check the window (not Wed/Sat
  17:20-20:00 UTC) and, read-only, that no boundary is open (`hosted-checks.sql` through `db query --linked --agent no`).
- [x] **Step 5:** After the go: the `release` fast-forward from `C:\Avi\Studies\Projects\Cloudiator\p15-arena` (`git merge-base
  --is-ancestor origin/release <deploy-commit>`, then `git push origin <deploy-commit>:refs/heads/release`, never `--force`;
  deployment.md "Client step"); the deployed checks about 2 minutes after Pages is live.
- [x] **Step 6:** Post the approved note with `private.post_message('patch-notes', <title>, <preview>, <body>, null)` per the
  runbook ("Posting a game message": one statement, UTF-8 without a byte-order mark, dollar quotes); read back the visible
  messages and one account's inbox (unread up by one).
- [x] **Step 7:** Only after the client, deployed probes and approved note succeed, run the approved private.record_patch statement for 1.5 linked to that new note, generated with scripts/patch-statement.mjs from the finalized changelog. Verify the patch record, exact feature wording, note link and world_revision.latest_patch read-only. Record the evidence in `docs/operations/release-evidence.md` and `docs/operations/deployment.md`, update
  `docs/implementation/HANDOFF.md` and this plan's status; commit `deploy: ship the Arena replays patch`.

### Task 11: A players' clip of the Arena replays patch

Made after the release, from the real game, with the HyperFrames skill (`npx hyperframes usage --json` first; on this PC run
the CLI as `node C:/Users/Avi_OP_PC/AppData/Roaming/npm/node_modules/hyperframes/bin/hyperframes.mjs`).

- [ ] **Step 1:** Capture the real screens locally (a temporary `tests/browser/zz-*.spec.ts`, never committed, against the dev
  server on 3200; live-routed owner Aster): My bouts with its day groups and the Lost chip, a bout playing with the bar and the
  speed, the result card and ▶ Next bout into the next bout, the camp button after a bout, ▶ Watch in Notifications, the Arena
  menu's recent bouts, and a tournament final full screen with its chapters; desktop and phone.
- [ ] **Step 2:** Build a 16:9 clip of about 30-45 s (1920 × 1080, 30 fps) for the Indigo Labs YouTube channel and a 9:16 cut
  (1080 × 1920) for Instagram and WhatsApp stories: one scene per feature with short plain captions, a sound on each visible
  action, narration in local Kokoro `bm_george`, the music bed at about 0.1 under the narration and never normalised up, a
  closing card naming the game and the update with no URL and no "Coming soon". `check --json` clean, snapshot review, then
  render with `--video-frame-format jpg` (and `--workers 4` if a render crashes); scan every frame for single-frame flashes.
- [ ] **Step 3:** Measure the loudness and put the measured LUFS and peak in the delivery note. Send Avi the files (a copy under
  30 MiB for remote viewing), and keep the project under `D:\Avi\Projects\Animation\Cloudiator\<what-it-shows>` with thumbnails
  under `D:\Avi\Projects\Animation\Indigo Labs\`. Upload to Indigo Labs and post the stories only after Avi's go in chat for
  each; no Telegram send unless he asks.

## Status

Planned 2026-10-29 from the approved mockup and Avi's three choices. Nothing built yet; starts after Patch A is merged.
