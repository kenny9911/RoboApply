#!/usr/bin/env node
// scripts/check-copy.mjs
//
// Two gates over the product's words:
//
//   1. BANNED WORDS — every term the panel found a first-time job seeker
//      cannot understand cold, plus every claim the product is not allowed to
//      make. Runs over all nine locale bundles, because "queue" and "ATS" leak
//      through translation unchanged.
//
//   2. CALL-SITE INTEGRITY — every t('key') resolves in en.json, and every
//      locale bundle has the same key set as English.
//      This matters more than it looks: lib/i18n.ts deep-merges each locale
//      over English and app/providers.tsx sets no onError, so next-intl does
//      NOT throw on a missing key — it renders the literal dotted path. A
//      deleted key ships to production as the string "jobs.headline", in all
//      nine locales, and neither `next build` nor `vitest` catches it.
//
//   npm run check:copy
//
// See docs/roboapply/OVERHAUL_RULINGS.md §3 and C30.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MESSAGES = join(ROOT, 'i18n/messages');

/** term -> why it is banned. The reason is printed on failure, because a bare
 *  "banned word" error just gets worked around with a synonym. */
const BANNED = {
  // Auto-apply vocabulary — the product does not submit anything (ruling R1).
  'auto-apply': 'the product never submits to an employer',
  'auto-applied': 'the product never submits to an employer',
  'autopilot': 'the product never submits to an employer',
  'review queue': 'the queue concept is deleted',
  'consent layer': 'internal architecture vocabulary',
  'review hold': 'internal architecture vocabulary',
  'night shift': 'idiom, and it narrates work that did not happen',
  'while you slept': 'narrates work that did not happen',
  'on your behalf': 'implies an agent acting as you',
  'on my end': 'first-person persona in an error message',

  // Invented scales the user has no calibration for (rulings C2, C3).
  'threshold': 'asks the user to pick an integer on a scale they have never seen',
  'above bar': 'implies an invisible cut line',
  'cleared your bar': 'implies an invisible cut line',
  'strong match': 'a fifth quality word; the ladder is Great fit / Good fit / Possible / Unlikely',
  'long shot': 'idiom (betting)',
  'stretch role': 'idiom (rubber)',

  // Recruiter-side and engineer-side vocabulary leaking into a candidate UI.
  ' jd ': 'ATS/recruiter abbreviation',
  'applicant tracking': 'a first-time job seeker has never heard this',
  'ats-safe': 'ATS expands to a phrase the user does not know',
  'ats-friendly': 'ATS expands to a phrase the user does not know',
  'parser': 'compiler-theory word',
  'recruiter screen': 'nobody outside recruiting calls a phone call a screen',
  'onsite': 'factually wrong — most final loops are video calls',
  'trajectory': 'physics word; nobody describes their own career this way',
  'dimension': 'analyst vocabulary',
  'kanban': 'project-management tool vocabulary',
  'funnel': 'internal/sales vocabulary',
  'pipeline': 'internal vocabulary',

  // Compliance vocabulary in a consumer product (ruling C12).
  'violation': 'compliance vocabulary on a screen where someone is sending a document',
  'citation-checked': 'names the mechanism, not the source',

  // The agent persona (ruling D4).
  'your ai job hunter': 'the agent persona is deleted',
  'mission control': 'invented noun',
  'aggressiveness': 'invented setting',
};

/** Terms that are legitimate inside these namespaces despite the ban. */
const ALLOW = {
  // The résumé editor legitimately talks about job descriptions it tailors to.
  'jobs.description': [' jd '],
};

const violations = [];
const fail = (file, path, rule, detail) => violations.push({ file, path, rule, detail });

// ── Load bundles ────────────────────────────────────────────────────────────

const LOCALES = readdirSync(MESSAGES).filter((f) => f.endsWith('.json'));
const bundles = Object.fromEntries(
  LOCALES.map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(join(MESSAGES, f), 'utf8'))]),
);

function leaves(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, path, out);
    else out.set(path, String(v));
  }
  return out;
}

const enLeaves = leaves(bundles.en ?? {});

