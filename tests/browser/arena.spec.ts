import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { BattleAction, BattleLog, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { PublicActor, StandingRow, StandingsPage } from '../../supabase/functions/_shared/contracts/reads';
import { ARENA_ACTIVITIES, ARENA_BOUTS, ARENA_GLADIATORS, arenaActivityId, arenaBattleId, type ArenaActivityKey, type ArenaBoutKey } from '../fixtures/arena-ids';
import { ARENA_STANDINGS, buildArenaFixtures } from '../fixtures/arena-build';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { worldToScreen } from '../../src/game/iso';
import { emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { forbidRemote, remoteRequest } from './remote';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MIN = 60_000;
const SLOT_MS = 4_800_000;
const NOW = worldFixture.serverNowMs;
/** The fixture world's slot: its Arena entrants reveal their bouts at S + 60 min. */
const S = NOW - (NOW % SLOT_MS);
const LOGS = Object.fromEntries((Object.keys(ARENA_BOUTS) as ArenaBoutKey[])
  .map(key => [key, JSON.parse(readFileSync(`tests/fixtures/arena/${key}.json`, 'utf8')) as BattleLog])) as Record<ArenaBoutKey, BattleLog>;
const { timelines: TIMELINES, worldActors: ENTRANTS } = buildArenaFixtures(LOGS);
const RING_TILES = JSON.parse(readFileSync('public/assets/camp/map.json', 'utf8')).zones.find((z: { id: string }) => z.id === 'arena').stations
  .filter((s: { kind: string }) => s.kind === 'arena-ring') as { id: string; x: number; y: number; facing: 'se' | 'sw' }[];
const ringAt = (x: number, y: number) => RING_TILES.find(r => r.x === Math.floor(x) && r.y === Math.floor(y)) ?? null;
const attacks = (log: BattleLog) => log.events.filter((e): e is BattleAction => e.kind === 'attack');
const COMBAT = ['idle', 'attack', 'thrust', 'shoot', 'hit', 'defend', 'evade', 'defeat', 'victory'];

const campState = (page: Page) => page.evaluate(() => window.__cloudiatorCamp!.state()!);
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

/**
 * Opens the fixture camp with the current slot's Arena entrants and their timelines, holding the display clock at a
 * minute of the slot. The entrants and timelines are the fixture gateway's own; pushing them through the scene hook
 * keeps these scene checks independent of how the page reads them (the page tests below use the real reads).
 */
async function openArena(page: Page, minute: number) {
  await page.goto('/game/?mode=fixture');
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
  await page.evaluate(({ entrants, timelines, at }) => {
    const hook = window.__cloudiatorCamp!;
    hook.freezeClock(at);
    const world = hook.world()!;
    const ids = new Set(entrants.map(a => a.gladiatorId));
    const others = world.actors.filter(a => !ids.has(a.gladiatorId));
    hook.setWorld({ ...world, actors: [...others.slice(0, 50 - entrants.length), ...entrants] });
    hook.setArenaTimelines(timelines);
  }, { entrants: ENTRANTS as PublicActor[], timelines: TIMELINES as Record<string, RevealedTimeline>, at: S + minute * MIN });
  await nextFrames(page);
}
const freezeAt = async (page: Page, ms: number) => { await page.evaluate(t => window.__cloudiatorCamp!.freezeClock(t), ms); await nextFrames(page); };

test.describe('arena staging and sparring rings in the camp', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');

  test('warms every entrant up in staging before minute 60, with no pairing or ring shown', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // added entrants take their staging spots at once
    await openArena(page, 40);
    const state = await campState(page);
    expect(state.arena.fights).toEqual([]);
    const entrants = state.actors.filter(a => ENTRANTS.some(e => e.gladiatorId === a.id));
    expect(entrants).toHaveLength(ENTRANTS.length);
    for (const a of entrants) {
      expect(a.zone, a.name).toBe('arena');
      expect(ringAt(a.x, a.y), `${a.name} stands on a ring tile`).toBeNull();
      expect([a.walking, a.action], a.name).toEqual([false, 'practice']);
    }
    expect(state.actors.some(a => a.kind === 'arena-npc')).toBe(false);
    await expect(page.getByRole('group', { name: 'Arena bouts in the rings' })).toHaveCount(0);
    await page.evaluate(() => window.__cloudiatorCamp!.centerOn(23, 23, 2));
    await nextFrames(page);
    await page.screenshot({ path: testInfo.outputPath('arena-minute-40-warm-up.png') });
  });

  test('walks each revealed pair into its own ring, face to face, and plays its bout from the log', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // pairs step into their rings at once
    await openArena(page, 60);
    let state = await campState(page);
    expect(state.arena.fights).toHaveLength(7);
    const inRings = state.arena.fights.filter(f => f.status !== 'queued');
    expect(inRings).toHaveLength(6);
    expect(new Set(inRings.map(f => f.ring)).size).toBe(6);
    expect(state.arena.fights.filter(f => f.status === 'queued')).toHaveLength(1);
    // Play every ring fight at its first logged attack and check who stands where and who swings. With reduced
    // motion the pairs stand in their rings at once, so the bout plays from its real start.
    for (const fight of inRings) {
      const bout = (Object.keys(ARENA_BOUTS) as ArenaBoutKey[]).find(k => arenaBattleId(k) === fight.battleId)!;
      const log = LOGS[bout];
      const first = attacks(log)[0];
      expect(fight.boutStartMs).toBe(S + 60 * MIN);
      await freezeAt(page, fight.boutStartMs + first.elapsedMs + 20);
      state = await campState(page);
      const live = state.arena.fights.find(f => f.battleId === fight.battleId)!;
      expect(live.status).toBe('fighting');
      expect(live.positionMs).toBe(first.elapsedMs + 20);
      const ids = [fight.fighters[0] ?? fight.npc!, fight.fighters[1] ?? fight.npc!];
      const [a, b] = ids.map(id => state.actors.find(x => x.id === id)!);
      const [ra, rb] = [ringAt(a.x, a.y)!, ringAt(b.x, b.y)!];
      expect([ra.facing, rb.facing], bout).toEqual(['se', 'sw']);
      expect([rb.x - ra.x, rb.y - ra.y]).toEqual([1, -1]);
      expect([a.flip, b.flip]).toEqual([false, true]);
      for (const x of [a, b]) {
        expect(COMBAT, `${x.name} ${x.frame}`).toContain(x.frame.split('/')[0]);
        // Depth stays with the feet, so walls and props in front still cover the fight.
        const feet = worldToScreen(x.x, x.y).y;
        expect(x.depth).toBeGreaterThanOrEqual(feet);
        expect(x.depth).toBeLessThan(feet + 1);
      }
      const attacker = first.attackerId === log.participants[0].id ? a : b;
      expect(['attack', 'thrust', 'shoot'], `${bout}: ${attacker.name} strikes first`).toContain(attacker.frame.split('/')[0]);
      expect(state.arena.effects.some(e => e.battleId === fight.battleId && e.target === (attacker === a ? 1 : 0)), `${bout} effect on the defender`).toBe(true);
    }
    await page.evaluate(() => window.__cloudiatorCamp!.centerOn(23, 22.5, 2));
    await freezeAt(page, inRings[0].boutStartMs + 9000);
    await page.screenshot({ path: testInfo.outputPath('arena-six-simultaneous-fights.png') });
  });

  test('draws an NPC fallback opponent as a tagged NPC in neutral grey, never as a player', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openArena(page, 60.25);
    const state = await campState(page);
    const npcFights = state.arena.fights.filter(f => f.npc);
    expect(npcFights).toHaveLength(2);
    const before = state.players;
    for (const fight of npcFights.filter(f => f.status !== 'queued')) {
      const npc = state.actors.find(a => a.id === fight.npc)!;
      expect(npc).toMatchObject({ kind: 'arena-npc', marker: 'NPC' });
      expect(['Iron Warden', 'Stone Gladius']).toContain(npc.name);
      expect(ringAt(npc.x, npc.y)).not.toBeNull();
    }
    expect(state.actors.filter(a => a.kind === 'player').length).toBe(before);
    expect(state.actors.filter(a => a.kind === 'player').some(a => a.id.startsWith('arena-npc:'))).toBe(false);
  });

  test('queues the seventh pair in staging and shows its bout’s end state once a ring frees', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openArena(page, 60.25);
    const fights = (await campState(page)).arena.fights;
    const queued = fights.find(f => f.status === 'queued')!;
    const freedBy = fights.filter(f => f.ring === queued.ring && f !== queued).map(f => f.leaveAtMs);
    expect(queued.enterAtMs).toBe(Math.max(...freedBy));
    await freezeAt(page, queued.enterAtMs - 1);
    let state = await campState(page);
    for (const id of queued.fighters.filter((x): x is string => !!x)) expect(ringAt(state.actors.find(a => a.id === id)!.x, state.actors.find(a => a.id === id)!.y)).toBeNull();
    // Its bout (Cato's, 16 s from minute 60) ended before a ring freed: the pair shows the logged end, never a fight.
    const bout = (Object.keys(ARENA_BOUTS) as ArenaBoutKey[]).find(k => arenaBattleId(k) === queued.battleId)!;
    expect(queued.boutStartMs + LOGS[bout].durationMs).toBeLessThan(queued.enterAtMs);
    for (const t of [queued.enterAtMs + 500, queued.enterAtMs + 3000]) {
      await freezeAt(page, t);
      state = await campState(page);
      const live = state.arena.fights.find(f => f.battleId === queued.battleId)!;
      expect([live.status, live.positionMs]).toEqual(['result', LOGS[bout].durationMs + 2000]);
      const ids = [queued.fighters[0] ?? queued.npc!, queued.fighters[1] ?? queued.npc!];
      const poses = ids.map(id => state.actors.find(a => a.id === id)!);
      for (const a of poses) expect(ringAt(a.x, a.y), a.name).not.toBeNull();
      const winner = LOGS[bout].winnerId === LOGS[bout].participants[0].id ? 0 : 1;
      expect(poses.map(a => a.frame.split('/')[0])).toEqual(winner === 0 ? ['victory', 'defeat'] : ['defeat', 'victory']);
    }
  });

  test('returns both fighters to staging after the result, the loser unhurt and idle like the winner', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openArena(page, 61);
    const fight = (await campState(page)).arena.fights.find(f => f.battleId === arenaBattleId('campThree'))!;
    await freezeAt(page, fight.boutStartMs + LOGS.campThree.durationMs + 2500);
    let state = await campState(page);
    const ids = fight.fighters as [string, string];
    const poses = ids.map(id => state.actors.find(a => a.id === id)!.frame.split('/')[0]);
    // Lucilla (participant 0) lost: defeat pose, then the winner's victory pose.
    expect(poses).toEqual(['defeat', 'victory']);
    await freezeAt(page, fight.leaveAtMs + 100);
    state = await campState(page);
    for (const id of ids) {
      const a = state.actors.find(x => x.id === id)!;
      expect(ringAt(a.x, a.y), a.name).toBeNull();
      expect(a.action, a.name).toBe('idle');
    }
    expect(state.arena.fights.find(f => f.battleId === fight.battleId)!.status).toBe('done');
  });

  test('lists the fights in the rings as buttons that find the pair', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openArena(page, 60.25);
    const group = page.getByRole('group', { name: 'Arena bouts in the rings' });
    await expect(group.getByRole('button')).toHaveCount(6);
    await expect(group.getByRole('button', { name: 'Bellator vs Corvina' })).toBeVisible();
    await expect(group.getByRole('button', { name: /^(Valeria vs Iron Warden|Cato vs Stone Gladius) \(NPC\)$/ }).first()).toBeVisible();
    // Below the camp view, never over its top rows (nameplates, clicks), and every button fits without scrolling.
    const canvasBox = (await page.locator('canvas').boundingBox())!;
    const groupBox = (await group.boundingBox())!;
    expect(groupBox.y, 'bout buttons below the camp view').toBeGreaterThanOrEqual(canvasBox.y + canvasBox.height - 1);
    for (const b of await group.getByRole('button').all()) {
      const box = (await b.boundingBox())!;
      expect(box.x, await b.textContent() ?? '').toBeGreaterThanOrEqual(groupBox.x - 1);
      expect(box.x + box.width, await b.textContent() ?? '').toBeLessThanOrEqual(groupBox.x + groupBox.width + 1);
    }
    await page.locator('section.camp-area').screenshot({ path: testInfo.outputPath('arena-bout-buttons-below-camp.png') });
    const button = group.getByRole('button', { name: 'Bellator vs Corvina' });
    await button.focus();
    await page.keyboard.press('Enter');
    expect((await campState(page)).selected).toBe(ARENA_GLADIATORS.bellator.id);
  });

  test('selects a fighter by a click on its body in the ring', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openArena(page, 60.25);
    const state = await campState(page);
    for (const fight of state.arena.fights.filter(f => f.status === 'fighting')) {
      for (const id of fight.fighters.filter((x): x is string => !!x)) {
        const a = state.actors.find(x => x.id === id)!;
        await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: a.x, y: a.y });
        await nextFrames(page);
        // Each click opens that fighter's Arena card, which scrolls the page to it: bring the camp back first.
        await page.locator('canvas').scrollIntoViewIfNeeded();
        const box = (await page.locator('canvas').boundingBox())!;
        const at = (await page.evaluate(x => window.__cloudiatorCamp!.screenOf(x), id))!;
        // The head (about 40 art px over the feet): nobody standing in front of a fighter reaches that high.
        await page.mouse.click(box.x + at.x, box.y + at.y - 40);
        expect((await campState(page)).selected, a.name).toBe(id);
      }
    }
  });

  test('forgets the Arena timelines and stage plans of entrants who left the camp', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openArena(page, 60.25);
    const timelines = () => page.evaluate(() => window.__cloudiatorCamp!.arenaTimelines());
    expect(await timelines()).toEqual(expect.arrayContaining(ENTRANTS.map(a => a.activityId!)));
    expect((await campState(page)).arena.plans.length).toBeGreaterThan(0);
    await page.evaluate(ids => {
      const hook = window.__cloudiatorCamp!;
      const world = hook.world()!;
      hook.setWorld({ ...world, actors: world.actors.filter(a => !ids.includes(a.gladiatorId)) });
    }, ENTRANTS.map(a => a.gladiatorId));
    await nextFrames(page);
    expect(await timelines()).toEqual([]);
    const state = await campState(page);
    expect(state.arena.fights).toEqual([]);
    expect(state.arena.plans).toEqual([]);
  });

  test('keeps damage labels clear of the fighters’ nameplates and the NPC tag', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // the pairs stand in their rings at once
    await openArena(page, 60);
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    let seen = 0;
    for (const motion of ['reduce', 'no-preference'] as const) {
      await page.emulateMedia({ reducedMotion: motion });
      await page.waitForFunction(m => window.__cloudiatorCamp!.state()!.reducedMotion === (m === 'reduce'), motion);
      for (const [key, gladiator] of [['campNpcOne', 'valeria'], ['campOne', 'bellator']] as const) {
        await page.evaluate(id => window.__cloudiatorCamp!.emit('find-character', { gladiatorId: id }), ARENA_GLADIATORS[gladiator].id);
        // Zoomed in, so every nameplate of the pair shows.
        const fighter = (await campState(page)).actors.find(a => a.id === ARENA_GLADIATORS[gladiator].id)!;
        await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: fighter.x, y: fighter.y });
        const fight = (await campState(page)).arena.fights.find(f => f.battleId === arenaBattleId(key))!;
        // Through the bout until a few labels of this pair have been drawn.
        let mine = 0;
        for (let t = fight.boutStartMs + 900; t < fight.boutStartMs + LOGS[key].durationMs && mine < 8; t += 150) {
          await freezeAt(page, t);
          const state = await campState(page);
          const ids = [fight.fighters[0] ?? fight.npc!, fight.fighters[1] ?? fight.npc!];
          const plates = state.actors.filter(a => ids.includes(a.id)).flatMap(a => a.plates.map(box => ({ name: a.name, box })));
          for (const label of state.arena.labels.filter(l => l.battleId === fight.battleId)) {
            mine += 1;
            expect(plates.length, 'the selected fighter shows its nameplate').toBeGreaterThan(0);
            for (const plate of plates) expect(overlaps(label.box, plate.box), `${motion} ${label.text} over ${plate.name} at ${t - fight.boutStartMs} ms`).toBe(false);
          }
        }
        seen += mine;
      }
    }
    expect(seen).toBeGreaterThan(10);
    // Valeria's ring, close up, with a fresh label over her NPC opponent's tag.
    const npcFight = (await campState(page)).arena.fights.find(f => f.battleId === arenaBattleId('campNpcOne'))!;
    await page.evaluate(id => window.__cloudiatorCamp!.emit('find-character', { gladiatorId: id }), ARENA_GLADIATORS.valeria.id);
    const valeria = (await campState(page)).actors.find(a => a.id === ARENA_GLADIATORS.valeria.id)!;
    await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x - 2, y - 2, 2.5), { x: valeria.x + 0.5, y: valeria.y - 0.5 });
    const hit = attacks(LOGS.campNpcOne).find(e => e.elapsedMs > 2000 && e.attackerId === LOGS.campNpcOne.participants[0].id)!;
    await freezeAt(page, npcFight.boutStartMs + hit.elapsedMs + 150);
    await page.locator('canvas').screenshot({ path: testInfo.outputPath('arena-labels-clear-of-nameplates.png') });
  });

  test('walks pairs into their rings within the walk-in time and back to staging after the result', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openArena(page, 59);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => window.__cloudiatorCamp!.state()!.reducedMotion === false);
    await freezeAt(page, S + 60 * MIN);
    let state = await campState(page);
    const entering = state.arena.fights.filter(f => f.status === 'entering');
    expect(entering.length).toBe(6);
    const walkers = entering.flatMap(f => f.fighters).filter((id): id is string => !!id);
    for (const id of walkers) {
      const a = state.actors.find(x => x.id === id)!;
      expect([a.walking, ringAt(a.x, a.y)], a.name).toEqual([true, null]);
    }
    // NPC opponents walk in through the arena gate.
    for (const f of entering.filter(x => x.npc)) expect(state.actors.find(a => a.id === f.npc)!.walking).toBe(true);
    // The display clock runs while frozen frames are drawn, so step it through the walk.
    for (let t = S + 60 * MIN; t <= entering[0].fightStartMs - 1; t += 250) await freezeAt(page, t);
    state = await campState(page);
    for (const id of walkers) {
      const a = state.actors.find(x => x.id === id)!;
      expect([a.walking, ringAt(a.x, a.y) !== null], `${a.name} arrived before the bout`).toEqual([false, true]);
    }
    const fight = entering[0];
    for (let t = fight.leaveAtMs; t <= fight.leaveAtMs + 600; t += 300) await freezeAt(page, t);
    state = await campState(page);
    for (const id of fight.fighters.filter((x): x is string => !!x)) expect(state.actors.find(a => a.id === id)!.walking, 'walking back to staging').toBe(true);
  });

  test('jogs pairs into their rings at three times the walking pace with a quicker step, and walks them back at the normal pace', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openArena(page, 59);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => window.__cloudiatorCamp!.state()!.reducedMotion === false);
    const start = S + 60 * MIN;
    await freezeAt(page, start);
    const entering = (await campState(page)).arena.fights.filter(f => f.status === 'entering');
    expect(entering.length).toBe(6);
    const sideIds = (f: (typeof entering)[number]) => [f.fighters[0] ?? f.npc!, f.fighters[1] ?? f.npc!];
    /** Straight-line tiles per second over 300 ms (a lower bound of the path speed) and walk-frame changes over 240 ms. */
    async function pace(ids: string[], t0: number) {
      await freezeAt(page, t0);
      const before = await campState(page);
      const frames = await page.evaluate(({ ids, t0 }) => {
        const hook = window.__cloudiatorCamp!;
        const seen: Record<string, string[]> = {};
        for (let t = t0; t < t0 + 240; t += 10) {
          hook.freezeClock(t);
          const state = hook.state()!;
          for (const id of ids) (seen[id] ??= []).push(state.actors.find(a => a.id === id)!.frame);
        }
        return seen;
      }, { ids, t0 });
      await freezeAt(page, t0 + 300);
      const after = await campState(page);
      return ids.flatMap(id => {
        const [a, b] = [before.actors.find(x => x.id === id)!, after.actors.find(x => x.id === id)!];
        if (!a.walking || !b.walking) return [];
        const changes = frames[id].filter((frame, i) => i > 0 && frame !== frames[id][i - 1]).length;
        return [{ name: a.name, speed: Math.hypot(b.x - a.x, b.y - a.y) / 0.3, changes, walk: frames[id].every(f => f.startsWith('walk/')) }];
      });
    }
    const jog = await pace(entering.flatMap(sideIds), start + 200);
    expect(jog.length, 'fighters still jogging in').toBeGreaterThanOrEqual(8);
    for (const w of jog) {
      expect(w.walk, `${w.name} plays the walk loop`).toBe(true);
      expect(w.speed, `${w.name} jogs in`).toBeGreaterThan(2.2);
      expect(w.speed, `${w.name} jogs in`).toBeLessThan(3.05);
      // Six 120 ms frames at three times the rate: about six changes in 240 ms (two at the walking rate).
      expect(w.changes, `${w.name} steps quicker`).toBeGreaterThanOrEqual(5);
    }
    // Into the rings (stepping the clock through the jog), then back to staging after the first result.
    for (let t = start; t <= entering[0].fightStartMs; t += 250) await freezeAt(page, t);
    const fight = entering[0];
    const back = await pace(sideIds(fight), fight.leaveAtMs + 200);
    expect(back.length, 'both fighters walk back').toBe(2);
    for (const w of back) {
      expect(w.walk, `${w.name} plays the walk loop`).toBe(true);
      expect(w.speed, `${w.name} walks back`).toBeGreaterThan(0.5);
      expect(w.speed, `${w.name} walks back`).toBeLessThan(1.05);
      expect(w.changes, `${w.name} steps at the walking rate`).toBeLessThanOrEqual(3);
    }
  });

  test('puts a fighter still walking in on its ring spot once its bout is over, so it walks back from the ring', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openArena(page, 59);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => window.__cloudiatorCamp!.state()!.reducedMotion === false);
    await freezeAt(page, S + 60 * MIN);
    const entering = (await campState(page)).arena.fights.filter(f => f.status === 'entering');
    expect(entering.length).toBe(6);
    await freezeAt(page, S + 60 * MIN + 500);
    let state = await campState(page);
    const sides = entering.flatMap(f => ([0, 1] as const).map(side => ({ fight: f, side, id: f.fighters[side] ?? f.npc! })));
    const midway = sides.filter(({ id }) => { const a = state.actors.find(x => x.id === id)!; return a.walking && !ringAt(a.x, a.y); });
    expect(midway.length, 'fighters still on their way in').toBeGreaterThanOrEqual(8);
    // The display clock jumps past every bout's end with no frame in between (a hidden tab coming back, or a late
    // timeline read), so the walk-in never finished on screen.
    await freezeAt(page, Math.max(...entering.map(f => f.leaveAtMs)));
    state = await campState(page);
    for (const { fight, side, id } of midway) {
      const a = state.actors.find(x => x.id === id)!;
      expect(state.arena.fights.find(f => f.battleId === fight.battleId)!.status).toBe('done');
      expect([a.walking, ringAt(a.x, a.y)?.id ?? null], `${a.name} starts back from its ring spot`).toEqual([true, `arena-ring-${fight.ring}-${side === 0 ? 'a' : 'b'}`]);
    }
  });

  test('keeps each fight’s damage labels clear of every nameplate in the six-fight view', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // the pairs stand in their rings at once
    await openArena(page, 60);
    const inRings = (await campState(page)).arena.fights.filter(f => f.status !== 'queued');
    expect(inRings).toHaveLength(6);
    const crossings: string[] = [];
    let seen = 0;
    for (const motion of ['reduce', 'no-preference'] as const) {
      await page.emulateMedia({ reducedMotion: motion });
      await page.waitForFunction(m => window.__cloudiatorCamp!.state()!.reducedMotion === (m === 'reduce'), motion);
      for (const fight of inRings) {
        const bout = (Object.keys(ARENA_BOUTS) as ArenaBoutKey[]).find(k => arenaBattleId(k) === fight.battleId)!;
        const gladiator = (fight.fighters[0] ?? fight.fighters[1])!;
        await page.evaluate(id => window.__cloudiatorCamp!.emit('find-character', { gladiatorId: id }), gladiator);
        // The six-fight view (the evidence capture), where every fighter's nameplate shows.
        await page.evaluate(() => window.__cloudiatorCamp!.centerOn(23, 22.5, 2));
        const found = await page.evaluate(async ({ battleId, from, to }) => {
          const hook = window.__cloudiatorCamp!;
          const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const hit = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
            a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
          const out: string[] = [];
          let labels = 0;
          for (let t = from; t < to; t += 100) {
            hook.freezeClock(t);
            await frame();
            const state = hook.state()!;
            for (const label of state.arena.labels.filter(l => l.battleId === battleId)) {
              labels += 1;
              for (const a of state.actors) for (const plate of a.plates) if (hit(label.box, plate)) out.push(`${label.text} over ${a.name} at ${t - from} ms`);
            }
          }
          return { out, labels };
        }, { battleId: fight.battleId, from: fight.boutStartMs + 500, to: fight.boutStartMs + LOGS[bout].durationMs });
        seen += found.labels;
        crossings.push(...found.out.map(x => `${motion} ${bout}: ${x}`));
      }
    }
    expect(seen).toBeGreaterThan(100);
    expect(crossings).toEqual([]);
  });
});


