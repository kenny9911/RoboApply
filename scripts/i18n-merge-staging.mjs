#!/usr/bin/env node
// scripts/i18n-merge-staging.mjs — fold the feature waves' staged strings into
// the real bundles (ARCHITECTURE.md §10.1.3; TASK_PLAN.md §2.3, R-22).
// FND-7 writes it; INT (WP-91) runs it.
//
//   node scripts/i18n-merge-staging.mjs            merge, write, empty staging
//   node scripts/i18n-merge-staging.mjs --dry-run  print the plan, write nothing
//   node scripts/i18n-merge-staging.mjs --check    exit 1 while any staging file has content
//   node scripts/i18n-merge-staging.mjs --index    regenerate i18n/staging/index.ts only
//   (any mode) --root <dir>                        operate on another checkout (tests)
//
// Inputs
//   i18n/staging/<ns>.en.json      { "<ns>": {…English…} }      → i18n/messages/en.json
//   i18n/staging/<ns>.zh.json      GoApply-authored Chinese (R-22):
//                                    key absent from zh.json  → zh.json
//                                    key present in zh.json   → i18n/brands/goapply/zh.json (override)
//   i18n/staging/<ns>.remove.json  ["a.b.c", …]                 deleted from all 9 bundles
//   i18n/staging/extension*.en.json / .zh.json (namespaces `extension`, `extension-cn`)
//                                                              → extension/src/i18n/<locale>.json
//   server/src/i18n/email/staging/<area>.en.json               → server/src/i18n/email/en.json
//
// Rules (step 1, validation — any failure aborts before anything is written):
//   valid JSON · exactly one top-level key equal to the file's namespace ·
//   every leaf a non-empty string that parses as ICU · no literal
//   RoboApply/GoApply (use %BRAND% / %OTHER_BRAND%) · RoboHire/GoHire only as
//   a `{sourceName}`-style parameter or under legal.*, jobsCn.source*,
//   people.source* (real source names, D3) · a .zh.json key must exist in
//   English (bundle ∪ staging).
//
// Outputs: merged bundles; `i18n/staging/_pending-translation.json`
// (`[{ bundle, path, en, reason: 'new'|'changed', provided? }]`) for the
// i18n-locale-sync skill; changed English keys lose their stale translations
// in the other locales; staging files reset to `{ "<ns>": {} }` / `[]`;
// `i18n/staging/index.ts` regenerated.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseIcu } from '@formatjs/icu-messageformat-parser';

export const LOCALES = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'];
/** Staging namespaces that belong to the extension package, not the web bundles. */
export const EXTENSION_NAMESPACES = ['extension', 'extension-cn'];
export const LITERAL_BRAND_RE = /RoboApply|GoApply/i;
export const SOURCE_NAME_RE = /RoboHire|GoHire/i;
/** Where a literal recruiter-bank source name may appear (D3 requires naming real sources). */
export const SOURCE_NAME_PATHS = [/^legal\./, /^jobsCn\.source/, /^people\.source/];

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function paths(root = DEFAULT_ROOT) {
  return {
    root,
    staging: join(root, 'i18n/staging'),
    messages: join(root, 'i18n/messages'),
    goapplyBrand: join(root, 'i18n/brands/goapply'),
    pending: join(root, 'i18n/staging/_pending-translation.json'),
    index: join(root, 'i18n/staging/index.ts'),
    email: join(root, 'server/src/i18n/email'),
    emailStaging: join(root, 'server/src/i18n/email/staging'),
    extension: join(root, 'extension'),
    extensionI18n: join(root, 'extension/src/i18n'),
  };
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Flatten to `Map<dottedPath, value>` (leaves only). */
export function leaves(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) leaves(v, p, out);
    else out.set(p, v);
  }
  return out;
}

function getPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (!isObj(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isObj(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts.at(-1)] = value;
}

/** Delete a leaf (or subtree) and prune parents left empty. Returns true when something was removed. */
function deletePath(obj, path) {
  const parts = path.split('.');
  const stack = [];
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isObj(cur[part])) return false;
    stack.push([cur, part]);
    cur = cur[part];
  }
  const last = parts.at(-1);
  if (!(last in cur)) return false;
  delete cur[last];
  for (let i = stack.length - 1; i >= 0; i--) {
    const [parent, key] = stack[i];
    if (isObj(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
    else break;
  }
  return true;
}

/** Deep merge `src` into `dst` (mutates dst). Staging wins on conflicts. */
export function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src ?? {})) {
    if (isObj(v) && isObj(dst[k])) deepMerge(dst[k], v);
    else dst[k] = isObj(v) ? deepMerge({}, v) : v;
  }
  return dst;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/** Classify one staging file name. */
export function classifyStagingFile(name) {
  let m = name.match(/^(.+)\.remove\.json$/);
  if (m) return { kind: 'remove', ns: m[1] };
  m = name.match(/^(.+)\.(en|zh)\.json$/);
  if (m) {
    const target = EXTENSION_NAMESPACES.includes(m[1]) ? 'extension' : 'web';
    return { kind: m[2], ns: m[1], target };
  }
  return null;
}

export function listStagingFiles(root = DEFAULT_ROOT) {
  const p = paths(root);
  const out = [];
  if (existsSync(p.staging)) {
    for (const name of readdirSync(p.staging).sort()) {
      if (name.startsWith('_')) continue;
      const c = classifyStagingFile(name);
      if (c) out.push({ ...c, file: join(p.staging, name), name, bundle: c.target ?? 'web' });
    }
  }
  if (existsSync(p.emailStaging)) {
    for (const name of readdirSync(p.emailStaging).sort()) {
      const m = name.match(/^(.+)\.en\.json$/);
      if (m) out.push({ kind: 'en', ns: m[1], target: 'email', bundle: 'email', file: join(p.emailStaging, name), name: `email/${name}` });
    }
  }
  return out;
}

// ── Validation ───────────────────────────────────────────────────────────────

