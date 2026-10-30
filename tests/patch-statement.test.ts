import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChangelog } from '../scripts/changelog.mjs';
import { patchStatement } from '../scripts/patch-statement.mjs';

// The release records each patch with private.record_patch from CHANGELOG.md's section, word for word (Patch A spec, "Patch numbers
// and the changelog", Release). scripts/patch-statement.mjs builds that one statement; Avi approves it with the patch note.
describe('patch statement', () => {
  it('writes the record statement from a released section, word for word', () => {
    const sections = parseChangelog(readFileSync('docs/CHANGELOG.md', 'utf8'));
    expect(patchStatement(sections, '1.2.1', null)).toBe("select private.record_patch(\n  '1.2.1',\n  $t$Clearer busy buttons$t$,\n"
      + '  array[$f$While a build, market, inventory or shop button sends its command, it dims and keeps the keyboard focus, and '
      + 'pressing it again does nothing.$f$],\n  null\n) as number;\n');
    expect(patchStatement(sections, '1.3.1', 4)).toMatch(/^select private\.record_patch\(\n  '1\.3\.1',\n  \$t\$Phone attribute points\$t\$,\n  array\[\$f\$Each attribute.*\$f\$, \$f\$Tap a points.*\$f\$, \$f\$The build step.*\$f\$\],\n  4\n\) as number;\n$/s);
  });

  type Section = ReturnType<typeof parseChangelog>[number];
  it('refuses a section in progress, an unknown number and a dollar quote in the text', () => {
    const at = (s: Partial<Section>) => [{ number: '2.0', title: 'x', date: '2027-01-01', features: ['a'], planned: false, ...s }];
    expect(() => patchStatement(at({ date: null, planned: true }), '2.0', 5)).toThrow(/in progress/);
    expect(() => patchStatement(at({}), '9.9', null)).toThrow(/no section/);
    expect(() => patchStatement(at({ features: ['a $f$ b'] }), '2.0', null)).toThrow(/dollar quote/);
    expect(() => patchStatement(at({ title: 'a $t$ b' }), '2.0', null)).toThrow(/dollar quote/);
  });

  // The command's refusal is pinned with a number CHANGELOG.md never has: the patch in progress is dated at its release, so the command
  // must not depend on it (the unit case above pins the in-progress refusal).
  it('writes the statement to the temporary folder as UTF-8 without a byte-order mark, and refuses an unknown number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-statement-'));
    try {
      const env = { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir };
      const run = spawnSync(process.execPath, ['scripts/patch-statement.mjs', '1.3.1', '--message', '4'], { encoding: 'utf8', env });
      expect(run.status).toBe(0);
      const path = join(dir, 'cloudiator-patch-1.3.1.sql');
      expect(run.stdout.trim()).toBe(path);
      const bytes = readFileSync(path);
      expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes.toString('utf8')).toBe(patchStatement(parseChangelog(readFileSync('docs/CHANGELOG.md', 'utf8')), '1.3.1', 4));
      const refused = spawnSync(process.execPath, ['scripts/patch-statement.mjs', '9.9'], { encoding: 'utf8', env });
      expect(refused.status).toBe(2);
      expect(refused.stderr).toMatch(/no section/);
      expect(readdirSync(dir)).toEqual(['cloudiator-patch-1.3.1.sql']);
      expect(spawnSync(process.execPath, ['scripts/patch-statement.mjs', '1.3.1', '--message', 'x'], { encoding: 'utf8', env }).status).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
