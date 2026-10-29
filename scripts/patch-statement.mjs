import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangelog } from './changelog.mjs';

// The release's record of a patch (Patch A spec, "Patch numbers and the changelog", Release; docs/operations/runbook.md,
// "Recording a patch"):
//   node scripts/patch-statement.mjs <number> [--message <id>]
// writes the one statement that records the patch, private.record_patch(number, title, features, message_id), with CHANGELOG.md's
// section word for word, to %TEMP%\cloudiator-patch-<number>.sql (UTF-8 without a byte-order mark) and prints its path. Avi
// approves it with the patch note; the operator runs it with the linked CLI after his go. It connects to nothing.
// It refuses a number with no section, a section still in progress, and a text holding the statement's own dollar quotes ($t$,
// $f$). Exit codes: 0 written, 2 refused or a usage error (the reason on stderr).

/** @typedef {import('./changelog.mjs').ChangelogSection} ChangelogSection */

/**
 * The record_patch statement for one released section.
 * @param {ChangelogSection[]} sections the changelog's patches (parseChangelog)
 * @param {string} number the patch to record
 * @param {number | null} messageId the patch note's id, or null for a patch without a note
 * @returns {string}
 */
export function patchStatement(sections, number, messageId) {
  const section = sections.find(s => s.number === number);
  if (!section) throw new Error(`There is no section for patch ${number} in CHANGELOG.md.`);
  if (section.planned || section.date === null) throw new Error(`Patch ${number} is in progress: finalize its section first.`);
  if (messageId !== null && !(Number.isSafeInteger(messageId) && messageId > 0)) throw new Error('The message id must be a positive whole number.');
  if ([section.title, ...section.features].some(text => text.includes('$t$') || text.includes('$f$'))) {
    throw new Error(`Patch ${number} holds a dollar quote ($t$ or $f$) the statement uses.`);
  }
  return 'select private.record_patch(\n'
    + `  '${section.number}',\n`
    + `  $t$${section.title}$t$,\n`
    + `  array[${section.features.map(f => `$f$${f}$f$`).join(', ')}],\n`
    + `  ${messageId === null ? 'null' : String(messageId)}\n`
    + ') as number;\n';
}

/**
 * The command's arguments: the number, then an optional `--message <id>`.
 * @param {string[]} argv
 * @returns {{ number: string; messageId: number | null }}
 */
export function parseArgs(argv) {
  const [number, flag, id, ...rest] = argv;
  if (!number || rest.length > 0 || (flag !== undefined && (flag !== '--message' || !/^[1-9][0-9]{0,15}$/.test(id ?? '')))) {
    throw new Error('Usage: node scripts/patch-statement.mjs <number> [--message <id>]');
  }
  return { number, messageId: flag === undefined ? null : Number(id) };
}

const isMain = () => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};

if (isMain()) {
  try {
    const { number, messageId } = parseArgs(process.argv.slice(2));
    const changelog = readFileSync(fileURLToPath(new URL('../docs/CHANGELOG.md', import.meta.url)), 'utf8');
    const statement = patchStatement(parseChangelog(changelog), number, messageId);
    const path = join(tmpdir(), `cloudiator-patch-${number}.sql`);
    // A string written as 'utf8' carries no byte-order mark.
    writeFileSync(path, statement, 'utf8');
    console.log(path);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
