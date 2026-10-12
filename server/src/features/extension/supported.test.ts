// @vitest-environment node
//
// WP-55a: supported ATS types are per market; the web mirror agrees. Both
// lists reach the brand-agnostic job-detail registry (Wave 5 gate), and the
// web button also checks the brand's own list.

import { describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({ registerExtensionAtsTypes: vi.fn() }));
vi.mock('../jobs/detail/index.js', () => registry);

import { EXTENSION_ATS_BY_BRAND, EXTENSION_PER_PAGE_ATS, extensionFillsAts } from '../../../../hooks/extension/bridge';
import { EXTENSION_ATS_HOST_PATTERNS, EXTENSION_ATS_TYPES_BY_MARKET, EXTENSION_PER_PAGE_ATS_TYPES, extensionOffersFill, matchesExtensionHostPattern } from './contract.js';
import { EXTENSION_ATS_TYPES, extensionAtsTypesFor, registerSupportedAtsTypes } from './supported.js';

describe('supported ATS types', () => {
  it('RoboApply fills WP-55b and WP-70 sites; GoApply its WP-71 portals plus the whole RoboApply list (a superset, D5); never `generic`', () => {
    const intl = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'icims', 'workable', 'taleo', 'successfactors'];
    expect(extensionAtsTypesFor('intl')).toEqual(intl);
    expect(extensionAtsTypesFor('cn')).toEqual(['moka', 'beisen', 'feishu', 'dayee', ...intl]);
    for (const type of extensionAtsTypesFor('intl')) expect(extensionAtsTypesFor('cn'), type).toContain(type);
    expect(new Set(extensionAtsTypesFor('cn')).size).toBe(extensionAtsTypesFor('cn').length);
    expect([...extensionAtsTypesFor('intl'), ...extensionAtsTypesFor('cn')]).not.toContain('generic');
    expect(EXTENSION_ATS_TYPES).toEqual(EXTENSION_ATS_TYPES_BY_MARKET.intl);
    // RoboApply's list gained nothing: the mainland portals stay GoApply's.
    for (const type of ['moka', 'beisen', 'feishu', 'dayee']) expect(extensionAtsTypesFor('intl')).not.toContain(type);
  });

  it('registers both lists in the brand-agnostic job-detail registry, once (the web checks the brand list)', () => {
    registerSupportedAtsTypes();
    registerSupportedAtsTypes();
    expect(registry.registerExtensionAtsTypes).toHaveBeenCalledTimes(1);
    const registered = [...registry.registerExtensionAtsTypes.mock.calls[0]![0]];
    expect(registered).toEqual([...new Set([...EXTENSION_ATS_TYPES_BY_MARKET.intl, ...EXTENSION_ATS_TYPES_BY_MARKET.cn])]);
    expect(new Set(registered).size).toBe(registered.length);
    expect(registry.registerExtensionAtsTypes.mock.calls[0]![1]).toBe(extensionOffersFill);
  });

  it('the web mirror matches the server lists', () => {
    expect(EXTENSION_ATS_BY_BRAND.roboapply.map((a) => a.type)).toEqual([...EXTENSION_ATS_TYPES_BY_MARKET.intl]);
    expect(EXTENSION_ATS_BY_BRAND.goapply.map((a) => a.type)).toEqual([...EXTENSION_ATS_TYPES_BY_MARKET.cn]);
    expect([...EXTENSION_PER_PAGE_ATS]).toEqual([...EXTENSION_PER_PAGE_ATS_TYPES]);
  });

  // Wave 5 gate: job pages offer the extension only on hosts its adapters run on,
  // and not for the page-by-page forms that may still start a run per page
  // (iCIMS, Taleo, SuccessFactors; Workday is covered by one run since R4, WP-93).
  it('every fillable type has host patterns; the matcher follows Chrome match-pattern rules', () => {
    expect(Object.keys(EXTENSION_ATS_HOST_PATTERNS).sort()).toEqual([...new Set<string>([...EXTENSION_ATS_TYPES_BY_MARKET.intl, ...EXTENSION_ATS_TYPES_BY_MARKET.cn])].sort());
    expect(matchesExtensionHostPattern('https://acme.jobs.feishu.cn/x', 'https://*.jobs.feishu.cn/*')).toBe(true);
    expect(matchesExtensionHostPattern('https://jobs.feishu.cn/x', 'https://*.jobs.feishu.cn/*')).toBe(true);
    expect(matchesExtensionHostPattern('https://jobs.bytedance.com/x', 'https://*.jobs.feishu.cn/*')).toBe(false);
    expect(matchesExtensionHostPattern('http://boards.greenhouse.io/x', 'https://boards.greenhouse.io/*')).toBe(false);
    expect(matchesExtensionHostPattern('https://acme.successfactors.com/career?company=a', 'https://*.successfactors.com/career*')).toBe(true);
    expect(matchesExtensionHostPattern('https://acme.successfactors.com/login', 'https://*.successfactors.com/career*')).toBe(false);
    expect(matchesExtensionHostPattern('not a url', 'https://*.mokahr.com/*')).toBe(false);
  });

  it('extensionOffersFill: market list, adapter host, no page-by-page form', () => {
    expect(extensionOffersFill('intl', 'lever', 'https://jobs.lever.co/acme/1')).toBe(true);
    expect(extensionOffersFill('intl', 'lever', 'https://api.lever.co/v0/postings/acme/1')).toBe(false);
    expect(extensionOffersFill('intl', 'workable', 'https://acme.workable.com/j/1')).toBe(false);
    expect(extensionOffersFill('intl', 'workable', 'https://apply.workable.com/acme/j/1')).toBe(true);
    // R4 (WP-93): one run covers a Workday application, so job pages offer it again.
    expect(extensionOffersFill('intl', 'workday', 'https://acme.wd5.myworkdayjobs.com/External/job/1')).toBe(true);
    expect(extensionOffersFill('intl', 'workday', 'https://acme.myworkday.com/External/job/1')).toBe(false);
    expect(extensionOffersFill('intl', 'icims', 'https://careers-acme.icims.com/jobs/1/job')).toBe(false);
    expect(extensionOffersFill('intl', 'taleo', 'https://acme.taleo.net/careersection/2/jobapply.ftl')).toBe(false);
    expect(extensionOffersFill('intl', 'successfactors', 'https://acme.successfactors.com/career?company=a')).toBe(false);
    expect(extensionOffersFill('cn', 'moka', 'https://app.mokahr.com/apply/acme/1')).toBe(true);
    expect(extensionOffersFill('cn', 'feishu', 'https://jobs.bytedance.com/campus/position/1')).toBe(false);
    expect(extensionOffersFill('intl', 'moka', 'https://app.mokahr.com/apply/acme/1')).toBe(false);
    expect(extensionOffersFill('intl', 'greenhouse', null)).toBe(false);
  });

  it('GoApply offers a fill wherever RoboApply does: the same hosts, and the same page-by-page hold', () => {
    const cases: Array<[string, string]> = [
      ['greenhouse', 'https://boards.greenhouse.io/acme/jobs/1'],
      ['lever', 'https://jobs.lever.co/acme/1'],
      ['lever', 'https://api.lever.co/v0/postings/acme/1'],
      ['workable', 'https://apply.workable.com/acme/j/1'],
      ['workday', 'https://acme.wd5.myworkdayjobs.com/External/job/1'],
      ['workday', 'https://acme.myworkday.com/External/job/1'],
      // Page-by-page forms stay held on both brands until one run covers them (R4).
      ['icims', 'https://careers-acme.icims.com/jobs/1/job'],
      ['taleo', 'https://acme.taleo.net/careersection/2/jobapply.ftl'],
      ['successfactors', 'https://acme.successfactors.com/career?company=a'],
    ];
    for (const [type, url] of cases) expect(extensionOffersFill('cn', type, url), `${type} ${url}`).toBe(extensionOffersFill('intl', type, url));
    expect(extensionOffersFill('cn', 'workday', 'https://acme.wd5.myworkdayjobs.com/External/job/1')).toBe(true);
    expect(extensionOffersFill('cn', 'greenhouse', 'https://boards.greenhouse.io/acme/jobs/1')).toBe(true);
    expect(extensionOffersFill('cn', 'successfactors', 'https://acme.successfactors.com/career?company=a')).toBe(false);
  });

  it('the web button never offers a page-by-page form', () => {
    expect(extensionFillsAts('roboapply', 'greenhouse')).toBe(true);
    for (const t of EXTENSION_PER_PAGE_ATS_TYPES) expect(extensionFillsAts('roboapply', t)).toBe(false);
    expect([...EXTENSION_PER_PAGE_ATS_TYPES]).not.toContain('workday');
    expect(extensionFillsAts('roboapply', 'workday')).toBe(true);
    // GoApply's button follows the same list plus its portals.
    expect(extensionFillsAts('goapply', 'greenhouse')).toBe(true);
    expect(extensionFillsAts('goapply', 'workday')).toBe(true);
    expect(extensionFillsAts('goapply', 'moka')).toBe(true);
    for (const t of EXTENSION_PER_PAGE_ATS_TYPES) expect(extensionFillsAts('goapply', t)).toBe(false);
    expect(extensionFillsAts('roboapply', 'moka')).toBe(false);
  });
});

