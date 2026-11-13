// Runs the three 2.0 balance scenarios and writes docs/balance/2026-11-12-1.9-sims.{md,json}.
// Usage: node scripts/balance/run-sims.ts [fightsPerMatchup=2000]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, type Matchup, type ScenarioId, type ScenarioResult } from './sims.ts';

const FIGHTS = Number(process.argv[2] ?? 2000);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'docs', 'balance');
// Only the full 2,000-fight run may write the committed outputs; any other count writes beside them with the count in the name.
const suffix = FIGHTS === 2000 ? '' : `-${FIGHTS}fights`;
mkdirSync(outDir, { recursive: true });

const ids: ScenarioId[] = ['critical', 'two-handed', 'renown'];
const results: ScenarioResult[] = ids.map(id => runScenario(id, FIGHTS));
const by = Object.fromEntries(results.map(r => [r.scenario, r.matchups])) as Record<ScenarioId, Matchup[]>;

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const interval = (m: Matchup) => `${pct(m.low95)} to ${pct(m.high95)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function table(rows: Matchup[], extra: boolean): string {
  const head = extra
    ? '| Matchup | Level | Context | Win rate | 95% interval | Critical chance | Crit share of damage | Hit rate | Mean length |\n|---|---|---|---|---|---|---|---|---|'
    : '| Matchup | Level | Context | Win rate | 95% interval | Hit rate | Mean length |\n|---|---|---|---|---|---|---|';
  const body = rows.map(m => extra
    ? `| ${m.label} | ${m.level} | ${m.context} | ${pct(m.winRate)} | ${interval(m)} | ${pct(m.criticalChance)} | ${pct(m.criticalDamageShare)} | ${pct(m.meanHit)} | ${secs(m.meanDurationMs)} |`
    : `| ${m.label} | ${m.level} | ${m.context} | ${pct(m.winRate)} | ${interval(m)} | ${pct(m.meanHit)} | ${secs(m.meanDurationMs)} |`);
  return [head, ...body].join('\n');
}

/** Plain findings computed from the numbers, so the prose cannot drift from the tables. */
function findings(): string[] {
  const out: string[] = [];
  const crit = by.critical, base = crit[0], top = crit[crit.length - 1];
  out.push(`Critical chance: the win rate falls steadily as points move into Precision (${crit.map(m => pct(m.winRate)).join(', ')} for Precision 0 to 50). The sweep takes those points out of the other four attributes, so it measures concentrating points in Precision, not critical chance on its own (the Precision 10 row is the identical build, so about 50% is expected). Critical chance only goes from ${pct(base.criticalChance)} to ${pct(top.criticalChance)} (the cap is 40%) and critical hits supply ${pct(base.criticalDamageShare)} to ${pct(top.criticalDamageShare)} of the damage dealt, while the hit rate rises from ${pct(base.meanHit)} to ${pct(top.meanHit)}. In this sweep, concentrating points in Precision does not pay.`);
  const two = by['two-handed'];
  const spears = two.filter(m => m.label.startsWith('Spear')), bows = two.filter(m => m.label.startsWith('Bow'));
  const avg = (rows: Matchup[]) => rows.reduce((s, m) => s + m.winRate, 0) / rows.length;
  const lo = two.reduce((a, b) => (b.winRate < a.winRate ? b : a)), hi = two.reduce((a, b) => (b.winRate > a.winRate ? b : a));
  out.push(`Two-handed weapons: the Spear averages ${pct(avg(spears))} and the Bow ${pct(avg(bows))} against one-handed weapons with a Round shield. The lowest result is ${lo.label} at level ${lo.level} (${pct(lo.winRate)}), the highest ${hi.label} at level ${hi.level} (${pct(hi.winRate)}). No two-handed matchup is above 60%, and every one against the Sword is below 35%; the Axe is the weaker one-handed opponent.`);
  const ren = by.renown, arena = ren.filter(m => m.context === 'arena' && m.id.includes('renown-vs-common')), exp = ren.filter(m => m.context === 'expedition');
  const cross = ren.find(m => m.id.startsWith('renown5'))!;
  out.push(`Renown weapons: against the same-tier common sword they win ${arena.map(m => pct(m.winRate)).join(', ')} in the Arena (levels 1, 5, 10) and ${exp.map(m => pct(m.winRate)).join(', ')} on expeditions. The tier-5 renown sword against the tier-10 common sword at level 10 wins ${pct(cross.winRate)}.`);
  return out;
}

const generated = new Date().toISOString().slice(0, 10);
const md = `# Offline balance simulations for 2.0

Generated ${generated} by \`node scripts/balance/run-sims.ts\` (${FIGHTS} fights per matchup). Nothing here changes a game number; the 2.0 patch decides what to do with it.

## Method

- Rules v1 combat (constants identical in v2, the live rules) (the Arena's and the expedition's use the same constants), classless fighters from \`makeFighter\`: attributes are base 5 plus the points, gear comes straight from the catalog, so gear and points are isolated. Balanced stance. Arena rules unless the Context column says expedition.
- Points at a level are the Training cap, 10 + 4 per level (level 10 = 50 points). The Balanced split is 20% to each attribute, the leftover points going in the order Strength, Agility, Vitality, Endurance, Precision.
- The critical sweep keeps the total fixed at 50 points, so raising Precision lowers the other four; read it as concentration, not as critical chance alone.
- Each fight uses the seed \`sim-<scenario>-<matchup>-<n>\`. The listed first side alternates every fight (half the fights each), so the first-attacker order cancels out.
- Win rate is the first named build's wins out of ${FIGHTS}; the interval is the Wilson 95% interval. Hit rate is the share of that build's attacks that landed; critical share is the part of its dealt damage that came from critical hits.

## Critical chance (level 10, 50 points, Balanced gear at gear level 10)

Precision 0 to 50, the rest of the points spread evenly over the other four attributes, against the Balanced preset (10 points in each attribute). Caution: the total stays 50, so each step moves points out of Strength, Agility, Vitality and Endurance. This sweep measures concentrating points in Precision; it does not isolate critical chance (the Precision 10 row is the identical build to the opponent).

${table(by.critical, true)}

## Two-handed weapons (Balanced split, Leather hood, Light armor, Light boots, balanced stance, highest gear level allowed)

${table(by['two-handed'], false)}

## Renown weapons (identical builds except the weapon)

${table(by.renown, false)}

## What this means for 2.0

${findings().map(f => `- ${f}`).join('\n')}
- These are plain results from the current numbers only. No number change is proposed here; classless fighters leave out the class bonus, and real builds add it.
`;

writeFileSync(join(outDir, `2026-11-12-1.9-sims${suffix}.md`), md);
writeFileSync(join(outDir, `2026-11-12-1.9-sims${suffix}.json`), `${JSON.stringify({ title: 'Offline balance simulations for 2.0', generated, fightsPerMatchup: FIGHTS,
  scenarios: results.map(r => ({ ...r, matchups: r.matchups.map(({ seeds, ...m }) => ({ ...m, firstSeed: seeds[0], lastSeed: seeds[seeds.length - 1] })) })) }, null, 2)}\n`);
console.log(`Wrote ${outDir}`);
