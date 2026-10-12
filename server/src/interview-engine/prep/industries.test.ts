// @vitest-environment node
//
// Browsing by industry: the listed industries (prep/industries.ts), ordered
// per job market and labelled in the candidate's language, and the roles an
// industry hires (prep/industryRoles.ts), written once per industry, language
// and market with the writing agent faked.
// Run: npx vitest run server/src/interview-engine/prep/industries.test.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  generateRequestId: () => 'req-test',
}));

import { getBrand } from '../../platform/brand/registry.js';
import type { PrepMarketContext } from './marketContext.js';
import { INDUSTRIES, industriesFor, industryTextEn, normalizeIndustryLocale } from './industries.js';
import { clearIndustryRolesCache, rolesForIndustry, type IndustryRolesWriter } from './industryRoles.js';

const LOCALES = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'] as const;

describe('INDUSTRIES', () => {
  it('lists 27 industries with unique ids and a label in each of the nine locales', () => {
    expect(INDUSTRIES).toHaveLength(27);
    expect(new Set(INDUSTRIES.map((entry) => entry.id)).size).toBe(27);
    for (const entry of INDUSTRIES) {
      for (const locale of LOCALES) expect(entry.labels[locale]?.trim(), `${entry.id}/${locale}`).toBeTruthy();
    }
  });
});

describe('industriesFor', () => {
  it.each([
    ['cn', 'zh', ['software_internet', 'ai', 'semiconductors_electronics', 'automotive_ev'], '软件与互联网'],
    ['tw', 'zh-TW', ['semiconductors_electronics', 'software_internet', 'ai', 'manufacturing_industrial'], '半導體與電子'],
    ['jp', 'ja', ['manufacturing_industrial', 'automotive_ev', 'software_internet', 'ai'], '製造・工業'],
    ['kr', 'ko', ['semiconductors_electronics', 'software_internet', 'ai', 'automotive_ev'], '반도체·전자'],
    ['default', 'en', ['software_internet', 'ai', 'banking_financial', 'healthcare'], 'Software & Internet'],
  ])('the %s market leads with its own industries, labelled in %s', (market, locale, firstIds, firstLabel) => {
    const list = industriesFor(market, locale);
    expect(list.slice(0, 4).map((entry) => entry.id)).toEqual(firstIds);
    expect(list[0].label).toBe(firstLabel);
    // Every industry once; the market's twelve first, marked as top.
    expect(list).toHaveLength(27);
    expect(new Set(list.map((entry) => entry.id)).size).toBe(27);
    expect(list.map((entry) => entry.top)).toEqual([...Array(12).fill(true), ...Array(15).fill(false)]);
  });

  it('a market without its own order uses the default order', () => {
    expect(industriesFor('us', 'en')).toEqual(industriesFor('default', 'en'));
    expect(industriesFor(null, 'en')).toEqual(industriesFor('default', 'en'));
  });

  it('labels follow the locale, whatever the order', () => {
    const jaInCn = industriesFor('cn', 'ja');
    expect(jaInCn[0]).toEqual({ id: 'software_internet', label: 'ソフトウェア・インターネット', top: true });
    expect(industriesFor('default', 'de').find((entry) => entry.id === 'ai')?.label).toBe('Künstliche Intelligenz');
  });
});

describe('normalizeIndustryLocale', () => {
  it('maps regional tags onto the nine label locales, else English', () => {
    expect(normalizeIndustryLocale('zh-Hant')).toBe('zh-TW');
    expect(normalizeIndustryLocale('zh-HK')).toBe('zh-TW');
    expect(normalizeIndustryLocale('zh-TW')).toBe('zh-TW');
    expect(normalizeIndustryLocale('zh-CN')).toBe('zh');
    expect(normalizeIndustryLocale('pt-BR')).toBe('pt');
    expect(normalizeIndustryLocale('fr-CA')).toBe('fr');
    expect(normalizeIndustryLocale('xx')).toBe('en');
    expect(normalizeIndustryLocale(null)).toBe('en');
  });
});