// ── 1. Banned words, every locale ───────────────────────────────────────────

for (const [locale, bundle] of Object.entries(bundles)) {
  for (const [path, value] of leaves(bundle)) {
    const hay = ` ${value.toLowerCase()} `;
    for (const [term, why] of Object.entries(BANNED)) {
      if (!hay.includes(term)) continue;
      if ((ALLOW[path] ?? []).includes(term)) continue;
      fail(`${locale}.json`, path, 'banned-word', `"${term}" — ${why}`);
    }
  }
}

// ── 2. Locale parity ────────────────────────────────────────────────────────
//
// Two tiers, because that is the truth on the ground today: the app UI is
// localized into four languages, while five more exist as landing pages only
// (we market in Spanish and then hand the user an English app). Wave 5 of the
// overhaul promotes them; until then the gate holds each tier to what it
// actually claims, rather than reporting ~10,000 phantom failures nobody reads.
//
// To promote a locale: move it into FULL and run the i18n-locale-sync skill.

const FULL = new Set(['en', 'ja', 'zh', 'zh-TW']);
/** Namespaces a landing-only locale must nonetheless cover completely. */
const LANDING_NS = ['landing', 'app'];

for (const [locale, bundle] of Object.entries(bundles)) {
  if (locale === 'en') continue;
  const keys = leaves(bundle);
  const required = FULL.has(locale)
    ? [...enLeaves.keys()]
    : [...enLeaves.keys()].filter((p) => LANDING_NS.some((ns) => p === ns || p.startsWith(`${ns}.`)));

  for (const path of required) {
    if (!keys.has(path)) {
      fail(`${locale}.json`, path, FULL.has(locale) ? 'missing-key' : 'missing-landing-key',
        'present in en.json, absent here');
    }
  }
  // An orphan is always a bug: it is a string nobody can ever reach, and it is
  // how deleted vocabulary survives a purge.
  for (const path of keys.keys()) {
    if (!enLeaves.has(path)) fail(`${locale}.json`, path, 'orphan-key', 'not present in en.json');
  }
}

// ── 3. Every t() call resolves ──────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (['.tsx', '.ts'].includes(extname(full))) out.push(full);
  }
  return out;
}

const SOURCES = ['app', 'components', 'hooks', 'lib']
  .map((d) => join(ROOT, d))
  .flatMap((d) => walk(d));

for (const abs of SOURCES) {
  const rel = relative(ROOT, abs);
  const src = readFileSync(abs, 'utf8');
  // The namespace a file binds, e.g. useTranslations('today').
  const ns = [...src.matchAll(/useTranslations\(\s*['"]([\w.]+)['"]\s*\)/g)].map((m) => m[1]);
  if (ns.length !== 1) continue; // multi-namespace or dynamic files: skip, too noisy to be useful
  // Only literal keys — a template literal is a runtime decision we cannot check here.
  for (const m of src.matchAll(/\bt\(\s*['"]([\w.]+)['"]/g)) {
    const full = `${ns[0]}.${m[1]}`;
    if (!enLeaves.has(full)) {
      const line = src.slice(0, m.index).split('\n').length;
      fail(rel, `${full}`, 'missing-string', `t('${m[1]}') at line ${line} does not resolve in en.json`);
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

if (violations.length === 0) {
  console.log(`✓ copy clean — ${LOCALES.length} locales, ${enLeaves.size} English strings`);
  process.exit(0);
}

const byRule = violations.reduce((acc, v) => ((acc[v.rule] ??= []).push(v), acc), {});
console.error(`\n✗ ${violations.length} copy violation(s)\n`);
for (const [rule, list] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
  console.error(`  ${rule} (${list.length})`);
  for (const v of list.slice(0, 15)) console.error(`    ${v.file}  ${v.path}\n      ${v.detail}`);
  if (list.length > 15) console.error(`    … and ${list.length - 15} more`);
  console.error('');
}
console.error('See docs/roboapply/OVERHAUL_RULINGS.md §3 for the vocabulary.\n');
process.exit(1);
