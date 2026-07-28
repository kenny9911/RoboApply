#!/usr/bin/env node
// scripts/check-design.mjs
//
// The design system's enforcement gate. Without this, every rule in
// docs/roboapply/OVERHAUL_RULINGS.md is a sentence in a document, and the first
// PR that reintroduces an 11px uppercase mono label lands unnoticed — which is
// exactly how the previous system accreted 31 font sizes, 141 sub-12px
// declarations, 78 uppercase micro-labels and 46 accent-glow shadows.
//
//   npm run check:design
//
// Exits non-zero on any violation. Wired into `prebuild`, so a violation fails
// the build rather than shipping.
//
// SCOPE. App chrome only. styles/v3-resume.css and every `.rb-*` selector are
// exempt by ruling C25: that file is résumé DOCUMENT typography, where an 11px
// date column and an uppercase "EXPERIENCE" heading are correct — the résumé is
// the user's own artifact and the scanner-readable PDF depends on those
// conventions.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Files exempt from the type/case/family rules entirely. */
const EXEMPT_FILES = new Set(['styles/v3-resume.css']);

/** Components that render the RÉSUMÉ DOCUMENT rather than app chrome. Same
 *  exemption as styles/v3-resume.css and for the same reason (ruling C25): the
 *  résumé is the user's own artifact, its sizes come from the Designer theme,
 *  and forcing them onto the UI scale would reflow every template. */
const EXEMPT_TSX = [
  'components/v3/resume-editor/',
  'components/v3/resumes/',
];

/** The complete type scale. Nothing else may set a font-size. */
const FS_TOKENS = [
  '--fs-hero', '--fs-display', '--fs-stat', '--fs-title',
  '--fs-subtitle', '--fs-body', '--fs-meta', '--fs-label',
];

