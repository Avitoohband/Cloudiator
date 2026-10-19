import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import dbConfig from '../vitest.db.config.ts';

/**
 * Task 23.2 Decision 3 (C16): a database test that waits for a stable slot sleeps up to `margin + 1 000` ms when it starts in
 * the last `margin` ms of its 80-minute slot: through `stableRealSlot(margin)`, or inline as
 * `if (remaining < margin) await new Promise(resolve => setTimeout(resolve, remaining + 1_000))` (the market and shop hooks).
 * Its timeout must cover every such sleep it can reach plus its own work, which gets at least the suite's default timeout (a
 * test's testTimeout, a hook's hookTimeout). Checked statically over tests/db/*.test.ts, through any helper in the same file
 * that wraps the wait.
 */
const { testTimeout, hookTimeout } = dbConfig.test as { testTimeout: number; hookTimeout: number };
const WAIT = 'stableRealSlot';
const TESTS = new Set(['it', 'test']);
const HOOKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
const NUMBER = '([\\d_]+(?: [+*] [\\d_]+)*)';
const INLINE = new RegExp(`^if \\(remaining < ${NUMBER}\\) await new Promise\\(resolve => setTimeout\\(resolve, remaining \\+ ${NUMBER}\\)\\);?$`);

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
const isFunction = (node: ts.Node): node is FunctionNode =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
const isLoop = (node: ts.Node) => ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)
  || ts.isWhileStatement(node) || ts.isDoStatement(node);

/** A numeric literal (underscores allowed) or a sum, difference or product of them; anything else is undefined. */
function evaluate(node: ts.Expression | undefined): number | undefined {
  if (!node) return undefined;
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ''));
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression);
  if (ts.isBinaryExpression(node)) {
    const left = evaluate(node.left), right = evaluate(node.right);
    if (left === undefined || right === undefined) return undefined;
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
    if (node.operatorToken.kind === ts.SyntaxKind.MinusToken) return left - right;
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
  }
  return undefined;
}
/** The value of a constant expression written in source text, such as `60_000` or `2 * 30_000`. */
const constant = (text: string) => evaluate((ts.createSourceFile('x.ts', `(${text});`, ts.ScriptTarget.ES2022)
  .statements[0] as ts.ExpressionStatement).expression);
/** `it`, `test`, `it.skip`, `test.only`, … and the hooks, by the name at the root of the callee. */
function calleeRoot(call: ts.CallExpression): string | undefined {
  let callee: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
  return ts.isIdentifier(callee) ? callee.text : undefined;
}
const calleeName = (call: ts.CallExpression) => ts.isIdentifier(call.expression) ? call.expression.text : undefined;
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild(child => walk(child, visit));
}

