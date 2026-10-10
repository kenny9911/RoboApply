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
  it('RoboApply fills WP-55b and WP-70 sites; GoApply the WP-71 portals; never `generic`', () => {
    expect(extensionAtsTypesFor('intl')).toEqual(['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'icims', 'workable', 'taleo', 'successfactors']);
    expect(extensionAtsTypesFor('cn')).toEqual(['moka', 'beisen', 'feishu', 'dayee']);
    expect([...extensionAtsTypesFor('intl'), ...extensionAtsTypesFor('cn')]).not.toContain('generic');
    expect(EXTENSION_ATS_TYPES).toEqual(EXTENSION_ATS_TYPES_BY_MARKET.intl);
  });

  it('registers both lists in the brand-agnostic job-detail registry, once (the web checks the brand list)', () => {
    registerSupportedAtsTypes();
    registerSupportedAtsTypes();
    expect(registry.registerExtensionAtsTypes).toHaveBeenCalledTimes(1);
    expect([...registry.registerExtensionAtsTypes.mock.calls[0]![0]]).toEqual([...EXTENSION_ATS_TYPES_BY_MARKET.intl, ...EXTENSION_ATS_TYPES_BY_MARKET.cn]);
    expect(registry.registerExtensionAtsTypes.mock.calls[0]![1]).toBe(extensionOffersFill);
  });

  it('the web mirror matches the server lists', () => {
    expect(EXTENSION_ATS_BY_BRAND.roboapply.map((a) => a.type)).toEqual([...EXTENSION_ATS_TYPES_BY_MARKET.intl]);
    expect(EXTENSION_ATS_BY_BRAND.goapply.map((a) => a.type)).toEqual([...EXTENSION_ATS_TYPES_BY_MARKET.cn]);
    expect([...EXTENSION_PER_PAGE_ATS]).toEqual([...EXTENSION_PER_PAGE_ATS_TYPES]);
  });

  // Wave 5 gate: job pages offer the extension only on hosts its adapters run on,
  // and not for page-by-page forms until one run covers an application (R4, WP-93).
  it('every fillable type has host patterns; the matcher follows Chrome match-pattern rules', () => {
    expect(Object.keys(EXTENSION_ATS_HOST_PATTERNS).sort()).toEqual([...EXTENSION_ATS_TYPES_BY_MARKET.intl, ...EXTENSION_ATS_TYPES_BY_MARKET.cn].sort());
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
    expect(extensionOffersFill('intl', 'workday', 'https://acme.wd5.myworkdayjobs.com/External/job/1')).toBe(false);
    expect(extensionOffersFill('intl', 'icims', 'https://careers-acme.icims.com/jobs/1/job')).toBe(false);
    expect(extensionOffersFill('cn', 'moka', 'https://app.mokahr.com/apply/acme/1')).toBe(true);
    expect(extensionOffersFill('cn', 'feishu', 'https://jobs.bytedance.com/campus/position/1')).toBe(false);
    expect(extensionOffersFill('cn', 'greenhouse', 'https://boards.greenhouse.io/acme/jobs/1')).toBe(false);
    expect(extensionOffersFill('intl', 'moka', 'https://app.mokahr.com/apply/acme/1')).toBe(false);
    expect(extensionOffersFill('intl', 'greenhouse', null)).toBe(false);
  });

  it('the web button never offers a page-by-page form', () => {
    expect(extensionFillsAts('roboapply', 'greenhouse')).toBe(true);
    for (const t of EXTENSION_PER_PAGE_ATS_TYPES) expect(extensionFillsAts('roboapply', t)).toBe(false);
    expect(extensionFillsAts('goapply', 'greenhouse')).toBe(false);
  });
});