/** Font-family values that are legitimate without a downloaded face. */
const SYSTEM_FAMILY = /^(ui-|system-ui|-apple-system|BlinkMacSystemFont|inherit|initial|unset|sans-serif|serif|monospace|cursive|var\()/;

const violations = [];
function fail(file, line, rule, detail) {
  violations.push({ file, line, rule, detail });
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ── CSS ─────────────────────────────────────────────────────────────────────

const CSS_FILES = [
  'app/globals.css',
  ...readdirSync(join(ROOT, 'styles'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `styles/${f}`),
].filter((f) => !EXEMPT_FILES.has(f));

for (const rel of CSS_FILES) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const lines = src.split('\n');

  lines.forEach((raw, i) => {
    const n = i + 1;
    // Strip trailing comments so a documented old value isn't flagged.
    const line = raw.replace(/\/\*.*?\*\//g, '');

    // 1. Type scale. A font-size must resolve through a token.
    const fs = line.match(/font-size:\s*([^;]+)/);
    if (fs) {
      const value = fs[1].trim();
      const ok =
        FS_TOKENS.some((t) => value.includes(t)) ||
        value === 'inherit' ||
        value === '0' ||
        value.includes('--resume-') ||
        value.includes('em)') === false && value.startsWith('var(--fs-');
      if (!ok) {
        fail(rel, n, 'type-scale', `font-size: ${value} — use one of ${FS_TOKENS.join(' ')}`);
      }
      if (/\d+\.\d*5px/.test(value)) {
        fail(rel, n, 'half-pixel', `font-size: ${value}`);
      }
    }

    // 2. No uppercase micro-labels in app chrome. All-caps destroys word-shape
    //    cues at exactly the sizes where the reader most needs them.
    if (/text-transform:\s*uppercase/.test(line) && !/\.rb-/.test(line)) {
      fail(rel, n, 'uppercase', line.trim());
    }

    // 3. No mono, no serif. Monospace is never a design choice; emphasis comes
    //    from size and weight inside one family.
    if (/var\(--mono\)|var\(--serif\)|var\(--sans\)/.test(line)) {
      fail(rel, n, 'legacy-font-var', `${line.trim()} — use var(--font-ui) / var(--font-display)`);
    }

    // 4. Glow is banned. No shadow may reference a hue. Match the VALUE only —
    //    a selector may legitimately still be named `.dc-glow-edge`.
    const shadow = line.match(/box-shadow:\s*([^;]+)/);
    if (shadow && /--accent|--brand|--lime|--violet|glow/.test(shadow[1])) {
      fail(rel, n, 'glow', line.trim());
    }

    // 5. A quoted family name never matches next/font's hashed @font-face, so
    //    it silently falls back while still downloading the woff2. This is the
    //    bug that left every résumé export set in Times New Roman.
    const ff = line.match(/font-family:\s*([^;]+)/);
    if (ff) {
      const value = ff[1].trim();
      const first = value.split(',')[0].trim();
      if (/^['"]/.test(first) && !SYSTEM_FAMILY.test(first.replace(/['"]/g, ''))) {
        fail(rel, n, 'literal-family', `font-family: ${first} — next/font emits a hashed family; use var(--font-*)`);
      }
    }

    // 6. Deleted concepts must not creep back.
    if (/\[data-accent|data-theme=['"]warm|var\(--density\)/.test(line)) {
      fail(rel, n, 'deleted-concept', line.trim());
    }
  });
}

// ── TSX inline styles ───────────────────────────────────────────────────────

const TSX_FILES = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))]
  .filter((f) => extname(f) === '.tsx')
  .map((f) => relative(ROOT, f));

for (const rel of TSX_FILES) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  src.split('\n').forEach((raw, i) => {
    const n = i + 1;
    if (raw.trimStart().startsWith('//') || raw.trimStart().startsWith('*')) return;

    // Inline sizes must come from the scale, exactly like CSS ones. Checking
    // only for sub-12px left ~150 literals — including 12.5, 13.5 and 14.5 —
    // sitting in style={{}} objects, which is the same "random fonts" problem
    // relocated from the stylesheets into the components. rem/em/% are relative
    // and legitimately outside the px scale, so they are not flagged.
    if (!EXEMPT_TSX.some((e) => rel.includes(e))) {
      const inline = raw.match(
        /fontSize:\s*(?:['"](\d+(?:\.\d+)?)px['"]|(\d+(?:\.\d+)?)\s*[,}])/,
      );
      const px = inline && Number(inline[1] ?? inline[2]);
      if (px) {
        fail(
          rel,
          n,
          px < 12 ? 'below-floor' : 'type-scale',
          `fontSize: ${px}px — use a token (${FS_TOKENS.join(' ')})`,
        );
      }
      // 400 body · 500 UI · 600 titles · 700 hero. 300 and 800 are deleted.
      const wt = raw.match(/fontWeight:\s*['"]?(\d{3})['"]?/);
      if (wt && !['400', '500', '600', '700'].includes(wt[1])) {
        fail(rel, n, 'weight', `fontWeight: ${wt[1]} — only 400/500/600/700 ship`);
      }
    }
    if (/textTransform:\s*['"]uppercase/.test(raw)) {
      fail(rel, n, 'uppercase', raw.trim());
    }
    if (/var\(--mono\)|var\(--serif\)/.test(raw)) {
      fail(rel, n, 'legacy-font-var', raw.trim());
    }
    // The four-accent picker and the tone/density knobs are gone for good.
    if (/useDcTheme|dcTheme|AiOrb|TweaksPanel|aggressiveness/.test(raw)) {
      fail(rel, n, 'deleted-concept', raw.trim());
    }
  });
}

// ── Report ──────────────────────────────────────────────────────────────────

if (violations.length === 0) {
  console.log(`✓ design system clean — ${CSS_FILES.length} stylesheets, ${TSX_FILES.length} components`);
  process.exit(0);
}

const byRule = violations.reduce((acc, v) => {
  (acc[v.rule] ??= []).push(v);
  return acc;
}, {});

console.error(`\n✗ ${violations.length} design-system violation(s)\n`);
for (const [rule, list] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
  console.error(`  ${rule} (${list.length})`);
  for (const v of list.slice(0, 12)) {
    console.error(`    ${v.file}:${v.line}  ${v.detail}`);
  }
  if (list.length > 12) console.error(`    … and ${list.length - 12} more`);
  console.error('');
}
console.error('See docs/roboapply/OVERHAUL_RULINGS.md §R4 and §5 for the rules.\n');
process.exit(1);