/** Every problem in one test file's waits, as `file:line message`; an empty list when every wait fits its timeout. */
function waitProblems(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const at = (node: ts.Node) => `${file}:${line(node)}`;
  const problems: string[] = [];
  // The helpers declared in this file, by name: function declarations and `const name = (async) () => …` / `function`.
  const helpers = new Map<string, FunctionNode>();
  walk(source, node => {
    if (ts.isFunctionDeclaration(node) && node.name) helpers.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFunction(node.initializer)) {
      helpers.set(node.name.text, node.initializer);
    }
  });
  /** An inline wait's longest sleep, or undefined when `node` is not one. */
  const inlineSleep = (node: ts.Node): number | undefined => {
    if (!ts.isIfStatement(node)) return undefined;
    const match = INLINE.exec(node.getText(source).replace(/\s+/g, ' '));
    return match ? constant(match[1])! + constant(match[2])! : undefined;
  };
  const sites: ts.Node[] = [];
  walk(source, node => {
    if ((ts.isCallExpression(node) && calleeName(node) === WAIT) || inlineSleep(node) !== undefined) sites.push(node);
  });
  if (!sites.length) return problems;
  // stableRealSlot itself: `if (remaining < marginMs) … setTimeout(resolve, remaining + EXTRA)` sleeps at most margin + EXTRA.
  const wait = helpers.get(WAIT);
  let extra = 0, defaultMargin: number | undefined;
  if (sites.some(ts.isCallExpression)) {
    const body = wait?.getText(source).replace(/\s+/g, ' ') ?? '';
    const shape = new RegExp(`if \\(remaining < marginMs\\) await new Promise\\(resolve => setTimeout\\(resolve, remaining \\+ ${NUMBER}\\)\\)`).exec(body);
    if (!wait || !shape) {
      problems.push(`${wait ? at(wait) : file} ${WAIT} is not the known shape (sleep remaining + N when remaining < marginMs); update this check`);
      return problems;
    }
    extra = constant(shape[1])!;
    defaultMargin = evaluate(wait.parameters[0]?.initializer);
  }
  /** The longest sleep of one wait site, or undefined when it cannot be bounded statically. */
  const sleepOf = (site: ts.Node): number | undefined => {
    const inline = inlineSleep(site);
    if (inline !== undefined) return inline;
    const call = site as ts.CallExpression;
    const margin = call.arguments.length ? evaluate(call.arguments[0]) : defaultMargin;
    return margin === undefined ? undefined : margin + extra;
  };
  /** The longest total sleep reachable inside `scope`, through helper calls; a wait that may repeat is a problem. */
  const memo = new Map<string, { sleep: number; lines: string[] }>();
  function sleepWithin(scope: ts.Node, stack: string[], lines: string[], reached: Set<ts.Node>): number {
    let total = 0;
    walk(scope, node => {
      if (node === scope) return;
      let sleep: number | undefined;
      if (sites.includes(node)) {
        sleep = sleepOf(node);
        if (sleep === undefined) { problems.push(`${at(node)} ${WAIT}'s margin is not a numeric constant`); return; }
        lines.push(String(line(node)));
        reached.add(node);
      } else if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (!name || !helpers.has(name) || name === WAIT || stack.includes(name)) return;
        let known = memo.get(name);
        if (!known) {
          const inner: string[] = [];
          known = { sleep: sleepWithin(helpers.get(name)!.body ?? helpers.get(name)!, [...stack, name], inner, viaHelpers), lines: inner };
          memo.set(name, known);
        }
        if (!known.sleep) return;
        sleep = known.sleep;
        lines.push(...known.lines.map(waitLine => `${waitLine} via ${name}()`));
      } else return;
      for (let up = node.parent; up && up !== scope; up = up.parent) {
        if (isLoop(up)) { problems.push(`${at(node)} a stable-slot wait inside a loop has no bounded sleep`); break; }
      }
      total += sleep;
    });
    return total;
  }
  // Every test and hook: its timeout must leave its own work at least the default timeout after the longest sleep.
  const reached = new Set<ts.Node>(), viaHelpers = new Set<ts.Node>();
  walk(source, node => {
    if (!ts.isCallExpression(node)) return;
    const root = calleeRoot(node);
    const hook = root !== undefined && HOOKS.has(root);
    if (!root || (!TESTS.has(root) && !hook)) return;
    const callback = node.arguments.find(isFunction);
    if (!callback) return;
    const lines: string[] = [];
    const sleep = sleepWithin(callback, [], lines, reached);
    if (!sleep) return;
    const options = node.arguments.find(ts.isObjectLiteralExpression);
    const property = options?.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'timeout') as ts.PropertyAssignment | undefined;
    const argument = node.arguments.find((a, index) => index > node.arguments.indexOf(callback) && !ts.isObjectLiteralExpression(a));
    const explicit = property ? evaluate(property.initializer) : argument ? evaluate(argument) : undefined;
    if ((property || argument) && explicit === undefined) { problems.push(`${at(node)} the timeout is not a numeric constant`); return; }
    const allowance = hook ? hookTimeout : testTimeout;
    const timeout = explicit ?? allowance;
    const title = ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : root;
    if (timeout - sleep < allowance) {
      problems.push(`${at(node)} "${title}" can sleep ${sleep} ms waiting for a stable slot (line ${lines.join(', line ')}) but times out at ${timeout} ms; it needs at least ${sleep + allowance} ms`);
    }
  });
  // A wait reached only through a helper is checked through the tests that call that helper; any other wait is unchecked.
  for (const site of sites) {
    if (reached.has(site) || viaHelpers.has(site)) continue;
    problems.push(`${at(site)} this stable-slot wait is not inside a test, a hook or a helper a test calls`);
  }
  return problems;
}