// The extension package's own tests run in its own suite (extension/test). The
// two below are the parity facts this area owns, read from the package source.
describe('the GoApply extension build (extension/src)', () => {
  it('ships the mainland portals, then every RoboApply adapter, with the 网申 fallback last', async () => {
    const { adaptersFor, plannedSitesFor } = await import('../../../../extension/src/adapters/registry');
    const { goapplyFillableAtsTypes, goapplyPortalIds, GOAPPLY_EXT } = await import('../../../../extension/src/brands/goapply/index');
    const cn = adaptersFor('cn');
    const intl = adaptersFor('intl');
    expect(GOAPPLY_EXT.adapterSet).toBe('cn');
    expect(cn.slice(0, 4).map((a) => a.id)).toEqual(['moka', 'beisen', 'feishu', 'dayee']);
    for (const adapter of intl) expect(cn, adapter.id).toContain(adapter);
    expect(cn[cn.length - 1]!.hostPatterns).toEqual([]);
    expect(goapplyPortalIds()).toEqual(['moka', 'beisen', 'feishu', 'dayee']);
    expect(goapplyFillableAtsTypes()).toEqual([...EXTENSION_ATS_TYPES_BY_MARKET.cn]);
    // RoboApply's build is what it was: no mainland portal.
    expect(intl.some((a) => ['moka', 'beisen', 'feishu', 'dayee'].includes(a.id))).toBe(false);
    // Every known site has an adapter in the build that lists it.
    expect(plannedSitesFor('cn')).toEqual([]);
  });

  it('its manifest holds the international form hosts too, and still no job board, tab or cookie permission', async () => {
    const { buildManifest, manifestViolations, PERMISSIONS } = await import('../../../../extension/src/manifest');
    const { adapterHostPatterns } = await import('../../../../extension/src/adapters/registry');
    for (const target of ['edge', 'chrome'] as const) {
      const go = buildManifest({ brand: 'goapply', target, dev: false, version: '1.0.0' }) as { host_permissions: string[]; permissions: string[]; content_scripts: Array<{ matches: string[] }> };
      const robo = buildManifest({ brand: 'roboapply', target: 'chrome', dev: false, version: '1.0.0' }) as { host_permissions: string[] };
      expect(manifestViolations(go)).toEqual([]);
      expect(go.permissions).toEqual([...PERMISSIONS]);
      expect(go.host_permissions[0]).toBe('https://www.goapply.top/*');
      // Every form host RoboApply's build may run on, GoApply's may too.
      for (const pattern of adapterHostPatterns('intl')) {
        expect(go.host_permissions, pattern).toContain(pattern);
        expect(go.content_scripts[0]!.matches, pattern).toContain(pattern);
      }
      for (const pattern of ['https://*.mokahr.com/*', 'https://*.jobs.feishu.cn/*']) expect(go.host_permissions).toContain(pattern);
      // The server's host patterns for GoApply's list are exactly what the manifest grants.
      for (const type of EXTENSION_ATS_TYPES_BY_MARKET.cn) {
        for (const pattern of EXTENSION_ATS_HOST_PATTERNS[type]) expect(go.host_permissions, `${type} ${pattern}`).toContain(pattern);
      }
      // RoboApply's manifest gained nothing.
      expect(robo.host_permissions.some((p) => /mokahr|feishu|zhiye|hotjob/.test(p))).toBe(false);
      expect(robo.host_permissions.slice(1)).toEqual(adapterHostPatterns('intl'));
    }
  });
});
