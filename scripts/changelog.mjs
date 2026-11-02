// docs/CHANGELOG.md read as the list of patches (Patch A spec, "Patch numbers and the changelog"). Each patch is a `##` heading
//   ## <number> — <title> (<YYYY-MM-DD>)                      a released patch
//   ## <number> — <title> (in progress, not yet released)      the patch being built
// followed by its features, one `- ` bullet each. A `### Built` or `### Planned` sub-heading only marks the section as planned (in
// progress); the bullets under it are its features. A `##` heading without a patch number ("Videos") is not a patch, and nothing
// outside a patch section is read. The released sections are the server's rows word for word (tests/db/patches.test.ts compares
// the M26 seed with them; scripts/patch-statement.mjs builds the release's record_patch statement from them).

/** The server's pattern for a patch number (public.patches.number; src/lib/patch.ts). */
export const PATCH_NUMBER = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})(\.[1-9][0-9]{0,2})?$/;

const HEADING = /^## (\S+) — (.+?)(?: \((\d{4}-\d{2}-\d{2}|in progress, not yet released)\))?$/;

/**
 * @typedef {{ number: string; title: string; date: string | null; features: string[]; planned: boolean }} ChangelogSection
 */

/**
 * The patches of a changelog, in its order (newest first).
 * @param {string} text the changelog's text
 * @returns {ChangelogSection[]}
 */
export function parseChangelog(text) {
  /** @type {ChangelogSection[]} */
  const sections = [];
  /** @type {ChangelogSection | null} */
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      const match = HEADING.exec(line);
      current = match && PATCH_NUMBER.test(match[1])
        ? { number: match[1], title: match[2], date: /^\d{4}-\d{2}-\d{2}$/.test(match[3] ?? '') ? match[3] : null, features: [], planned: false }
        : null;
      if (current) sections.push(current);
    } else if (current && /^### (Built|Planned)$/.test(line)) {
      current.planned = true;
    } else if (current && line.startsWith('- ')) {
      current.features.push(line.slice(2).trim());
    }
  }
  return sections;
}