describe('stable-slot waits (Task 23.2 Decision 3)', () => {
  it('gives every stableRealSlot wait a timeout longer than its longest sleep', () => {
    const files = readdirSync('tests/db').filter(name => name.endsWith('.test.ts')).sort();
    expect(files.length).toBeGreaterThan(10);
    const problems = files.flatMap(name => waitProblems(`tests/db/${name}`, readFileSync(`tests/db/${name}`, 'utf8')));
    expect(problems).toEqual([]);
  });

  it('reports short and default timeouts, waits behind a helper or inline in a hook, and an unchecked wait, with file and line', () => {
    const helper = `async function stableRealSlot(marginMs = 30_000) {
  const remaining = SLOT - (Date.now() % SLOT);
  if (remaining < marginMs) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
  return nowSlot();
}
`;
    const text = `${helper}async function world() { return stableRealSlot(); }
const loose = stableRealSlot(5_000);
describe('suite', () => {
  it('fits', async () => { await stableRealSlot(60_000); }, 81_000);
  it('too short', async () => { await stableRealSlot(120_000); }, 60_000);
  it('default timeout', async () => { await stableRealSlot(1_000); });
  it('helper', () => withClock(async () => { await world(); }), 50_000);
  it('helper, enough', async () => { await world(); }, 51_000);
  it('two waits', async () => { await stableRealSlot(10_000); await world(); }, 2 * 30_000);
  test.skip('options form', { timeout: 30_000 }, async () => { await stableRealSlot(10_000); });
  beforeAll(async () => {
    const remaining = SLOT - (Date.now() % SLOT);
    if (remaining < 180_000) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
  }, 200_000);
  beforeEach(async () => {
    const remaining = SLOT - (Date.now() % SLOT);
    if (remaining < 120_000) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
  }, 121_000 + 30_000);
});
`;
    expect(waitProblems('x.test.ts', text)).toEqual([
      'x.test.ts:10 "too short" can sleep 121000 ms waiting for a stable slot (line 10) but times out at 60000 ms; it needs at least 141000 ms',
      'x.test.ts:11 "default timeout" can sleep 2000 ms waiting for a stable slot (line 11) but times out at 20000 ms; it needs at least 22000 ms',
      'x.test.ts:12 "helper" can sleep 31000 ms waiting for a stable slot (line 6 via world()) but times out at 50000 ms; it needs at least 51000 ms',
      'x.test.ts:14 "two waits" can sleep 42000 ms waiting for a stable slot (line 14, line 6 via world()) but times out at 60000 ms; it needs at least 62000 ms',
      'x.test.ts:15 "options form" can sleep 11000 ms waiting for a stable slot (line 15) but times out at 30000 ms; it needs at least 31000 ms',
      // A hook's own work gets the hook default (30 s).
      'x.test.ts:16 "beforeAll" can sleep 181000 ms waiting for a stable slot (line 18) but times out at 200000 ms; it needs at least 211000 ms',
      'x.test.ts:7 this stable-slot wait is not inside a test, a hook or a helper a test calls',
    ]);
    // A changed wait shape is refused rather than measured with the wrong bound.
    expect(waitProblems('y.test.ts', `async function stableRealSlot(marginMs: number) { await sleep(marginMs * 2); }
it('t', async () => { await stableRealSlot(1); }, 100_000);`)).toEqual([
      'y.test.ts:1 stableRealSlot is not the known shape (sleep remaining + N when remaining < marginMs); update this check']);
    // A wait inside a loop has no bounded total.
    expect(waitProblems('z.test.ts', `${helper}it('loop', async () => { for (const x of [1, 2]) await stableRealSlot(1_000); }, 600_000);`))
      .toEqual(['z.test.ts:6 a stable-slot wait inside a loop has no bounded sleep']);
  });
});