// ------------------------------------------------------------------ the Arena card and standings on the game page
// These use the page's real reads: the fixture gateway's timelines, profiles and standings, and the fixture world's
// Arena entrants. They need the shared integration in src/app/game/page.tsx and the fixture gateway.

const startOf = (key: ArenaActivityKey) => S - ARENA_ACTIVITIES[key].slotsAgo * SLOT_MS;
const labelOf = (key: ArenaActivityKey) => ARENA_ACTIVITIES[key].label;
const card = (page: Page) => page.locator('article[data-phase]');
const arenaState = (page: Page) => page.evaluate(() => window.__cloudiatorArena!.state());

async function openGame(page: Page) {
  await page.goto('/game/?mode=fixture');
  await expect(page.getByRole('heading', { name: 'Arena bouts' })).toBeVisible({ timeout: 45_000 });
  // The section also shows for spectators (Task 13.4), so it can appear before the fixture owner, whose page these tests
  // are, and before its test hook is installed.
  await expect(page.getByRole('heading', { name: 'Aster', exact: true, level: 2 })).toBeVisible({ timeout: 45_000 });
  await page.waitForFunction(() => !!window.__cloudiatorArena);
}
/** Opens a sample Arena activity in the card. */
async function openSample(page: Page, key: ArenaActivityKey) {
  await page.getByRole('button', { name: labelOf(key), exact: true }).click();
  await page.waitForFunction(id => window.__cloudiatorArena?.state()?.activityId === id, arenaActivityId(key));
}
/** The plan's helper: the Arena card of a sample activity, with the display clock at a minute of its slot. */
const arenaFlow = {
  async openAtMinute(page: Page, minute: number, key: ArenaActivityKey = 'ownerNpcWin') {
    if (!(await page.evaluate(() => !!window.__cloudiatorArena))) await openGame(page);
    if ((await page.evaluate(() => window.__cloudiatorArena!.state()?.activityId ?? null)) !== arenaActivityId(key)) await openSample(page, key);
    await page.evaluate(ms => window.__cloudiatorArena!.freeze(ms), startOf(key) + minute * MIN);
    await page.waitForFunction(ms => {
      const s = window.__cloudiatorArena!.state();
      return !!s && s.minute !== null && Math.abs(s.minute * 60_000 - ms) < 1;
    }, minute * MIN);
  },
};

