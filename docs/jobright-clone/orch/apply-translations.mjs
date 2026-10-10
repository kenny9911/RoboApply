#!/usr/bin/env node
// Validate translator chunk files and deep-merge them into locale bundles.
//
//   node apply-translations.mjs <repoRoot> <chunksDir> [--dry-run] [--only <target>/<locale>/<file.json>]
//
// chunksDir layout: <chunksDir>/<target>/<locale>/<chunk>.json
//   target = web | email | extension
//   web       → <repo>/i18n/messages/<locale>.json          (EN ref: i18n/messages/en.json)
//   email     → <repo>/server/src/i18n/email/<locale>.json  (EN ref: server/src/i18n/email/en.json)
//   extension → <repo>/extension/src/i18n/<locale>.json     (EN ref: extension/src/i18n/en.json)
// Each chunk is a nested object mirroring the EN structure (a subset of leaves).
// A leaf is accepted only if: the EN leaf exists and is a string; the translation
// is a non-empty string that parses as ICU; the ICU argument names equal EN's;
// the %BRAND% / %OTHER_BRAND% counts equal EN's; no literal RoboApply/GoApply
// that EN does not have. Rejected leaves are reported and skipped; accepted
// leaves are merged. Exit code 1 when anything was rejected.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const [root, chunksDir, ...rest] = process.argv.slice(2);
const dry = rest.includes('--dry-run');
const only = rest.includes('--only') ? rest[rest.indexOf('--only') + 1].split('/') : null;
const require = createRequire(join(root, 'package.json'));
const { parse } = require('@formatjs/icu-messageformat-parser');

const TARGETS = {
  web: { en: 'i18n/messages/en.json', out: (l) => `i18n/messages/${l}.json` },
  email: { en: 'server/src/i18n/email/en.json', out: (l) => `server/src/i18n/email/${l}.json` },
  extension: { en: 'extension/src/i18n/en.json', out: (l) => `extension/src/i18n/${l}.json` },
};

function argNames(ast, acc = new Set()) {
  for (const el of ast) {
    if (typeof el.value === 'string' && [1, 2, 3, 4, 5, 6].includes(el.type)) acc.add(el.value);
    if (el.options) for (const opt of Object.values(el.options)) argNames(opt.value, acc);
    if (el.children) argNames(el.children, acc);
  }
  return acc;
}
const count = (s, re) => (s.match(re) || []).length;
function leaves(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, p, out);
    else out.push([p, v]);
  }
  return out;
}
const get = (obj, p) => p.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
function set(obj, p, v) {
  const ks = p.split('.');
  let o = obj;
  for (const k of ks.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[ks.at(-1)] = v;
}

const report = {};
let rejectedTotal = 0;
for (const target of Object.keys(TARGETS)) {
  const tdir = join(chunksDir, target);
  if (!existsSync(tdir)) continue;
  if (only && only[0] !== target) continue;
  const en = JSON.parse(readFileSync(join(root, TARGETS[target].en), 'utf8'));
  for (const locale of readdirSync(tdir)) {
    const ldir = join(tdir, locale);
    if (!statSync(ldir).isDirectory()) continue;
    if (only && only[1] !== locale) continue;
    const outPath = join(root, TARGETS[target].out(locale));
    const bundle = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};
    const r = (report[`${target}/${locale}`] = { accepted: 0, rejected: [] });
    for (const f of readdirSync(ldir).filter((x) => x.endsWith('.json') && (!only || only[2] === x)).sort()) {
      let chunk;
      try {
        chunk = JSON.parse(readFileSync(join(ldir, f), 'utf8'));
      } catch (e) {
        r.rejected.push(`${f}: invalid JSON (${e.message})`);
        continue;
      }
      for (const [p, v] of leaves(chunk)) {
        const ev = get(en, p);
        if (typeof ev !== 'string') { r.rejected.push(`${p}: not an EN string leaf`); continue; }
        if (typeof v !== 'string' || !v.trim()) { r.rejected.push(`${p}: empty/non-string`); continue; }
        if (/RoboApply|GoApply/i.test(v) && !/RoboApply|GoApply/i.test(ev)) { r.rejected.push(`${p}: literal brand name`); continue; }
        if (count(v, /%BRAND%/g) !== count(ev, /%BRAND%/g) || count(v, /%OTHER_BRAND%/g) !== count(ev, /%OTHER_BRAND%/g)) {
          r.rejected.push(`${p}: %BRAND% count differs`);
          continue;
        }
        let tv;
        let te;
        try { tv = argNames(parse(v, { ignoreTag: true })); } catch { r.rejected.push(`${p}: ICU parse error`); continue; }
        try { te = argNames(parse(ev, { ignoreTag: true })); } catch { te = null; }
        if (te && [...te].sort().join(',') !== [...tv].sort().join(',')) {
          r.rejected.push(`${p}: ICU args [${[...tv]}] ≠ EN [${[...te]}]`);
          continue;
        }
        set(bundle, p, v);
        r.accepted++;
      }
    }
    rejectedTotal += r.rejected.length;
    if (!dry && !only) writeFileSync(outPath, JSON.stringify(bundle, null, 2) + '\n');
  }
}
for (const [k, v] of Object.entries(report)) {
  console.log(`${k}: accepted ${v.accepted}, rejected ${v.rejected.length}`);
  for (const x of v.rejected.slice(0, 20)) console.log(`   ✗ ${x}`);
}
process.exit(rejectedTotal ? 1 : 0);