describe('industryTextEn', () => {
  it('maps a listed industry id to its English label and keeps typed text as typed (single-spaced, capped)', () => {
    expect(industryTextEn('ai')).toBe('Artificial Intelligence');
    expect(industryTextEn(' pharma_biotech ')).toBe('Pharma & Biotech');
    expect(industryTextEn('  Space   mining ')).toBe('Space mining');
    expect(industryTextEn('航天')).toBe('航天');
    expect(industryTextEn('x'.repeat(100))).toHaveLength(80);
    for (const empty of ['', '   ', null, undefined]) expect(industryTextEn(empty)).toBeNull();
  });
});

describe('rolesForIndustry', () => {
  const cnCtx: PrepMarketContext = { brand: getBrand('goapply'), formatMarket: 'cn', country: 'CN', marketKey: 'cn', marketLabel: 'Mainland China' };
  const usCtx: PrepMarketContext = { brand: getBrand('roboapply'), formatMarket: 'intl', country: 'US', marketKey: 'us', marketLabel: 'United States and Canada' };
  const ROLES = [
    { title: '飞行试验工程师', titleEn: 'Flight Test Engineer', context: '负责试飞数据' },
    { title: 'Program Manager', titleEn: 'Program Manager', context: '' },
  ];

  beforeEach(() => {
    clearIndustryRolesCache();
  });

  it('writes the roles once per industry, language and market, then serves the cache', async () => {
    const write = vi.fn<IndustryRolesWriter>(async () => structuredClone(ROLES));
    const roles = await rolesForIndustry({ industry: 'aerospace_defense', locale: 'zh', ctx: cnCtx, requestId: 'r1' }, write);
    expect(roles).toEqual([
      { title: '飞行试验工程师', titleEn: 'Flight Test Engineer', source: 'ai', context: '负责试飞数据' },
      { title: 'Program Manager', titleEn: null, source: 'ai', context: null },
    ]);
    // A listed industry reaches the agent by its English label.
    expect(write).toHaveBeenCalledWith({ industry: 'Aerospace & Defense', locale: 'zh', marketLabel: 'Mainland China' }, 'r1');

    expect(await rolesForIndustry({ industry: 'aerospace_defense', locale: 'zh', ctx: cnCtx }, write)).toEqual(roles);
    expect(write).toHaveBeenCalledTimes(1);
    await rolesForIndustry({ industry: 'aerospace_defense', locale: 'en', ctx: cnCtx }, write);
    await rolesForIndustry({ industry: 'aerospace_defense', locale: 'zh', ctx: usCtx }, write);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('a typed industry is used as typed, and matched again whatever its spacing or case', async () => {
    const write = vi.fn<IndustryRolesWriter>(async () => structuredClone(ROLES));
    await rolesForIndustry({ industry: 'Space Mining', locale: 'en', ctx: usCtx }, write);
    await rolesForIndustry({ industry: '  space   MINING ', locale: 'en', ctx: usCtx }, write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0].industry).toBe('Space Mining');
  });

  it('answers null when the writer fails, and tries again next time', async () => {
    const write = vi.fn<IndustryRolesWriter>().mockRejectedValueOnce(new Error('model down')).mockResolvedValue(structuredClone(ROLES));
    expect(await rolesForIndustry({ industry: 'insurance', locale: 'en', ctx: usCtx }, write)).toBeNull();
    expect(await rolesForIndustry({ industry: 'insurance', locale: 'en', ctx: usCtx }, write)).toHaveLength(2);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('an empty answer is returned but not remembered', async () => {
    const write = vi.fn<IndustryRolesWriter>(async () => []);
    expect(await rolesForIndustry({ industry: 'insurance', locale: 'en', ctx: usCtx }, write)).toEqual([]);
    await rolesForIndustry({ industry: 'insurance', locale: 'en', ctx: usCtx }, write);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('an empty industry asks nothing', async () => {
    const write = vi.fn<IndustryRolesWriter>(async () => structuredClone(ROLES));
    expect(await rolesForIndustry({ industry: '   ', locale: 'en', ctx: usCtx }, write)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});
