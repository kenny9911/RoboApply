// @vitest-environment node
// The build script and the GoApply distribution (WP-93): the store name,
// short name, description and toolbar title of a GoApply build come from the
// `extension-cn.manifest` strings GOAPPLY_DISTRIBUTION names, in `_locales/en`
// and `_locales/zh_CN`; `--store` picks the build target a store receives.

import { describe, expect, it } from 'vitest';

import { GOAPPLY_DISTRIBUTION } from '../src/brands/goapply/index';
import { boardDomains } from '../src/content/boards/index';
import { buildManifest, defaultLocaleFolder, isForbiddenHostPattern, manifestViolations } from '../src/manifest';
// @ts-expect-error — plain .mjs build script
import { DEFAULT_MANIFEST_STRINGS_KEY, allBuilds, loadCnMessages, loadMessages, localeMessagesFor, parseArgs, resolveBuild } from '../scripts/build.mjs';

type Messages = Record<string, { message: string }>;
type Locales = Record<string, Messages>;

const { en, others } = loadMessages() as { en: object; others: Record<string, object> };
const staged = loadCnMessages() as Record<string, object>;

function goapplyLocales(target: 'edge' | 'chrome'): Locales {
  return localeMessagesFor({ brandName: 'GoApply', target, stringsKey: GOAPPLY_DISTRIBUTION.manifestStringsKey, en, others, staged }) as Locales;
}

describe('GoApply build: both distributions', () => {
  it('reads the extension-cn strings in English and Chinese', () => {
    // WP-91 merged them into src/i18n/{en,zh}.json; the staging files stay as scratch space for later strings.
    expect(Object.keys(staged).sort()).toEqual(['en', 'zh']);
    expect(en).toHaveProperty(['extension-cn', 'manifest', 'nameEdge']);
    expect(others.zh).toHaveProperty(['extension-cn', 'manifest', 'nameEdge']);
    expect(GOAPPLY_DISTRIBUTION.manifestStringsKey).toBe('extension-cn.manifest');
  });

  it('Edge Add-ons: the store name is the distribution\'s, never the generic "GoApply for Edge"', () => {
    const locales = goapplyLocales(GOAPPLY_DISTRIBUTION.buildTarget.edge);
    expect(Object.keys(locales).sort()).toEqual(['en', 'zh_CN']);
    expect(locales.zh_CN).toEqual({
      extName: { message: 'GoApply 一键填表' },
      extShortName: { message: 'GoApply' },
      extDescription: { message: '用你在 GoApply 的资料填写网申表单。每一项由你核对，申请由你自己提交。' },
      actionTitle: { message: '一键填表' },
    });
    expect(locales.en.extName.message).toBe('GoApply Form Filler');
    expect(locales.en.actionTitle.message).toBe('Fill this form');
    for (const l of Object.values(locales)) expect(l.extName.message).not.toBe('GoApply for Edge');
    // Edge Add-ons: name ≤ 45 characters.
    for (const l of Object.values(locales)) expect(l.extName.message.length).toBeLessThanOrEqual(45);
  });

  it('Chrome Web Store and the self-hosted CRX: the Chrome name, within the store limits', () => {
    expect(GOAPPLY_DISTRIBUTION.buildTarget.chrome).toBe('chrome');
    expect(GOAPPLY_DISTRIBUTION.buildTarget.crx).toBe('chrome');
    const locales = goapplyLocales('chrome');
    expect(locales.zh_CN.extName.message).toBe('GoApply 一键填表（Chrome 版）');
    expect(locales.en.extName.message).toBe('GoApply Form Filler for Chrome');
    for (const l of Object.values(locales)) {
      expect(l.extName.message.length).toBeLessThanOrEqual(75);
      expect(l.extShortName.message.length).toBeLessThanOrEqual(12);
      expect(l.extDescription.message.length).toBeLessThanOrEqual(132);
      // D1: the listing says who submits.
      expect(l.extDescription.message).toMatch(/submit the application yourself|申请由你自己提交/);
      expect(JSON.stringify(l)).not.toContain('%BRAND%');
    }
  });

  it('the default locale of each build has a messages file (Chrome refuses the extension otherwise)', () => {
    expect(defaultLocaleFolder('goapply')).toBe('zh_CN');
    expect(defaultLocaleFolder('roboapply')).toBe('en');
    for (const store of GOAPPLY_DISTRIBUTION.stores) {
      const target = GOAPPLY_DISTRIBUTION.buildTarget[store];
      const m = buildManifest({ brand: 'goapply', target, dev: false, version: '1.0.0' }) as { default_locale: string; name: string };
      expect(m.default_locale).toBe('zh_CN');
      expect(m.name).toBe('__MSG_extName__');
      expect(goapplyLocales(target)[m.default_locale]).toBeTruthy();
    }
    const robo = buildManifest({ brand: 'roboapply', target: 'chrome', dev: false, version: '1.0.0' }) as { default_locale: string };
    expect(robo.default_locale).toBe('en');
  });

  it('a translated bundle wins over the staged strings of the same locale', () => {
    const translated = { zh: { 'extension-cn': { manifest: { nameEdge: '%BRAND% 填表助手' } } } };
    // The authored zh strings as the staged layer (where they sat until WP-91 merged them into src/i18n/zh.json).
    const stagedZh = { zh: others.zh };
    const locales = localeMessagesFor({ brandName: 'GoApply', target: 'edge', stringsKey: 'extension-cn.manifest', en, others: translated, staged: stagedZh }) as Locales;
    expect(locales.zh_CN.extName.message).toBe('GoApply 填表助手');
    // Keys the translation does not carry still come from the staged zh strings.
    expect(locales.zh_CN.actionTitle.message).toBe('一键填表');
  });
});

