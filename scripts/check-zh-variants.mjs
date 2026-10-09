#!/usr/bin/env node
// scripts/check-zh-variants.mjs — Simplified/Traditional Chinese variant
// guard (CN_TW_LAUNCH_PLAN.md §4.2 WP-TW-LOCALE, §8, §9; TASK_PLAN.md WP-12,
// catalog TW-08).
//
// GoApply speaks mainland Simplified Chinese (`zh`); RoboApply's Taiwan
// audience reads Taiwan Traditional Chinese (`zh-TW`). A mainland word in a
// Taiwan bundle (简历, 视频, 用户 …) reads as a machine translation there, and
// a Taiwan word in a mainland bundle (履歷, 職缺, 面議) the same. The term lists
// live in i18n/glossary/zh-variants.json (`banned`), next to the glossary the
// translators use.
//
// Scanned: every JSON message bundle whose path names a Chinese variant —
//   i18n/messages/{zh,zh-TW}.json, i18n/staging/*.{zh,zh-TW}.json,
//   i18n/brands/<brand>/{zh,zh-TW}.json, server/src/i18n/email/** (bundles and
//   staging), components/**/messages.{zh,zh-TW}.json, and the extension's
//   _locales/{zh_CN,zh_TW}/messages.json once extension/ exists.
// Only string VALUES are checked (keys are code). Exceptions go in the
// glossary's `allow` list, one key path + term + reason per row.
//
//   npm run check:zh-variants          (`--root <dir>` checks another tree)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GLOSSARY_PATH = 'i18n/glossary/zh-variants.json';
/** Directories walked for bundles (relative to the root). */
export const SCAN_DIRS = ['i18n/messages', 'i18n/staging', 'i18n/brands', 'server/src/i18n', 'components', 'extension'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__', 'glossary']);

/**
 * The Chinese variant a bundle path is written in, or null for any other file.
 *   zh-TW: `zh-TW.json`, `x.zh-TW.json`, `_locales/zh_TW/…`, zh-Hant, zh-HK
 *   zh:    `zh.json`, `x.zh.json`, `_locales/zh_CN/…`, zh-Hans
 */
export function variantOf(relPath) {
  const p = relPath.split(sep).join('/');
  if (!p.endsWith('.json')) return null;
  if (/(^|[/._-])zh[-_](tw|hant|hk|mo)([/._-]|$)/i.test(p)) return 'zh-TW';
  if (/(^|[/.])zh([-_](cn|hans))?(\.json$|\/)/i.test(p)) return 'zh';
  return null;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.json')) out.push(full);
  }
  return out;
}

/** Every string value in a parsed JSON document, with its dotted key path. */
export function* stringsOf(node, path = '') {
  if (typeof node === 'string') {
    yield [path, node];
  } else if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* stringsOf(node[i], path ? `${path}.${i}` : String(i));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) yield* stringsOf(v, path ? `${path}.${k}` : k);
  }
}

export function loadGlossary(root) {
  const file = join(root, GLOSSARY_PATH);
  if (!existsSync(file)) throw new Error(`${GLOSSARY_PATH} is missing`);
  const g = JSON.parse(readFileSync(file, 'utf8'));
  for (const v of ['zh', 'zh-TW']) {
    if (!Array.isArray(g?.banned?.[v]?.terms)) throw new Error(`${GLOSSARY_PATH}: banned["${v}"].terms must be an array`);
  }
  return g;
}

function isAllowed(allow, file, keyPath, term) {
  return allow.some(
    (a) =>
      a &&
      a.term === term &&
      (!a.file || a.file === file) &&
      typeof a.key === 'string' &&
      (a.key.endsWith('.') ? keyPath.startsWith(a.key) : a.key === keyPath),
  );
}

/**
 * Check one bundle. `variant` is 'zh' or 'zh-TW'; returns violations as
 * `{ file, key, term, variant }`.
 */
export function checkBundle(glossary, file, variant, json) {
  const terms = glossary.banned[variant]?.terms ?? [];
  const allow = Array.isArray(glossary.allow) ? glossary.allow : [];
  const out = [];
  for (const [key, value] of stringsOf(json)) {
    for (const term of terms) {
      if (value.includes(term) && !isAllowed(allow, file, key, term)) out.push({ file, key, term, variant });
    }
  }
  return out;
}

/** Scan a tree. Returns `{ files, violations, errors }`. */
export function evaluate(root) {
  const glossary = loadGlossary(root);
  const files = [];
  const violations = [];
  const errors = [];
  for (const dir of SCAN_DIRS) {
    for (const full of walk(join(root, dir))) {
      const rel = relative(root, full).split(sep).join('/');
      const variant = variantOf(rel);
      if (!variant) continue;
      files.push(rel);
      let json;
      try {
        json = JSON.parse(readFileSync(full, 'utf8'));
      } catch (err) {
        errors.push(`${rel}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      violations.push(...checkBundle(glossary, rel, variant, json));
    }
  }
  return { files: files.sort(), violations, errors };
}

function rootFromArgs(argv) {
  const i = argv.indexOf('--root');
  return i === -1 ? fileURLToPath(new URL('..', import.meta.url)) : argv[i + 1];
}

export function main(argv = process.argv.slice(2), log = console) {
  const root = rootFromArgs(argv);
  let result;
  try {
    result = evaluate(root);
  } catch (err) {
    log.error(`✗ zh variants: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const { files, violations, errors } = result;
  if (violations.length || errors.length) {
    const lines = [
      ...errors,
      ...violations.map((v) => {
        const other = v.variant === 'zh-TW' ? 'mainland' : 'Taiwan';
        return `${v.file}  ${v.key}: "${v.term}" is ${other} vocabulary in a ${v.variant} bundle (see ${GLOSSARY_PATH})`;
      }),
    ];
    log.error(`\n✗ ${lines.length} zh variant problem(s)\n  ${lines.join('\n  ')}\n`);
    return 1;
  }
  log.log(`✓ zh variants clean — ${files.length} bundle(s): no mainland terms in zh-TW, no Taiwan terms in zh`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
