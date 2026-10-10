// extension/scripts/build.mjs — build one brand of the extension (ARCHITECTURE.md §6.1).
//
//   node scripts/build.mjs --brand=roboapply|goapply --target=chrome|edge [--dev]
//                          [--api-origin=http://127.0.0.1:4799] [--out=dist/x] [--all]
//   node scripts/build.mjs --brand=goapply --store=edge|chrome|crx
//
// GoApply builds follow GOAPPLY_DISTRIBUTION (src/brands/goapply): `--store`
// picks the build target that store receives (Edge Add-ons first), `--all`
// builds one folder per store, and the store name, short name, description
// and toolbar title come from the strings it names (`extension-cn.manifest`
// in i18n/staging/extension-cn.{en,zh}.json), written to `_locales/en` and
// `_locales/zh_CN` (the GoApply default locale).
//
// Output (default dist/<brand>-<target>[-dev]/) is an unpacked MV3 extension:
// manifest.json, sw.js (module), content.js, popup.html/js, _locales/, icons/.
// Load it in chrome://extensions → Developer mode → "Load unpacked".
//
// The build refuses a manifest that breaks the permission policy
// (src/manifest.ts manifestViolations) and runs the D1 no-submit gate first.

import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

import { readClarity, tokenCss } from './tokens.mjs';

export const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(EXT_ROOT, '..');

const BRANDS = ['roboapply', 'goapply'];
const TARGETS = ['chrome', 'edge'];
/** extension/src/i18n locale → Chrome _locales folder. */
const CHROME_LOCALE = { en: 'en', zh: 'zh_CN', 'zh-TW': 'zh_TW', ja: 'ja', ko: 'ko', es: 'es', fr: 'fr', pt: 'pt_BR', de: 'de' };

export function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
  };
  const brand = get('brand') ?? 'roboapply';
  const target = get('target') ?? 'chrome';
  const store = typeof get('store') === 'string' ? get('store') : undefined;
  if (!BRANDS.includes(brand)) throw new Error(`--brand must be one of ${BRANDS.join(', ')}`);
  if (!TARGETS.includes(target)) throw new Error(`--target must be one of ${TARGETS.join(', ')}`);
  return { brand, target, store, dev: get('dev') === true, apiOrigin: typeof get('api-origin') === 'string' ? get('api-origin') : undefined, out: get('out'), all: get('all') === true };
}

/** The strings that name a RoboApply build in the stores. */
export const DEFAULT_MANIFEST_STRINGS_KEY = 'extension.manifest';

/**
 * One build, resolved against the GoApply distribution: `--store` names the
 * build target that store receives; without it `--target` is used as given.
 * Returns the target, the strings key and the default output folder name.
 */
export function resolveBuild(opts, distribution) {
  if (opts.store !== undefined) {
    if (opts.brand !== 'goapply') throw new Error('--store is for --brand=goapply');
    if (!distribution.stores.includes(opts.store)) throw new Error(`--store must be one of ${distribution.stores.join(', ')}`);
  }
  const goapply = opts.brand === 'goapply';
  const target = opts.store ? distribution.buildTarget[opts.store] : opts.target;
  return {
    ...opts,
    target,
    stringsKey: goapply ? distribution.manifestStringsKey : DEFAULT_MANIFEST_STRINGS_KEY,
    outName: `${opts.brand}-${opts.store ?? target}${opts.dev ? '-dev' : ''}`,
  };
}

/** `--all`: RoboApply for every target, GoApply for every store of its distribution (Edge Add-ons first). */
export function allBuilds(opts, distribution) {
  return [
    ...TARGETS.map((target) => ({ ...opts, brand: 'roboapply', target, store: undefined, out: undefined })),
    ...distribution.stores.map((store) => ({ ...opts, brand: 'goapply', target: distribution.buildTarget[store], store, out: undefined })),
  ];
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src ?? {})) {
    if (isObj(v) && isObj(dst[k])) deepMerge(dst[k], v);
    else dst[k] = isObj(v) ? deepMerge({}, v) : v;
  }
  return dst;
}

