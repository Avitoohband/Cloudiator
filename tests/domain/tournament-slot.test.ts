import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { slotAt } from '@domain/clock';
import { isTournamentSlot as reexported } from '@domain/tournament';
import { RULES_V1 } from '@domain/rules-v1';

// Tasks 19 (M5) and 20: the client's tournament stage core names tournament slots through an engine-free module, so
// its import graph holds no combat engine even before tree shaking. The walk reads the source text: every import and
// export-from specifier (type-only ones too), with the repo's path aliases, and the `.ts` specifiers the Edge code uses.

const ROOT = resolve('.');
const ALIASES: Record<string, string> = {
  '@domain/': 'supabase/functions/_shared/domain/',
  '@contracts/': 'supabase/functions/_shared/contracts/',
  '@/': 'src/',
};
const ENGINE = ['supabase/functions/_shared/domain/combat.ts', 'supabase/functions/_shared/domain/tournament.ts', 'supabase/functions/_shared/domain/arena.ts'];

function resolveImport(from: string, specifier: string): string | null {
  const alias = Object.keys(ALIASES).find(prefix => specifier.startsWith(prefix));
  const base = alias ? resolve(ROOT, ALIASES[alias] + specifier.slice(alias.length)) : specifier.startsWith('.') ? resolve(dirname(from), specifier) : null;
  if (base === null) return null; // a package (react, phaser, ...): not part of the domain graph
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
  if (existsSync(base)) return null; // JSON data or a stylesheet: no imports of its own
  throw new Error(`cannot resolve ${specifier} from ${from}`);
}

/** Every module reachable from `entry` through import and export-from statements, as repo-relative paths. */
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(ROOT, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
      const target = resolveImport(file, match[1] ?? match[2]);
      if (target) queue.push(target);
    }
  }
  return [...seen].map(file => file.slice(ROOT.length + 1).replaceAll('\\', '/')).sort();
}

describe('the engine-free tournament slot rule (Tasks 19 M5, 20)', () => {
  it('isTournamentSlot imports no combat engine', () => {
    const graph = importGraph('supabase/functions/_shared/domain/tournament-slot.ts');
    expect(graph).toContain('supabase/functions/_shared/domain/clock.ts');
    for (const engine of ENGINE) expect(graph, engine).not.toContain(engine);
  });

  it('keeps the client stage core and the camp free of the combat engine', () => {
    for (const entry of ['src/game/tournament-stage.ts', 'src/game/tournament-camp.ts', 'src/features/tournaments/TournamentPanel.tsx']) {
      const graph = importGraph(entry);
      for (const engine of ENGINE) expect(graph, `${entry} reaches ${engine}`).not.toContain(engine);
      expect(graph, entry).toContain('supabase/functions/_shared/domain/tournament-slot.ts');
    }
  });

  it('is the very rule the backend uses: tournament.ts re-exports it', async () => {
    const { isTournamentSlot } = await import('@domain/tournament-slot');
    expect(reexported).toBe(isTournamentSlot);
    const wednesday = Date.UTC(2026, 9, 14, 18, 40);
    expect(isTournamentSlot(slotAt(wednesday))).toBe(true);
    expect(isTournamentSlot(slotAt(wednesday - 1))).toBe(false);
    expect(isTournamentSlot(slotAt(Date.UTC(2026, 9, 17, 18, 40)), RULES_V1)).toBe(true);
    // The old afternoon slot, an hour and twenty minutes earlier, is an ordinary slot now.
    expect(isTournamentSlot(slotAt(Date.UTC(2026, 9, 17, 17, 20)), RULES_V1)).toBe(false);
    expect(isTournamentSlot(slotAt(Date.UTC(2026, 9, 14, 17, 20)))).toBe(false);
    expect(slotAt(Date.UTC(2026, 9, 17, 18, 40)).phase).toBe('evening');
  });
});