test('flags only requests that leave the test origin or reach Supabase, on any dev port', () => {
  for (const origin of ['http://127.0.0.1:3100', 'http://127.0.0.1:3300', 'http://127.0.0.1:4173']) {
    for (const local of [`${origin}/_next/static/chunks/app.js`, `${origin}/game/?mode=fixture`, `${origin}/assets/camp/map.json`, 'data:image/png;base64,AAAA', 'blob:http://127.0.0.1/1']) {
      expect(remoteRequest(local, origin), local).toBe(false);
    }
    for (const remote of ['http://127.0.0.1:54321/rest/v1/owner_state', 'https://abc.supabase.co/auth/v1/user', `${origin}/functions/v1/game-command`, `${origin}/rest/v1/world`, 'https://example.com/x.js']) {
      expect(remoteRequest(remote, origin), remote).toBe(true);
    }
  }
  expect(remoteRequest('http://127.0.0.1:3300/a.js', 'http://127.0.0.1:3100')).toBe(true);
});

test.describe('the Arena card and league standings', () => {
  test.skip(production, 'The Arena samples need the fixture preview, which production exports never include.');

  test('reveals the bout at minute 60 and discloses an NPC fallback (plan Step 1)', async ({ page, baseURL }) => {
    const remote = forbidRemote(page, baseURL);
    await arenaFlow.openAtMinute(page, 59);
    await expect(page.getByText('Warming up')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Watch replay' })).toBeDisabled();
    await expect(page.getByText('NPC opponent — reduced renown, no rating change')).toHaveCount(0);
    await arenaFlow.openAtMinute(page, 60);
    await expect(page.getByRole('button', { name: 'Watch replay' })).toBeEnabled();
    await expect(page.getByText('NPC opponent — reduced renown, no rating change')).toBeVisible();
    await expect(card(page)).toContainText('Bout in progress');
    await expect(card(page)).not.toContainText(/Victory|Defeat/);
    expect(remote).toEqual([]);
  });

  test('stages, reveals, completes and credits a human bout, crediting nothing before minute 80', async ({ page, baseURL }, testInfo) => {
    const remote = forbidRemote(page, baseURL);
    const key = 'ownerHumanWin';
    await arenaFlow.openAtMinute(page, 30, key);
    await expect(card(page).getByRole('status')).toHaveText('Warming up');
    await expect(card(page)).not.toContainText('Varro');
    await arenaFlow.openAtMinute(page, 60.1, key);
    await expect(card(page).getByRole('status')).toHaveText('Bout in progress');
    const opponent = card(page).getByRole('definition');
    await expect(opponent).toHaveText(['Varro', 'Berserker', '1027']);
    await arenaFlow.openAtMinute(page, 60 + LOGS.ownerHumanWin.durationMs / MIN, key);
    await expect(card(page).getByRole('status')).toHaveText('Completed');
    await expect(card(page).getByRole('region', { name: 'Result' })).toContainText('Victory');
    await expect(card(page)).toContainText('Rewards and any rating change are credited at minute 80.');
    await expect(card(page)).not.toContainText(/\+10 renown|Rating \+13/);
    await arenaFlow.openAtMinute(page, 80, key);
    await expect(card(page).getByRole('region', { name: 'Credited' })).toContainText('+10 renown');
    await expect(card(page).getByRole('region', { name: 'Credited' })).toContainText('Rating +13');
    await card(page).screenshot({ path: testInfo.outputPath('arena-card-human-credited.png') });
    expect(remote).toEqual([]);
  });

  test('reports NPC and human losses with no lasting injury, crediting their reduced rewards', async ({ page }, testInfo) => {
    await arenaFlow.openAtMinute(page, 80, 'ownerNpcLoss');
    await expect(card(page).getByRole('region', { name: 'Result' })).toContainText('Defeat');
    await expect(card(page)).toContainText('no lasting injury and no gear lost');
    await expect(card(page).getByRole('region', { name: 'Credited' })).toHaveText(/No renown\s*No rating change/);
    await card(page).screenshot({ path: testInfo.outputPath('arena-card-npc-loss.png') });
    await arenaFlow.openAtMinute(page, 80, 'ownerHumanLoss');
    await expect(card(page).getByRole('region', { name: 'Result' })).toContainText('Defeat');
    await expect(card(page)).toContainText('no lasting injury and no gear lost');
    await expect(card(page).getByRole('region', { name: 'Credited' })).toHaveText(/\+2 renown\s*Rating −13/);
    await arenaFlow.openAtMinute(page, 80, 'ownerTieBreak');
    await expect(card(page).getByRole('region', { name: 'Result' })).toContainText('A seeded tie-break named Aster the winner.');
  });

  test('says Preparing while the worker is late, invents no result, and asks again', async ({ page }, testInfo) => {
    await arenaFlow.openAtMinute(page, 65, 'ownerDelayed');
    await expect(card(page).getByRole('status')).toHaveText('Preparing');
    await expect(card(page)).toContainText('has not been published yet');
    await expect(page.getByRole('button', { name: 'Watch replay' })).toBeDisabled();
    await expect(card(page).getByRole('definition')).toHaveCount(0);
    const reads = await page.evaluate(() => window.__cloudiatorArena!.reads());
    await arenaFlow.openAtMinute(page, 65.6, 'ownerDelayed');
    await page.waitForFunction(n => window.__cloudiatorArena!.reads() > n, reads);
    await arenaFlow.openAtMinute(page, 85, 'ownerDelayed');
    await expect(card(page)).toContainText('Processing results');
    await card(page).screenshot({ path: testInfo.outputPath('arena-card-worker-delay.png') });
  });

  test('never shows a spectator the rewards', async ({ page }) => {
    await arenaFlow.openAtMinute(page, 85, 'varroSpectator');
    await expect(card(page).getByRole('status')).toHaveText('Completed');
    await expect(card(page).getByRole('region', { name: 'Result' })).toContainText('Defeat');
    await expect(card(page)).toContainText('Rewards are private');
    await expect(card(page)).not.toContainText(/renown|Rating [+−]/i);
    expect((await arenaState(page))!.owner).toBe(false);
  });

  test('opens the selected bout as an expanded replay and returns to the camp', async ({ page }) => {
    await arenaFlow.openAtMinute(page, 61, 'ownerNpcWin');
    await page.getByRole('button', { name: 'Watch replay' }).click();
    await page.waitForURL(url => url.pathname === '/replay/');
    const url = new URL(page.url());
    expect(Object.fromEntries(url.searchParams)).toEqual({ mode: 'fixture', activity: arenaActivityId('ownerNpcWin'), stage: `${arenaActivityId('ownerNpcWin')}:1` });
    await expect(page.getByRole('heading', { level: 1, name: 'Aster vs Iron Warden' })).toBeVisible({ timeout: 45_000 });
    await page.getByRole('link', { name: 'Back to camp' }).click();
    await page.waitForURL(u => u.pathname === '/game/');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    expect(await page.evaluate(() => window.__cloudiatorCamp!.canvases())).toBe(1);
    await openSample(page, 'ownerNpcWin');
    await expect(page.getByRole('button', { name: 'Watch replay' })).toBeEnabled();
  });

  test('reads Arena timelines for the camp only once bouts are due, and pauses while the tab is hidden', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/game/?mode=fixture');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    const entrants = await page.evaluate(() => window.__cloudiatorCamp!.world()!.actors.filter(a => a.location === 'arena' && a.visibleStage?.kind === 'staging').map(a => a.activityId));
    expect(entrants.sort()).toEqual(ENTRANTS.map(a => a.activityId).sort());
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), S + 59 * MIN);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.arenaReads())).toBe(0);
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), S + 60 * MIN);
    await page.waitForFunction(n => window.__cloudiatorCamp!.arenaTimelines().length >= n, ENTRANTS.length);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.arenaReads())).toBe(ENTRANTS.length);
    await page.waitForFunction(() => window.__cloudiatorCamp!.state()!.arena.fights.length === 7);
    // Only the delayed bout is asked for again, 30 s later, and never while the tab is hidden.
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); });
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), S + 60 * MIN + 31_000);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.arenaReads())).toBe(ENTRANTS.length);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); });
    await page.waitForFunction(n => window.__cloudiatorCamp!.arenaReads() === n + 1, ENTRANTS.length);
  });

  for (const motion of ['reduce', 'no-preference'] as const) {
    test(`scrolls the card into view and focuses its heading when a camp bout opens it (${motion} motion)`, async ({ page }, testInfo) => {
      await page.emulateMedia({ reducedMotion: motion });
      await page.goto('/game/?mode=fixture');
      await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
      await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), S + 60 * MIN + 12_000);
      const fights = page.getByRole('group', { name: 'Arena bouts in the rings' });
      await expect(fights.getByRole('button')).toHaveCount(6, { timeout: 15_000 });
      const heading = (name: string) => card(page).getByRole('heading', { name });
      const inView = (name: string) => heading(name).evaluate(h => { const r = h.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
      await fights.getByRole('button', { name: 'Bellator vs Corvina' }).click();
      await expect(heading('Bellator')).toBeFocused();
      // Reduced motion jumps (no smooth scroll); otherwise the scroll may still be running.
      if (motion === 'reduce') expect(await inView('Bellator')).toBe(true);
      await expect(heading('Bellator')).toBeInViewport();
      // A click on a fighter in its ring, after scrolling back to the camp.
      await page.locator('canvas').scrollIntoViewIfNeeded();
      await expect(heading('Bellator')).not.toBeInViewport();
      const id = ARENA_GLADIATORS.lucilla.id;
      const lucilla = (await campState(page)).actors.find(a => a.id === id)!;
      await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: lucilla.x, y: lucilla.y });
      await nextFrames(page);
      const at = (await page.evaluate(x => window.__cloudiatorCamp!.screenOf(x), id))!;
      const box = (await page.locator('canvas').boundingBox())!;
      await page.mouse.click(box.x + at.x, box.y + at.y - 40);
      await expect(heading('Lucilla')).toBeFocused();
      if (motion === 'reduce') expect(await inView('Lucilla')).toBe(true);
      await expect(heading('Lucilla')).toBeInViewport();
      if (motion === 'reduce') await page.screenshot({ path: testInfo.outputPath('arena-card-opened-from-camp.png') });
    });
  }

  test('leaves the page where it is when a camp bout opens a card that is already in view (desktop)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'The desktop layout shows the card beside the camp.');
    await page.emulateMedia({ reducedMotion: 'reduce' }); // a scroll would be an instant jump
    await page.goto('/game/?mode=fixture');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), S + 60 * MIN + 12_000);
    const selection = { activityId: arenaActivityId('bellator'), gladiatorId: ARENA_GLADIATORS.bellator.id };
    await page.evaluate(next => window.__cloudiatorArena!.open(next), selection);
    const heading = card(page).getByRole('heading', { name: 'Bellator' });
    await expect(card(page).getByRole('status')).toHaveText('Bout in progress');
    // Scroll so the whole card shows below the top of the view, as when a player reads it beside the camp.
    await card(page).evaluate(el => { const r = el.getBoundingClientRect(); window.scrollTo(0, window.scrollY + r.top - Math.max(40, (window.innerHeight - r.height) / 2)); });
    const box = () => card(page).evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, view: window.innerHeight, scrollY: window.scrollY }; });
    const before = await box();
    expect(before.top, 'the card starts below the top of the view').toBeGreaterThan(20);
    expect(before.bottom, 'the whole card is in view').toBeLessThanOrEqual(before.view);
    // The event a fighter click or a bout button sends.
    await page.evaluate(next => window.__cloudiatorCamp!.emit('open-arena', next), selection);
    await expect(heading).toBeFocused();
    await nextFrames(page);
    expect((await box()).scrollY, 'the page did not scroll').toBe(before.scrollY);
  });

  test('ends the ring fight when its card shows the result, never before', async ({ page }) => {
    await page.goto('/game/?mode=fixture');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    const start = S + 60 * MIN;
    const end = start + LOGS.campOne.durationMs;
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), start);
    await page.waitForFunction(() => window.__cloudiatorCamp!.state()!.arena.fights.length === 7);
    await page.evaluate(selection => window.__cloudiatorArena!.open(selection), { activityId: arenaActivityId('bellator'), gladiatorId: ARENA_GLADIATORS.bellator.id });
    const times = [...Array.from({ length: Math.ceil((end + 4000 - start) / 500) }, (_, i) => start + i * 500), end - 1, end].sort((p, q) => p - q);
    const seen = new Map<number, [string, string | null]>();
    for (const t of times) {
      await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), t);
      await page.waitForFunction(ms => { const s = window.__cloudiatorArena!.state(); return !!s && s.minute !== null && Math.abs(s.minute * 60_000 - ms) < 1; }, t - S);
      await nextFrames(page);
      const [status, result] = await page.evaluate(id => [
        window.__cloudiatorCamp!.state()!.arena.fights.find(f => f.battleId === id)!.status, window.__cloudiatorArena!.state()!.result,
      ] as [string, string | null], arenaBattleId('campOne'));
      if (status === 'fighting') expect(result, `the card shows a result ${t - start} ms in, while the ring still fights`).toBeNull();
      seen.set(t, [status, result]);
    }
    // The pair arrived in time: its ring fight and the card change over at the bout's logged end.
    expect(seen.get(end - 1)).toEqual(['fighting', null]);
    expect(seen.get(end)).toEqual(['result', 'victory']);
  });

  test('opens the card from a fighting pair in the camp, by click and by keyboard', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/game/?mode=fixture');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), S + 60 * MIN + 15_000);
    const fights = page.getByRole('group', { name: 'Arena bouts in the rings' });
    await expect(fights.getByRole('button')).toHaveCount(6, { timeout: 15_000 });
    await fights.getByRole('button', { name: 'Bellator vs Corvina' }).focus();
    await page.keyboard.press('Enter');
    await expect(card(page).getByRole('heading', { name: 'Bellator' })).toBeVisible();
    await expect(card(page).getByRole('status')).toHaveText('Bout in progress');
    await expect(card(page).getByRole('definition').first()).toHaveText('Corvina');
    // A click on a fighter in the ring opens that fighter's own card.
    const id = ARENA_GLADIATORS.lucilla.id;
    const lucilla = (await campState(page)).actors.find(a => a.id === id)!;
    await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: lucilla.x, y: lucilla.y });
    await nextFrames(page);
    // Opening Bellator's card scrolled the page to it; the camp comes back into view for the click.
    await page.locator('canvas').scrollIntoViewIfNeeded();
    const at = (await page.evaluate(x => window.__cloudiatorCamp!.screenOf(x), id))!;
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.click(box.x + at.x, box.y + at.y - 40);
    await expect(card(page).getByRole('heading', { name: 'Lucilla' })).toBeVisible();
    expect((await arenaState(page))!.activityId).toBe(arenaActivityId('lucilla'));
  });

  test('pages league standings and shows the owner’s rating, renown and current strength apart from them', async ({ page, baseURL }, testInfo) => {
    const remote = forbidRemote(page, baseURL);
    await openGame(page);
    await page.getByRole('button', { name: 'Standings', exact: true }).click();
    const table = page.getByRole('table', { name: 'Bronze league standings' });
    await expect(table.locator('tbody tr')).toHaveCount(50);
    await expect(table).toContainText('Promoted');
    await expect(table).toContainText('Inactive');
    await expect(table.locator('tr[aria-current="true"]')).toContainText('Aster');
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await expect(table.locator('tbody tr')).toHaveCount(58);
    await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
    const own = page.getByRole('region', { name: 'Your standing' });
    await expect(own.getByRole('definition')).toHaveText(['Bronze', '1015', '25', '412']);
    const rules = page.getByRole('region', { name: 'How leagues work' });
    for (const range of ['index below 25', 'index 25–59', 'index 60–119', 'index 120 and above']) await expect(rules).toContainText(range);
    await page.getByRole('group', { name: 'League' }).getByRole('button', { name: 'Silver' }).click();
    await expect(page.getByRole('table', { name: 'Silver league standings' }).locator('tbody tr')).toHaveCount(12);
    await page.getByRole('group', { name: 'League' }).getByRole('button', { name: 'Champion' }).click();
    await expect(page.getByText('No standings in the Champion league yet.')).toBeVisible();
    await page.getByRole('group', { name: 'League' }).getByRole('button', { name: 'Bronze' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(50);
    await page.getByRole('region', { name: 'Gladiator management' }).screenshot({ path: testInfo.outputPath('standings-bronze.png') });
    expect(remote).toEqual([]);
  });

  test('opens a spectator Arena card from the camp without owner rewards', async ({ page, baseURL }) => {
    const remote = forbidRemote(page, baseURL);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // The visitor preview: the fixture camp and reads, with no owner.
    await page.goto('/game/?mode=fixture&as=visitor');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    await expect(page.getByRole('heading', { name: 'A legend awaits' })).toBeVisible();
    const arena = page.getByRole('region', { name: 'Arena bouts' });
    await expect(arena).toBeVisible();
    await expect(arena.getByRole('button', { name: 'Your arena bout' })).toHaveCount(0);
    // A fight button in the camp opens that entrant's card.
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), S + 60 * MIN + 12_000);
    const fights = page.getByRole('group', { name: 'Arena bouts in the rings' });
    await expect(fights.getByRole('button')).toHaveCount(6, { timeout: 15_000 });
    await fights.getByRole('button', { name: 'Bellator vs Corvina' }).click();
    await expect(card(page).getByRole('heading', { name: 'Bellator' })).toBeFocused();
    await expect(card(page).getByRole('status')).toHaveText('Bout in progress');
    expect((await arenaState(page))!.owner).toBe(false);
    // The owner's credited bout, opened from the camp by a visitor: its public stages and result, never its rewards.
    await page.evaluate(next => window.__cloudiatorCamp!.emit('open-arena', next), { activityId: arenaActivityId('ownerHumanWin'), gladiatorId: ARENA_GLADIATORS.aster.id });
    await page.waitForFunction(id => window.__cloudiatorArena?.state()?.activityId === id, arenaActivityId('ownerHumanWin'));
    await page.evaluate(ms => window.__cloudiatorArena!.freeze(ms), startOf('ownerHumanWin') + 85 * MIN);
    await expect(card(page).getByRole('status')).toHaveText('Completed');
    await expect(card(page).getByRole('region', { name: 'Result' })).toContainText('Victory');
    await expect(card(page)).toContainText('Rewards are private');
    await expect(card(page).getByRole('region', { name: 'Credited' })).toHaveCount(0);
    await expect(card(page)).not.toContainText(/renown|Rating [+−]|CREDITED/i);
    const state = (await arenaState(page))!;
    expect([state.owner, state.phase, state.credited, state.awaitingSummary]).toEqual([false, 'completed', null, false]);
    expect(remote).toEqual([]);
  });

  test('works by keyboard alone', async ({ page }) => {
    await openGame(page);
    const sample = page.getByRole('button', { name: labelOf('ownerNpcWin'), exact: true });
    await sample.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !!window.__cloudiatorArena?.state());
    await page.evaluate(ms => window.__cloudiatorArena!.freeze(ms), startOf('ownerNpcWin') + 61 * MIN);
    const watch = page.getByRole('button', { name: 'Watch replay' });
    await expect(watch).toBeEnabled();
    await watch.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(url => url.pathname === '/replay/');
  });

  test('fits a 360 px phone with reduced motion', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 760 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await arenaFlow.openAtMinute(page, 80, 'ownerHumanWin');
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await wide()).toBeLessThanOrEqual(0);
    await card(page).scrollIntoViewIfNeeded();
    await card(page).screenshot({ path: testInfo.outputPath('width360-arena-card.png') });
    await page.getByRole('button', { name: 'Standings', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Bronze league standings' }).locator('tbody tr')).toHaveCount(50);
    expect(await wide()).toBeLessThanOrEqual(0);
    await page.getByRole('region', { name: 'Your standing' }).screenshot({ path: testInfo.outputPath('width360-standings.png') });
  });
});