describe('RoboApply build', () => {
  it('uses extension.manifest, with a _locales folder for every locale that translates it (WP-92)', () => {
    const locales = localeMessagesFor({ brandName: 'RoboApply', target: 'chrome', stringsKey: DEFAULT_MANIFEST_STRINGS_KEY, en, others, staged: {} }) as Locales;
    expect(locales.en.extName.message).toBe('RoboApply for Chrome');
    // English plus the eight translated locales, under Chrome's folder names.
    expect(Object.keys(locales).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt_BR', 'zh_CN', 'zh_TW']);
    // Simplified Chinese is RoboApply's own listing, never GoApply's distribution name.
    expect(locales.zh_CN.extName.message).toBe('RoboApply Chrome 版');
    expect(locales.zh_CN.extName.message).not.toBe(goapplyLocales('chrome').zh_CN.extName.message);
    const sources: Record<string, object> = { en, ...others };
    const folderOf: Record<string, string> = { zh: 'zh_CN', 'zh-TW': 'zh_TW', pt: 'pt_BR' };
    for (const [locale, bundle] of Object.entries(sources)) {
      const l = locales[folderOf[locale] ?? locale];
      const src = (bundle as { extension: { manifest: Record<string, string> } }).extension.manifest;
      expect(l.extName.message, locale).toContain('RoboApply');
      expect(JSON.stringify(l), locale).not.toMatch(/%BRAND%|GoApply/);
      // Store limits, and nothing was cut to fit them: each string is the bundle's, whole.
      expect(l.extName.message.length, locale).toBeLessThanOrEqual(75);
      expect(l.extShortName.message.length, locale).toBeLessThanOrEqual(12);
      expect(l.extDescription.message.length, locale).toBeLessThanOrEqual(132);
      expect(l.extName.message, locale).toBe(src.nameChrome.replace(/%BRAND%/g, 'RoboApply'));
      expect(l.extDescription.message, locale).toBe(src.description.replace(/%BRAND%/g, 'RoboApply'));
      expect(l.actionTitle.message, locale).toBe(src.actionTitle);
    }
    const edge = localeMessagesFor({ brandName: 'RoboApply', target: 'edge', en, others }) as Locales;
    expect(edge.en.extName.message).toBe('RoboApply for Edge');
    expect(edge.zh_TW.extName.message).toBe('RoboApply Edge 版');
  });

  it('a locale whose bundle lacks the manifest strings gets no folder; English always does', () => {
    const locales = localeMessagesFor({ brandName: 'RoboApply', target: 'chrome', stringsKey: DEFAULT_MANIFEST_STRINGS_KEY, en, others: { zh: { extension: {} }, ja: {} }, staged: {} }) as Locales;
    expect(Object.keys(locales)).toEqual(['en']);
    expect(locales.zh_CN).toBeUndefined();
  });
});

describe('--store and --all follow GOAPPLY_DISTRIBUTION', () => {
  it('--store names the build target that store receives', () => {
    expect(parseArgs(['--brand=goapply', '--store=edge'])).toMatchObject({ brand: 'goapply', store: 'edge' });
    expect(resolveBuild(parseArgs(['--brand=goapply', '--store=edge']), GOAPPLY_DISTRIBUTION)).toMatchObject({ target: 'edge', stringsKey: 'extension-cn.manifest', outName: 'goapply-edge' });
    expect(resolveBuild(parseArgs(['--brand=goapply', '--store=crx']), GOAPPLY_DISTRIBUTION)).toMatchObject({ target: 'chrome', outName: 'goapply-crx' });
    // Without --store the target is used as given (package.json `build:goapply`).
    expect(resolveBuild(parseArgs(['--brand=goapply', '--target=edge']), GOAPPLY_DISTRIBUTION)).toMatchObject({ target: 'edge', stringsKey: 'extension-cn.manifest', outName: 'goapply-edge' });
    expect(resolveBuild(parseArgs(['--brand=roboapply', '--target=chrome', '--dev']), GOAPPLY_DISTRIBUTION)).toMatchObject({ target: 'chrome', stringsKey: 'extension.manifest', outName: 'roboapply-chrome-dev' });
  });

  it('refuses a store for RoboApply and an unknown store', () => {
    expect(() => resolveBuild(parseArgs(['--brand=roboapply', '--store=edge']), GOAPPLY_DISTRIBUTION)).toThrow(/--store is for --brand=goapply/);
    expect(() => resolveBuild(parseArgs(['--brand=goapply', '--store=firefox']), GOAPPLY_DISTRIBUTION)).toThrow(/--store must be one of edge, chrome, crx/);
  });

  it('--all builds RoboApply per target and GoApply per store, Edge Add-ons first', () => {
    const jobs = allBuilds(parseArgs(['--all']), GOAPPLY_DISTRIBUTION) as Array<{ brand: string; target: string; store?: string }>;
    expect(jobs.map((j) => `${j.brand}:${j.store ?? j.target}`)).toEqual(['roboapply:chrome', 'roboapply:edge', 'goapply:edge', 'goapply:chrome', 'goapply:crx']);
    expect(jobs.filter((j) => j.brand === 'goapply').map((j) => j.target)).toEqual(['edge', 'chrome', 'chrome']);
  });
});

describe('permissions are unchanged by the GoApply popup and build wiring', () => {
  it('every GoApply build: the same three permissions, no optional ones, policy clean', () => {
    for (const store of GOAPPLY_DISTRIBUTION.stores) {
      const m = buildManifest({ brand: 'goapply', target: GOAPPLY_DISTRIBUTION.buildTarget[store], dev: false, version: '1.0.0' });
      expect(m.permissions).toEqual(['activeTab', 'scripting', 'storage']);
      expect('optional_permissions' in m).toBe(false);
      expect('optional_host_permissions' in m).toBe(false);
      expect(manifestViolations(m)).toEqual([]);
    }
  });

  it('manifestViolations still refuses every boardDomains() host, as a host permission or a content script', () => {
    const base = buildManifest({ brand: 'goapply', target: 'edge', dev: false, version: '1.0.0' });
    expect(boardDomains().length).toBeGreaterThan(0);
    for (const domain of boardDomains()) {
      for (const pattern of [`https://${domain}/*`, `https://*.${domain}/*`, `*://www.${domain}/*`]) {
        expect(isForbiddenHostPattern(pattern), pattern).toBe(true);
        expect(manifestViolations({ ...base, host_permissions: [...(base.host_permissions as string[]), pattern] })).toContain(`host permission "${pattern}" is not allowed`);
        expect(manifestViolations({ ...base, content_scripts: [{ matches: [pattern] }] })).toContain(`content script on "${pattern}" is not allowed`);
      }
    }
    expect(manifestViolations({ ...base, permissions: ['activeTab', 'scripting', 'storage', 'tabs'] })).toContain('permission "tabs" is not allowed');
  });
});
