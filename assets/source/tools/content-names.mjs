// Content-addressed atlas image names and the `build-assets.mjs --check` audit (final review F1, 2026-10-26).
// A page bundles every atlas's frame table into its JavaScript but fetches the atlas image by name, and `/assets/*` is not
// cached as immutable. An image named by its own bytes gets a new address whenever its art changes, so a tab left open
// across a release keeps loading the image that matches the frame table it already holds.
import { createHash } from 'node:crypto';

/** How many hex digits of the image's sha256 its name carries. */
export const HASH_DIGITS = 10;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The content-addressed name of an atlas image: `actors/gladiators.png` with these bytes is
 * `actors/gladiators.<first 10 hex digits of their sha256>.png`.
 * @param {string} path
 * @param {Uint8Array} bytes
 */
export function contentName(path, bytes) {
  if (!path.endsWith('.png')) throw new Error(`Not an atlas image: ${path}`);
  return `${path.slice(0, -'.png'.length)}.${sha256(bytes).slice(0, HASH_DIGITS)}.png`;
}

/**
 * Whether `file` is a content-addressed version of the atlas image `path` (of any bytes): the same folder and name, with a
 * hash of exactly HASH_DIGITS lowercase hex digits.
 * @param {string} path
 * @param {string} file
 */
export function isVersionOf(path, file) {
  return new RegExp(`^${escape(path.slice(0, -'.png'.length))}\\.[0-9a-f]{${HASH_DIGITS}}\\.png$`).test(file);
}

/**
 * What `--check` refuses, in order: each output that is missing or not byte-identical (`missing`, `stale`), each retained
 * image that is missing or not its recorded bytes (`retained-missing`, `retained-changed`), and each other file present
 * (`orphan`), such as a content-addressed image the generators no longer write. `allowed` files (hand-written) are accepted
 * as they are.
 * @param {{
 *   outputs: Map<string, Uint8Array>, present: string[], allowed: string[],
 *   retained: { file: string, sha256: string }[], read: (file: string) => Uint8Array | null,
 * }} input
 * @returns {{ file: string, problem: 'missing' | 'stale' | 'retained-missing' | 'retained-changed' | 'orphan' }[]}
 */
export function auditFiles({ outputs, present, allowed, retained, read }) {
  /** @type {{ file: string, problem: 'missing' | 'stale' | 'retained-missing' | 'retained-changed' | 'orphan' }[]} */
  const problems = [];
  for (const [file, bytes] of outputs) {
    const committed = read(file);
    if (!committed) problems.push({ file, problem: 'missing' });
    else if (!Buffer.from(committed).equals(Buffer.from(bytes))) problems.push({ file, problem: 'stale' });
  }
  for (const { file, sha256: expected } of retained) {
    const committed = read(file);
    if (!committed) problems.push({ file, problem: 'retained-missing' });
    else if (sha256(committed) !== expected) problems.push({ file, problem: 'retained-changed' });
  }
  const known = new Set([...outputs.keys(), ...allowed, ...retained.map(r => r.file)]);
  for (const file of present) if (!known.has(file)) problems.push({ file, problem: 'orphan' });
  return problems;
}
