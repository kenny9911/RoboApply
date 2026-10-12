// @vitest-environment node
//
// WP-12 acceptance: WCAG contrast over both brands × both themes for every
// brand token (TASK_PLAN.md WP-12; docs/design-system.md "4.5:1 text").
//
// Effective tokens are read from the real stylesheets the way the cascade
// applies them: app/globals.css `:root` (light) and `html[data-theme='dark']`
// (dark), then styles/brands/goapply.css `html[data-brand='goapply']` and
// `html[data-brand='goapply'][data-theme='dark']` on top for GoApply.
// Gradients are checked at every colour stop.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** The brand tokens scripts/check-design.mjs allows a brand sheet to set (it runs on import, so read its source). */
const BRAND_TOKENS: string[] = (() => {
  const src = readFileSync(join(ROOT, 'scripts/check-design.mjs'), 'utf8');
  const m = src.match(/export const BRAND_TOKENS = \[([\s\S]*?)\];/);
  if (!m) throw new Error('BRAND_TOKENS not found in scripts/check-design.mjs');
  return [...m[1].matchAll(/'(--[\w-]+)'/g)].map((x) => x[1]);
})();
const GLOBALS = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
const GOAPPLY = readFileSync(join(ROOT, 'styles/brands/goapply.css'), 'utf8');

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Declarations of the FIRST rule whose selector matches exactly. */
function block(css: string, selector: string): Record<string, string> {
  const src = stripComments(css);
  const re = new RegExp(`(^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`no rule for ${selector}`);
  const out: Record<string, string> = {};
  for (const decl of m[2].split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    const prop = decl.slice(0, i).trim();
    if (prop.startsWith('--')) out[prop] = decl.slice(i + 1).trim().replace(/\s+/g, ' ');
  }
  return out;
}

type Theme = 'light' | 'dark';
type Brand = 'roboapply' | 'goapply';

const base = {
  light: block(GLOBALS, ':root'),
  dark: { ...block(GLOBALS, ':root'), ...block(GLOBALS, "html[data-theme='dark']") },
};
const goOverrides = {
  light: block(GOAPPLY, "html[data-brand='goapply']"),
  dark: {
    ...block(GOAPPLY, "html[data-brand='goapply']"),
    ...block(GOAPPLY, "html[data-brand='goapply'][data-theme='dark']"),
  },
};

function tokens(brand: Brand, theme: Theme): Record<string, string> {
  return brand === 'goapply' ? { ...base[theme], ...goOverrides[theme] } : base[theme];
}

const HEX = /#[0-9a-fA-F]{6}\b/g;

function hexes(value: string | undefined, name: string): string[] {
  const found = value?.match(HEX);
  if (!found?.length) throw new Error(`${name} has no #rrggbb colour (${value})`);
  return found;
}
function hex(value: string | undefined, name: string): string {
  const [first, ...rest] = hexes(value, name);
  if (rest.length) throw new Error(`${name} is not a single colour`);
  return first;
}

function luminance(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT = 4.5;
const UI = 3;

/** [foreground token, background token, minimum, what it is]. Gradient tokens are checked at every stop. */
const PAIRS: Array<[string, string, number, string]> = [
  ['--action-ink', '--action', TEXT, 'primary button label'],
  ['--action-ink', '--action-hover', TEXT, 'primary button label, hover'],
  ['--action-ink', '--grad-brand', TEXT, 'gradient button label'],
  ['--action-ink', '--grad-brand-hover', TEXT, 'gradient button label, hover'],
  ['--action', '--bg', TEXT, 'action text on the page'],
  ['--action', '--surface', TEXT, 'action text on a card'],
  ['--action', '--surface-2', TEXT, 'action text on a muted surface'],
  ['--action', '--action-subtle', TEXT, 'selected chip / pill text'],
  ['--action-hover', '--bg', TEXT, 'link hover'],
  ['--text', '--action-subtle', TEXT, 'body text on a subtle action fill'],
  ['--text', '--grad-soft', TEXT, 'text on the soft gradient'],
  ['--text', '--grad-panel', TEXT, 'text on the panel gradient'],
  ['--text-2', '--grad-soft', TEXT, 'secondary text on the soft gradient (nudge banner)'],
  ['--brand-mark', '--brand-plane', UI, 'brand glyph on the identity plane'],
  ['--action', '--bg', UI, 'focus ring / control outline'],
];

describe('brand stylesheets', () => {
  it('goapply.css defines exactly the brand tokens, in light and in dark', () => {
    const light = block(GOAPPLY, "html[data-brand='goapply']");
    const dark = block(GOAPPLY, "html[data-brand='goapply'][data-theme='dark']");
    expect(Object.keys(light).sort()).toEqual([...BRAND_TOKENS].sort());
    expect(Object.keys(dark).sort()).toEqual([...BRAND_TOKENS].sort());
  });

  it('GoApply differs from RoboApply on the action colour (it is a different brand)', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(tokens('goapply', theme)['--action']).not.toBe(tokens('roboapply', theme)['--action']);
    }
  });
});

describe.each([
  ['roboapply', 'light'],
  ['roboapply', 'dark'],
  ['goapply', 'light'],
  ['goapply', 'dark'],
] as Array<[Brand, Theme]>)('contrast: %s × %s', (brand, theme) => {
  const t = tokens(brand, theme);
  it.each(PAIRS)('%s on %s ≥ %s (%s)', (fg, bg, min) => {
    const fgColour = hex(t[fg], fg);
    for (const stop of hexes(t[bg], bg)) {
      const ratio = contrast(fgColour, stop);
      expect(ratio, `${brand}/${theme}: ${fg} ${fgColour} on ${bg} stop ${stop} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
    }
  });
});

describe('contrast helper', () => {
  it('matches the WCAG reference values', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrast('#767676', '#FFFFFF')).toBeGreaterThan(4.5);
  });
});