export function icuError(text) {
  try {
    parseIcu(text);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Errors for one string leaf at `path` (namespaced dotted path). */
export function leafErrors(path, value) {
  const errors = [];
  if (typeof value !== 'string') return [`${path}: must be a string (got ${Array.isArray(value) ? 'array' : typeof value})`];
  if (value.trim() === '') errors.push(`${path}: empty string`);
  const icu = icuError(value);
  if (icu) errors.push(`${path}: ICU does not parse (${icu})`);
  if (LITERAL_BRAND_RE.test(value)) errors.push(`${path}: literal product name — use %BRAND% / %OTHER_BRAND%`);
  if (SOURCE_NAME_RE.test(value) && !SOURCE_NAME_PATHS.some((re) => re.test(path))) {
    errors.push(`${path}: literal RoboHire/GoHire — pass it as a {sourceName} parameter (allowed literally only under legal.*, jobsCn.source*, people.source*)`);
  }
  return errors;
}

/**
 * Validate every staging file. Returns `{ errors, files }` where each file
 * carries its parsed `data` when it parsed.
 */
export function validateStaging(root = DEFAULT_ROOT) {
  const p = paths(root);
  const files = listStagingFiles(root);
  const errors = [];
  const enUnion = existsSync(join(p.messages, 'en.json')) ? leaves(readJson(join(p.messages, 'en.json'))) : new Map();
  for (const f of files) {
    const rel = relative(root, f.file);
    let data;
    try {
      data = readJson(f.file);
    } catch (err) {
      errors.push(`${rel}: invalid JSON (${err instanceof Error ? err.message : err})`);
      continue;
    }
    f.data = data;
    if (f.kind === 'remove') {
      if (!Array.isArray(data) || data.some((x) => typeof x !== 'string' || !/^[\w-]+(\.[\w-]+)+$/.test(x))) {
        errors.push(`${rel}: must be an array of dotted key paths`);
      }
      continue;
    }
    const keys = isObj(data) ? Object.keys(data) : [];
    if (keys.length !== 1 || keys[0] !== f.ns) {
      errors.push(`${rel}: must have exactly one top-level key "${f.ns}" (found ${keys.length ? keys.map((k) => `"${k}"`).join(', ') : 'none'})`);
      continue;
    }
    if (!isObj(data[f.ns])) {
      errors.push(`${rel}: "${f.ns}" must be an object`);
      continue;
    }
    for (const [path, value] of leaves(data)) {
      for (const e of leafErrors(path, value)) errors.push(`${rel}: ${e}`);
      if (f.kind === 'en' && f.bundle === 'web') enUnion.set(path, value);
    }
  }
  for (const f of files) {
    if (f.kind !== 'zh' || f.bundle !== 'web' || !f.data || !isObj(f.data[f.ns])) continue;
    for (const path of leaves(f.data).keys()) {
      if (!enUnion.has(path)) errors.push(`${relative(root, f.file)}: ${path} has no English source (add it to ${f.ns}.en.json)`);
    }
  }
  return { errors, files };
}

/** True when a staging file still holds content (INT's final gate). */
export function hasContent(f) {
  if (f.kind === 'remove') return Array.isArray(f.data) && f.data.length > 0;
  return isObj(f.data) && leaves(f.data).size > 0;
}

// ── index.ts ────────────────────────────────────────────────────────────────

function identifierFor(ns) {
  const camel = ns.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
  return /^[0-9]/.test(camel) ? `ns${camel}` : camel;
}

/** The generated `i18n/staging/index.ts` source for the current staging files. */
export function renderIndex(root = DEFAULT_ROOT) {
  const web = listStagingFiles(root).filter((f) => f.kind === 'en' && f.bundle === 'web');
  const lines = [
    '// i18n/staging/index.ts — GENERATED by scripts/i18n-merge-staging.mjs. Do not edit;',
    '// run `npm run i18n:merge -- --index` after adding a staging file.',
    '//',
    '// Every web staging namespace (`<ns>.en.json`), deep-merged. lib/i18n.ts merges',
    '// STAGING_EN over en.json before deriving the other locales, so a staged key',
    '// renders in English everywhere until INT translates it (ARCHITECTURE.md §10.1.2).',
    '// Extension namespaces (extension, extension-cn) merge into the extension package.',
    '',
  ];
  for (const f of web) lines.push(`import ${identifierFor(f.ns)} from './${f.name}';`);
  lines.push(
    '',
    'type Messages = { [key: string]: string | Messages };',
    '',
    'function deepMerge(dst: Messages, src: Messages): Messages {',
    '  for (const [k, v] of Object.entries(src)) {',
    '    const prev = dst[k];',
    "    if (v && typeof v === 'object' && prev && typeof prev === 'object') deepMerge(prev, v);",
    "    else dst[k] = v && typeof v === 'object' ? deepMerge({}, v) : v;",
    '  }',
    '  return dst;',
    '}',
    '',
    '/** Staging namespaces, in file order. */',
    `export const STAGING_NAMESPACES: readonly string[] = [${web.map((f) => `'${f.ns}'`).join(', ')}];`,
    '',
    '/** All staged English strings (cloned, so callers may not mutate the JSON modules). */',
    'export const STAGING_EN: Messages = [',
    ...web.map((f) => `  ${identifierFor(f.ns)},`),
    '].reduce<Messages>((acc, bundle) => deepMerge(acc, JSON.parse(JSON.stringify(bundle)) as Messages), {});',
    '',
  );
  return lines.join('\n');
}

export function indexIsFresh(root = DEFAULT_ROOT) {
  const file = paths(root).index;
  return existsSync(file) && readFileSync(file, 'utf8') === renderIndex(root);
}

// ── Merge ────────────────────────────────────────────────────────────────────

function loadLocaleBundles(dir, locales = LOCALES) {
  const out = {};
  for (const l of locales) {
    const file = join(dir, `${l}.json`);
    if (existsSync(file)) out[l] = readJson(file);
  }
  return out;
}

/**
 * Merge English staging leaves into `bundles.en`, deleting stale translations
 * of changed keys from the other locales. Returns pending entries.
 */
function mergeEnglish(bundles, stagingDocs, bundleName) {
  const pending = [];
  const en = (bundles.en ??= {});
  for (const doc of stagingDocs) {
    for (const [path, value] of leaves(doc)) {
      const prev = getPath(en, path);
      if (prev === value) continue;
      const reason = prev === undefined ? 'new' : 'changed';
      setPath(en, path, value);
      if (reason === 'changed') {
        for (const [locale, bundle] of Object.entries(bundles)) if (locale !== 'en') deletePath(bundle, path);
      }
      pending.push({ bundle: bundleName, path, en: value, reason });
    }
  }
  return pending;
}

/** Build the merge plan; writes nothing. */
export function planMerge(root = DEFAULT_ROOT) {
  const p = paths(root);
  const { errors, files } = validateStaging(root);
  if (errors.length) return { errors, files };

  const web = loadLocaleBundles(p.messages);
  const email = loadLocaleBundles(p.email);
  const extensionPresent = existsSync(p.extension);
  const ext = extensionPresent ? loadLocaleBundles(p.extensionI18n) : {};
  const goapplyZhFile = join(p.goapplyBrand, 'zh.json');
  const goapplyZh = existsSync(goapplyZhFile) ? readJson(goapplyZhFile) : {};
  const touched = new Set();

  const withContent = files.filter(hasContent);
  const pending = [];
  const by = (kind, bundle) => withContent.filter((f) => f.kind === kind && f.bundle === bundle);

  // 2–4. English (web) + removes + stale translations.
  pending.push(...mergeEnglish(web, by('en', 'web').map((f) => f.data), 'web'));
  if (by('en', 'web').length) touched.add('web');
  const removed = [];
  for (const f of by('remove', 'web')) {
    for (const path of f.data) {
      for (const [locale, bundle] of Object.entries(web)) if (deletePath(bundle, path)) removed.push(`${locale}:${path}`);
    }
    touched.add('web');
  }

  // R-22 zh routing.
  const zhRouted = { bundle: [], brandOverride: [] };
  for (const f of by('zh', 'web')) {
    for (const [path, value] of leaves(f.data)) {
      if (getPath(web.zh ?? {}, path) === undefined) {
        setPath((web.zh ??= {}), path, value);
        zhRouted.bundle.push(path);
        const entry = pending.find((e) => e.bundle === 'web' && e.path === path);
        if (entry) entry.provided = [...new Set([...(entry.provided ?? []), 'zh'])];
      } else {
        setPath(goapplyZh, path, value);
        zhRouted.brandOverride.push(path);
      }
    }
    touched.add('web');
    if (zhRouted.brandOverride.length) touched.add('goapply');
  }

  // 5a. Email staging.
  pending.push(...mergeEnglish(email, by('en', 'email').map((f) => f.data), 'email'));
  if (by('en', 'email').length) touched.add('email');

  // 5b. Extension staging.
  const extFiles = [...by('en', 'extension'), ...by('zh', 'extension')];
  if (extFiles.length && !extensionPresent) {
    return { errors: [`extension staging has content but extension/ does not exist (${extFiles.map((f) => f.name).join(', ')})`], files };
  }
  pending.push(...mergeEnglish(ext, by('en', 'extension').map((f) => f.data), 'extension'));
  for (const f of by('zh', 'extension')) for (const [path, value] of leaves(f.data)) setPath((ext.zh ??= {}), path, value);
  if (extFiles.length) touched.add('extension');

  return {
    errors: [],
    files,
    withContent,
    pending,
    removed,
    zhRouted,
    bundles: { web, email, ext, goapplyZh },
    touched,
  };
}

function mergePending(file, entries) {
  const prev = existsSync(file) ? readJson(file) : [];
  const byKey = new Map(prev.map((e) => [`${e.bundle ?? 'web'}:${e.path}`, e]));
  for (const e of entries) byKey.set(`${e.bundle}:${e.path}`, e);
  return [...byKey.values()];
}

/** Apply a plan to disk. */
export function writeMerge(plan, root = DEFAULT_ROOT) {
  const p = paths(root);
  const { web, email, ext, goapplyZh } = plan.bundles;
  if (plan.touched.has('web')) for (const [l, b] of Object.entries(web)) writeJson(join(p.messages, `${l}.json`), b);
  if (plan.touched.has('goapply')) writeJson(join(p.goapplyBrand, 'zh.json'), goapplyZh);
  if (plan.touched.has('email')) for (const [l, b] of Object.entries(email)) writeJson(join(p.email, `${l}.json`), b);
  if (plan.touched.has('extension')) for (const [l, b] of Object.entries(ext)) writeJson(join(p.extensionI18n, `${l}.json`), b);
  if (plan.pending.length) writeJson(p.pending, mergePending(p.pending, plan.pending));
  for (const f of plan.withContent) writeJson(f.file, f.kind === 'remove' ? [] : { [f.ns]: {} });
  writeFileSync(p.index, renderIndex(root));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, check: false, index: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--check') args.check = true;
    else if (a === '--index') args.index = true;
    else if (a === '--root') args.root = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2), log = console) {
  const args = parseArgs(argv);
  const root = args.root;

  if (args.index) {
    const { errors } = validateStaging(root);
    if (errors.length) {
      log.error(`✗ ${errors.length} staging error(s)\n  ${errors.join('\n  ')}`);
      return 1;
    }
    writeFileSync(paths(root).index, renderIndex(root));
    log.log('✓ i18n/staging/index.ts regenerated');
    return 0;
  }

  if (args.check) {
    const { errors, files } = validateStaging(root);
    const full = files.filter((f) => f.data !== undefined && hasContent(f));
    const problems = [...errors, ...full.map((f) => `${relative(root, f.file)}: not merged yet`)];
    if (!indexIsFresh(root)) problems.push('i18n/staging/index.ts is stale (npm run i18n:merge -- --index)');
    if (problems.length) {
      log.error(`✗ staging is not empty or not valid\n  ${problems.join('\n  ')}`);
      return 1;
    }
    log.log(`✓ staging empty — ${files.length} files`);
    return 0;
  }

  const plan = planMerge(root);
  if (plan.errors.length) {
    log.error(`✗ ${plan.errors.length} staging error(s); nothing written\n  ${plan.errors.join('\n  ')}`);
    return 1;
  }
  const summary = [
    `files with content: ${plan.withContent.map((f) => f.name).join(', ') || 'none'}`,
    `keys: ${plan.pending.filter((e) => e.reason === 'new').length} new, ${plan.pending.filter((e) => e.reason === 'changed').length} changed`,
    `removed: ${plan.removed.length}`,
    `zh → zh.json: ${plan.zhRouted.bundle.length}; zh → i18n/brands/goapply/zh.json: ${plan.zhRouted.brandOverride.length}`,
  ];
  if (args.dryRun) {
    log.log(`i18n merge plan (dry run, nothing written)\n  ${summary.join('\n  ')}`);
    for (const e of plan.pending) log.log(`  ${e.reason.padEnd(7)} ${e.bundle}:${e.path}`);
    for (const r of plan.removed) log.log(`  remove  ${r}`);
    return 0;
  }
  writeMerge(plan, root);
  log.log(`✓ merged staging\n  ${summary.join('\n  ')}\n  pending translation: ${relative(root, paths(root).pending)}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
}
