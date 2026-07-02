// check-plans-i18n-parity.mjs
//
// Oracle O3 for the Job Seeker Subscription Plans feature. Guards that every
// i18n key the feature introduced exists, with an identical key set, across all
// four RoboApply locales (en, zh, zh-TW, ja). Scoped to the touched namespaces
// (plans.* + the handful of added keys under nav_v3 / choosePlan / account)
// so it never trips on pre-existing drift elsewhere in the bundles.
//
//   node scripts/check-plans-i18n-parity.mjs   (run from roboapply/)
//
// Exit non-zero (and print the diff) on any missing or extra key.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MSG_DIR = join(HERE, '..', 'i18n', 'messages');
const LOCALES = ['en', 'zh', 'zh-TW', 'ja'];

// Specific non-`plans` keys this feature added outside its own namespace.
const EXTRA_KEYS = [
  'nav_v3.plans',
  'choosePlan.welcome',
  'choosePlan.creditsHint',
  'choosePlan.checkoutFailed',
  'account.billing.explore.title',
  'account.billing.explore.sub',
  'account.billing.explore.cta',
  'account.billing.explore.titleMax',
  'account.billing.explore.subMax',
  'account.billing.explore.ctaMax',
];

function load(locale) {
  return JSON.parse(readFileSync(join(MSG_DIR, `${locale}.json`), 'utf8'));
}

/** Flatten an object into dotted leaf keys. */
function flatten(obj, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.add(key);
  }
  return out;
}

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const bundles = Object.fromEntries(LOCALES.map((l) => [l, load(l)]));

// 1. plans.* key-set parity across all four locales (EN is the reference).
const refPlans = flatten(bundles.en.plans, 'plans');
let failures = 0;
for (const loc of LOCALES) {
  if (loc === 'en') continue;
  const here = flatten(bundles[loc].plans, 'plans');
  const missing = [...refPlans].filter((k) => !here.has(k));
  const extra = [...here].filter((k) => !refPlans.has(k));
  if (missing.length || extra.length) {
    failures++;
    console.error(`✗ ${loc}: plans.* key drift vs en`);
    if (missing.length) console.error(`    missing: ${missing.join(', ')}`);
    if (extra.length) console.error(`    extra:   ${extra.join(', ')}`);
  }
}

// 2. The handful of feature keys added outside plans.* must exist in all locales.
for (const key of EXTRA_KEYS) {
  for (const loc of LOCALES) {
    const v = get(bundles[loc], key);
    if (typeof v !== 'string' || v.length === 0) {
      failures++;
      console.error(`✗ ${loc}: missing or empty key "${key}"`);
    }
  }
}

if (failures) {
  console.error(`\ni18n parity FAILED with ${failures} issue(s).`);
  process.exit(1);
}
console.log(`i18n parity OK — plans.* (${refPlans.size} keys) + ${EXTRA_KEYS.length} extra keys identical across ${LOCALES.join(', ')}.`);