/** English (en.json + staged English) and every translated bundle in src/i18n. */
export function loadMessages() {
  const dir = join(EXT_ROOT, 'src/i18n');
  const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
  const en = read(join(dir, 'en.json'));
  const staged = join(REPO_ROOT, 'i18n/staging/extension.en.json');
  if (existsSync(staged)) deepMerge(en, read(staged));
  const others = {};
  for (const name of readdirSync(dir)) {
    const m = name.match(/^(.+)\.json$/);
    if (!m || m[1] === 'en') continue;
    others[m[1]] = read(join(dir, name));
  }
  return { en, others };
}

/** GoApply's own manifest strings, staged per language: `{ en, zh }` (a missing file is left out). */
export function loadCnMessages() {
  const out = {};
  for (const locale of ['en', 'zh']) {
    const file = join(REPO_ROOT, `i18n/staging/extension-cn.${locale}.json`);
    if (existsSync(file)) out[locale] = JSON.parse(readFileSync(file, 'utf8'));
  }
  return out;
}

function lookup(bundle, path) {
  return path.split('.').reduce((cur, k) => (isObj(cur) ? cur[k] : undefined), bundle);
}

/** `_locales/<lang>/messages.json` for the manifest's name, description and action title. */
export function manifestMessages(bundle, fallback, brandName, target, stringsKey = DEFAULT_MANIFEST_STRINGS_KEY) {
  const pick = (key) => lookup(bundle, `${stringsKey}.${key}`) ?? lookup(fallback, `${stringsKey}.${key}`);
  const sub = (s) => String(s ?? '').replace(/%BRAND%/g, brandName);
  const name = target === 'edge' ? pick('nameEdge') : pick('nameChrome');
  return {
    extName: { message: sub(name).slice(0, 75) },
    extShortName: { message: sub(pick('shortName')).slice(0, 12) },
    extDescription: { message: sub(pick('description')).slice(0, 132) },
    actionTitle: { message: sub(pick('actionTitle')) },
  };
}

/**
 * Every `_locales` folder of one build: `{ en: {...}, zh_CN: {...} }`.
 * `staged` holds strings staged outside src/i18n, per locale (GoApply's
 * `extension-cn` files); they are read under the translated bundle of the
 * same locale, so a merged translation wins. A locale without the build's
 * manifest strings gets no folder (English always does).
 */
export function localeMessagesFor({ brandName, target, stringsKey = DEFAULT_MANIFEST_STRINGS_KEY, en, others = {}, staged = {} }) {
  const bundles = { en, ...others };
  for (const [locale, extra] of Object.entries(staged)) bundles[locale] = deepMerge(deepMerge({}, extra), bundles[locale] ?? {});
  const out = {};
  for (const [locale, bundle] of Object.entries(bundles)) {
    const folder = CHROME_LOCALE[locale];
    if (!folder) continue;
    if (locale !== 'en' && !lookup(bundle, stringsKey)) continue;
    out[folder] = manifestMessages(bundle, bundles.en, brandName, target, stringsKey);
  }
  return out;
}

