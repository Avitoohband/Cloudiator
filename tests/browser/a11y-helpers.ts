// Accessibility checks for the browser specs (Task 23.5, plan Decision 8), with no new package: Playwright's own accessible
// name computation, a page-side focus watch, and a WCAG 2.2 contrast ratio from computed styles.
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/** One moment the focus fell to <body>: what had it before, and the key or change that preceded it. */
export type FocusDrop = { from: string; after: string };
declare global {
  interface Window { __a11yFocusDrops?: FocusDrop[] }
}

/**
 * Watches, from the first script on every page, for the focus falling to <body> while the window has it: after any key
 * and after any DOM change (an unmounted or disabled control). A check runs a task later, so a focus the page moves on
 * at once (a menu closing to its icon) is not counted; only a focus left on <body> is. Read it with `focusDrops`.
 */
export async function watchFocus(page: Page) {
  await page.addInitScript(() => {
    const drops: FocusDrop[] = [];
    window.__a11yFocusDrops = drops;
    let last: Element | null = null;
    let lastText = '';
    const describe = (el: Element | null) => {
      if (!el) return 'nothing';
      const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '';
      return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}> ${name}`;
    };
    let pending = false;
    const check = (after: string) => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        const active = document.activeElement;
        if (last && (!active || active === document.body) && document.hasFocus()) {
          drops.push({ from: lastText, after });
          last = null;
        }
      }, 0);
    };
    document.addEventListener('focusin', event => { last = event.target as Element; lastText = describe(last); }, true);
    document.addEventListener('keydown', event => check(`key ${event.key}`), true);
    // A click on the page itself moves the focus to <body> on purpose; that is no drop.
    document.addEventListener('pointerdown', () => { last = null; }, true);
    const start = () => new MutationObserver(() => check('a DOM change'))
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'inert', 'open'] });
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  });
}

/** The focus drops recorded so far on this page. */
export const focusDrops = (page: Page) => page.evaluate(() => window.__a11yFocusDrops ?? []);

/** Where the focus is now: `body`, or the element's tag and accessible label or text. */
export const focusedElement = (page: Page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  return `<${el.tagName.toLowerCase()}> ${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 60) ?? ''}`;
});

/**
 * Every control in `scope` a keyboard can reach (tab order, shown, not disabled) has an accessible name, as Playwright
 * computes it from the accessibility tree (labels, aria-label, aria-labelledby, content).
 */
export async function expectNamedControls(scope: Locator, label: string) {
  const count = await scope.evaluate(root => {
    const shown = (el: Element) => (typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0);
    const tabbable = [root, ...root.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]')]
      .filter(el => el instanceof HTMLElement && el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest('[inert]')
        && !(el instanceof HTMLInputElement && el.type === 'hidden') && shown(el));
    document.querySelectorAll('[data-a11y-probe]').forEach(el => el.removeAttribute('data-a11y-probe'));
    tabbable.forEach((el, i) => el.setAttribute('data-a11y-probe', String(i)));
    return tabbable.length;
  });
  const unnamed: string[] = [];
  for (let i = 0; i < count; i++) {
    const control = scope.page().locator(`[data-a11y-probe="${i}"]`);
    try {
      await expect(control).toHaveAccessibleName(/\S/, { timeout: 500 });
    } catch {
      unnamed.push(await control.evaluate(el => el.outerHTML.replace(/\s+data-a11y-probe="\d+"/, '').slice(0, 160)));
    }
  }
  expect(count, `${label}: no keyboard control found`).toBeGreaterThan(0);
  expect(unnamed, `${label}: keyboard controls without an accessible name`).toEqual([]);
  return count;
}

/** One text or control that misses its WCAG 2.2 contrast minimum. */
export type ContrastIssue = { what: string; ratio: number; needs: number; fg: string; bg: string };

/**
 * WCAG 2.2 contrast inside `scope`, from computed styles:
 * - text (1.4.3): 4.5:1, or 3:1 for large text (24 px, or 18.66 px bold); text in a disabled control is exempt;
 * - control boundaries (1.4.11): 3:1 for a form field's border or fill against what surrounds it, a progress bar's fill
 *   against its track, and a focus outline against the background.
 * Backgrounds are composited up the ancestors (with their opacity) onto the first opaque one; a gradient counts its worst
 * stop. Translucent panels over the camp are composited onto the camp's own colour (#1c3f24, the shell and the scene's
 * background), the backdrop they are designed for.
 */
export async function contrastIssues(scope: Locator, options: { focusRing?: boolean } = {}): Promise<ContrastIssue[]> {
  return scope.evaluate((root, { focusRing }) => {
    type RGBA = [number, number, number, number];
    const parse = (value: string): RGBA[] => [...value.matchAll(/rgba?\(([^)]+)\)/g)].map(m => {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    });
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      return [0, 1, 2].map(i => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a) as RGBA;
    };
    const lum = ([r, g, b]: RGBA) => {
      const c = [r, g, b].map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const CAMP: RGBA = [28, 63, 36, 1];
    const hex = (c: RGBA) => `rgba(${c.map((v, i) => (i < 3 ? Math.round(v) : Math.round(v * 100) / 100)).join(', ')})`;
    /** The backgrounds behind an element (each gradient stop gives one), composited onto the first opaque one. */
    const backgrounds = (el: Element | null): RGBA[] => {
      const layers: RGBA[][] = [];
      for (let node = el; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        const opacity = Number(style.opacity);
        const stops = style.backgroundImage.includes('gradient') ? parse(style.backgroundImage) : [];
        const fill = parse(style.backgroundColor)[0] ?? [0, 0, 0, 0];
        const own = (stops.length ? stops : [fill]).map(c => [c[0], c[1], c[2], c[3] * opacity] as RGBA);
        layers.push(own);
        if (own.every(c => c[3] >= 1)) break;
        if (node.matches('dialog[open]')) break;
      }
      let result: RGBA[] = [CAMP];
      for (const own of layers.reverse()) result = result.flatMap(under => own.map(top => over(top, under)));
      return result;
    };
    const shown = (el: Element) => (typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : el.getClientRects().length > 0);
    const name = (el: Element) => `<${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''}> ${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50)}`;
    const issues: { what: string; ratio: number; needs: number; fg: string; bg: string }[] = [];
    const check = (what: string, fg: RGBA, bgs: RGBA[], needs: number) => {
      const worst = Math.min(...bgs.map(bg => ratio(over(fg, bg), bg)));
      if (worst < needs) issues.push({ what, ratio: Math.round(worst * 100) / 100, needs, fg: hex(fg), bg: hex(bgs[0]) });
    };
    const opacityOf = (el: Element) => { let o = 1; for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };

    // Text: every shown element with its own text.
    for (const el of [root, ...root.querySelectorAll('*')]) {
      // Inactive controls have no contrast requirement (WCAG 1.4.3): natively disabled ones, and buttons that are
      // aria-disabled while their command is sent.
      if (!shown(el) || el.closest('[aria-hidden="true"], button:disabled, button[aria-disabled="true"], input:disabled, select:disabled, fieldset:disabled')) continue;
      const own = [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && /[\p{L}\p{N}]/u.test(n.textContent ?? ''));
      if (!own) continue;
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize), bold = Number(style.fontWeight) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const [fg] = parse(style.color);
      check(name(el), [fg[0], fg[1], fg[2], fg[3] * opacityOf(el)], backgrounds(el), large ? 3 : 4.5);
    }
    // Form fields: the border or the fill against what surrounds the field.
    for (const el of root.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]):not([type="range"]):not([type="hidden"]), select, textarea')) {
      if (!shown(el) || (el as HTMLInputElement).disabled) continue;
      const style = getComputedStyle(el);
      const around = backgrounds(el.parentElement);
      const [border] = parse(style.borderTopColor);
      const fill = backgrounds(el);
      const best = Math.max(
        Math.min(...around.map(bg => ratio(over(border, bg), bg))),
        Math.min(...around.flatMap(bg => fill.map(f => ratio(f, bg)))),
      );
      if (best < 3) issues.push({ what: `field ${name(el)} ${el.getAttribute('aria-label') ?? (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? ''}`, ratio: Math.round(best * 100) / 100, needs: 3, fg: hex(border), bg: hex(around[0]) });
    }
    // Progress bars: the fill against its track.
    for (const el of root.querySelectorAll('[role="progressbar"]')) {
      const fillEl = el.firstElementChild;
      if (!fillEl || !shown(el)) continue;
      const track = backgrounds(el), fill = backgrounds(fillEl);
      const worst = Math.min(...track.flatMap(t => fill.map(f => ratio(f, t))));
      if (worst < 3) issues.push({ what: `progress ${el.getAttribute('aria-label')}`, ratio: Math.round(worst * 100) / 100, needs: 3, fg: hex(fill[0]), bg: hex(track[0]) });
    }
    // The focus outline of the focused element, against the background around it.
    if (focusRing) {
      const el = document.activeElement;
      if (el && el !== document.body && root.contains(el)) {
        const style = getComputedStyle(el);
        const [ring] = parse(style.outlineColor);
        if (style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0 || !ring) issues.push({ what: `no focus outline on ${name(el)}`, ratio: 0, needs: 3, fg: 'none', bg: '' });
        else check(`focus outline of ${name(el)}`, ring, backgrounds(el.parentElement), 3);
      }
    }
    return issues;
  }, options);
}

/**
 * An evidence screenshot for the visual review of a visible accessibility change (`a11y-` prefix): in the test's output
 * folder, and also in A11Y_SHOTS when that is set (Playwright clears its output folder on every run).
 */
export async function a11yShot(page: Page, testInfo: TestInfo, name: string) {
  const file = `a11y-${testInfo.project.name}-${name}.png`;
  await page.screenshot({ path: testInfo.outputPath(file) });
  if (process.env.A11Y_SHOTS) await page.screenshot({ path: `${process.env.A11Y_SHOTS}/${file}` });
}

/** The page never scrolls sideways. */
export const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/**
 * The attribute points fit the screen (points hotfix, 2026-10-29): no sideways scroll, and each row (its label, its field and its
 * −, +1 and +5) lies whole inside `group`, below the row before it, with every button at least 44 x 44 px. `fields` are the
 * fields' accessible names and `names` the title-case names the buttons use, in the same order. `minus: false` is the build step,
 * which has no − (points can't be taken back, Avi's change round 1).
 */
export async function expectPointsFit(page: Page, group: Locator, fields: string[], names: string[], { minus = true } = {}) {
  expect(await noHorizontalScroll(page), 'the page does not scroll sideways').toBe(true);
  const area = (await group.boundingBox())!;
  const inside = (box: { x: number; width: number }, what: string) => {
    expect(box.x, `${what} starts inside the points`).toBeGreaterThanOrEqual(area.x - 0.5);
    expect(box.x + box.width, `${what} ends inside the points`).toBeLessThanOrEqual(area.x + area.width + 0.5);
  };
  let above = -Infinity;
  for (const [index, name] of names.entries()) {
    const field = group.getByRole('spinbutton', { name: fields[index], exact: true });
    const verbs = [...(minus ? ['Remove a point from'] : []), 'Add a point to', 'Add 5 points to'];
    const buttons = verbs.map(verb => group.getByRole('button', { name: `${verb} ${name}`, exact: true }));
    let top = Infinity, bottom = -Infinity;
    const label = await field.evaluate(el => {
      const label = (el as HTMLInputElement).labels?.[0];
      if (!label) return null;
      const rect = label.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, clipped: label.scrollWidth > label.clientWidth + 0.5 };
    });
    expect(label, `${name} has a label`).not.toBeNull();
    expect(label!.clipped, `${name}'s label is not clipped`).toBe(false);
    inside(label!, `${name}'s label`);
    top = Math.min(top, label!.y);
    for (const [i, control] of [field, ...buttons].entries()) {
      await expect(control).toBeVisible();
      const box = (await control.boundingBox())!;
      const what = i === 0 ? `${name}'s field` : `${name}'s ${verbs[i - 1]}`;
      inside(box, what);
      expect(box.height, `${what} is 44 px tall`).toBeGreaterThanOrEqual(44 - 0.5);
      if (i > 0) expect(box.width, `${what} is 44 px wide`).toBeGreaterThanOrEqual(44 - 0.5);
      // Phone polish (fix round 2): iOS zooms into a field under 16 px when it takes the focus, and double-tap-zooms on fast taps
      // of a button without `touch-action: manipulation`.
      const style = await control.evaluate(el => ({ fontSize: parseFloat(getComputedStyle(el).fontSize), touchAction: getComputedStyle(el).touchAction }));
      if (i === 0) expect(style.fontSize, `${what}'s text is at least 16 px`).toBeGreaterThanOrEqual(16);
      else expect(style.touchAction, `${what} takes fast taps`).toBe('manipulation');
      top = Math.min(top, box.y);
      bottom = Math.max(bottom, box.y + box.height);
    }
    expect(top, `${name}'s row starts below the row before it`).toBeGreaterThanOrEqual(above - 0.5);
    above = bottom;
  }
}
