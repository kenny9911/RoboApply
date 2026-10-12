#!/usr/bin/env node
// Validate every translated bundle against its English source (same rules as
// apply-translations.mjs): node validate-bundles.mjs <repoRoot> [locale]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const [root, onlyLocale] = process.argv.slice(2);
const require = createRequire(join(root, 'package.json'));
const { parse } = require('@formatjs/icu-messageformat-parser');
const LOCALES = ['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'];
const TARGETS = { web: (l) => `i18n/messages/${l}.json`, email: (l) => `server/src/i18n/email/${l}.json`, extension: (l) => `extension/src/i18n/${l}.json` };
function argNames(ast, acc = new Set()) {
  for (const el of ast) {
    if (typeof el.value === 'string' && [1, 2, 3, 4, 5, 6].includes(el.type)) acc.add(el.value);
    if (el.options) for (const o of Object.values(el.options)) argNames(o.value, acc);
    if (el.children) argNames(el.children, acc);
  }
  return acc;
}
function leaves(o, p = '', out = []) {
  for (const [k, v] of Object.entries(o)) {
    const q = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object') leaves(v, q, out); else out.push([q, v]);
  }
  return out;
}
const get = (o, p) => p.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
const count = (s, re) => (s.match(re) || []).length;
let bad = 0;
for (const [t, file] of Object.entries(TARGETS)) {
  const en = JSON.parse(readFileSync(join(root, file('en')), 'utf8'));
  for (const l of LOCALES) {
    if (onlyLocale && l !== onlyLocale) continue;
    const p = join(root, file(l));
    if (!existsSync(p)) continue;
    let n = 0;
    for (const [path, v] of leaves(JSON.parse(readFileSync(p, 'utf8')))) {
      const ev = get(en, path);
      const fail = (why) => { bad++; n++; if (n <= 12) console.log(`✗ ${t}/${l} ${path}: ${why}`); };
      if (typeof ev !== 'string') { fail('orphan (no EN string)'); continue; }
      if (typeof v !== 'string' || !v.trim()) { fail('empty'); continue; }
      if (count(v, /%BRAND%/g) !== count(ev, /%BRAND%/g) || count(v, /%OTHER_BRAND%/g) !== count(ev, /%OTHER_BRAND%/g)) { fail('%BRAND% count differs'); continue; }
      if (/RoboApply|GoApply/i.test(v) && !/RoboApply|GoApply/i.test(ev)) { fail('literal brand'); continue; }
      let a, b;
      try { a = argNames(parse(v, { ignoreTag: true })); } catch { fail('ICU parse error'); continue; }
      try { b = argNames(parse(ev, { ignoreTag: true })); } catch { b = null; }
      if (b && [...a].sort().join() !== [...b].sort().join()) fail(`ICU args [${[...a]}] ≠ EN [${[...b]}]`);
    }
    if (n) console.log(`  ${t}/${l}: ${n} problem(s)`);
  }
}
console.log(bad ? `✗ ${bad} problem(s)` : '✓ all translated bundles structurally valid');
process.exit(bad ? 1 : 0);
