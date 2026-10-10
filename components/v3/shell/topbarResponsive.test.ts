// The Topbar at phone width (verify finding FIX-1 #1).
//
// What went wrong: the search pill carried `search max-[760px]:hidden` and the
// compact icon button `icon-btn hidden max-[760px]:grid`. Tailwind v4 emits
// utilities inside `@layer utilities`, while styles/v3.css and
// styles/workspace.css are imported UNLAYERED by app/globals.css — and an
// unlayered rule beats every layered one, whatever its specificity. So
// `.search { display: flex }` and `.icon-btn { display: grid }` always won:
// the 255px pill never collapsed, both buttons showed at every width, and
// every signed-in page was ~600px wide on a 375px phone.
//
// jsdom has no layout and no media queries, so this file pins the two things
// that decide the outcome: (1) the breakpoint lives in the same unlayered
// stylesheet as the classes it overrides, and (2) no shell component tries to
// switch `display` with a Tailwind utility on an element whose class sets
// `display` in those stylesheets.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selectors: string[];
  body: string;
  /** The enclosing at-rule preludes, outermost first (e.g. `@media (max-width: 760px)`). */
  at: string[];
}

/** A small brace-matching reader: enough for plain rules nested in at-rules. */
function parseRules(css: string, at: string[] = []): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const semi = css.lastIndexOf(';', open);
    const prelude = css.slice(Math.max(i, semi > i ? semi + 1 : i), open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) {
      if (/^@(media|supports|layer|container)\b/.test(prelude)) out.push(...parseRules(body, [...at, prelude]));
    } else {
      out.push({ selectors: prelude.split(',').map((s) => s.trim()), body, at });
    }
    i = j;
  }
  return out;
}

const UNLAYERED_SHEETS = ['styles/v3.css', 'styles/workspace.css'];
const rules = UNLAYERED_SHEETS.flatMap((sheet) => parseRules(stripComments(read(sheet))));
const declares = (rule: Rule, prop: string, value: string) =>
  new RegExp(`(^|[;\\s])${prop}\\s*:\\s*${value}\\s*(;|$)`).test(rule.body.trim());
const isPhone = (rule: Rule) => rule.at.some((a) => /max-width:\s*760px/.test(a));
const find = (selector: string, where: (r: Rule) => boolean) =>
  rules.filter((r) => r.selectors.includes(selector) && where(r));