// ── icons (plain brand-colour tiles until brand artwork exists) ─────────────
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function tilePng(size, hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const radius = Math.max(2, Math.round(size * 0.22));
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : x;
      const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : y;
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
      const mark = Math.abs(x - size / 2) + Math.abs(y - size / 2) < size * 0.18;
      const o = 1 + x * 4;
      if (!inside) continue;
      row[o] = mark ? 255 : r;
      row[o + 1] = mark ? 255 : g;
      row[o + 2] = mark ? 255 : b;
      row[o + 3] = 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function loadManifestModule(tmpDir) {
  const outfile = join(tmpDir, 'manifest.mjs');
  await build({ entryPoints: [join(EXT_ROOT, 'src/manifest.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

/** GOAPPLY_DISTRIBUTION as the build sees it (bundled from src/brands/goapply through src/manifest.ts). */
export async function loadDistribution() {
  const tmpDir = join(EXT_ROOT, '.build-tmp');
  mkdirSync(tmpDir, { recursive: true });
  try {
    return (await loadManifestModule(tmpDir)).GOAPPLY_DISTRIBUTION;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function buildOne(input) {
  const pkg = JSON.parse(readFileSync(join(EXT_ROOT, 'package.json'), 'utf8'));
  const tmpDir = join(EXT_ROOT, '.build-tmp');
  mkdirSync(tmpDir, { recursive: true });

  const { buildManifest, manifestViolations, getExtBrand, GOAPPLY_DISTRIBUTION } = await loadManifestModule(tmpDir);
  const opts = resolveBuild(input, GOAPPLY_DISTRIBUTION);
  const outDir = resolve(EXT_ROOT, opts.out ?? `dist/${opts.outName}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const manifest = buildManifest({ brand: opts.brand, target: opts.target, dev: opts.dev, version: pkg.version, apiOrigin: opts.apiOrigin });
  const violations = manifestViolations(manifest);
  if (violations.length) throw new Error(`manifest policy:\n  ${violations.join('\n  ')}`);

  const { en, others } = loadMessages();
  const tokens = readClarity(REPO_ROOT);
  const brandName = getExtBrand(opts.brand).name;
  const define = {
    __BRAND__: JSON.stringify(opts.brand),
    __TARGET__: JSON.stringify(opts.target),
    __DEV__: JSON.stringify(Boolean(opts.dev)),
    __API_ORIGIN__: JSON.stringify(opts.apiOrigin ?? ''),
    __EXT_VERSION__: JSON.stringify(pkg.version),
    __EXT_LOCALE_BUNDLES__: JSON.stringify(others),
    __CLARITY_TOKENS__: JSON.stringify(tokenCss(tokens, 'host')),
    __CLARITY_TOKENS_ROOT__: JSON.stringify(tokenCss(tokens, 'root')),
    'process.env.NODE_ENV': JSON.stringify(opts.dev ? 'development' : 'production'),
  };
  const common = { bundle: true, define, jsx: 'automatic', target: ['chrome116'], minify: !opts.dev, sourcemap: opts.dev ? 'inline' : false, logLevel: 'warning', legalComments: 'none' };
  await build({ ...common, entryPoints: [join(EXT_ROOT, 'src/background/sw.ts')], format: 'esm', outfile: join(outDir, 'sw.js') });
  await build({ ...common, entryPoints: [join(EXT_ROOT, 'src/content/main.ts')], format: 'iife', outfile: join(outDir, 'content.js') });
  await build({ ...common, entryPoints: [join(EXT_ROOT, 'src/popup/main.tsx')], format: 'iife', outfile: join(outDir, 'popup.js') });
  copyFileSync(join(EXT_ROOT, 'src/popup/popup.html'), join(outDir, 'popup.html'));

  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const locales = localeMessagesFor({
    brandName,
    target: opts.target,
    stringsKey: opts.stringsKey,
    en,
    others,
    staged: opts.brand === 'goapply' ? loadCnMessages() : {},
  });
  // Chrome refuses an extension whose default locale has no messages file.
  if (!locales[manifest.default_locale]) throw new Error(`no _locales/${manifest.default_locale} strings for ${opts.brand} (${opts.stringsKey})`);
  for (const [folder, messages] of Object.entries(locales)) {
    const dir = join(outDir, '_locales', folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'messages.json'), `${JSON.stringify(messages, null, 2)}\n`);
  }

  const action = (opts.brand === 'goapply' ? tokens.goLight : tokens.light).match(/--action:\s*(#[0-9A-Fa-f]{6})/)?.[1] ?? '#4F3DCA';
  mkdirSync(join(outDir, 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) writeFileSync(join(outDir, 'icons', `${size}.png`), tilePng(size, action));

  rmSync(tmpDir, { recursive: true, force: true });
  return { outDir, manifest, locales };
}

async function main(argv) {
  const { checkExtension } = await import(pathToFileURL(join(REPO_ROOT, 'scripts/check-extension-no-submit.mjs')).href);
  const gate = checkExtension(REPO_ROOT);
  if (gate.violations.length) {
    console.error(`✗ D1 no-submit gate failed:\n  ${gate.violations.join('\n  ')}`);
    return 1;
  }
  const opts = parseArgs(argv);
  const jobs = opts.all ? allBuilds(opts, await loadDistribution()) : [opts];
  for (const job of jobs) {
    const { outDir, manifest } = await buildOne(job);
    console.log(`✓ built ${job.brand} for ${job.store ?? job.target}${job.dev ? ' (dev)' : ''} → ${outDir} (default locale ${manifest.default_locale})`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
