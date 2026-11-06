import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BattleLog } from '@contracts/events';
import { BattleReplay } from '@/features/arena/BattleReplay';
import { titleLookupOf, type TitleLookup } from '@/features/titles/title-text';
import { FIXTURE_BATTLE_LOGS } from '../fixtures/battles';

const pvp: BattleLog = FIXTURE_BATTLE_LOGS.pvp;
const npc: BattleLog = FIXTURE_BATTLE_LOGS.npc;
const [ASTER, VARRO] = [pvp.participants[0].gladiatorId!, pvp.participants[1].gladiatorId!];

function header(log: BattleLog, titles?: TitleLookup): string {
  const view = { kind: 'replay' as const, selected: 0, summary: null, battles: [{ log, stage: {
    id: 'stage-1', kind: 'bout' as const, label: 'Arena bout', revealedAtMs: 0, startedAtMs: 0, endsAtMs: 60_000 } }] };
  return renderToStaticMarkup(createElement(BattleReplay, { view, titles }));
}
const titleLines = (html: string) => [...html.matchAll(/<div[^>]*data-fighter-title=""[^>]*>([^<]*)<\/div>/g)].map(m => m[1]);

describe('the replay header shows each fighter’s worn title under its name', () => {
  it('shows the title under Aster only when the lookup knows one for Aster', () => {
    const titles = titleLookupOf({ [ASTER]: 'founder', [VARRO]: null });
    expect(titleLines(header(pvp, titles))).toEqual(['Founder']);
  });

  it('shows no title at all without the prop', () => {
    expect(titleLines(header(pvp))).toEqual([]);
  });

  it('gives an NPC or creature fighter no title, even from a lookup that answers for everything', () => {
    const always: TitleLookup = () => 'Founder';
    const lines = titleLines(header(npc, always));
    expect(lines).toEqual(['Founder']); // only the gladiator
  });

  // R4 regression guard (passes before the code: nothing rendered a title at all): an unknown or junk id shows nothing and never throws.
  it('shows nothing for an unknown or junk id, and nothing when the lookup throws', () => {
    expect(titleLines(header(pvp, titleLookupOf({ [ASTER]: 'not-a-title', [VARRO]: 42 })))).toEqual([]);
    expect(titleLines(header(pvp, () => { throw new Error('bad'); }))).toEqual([]);
  });
});