// ------------------------------------------------------------------ live standings follow the world revision
// Live mode through the test transport (Task 13.4): the shared sync controller's revision, not a timer in the panel,
// tells the standings to read again.

const standingsPage = (rows: StandingRow[]): StandingsPage => ({ league: 'bronze', seasonId: '3', archived: false, nextCursor: null, rows });
const standingRow = (gladiatorId: string, name: string, rank: number, rating: number): StandingRow =>
  ({ rank, gladiatorId, name, rating, humanWins: 1, humanLosses: 0, promoted: false, inactive: false, rewardEligible: false });

test.describe('live league standings', () => {
  test.skip(production, 'Live mode uses development-only intercepted Supabase transport.');

  test('re-reads standings when the revision changes, and not on its own timer', async ({ page, context }) => {
    const user = await seedSession(context);
    const owner = structuredClone(ownerFixture);
    const varro = ARENA_GLADIATORS.varro.id;
    const world = emptyWorld();
    const live = await routeLiveReads(context, { world, owner, standings: [standingsPage([standingRow(owner.gladiatorId, 'Aster', 1, 1000), standingRow(varro, 'Varro', 2, 990)])] });
    await page.clock.install();
    await page.goto('/game/');
    await page.getByRole('button', { name: 'Standings', exact: true }).click();
    const table = page.getByRole('table', { name: 'Bronze league standings' });
    await expect(table.getByRole('row', { name: /Aster/ })).toContainText('1000');
    const own = page.getByRole('region', { name: 'Your standing' }).getByRole('definition');
    await expect(own.nth(1)).toHaveText('1000');
    const reads = () => live.count('arena_standing_reads');
    const first = reads();
    // No timer of its own: the shared clock passes a slot boundary and five minutes go by with the same revision.
    await page.evaluate(() => { const clock = window.__cloudiatorShell!.clock; clock.freeze((Math.floor(clock.now() / 4_800_000) + 1) * 4_800_000 + 1000); });
    for (let poll = 0; poll < 10; poll++) await page.clock.fastForward(30_000);
    await page.waitForTimeout(500);
    expect(reads()).toBe(first);
    // The server credits a result, which changes the world revision: the shown standings and the owner are read again.
    live.setStandings([standingsPage([standingRow(owner.gladiatorId, 'Aster', 1, 1013), standingRow(varro, 'Varro', 2, 977)])]);
    live.setOwner({ ...owner, progression: { ...owner.progression, rating: 1013 } });
    live.setWorld({ ...world, revision: 'empty-2' });
    await page.clock.fastForward(30_000);
    await expect.poll(reads).toBe(first + 1);
    await expect(table.getByRole('row', { name: /Aster/ })).toContainText('1013');
    await expect(own.nth(1)).toHaveText('1013');
    // The same revision again: nothing more.
    await page.clock.fastForward(30_000);
    await page.waitForTimeout(500);
    expect(reads()).toBe(first + 1);
    expect(live.requests.filter(r => r.table === 'arena_standing_reads').every(r => r.reader === user.id)).toBe(true);
  });

  test('keeps the rows loaded with More when a new revision re-reads them', async ({ page, context }) => {
    const world = emptyWorld();
    const live = await routeLiveReads(context, { world, standings: [standingsPage(ARENA_STANDINGS.bronze)] });
    await page.clock.install();
    await page.goto('/game/');
    await page.getByRole('button', { name: 'Standings', exact: true }).click();
    const table = page.getByRole('table', { name: 'Bronze league standings' });
    await expect(table.locator('tbody tr')).toHaveCount(50);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await expect(table.locator('tbody tr')).toHaveCount(ARENA_STANDINGS.bronze.length);
    const reads = live.count('arena_standing_reads');
    live.setWorld({ ...world, revision: 'empty-2' });
    await page.clock.fastForward(30_000);
    // Both loaded pages are read again, and every row stays.
    await expect.poll(() => live.count('arena_standing_reads')).toBe(reads + 2);
    await page.waitForTimeout(500);
    await expect(table.locator('tbody tr')).toHaveCount(ARENA_STANDINGS.bronze.length);
    await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
    // A visitor's standings reads are anonymous.
    expect(live.requests.every(r => r.reader === null)).toBe(true);
  });
});