describe('the stylesheets the shell classes live in', () => {
  it('are imported unlayered (which is why a Tailwind utility cannot override them)', () => {
    const globals = read('app/globals.css');
    for (const sheet of UNLAYERED_SHEETS) {
      const line = globals.split('\n').find((l) => l.includes(`'../${sheet}'`));
      expect(line, sheet).toBeTruthy();
      expect(line, sheet).not.toMatch(/layer\(/);
    }
  });
});

describe('Topbar search at phone width', () => {
  it('hides the pill and shows the icon button at 760px and below, in the unlayered stylesheet', () => {
    expect(find('.top-actions .search', (r) => isPhone(r) && declares(r, 'display', 'none'))).toHaveLength(1);
    expect(find('.top-actions .search-compact', (r) => isPhone(r) && declares(r, 'display', 'grid'))).toHaveLength(1);
  });

  it('hides the icon button on wide screens', () => {
    expect(find('.top-actions .search-compact', (r) => r.at.length === 0 && declares(r, 'display', 'none'))).toHaveLength(1);
  });

  it('never hides the pill outside the phone breakpoint', () => {
    const hidden = rules.filter(
      (r) => r.selectors.some((s) => /(^|\s)\.search$/.test(s)) && !isPhone(r) && declares(r, 'display', 'none'),
    );
    expect(hidden).toEqual([]);
  });

  it('gives the two buttons the classes those rules target', () => {
    const source = read('components/v3/shell/Topbar.tsx');
    expect(source).toMatch(/className="search"/);
    expect(source).toMatch(/className="icon-btn search-compact"/);
  });
});

describe('Topbar width at phone width', () => {
  it('lets the page name give way instead of pushing the buttons off screen', () => {
    // A flex item does not shrink below its content unless min-width is 0.
    expect(find('.main > .topbar > .crumbs', (r) => isPhone(r) && declares(r, 'min-width', '0'))).toHaveLength(1);
    expect(find('.main > .topbar > .crumbs .now', (r) => isPhone(r) && declares(r, 'overflow', 'hidden'))).toHaveLength(1);
    expect(find('.main > .topbar > .top-actions', (r) => isPhone(r) && /flex(-shrink)?\s*:\s*0\b/.test(r.body))).toHaveLength(1);
  });
});

describe('a page name of one long word, at phone width', () => {
  // Measured in Chromium at 360px: `overflow-wrap: anywhere` split English
  // "Applications" as "Applicatio / ns" — no hyphen, because Chrome does not
  // auto-hyphenate a capitalised English word, so `hyphens: auto` did nothing
  // and the break fell on an arbitrary letter.
  const name = find('.main > .topbar > .crumbs .now', isPhone);

  it('is never split at an arbitrary letter', () => {
    expect(name).toHaveLength(1);
    expect(name[0]!.body).not.toMatch(/overflow-wrap\s*:\s*(anywhere|break-word)/);
    expect(name[0]!.body).not.toMatch(/word-break\s*:\s*(break-all|break-word)/);
  });

  it('is hyphenated where the browser can, and otherwise ends in an ellipsis', () => {
    expect(declares(name[0]!, 'hyphens', 'auto')).toBe(true);
    expect(declares(name[0]!, 'text-overflow', 'ellipsis')).toBe(true);
    expect(declares(name[0]!, 'overflow', 'hidden')).toBe(true);
  });
});

describe('the onboarding header, which reuses .topbar > .crumbs for the brand name', () => {
  // app/(onboarding)/layout.tsx: <header class="topbar"><div class="crumbs">
  // brand</div> + three buttons. The rules above are for the six-button app
  // topbar; applied here they hid the brand name on a 320px phone.
  it('really is a .topbar > .crumbs outside .main, and the app topbar is inside it', () => {
    const onboarding = read('app/(onboarding)/layout.tsx');
    expect(onboarding).toMatch(/<header className="topbar">\s*<div className="crumbs">/);
    expect(onboarding).not.toMatch(/className="main"/);
    expect(read('components/v3/shell/HybridShell.tsx')).toMatch(/<main className="main"[^>]*>\s*<Topbar \/>/);
    expect(read('components/v3/shell/Topbar.tsx')).toMatch(/<div className="topbar">\s*<div className="crumbs">/);
  });

  it('is not touched by any rule this file tests: each one is scoped to .main > .topbar', () => {
    const unscoped = rules.filter((r) => r.selectors.some((s) => /^\.topbar\s*>/.test(s)));
    expect(unscoped.map((r) => r.selectors.join(', '))).toEqual([]);
  });

  it('never has its brand name hidden', () => {
    const hides = rules.filter(
      (r) => declares(r, 'display', 'none') && r.selectors.some((s) => /\.crumbs$/.test(s) && !s.startsWith('.main > .topbar')),
    );
    expect(hides.map((r) => r.selectors.join(', '))).toEqual([]);
    // The app topbar's own name is what gives way under 340px.
    expect(find('.main > .topbar > .crumbs', (r) => r.at.some((a) => /max-width:\s*340px/.test(a)) && declares(r, 'display', 'none'))).toHaveLength(1);
  });
});

describe('Topbar width between the phone breakpoint and a full desktop', () => {
  // 768px: the rail takes 212px, and the page name + a 255px pill + five
  // buttons need more than what is left. Something has to give, and it is the pill.
  const base = (r: Rule) => r.at.length === 0;

  it('lets only the search pill shrink', () => {
    expect(find('.main > .topbar > .top-actions', (r) => base(r) && declares(r, 'min-width', '0'))).toHaveLength(1);
    expect(find('.main > .topbar > .top-actions > *', (r) => base(r) && declares(r, 'flex-shrink', '0'))).toHaveLength(1);
    expect(find('.main > .topbar > .top-actions > .search', (r) => base(r) && declares(r, 'flex-shrink', '1') && declares(r, 'min-width', '0'))).toHaveLength(1);
  });

  it('ends a shortened pill label in an ellipsis and keeps the page name whole', () => {
    expect(find('.search .grow', (r) => base(r) && declares(r, 'text-overflow', 'ellipsis') && declares(r, 'overflow', 'hidden'))).toHaveLength(1);
    expect(find('.main > .topbar > .crumbs', (r) => base(r) && declares(r, 'white-space', 'nowrap'))).toHaveLength(1);
  });

  it('does not touch the page header, which reuses .top-actions for its own buttons', () => {
    // PageHeader's buttons must keep wrapping: no rule may stop a bare .top-actions or its children from shrinking.
    const bare = rules.filter((r) => r.selectors.some((s) => s === '.top-actions' || s === '.top-actions > *'));
    expect(bare.filter((r) => /flex(-shrink)?\s*:/.test(r.body))).toEqual([]);
  });
});

describe('shell components', () => {
  // Classes that set `display` in the unlayered stylesheets, e.g. search, icon-btn, avatar.
  const displayClasses = new Set<string>();
  for (const rule of rules) {
    if (!/(^|[;\s])display\s*:/.test(rule.body)) continue;
    for (const selector of rule.selectors) {
      const m = /^\.([A-Za-z0-9_-]+)$/.exec(selector);
      if (m) displayClasses.add(m[1]!);
    }
  }
  // `hidden`, `md:flex`, `max-[760px]:grid`, … — a Tailwind utility that sets display.
  const DISPLAY_UTILITY = /^(?:[a-z0-9-]+(?:\[[^\]]+\])?:)*(?:hidden|block|inline-block|inline|flex|inline-flex|grid|inline-grid|contents)$/;

  it('know which classes set display', () => {
    expect(displayClasses.has('search')).toBe(true);
    expect(displayClasses.has('icon-btn')).toBe(true);
  });

  it('never pair one of those classes with a Tailwind display utility', () => {
    const dir = 'components/v3/shell';
    const offenders: string[] = [];
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!name.endsWith('.tsx')) continue;
      const source = read(`${dir}/${name}`);
      for (const m of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
        const tokens = (m[1] ?? m[2] ?? m[3] ?? '').split(/\s+/).filter(Boolean);
        const fixed = tokens.filter((t) => displayClasses.has(t));
        const utilities = tokens.filter((t) => DISPLAY_UTILITY.test(t));
        if (fixed.length > 0 && utilities.length > 0) offenders.push(`${name}: "${tokens.join(' ')}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
