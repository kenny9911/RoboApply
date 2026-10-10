// @vitest-environment node
// WP-56 lib/seo.ts builders: browse classification, JobPosting JSON-LD
// honesty, per-host robots / static sitemap / llms.txt snapshots (both
// hosts), sitemap XML.

import { describe, expect, it } from 'vitest';

import {
  AI_CRAWLERS,
  appDisallowPaths,
  breadcrumbNode,
  browseUnknownQuery,
  classifyBrowseSegments,
  jobPostingNode,
  llmsTxt,
  parseJobIdSlug,
  robotsFor,
  seoCacheTag,
  sitemapIndexXml,
  staticSitemapEntries,
  urlsetXml,
} from '../../../../lib/seo';
import { PROTECTED_PREFIXES } from '../../../../lib/proxyPaths';
import { roleLabel } from '../names';
import { job, ROLE } from './fixtures';

describe('unresolved browse paths name what was not found', () => {
  it.each([
    [['backend-engineer', 'atlantis'], 'unknown_city', { kind: 'city', role: 'backend engineer', city: 'atlantis' }],
    [['zzqx', 'taipei'], 'unknown_role', { kind: 'role', role: 'zzqx', city: 'taipei' }],
    [['underwater-basket-weaver'], 'unknown_role', { kind: 'role', role: 'underwater basket weaver', city: null }],
    [['remote', 'zzqx'], 'unknown_role', { kind: 'role', role: 'zzqx', city: null }],
    [['visa-sponsorship', 'us', 'zzqx'], 'unknown_role', { kind: 'role', role: 'zzqx', city: null }],
  ] as const)('%j (%s)', (segments, reason, expected) => {
    expect(browseUnknownQuery(segments, reason)).toEqual(expected);
  });

  it('other reasons and shapes → null', () => {
    expect(browseUnknownQuery(['backend-engineer'], 'unknown_city')).toBeNull();
    expect(browseUnknownQuery(['visa-sponsorship', 'zz', 'backend-engineer'], 'unknown_country')).toBeNull();
    expect(browseUnknownQuery(['backend-engineer'], null)).toBeNull();
    expect(browseUnknownQuery(['a', 'b', 'c', 'd'], 'unknown_role')).toBeNull();
  });
});

describe('role names per Chinese script', () => {
  it('Simplified on zh / zh-CN; English (not Simplified) on zh-TW until the taxonomy has Traditional labels', () => {
    expect(roleLabel(ROLE, 'zh')).toBe('后端工程师');
    expect(roleLabel(ROLE, 'zh-CN')).toBe('后端工程师');
    expect(roleLabel(ROLE, 'zh-TW')).toBe('Backend engineer');
    expect(roleLabel(ROLE, 'zh-HK')).toBe('Backend engineer');
    expect(roleLabel(ROLE, 'en')).toBe('Backend engineer');
  });
});

describe('browse classification (twin of the server)', () => {
  it.each([
    [['backend-engineer'], { type: 'role', slug: 'backend-engineer' }],
    [['backend-engineer', 'taipei'], { type: 'role_city', slug: 'backend-engineer/taipei' }],
    [['remote', 'backend-engineer'], { type: 'remote_role', slug: 'backend-engineer' }],
    [['visa-sponsorship', 'us', 'backend-engineer'], { type: 'sponsorship_role', slug: 'us/backend-engineer' }],
    [['graduate', 'data-analyst'], { type: 'graduate_role', slug: 'data-analyst' }],
    [['entry-level'], { type: 'segment', slug: 'entry-level' }],
    [['internships'], { type: 'segment', slug: 'internships' }],
    [['%E5%90%8E%E7%AB%AF'], { type: 'role', slug: '后端' }],
  ])('%j', (segments, expected) => {
    expect(classifyBrowseSegments(segments)).toEqual(expected);
  });

  it('rejects other shapes', () => {
    expect(classifyBrowseSegments([])).toBeNull();
    expect(classifyBrowseSegments(['a', 'b', 'c', 'd'])).toBeNull();
    expect(classifyBrowseSegments(['remote'])).toBeNull();
    expect(classifyBrowseSegments(['a b'])).toBeNull();
  });

  it('job id from idSlug and cache tags per brand', () => {
    expect(parseJobIdSlug('cmjob1-backend-engineer')).toBe('cmjob1');
    expect(parseJobIdSlug('<script>')).toBeNull();
    expect(seoCacheTag('roboapply', 'job', 'x')).not.toBe(seoCacheTag('goapply', 'job', 'x'));
  });
});

describe('JobPosting JSON-LD (ARCH §9.3)', () => {
  it('carries real dates, disclosed pay and the canonical URL', () => {
    const node = jobPostingNode(job(), 'roboapply');
    expect(node).toMatchObject({
      '@type': 'JobPosting',
      title: 'Backend Engineer',
      url: 'https://www.roboapply.io/job/cmjob1-backend-engineer-acme',
      datePosted: '2026-10-01T00:00:00.000Z',
      validThrough: '2026-11-30T00:00:00.000Z',
      employmentType: 'FULL_TIME',
      directApply: false,
      hiringOrganization: { name: 'Acme', sameAs: 'https://acme.example' },
      baseSalary: { currency: 'TWD', value: { unitText: 'YEAR', minValue: 1_200_000, maxValue: 1_600_000 } },
      jobLocation: { address: { addressLocality: 'Taipei', addressCountry: 'TW' } },
    });
  });

  it('omits datePosted when estimated, validThrough without a real end date, baseSalary without disclosed pay', () => {
    const node = jobPostingNode(job({ postedAt: null, expiresAt: null, pay: null }), 'roboapply');
    expect(node).not.toHaveProperty('datePosted');
    expect(node).not.toHaveProperty('validThrough');
    expect(node).not.toHaveProperty('baseSalary');
  });

  it('remote jobs are TELECOMMUTE without a made-up address', () => {
    const node = jobPostingNode(job({ workModel: 'remote', remoteScope: 'US' }), 'roboapply');
    expect(node).toMatchObject({ jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { name: 'US' } });
    expect(node).not.toHaveProperty('jobLocation');
  });

  it('breadcrumbs are absolute on the brand origin', () => {
    expect(breadcrumbNode('goapply', [{ name: 'Home', path: '/' }])).toMatchObject({ itemListElement: [{ item: 'https://www.goapply.top/' }] });
  });
});

describe('robots per host', () => {
  it.each(['roboapply', 'goapply'] as const)('%s', (brand) => {
    const r = robotsFor(brand);
    expect(r).toMatchSnapshot();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    // Every group keeps the app disallowed.
    for (const rule of rules) expect(rule.disallow).toEqual(expect.arrayContaining(['/api/', ...PROTECTED_PREFIXES]));
    // AI crawlers: marketing allowed, /job/* disallowed (OPS-A4).
    const ai = rules.find((x) => Array.isArray(x.userAgent) && x.userAgent.includes('ClaudeBot'))!;
    expect(ai.allow).toBe('/');
    expect(ai.disallow).toContain('/job/');
    expect(ai.userAgent).toEqual([...AI_CRAWLERS]);
    // Other crawlers may crawl job pages.
    expect(rules.find((x) => x.userAgent === '*')!.disallow).toEqual(appDisallowPaths());
    expect(r.sitemap).toBe(brand === 'goapply' ? 'https://www.goapply.top/sitemap.xml' : 'https://www.roboapply.io/sitemap.xml');
    expect(rules.some((x) => x.userAgent === 'Baiduspider')).toBe(brand === 'goapply');
  });
});

describe('static sitemap per host', () => {
  const surfaces = { browse: true, campus: true };

  it('RoboApply: hreflang only for seoLocales plus the GoApply zh-CN alternate; /browse when live', () => {
    const entries = staticSitemapEntries('roboapply', { featurePaths: ['/features/job-matches'], surfaces });
    expect(entries).toMatchSnapshot();
    const home = entries[0]!;
    expect(home.loc).toBe('https://www.roboapply.io/');
    expect(home.alternates).toMatchObject({ en: 'https://www.roboapply.io/', 'zh-CN': 'https://www.goapply.top/', 'x-default': 'https://www.roboapply.io/' });
    expect(entries.map((e) => e.loc)).toContain('https://www.roboapply.io/browse');
    expect(entries.map((e) => e.loc)).not.toContain('https://www.roboapply.io/campus');
    expect(entries.every((e) => e.loc.startsWith('https://www.roboapply.io/'))).toBe(true);
  });

  it('GoApply: zh-CN home with the cross-domain en / zh-Hant alternates; /campus when live, never /browse', () => {
    const entries = staticSitemapEntries('goapply', { featurePaths: [], surfaces });
    expect(entries).toMatchSnapshot();
    expect(entries[0]!.alternates).toMatchObject({ 'zh-CN': 'https://www.goapply.top/', en: 'https://www.roboapply.io/' });
    expect(Object.keys(entries[0]!.alternates!)).not.toContain('zh-Hans');
    const locs = entries.map((e) => e.loc);
    expect(locs).toContain('https://www.goapply.top/campus');
    expect(locs).not.toContain('https://www.goapply.top/browse');
    expect(staticSitemapEntries('goapply', { featurePaths: [], surfaces: { browse: false, campus: false } }).map((e) => e.loc)).not.toContain('https://www.goapply.top/campus');
  });

  it('XML is escaped and well formed', () => {
    const xml = urlsetXml([{ loc: 'https://www.roboapply.io/a?b=1&c=2', lastmod: '2026-10-10', alternates: { en: 'https://www.roboapply.io/' } }]);
    expect(xml).toContain('<loc>https://www.roboapply.io/a?b=1&amp;c=2</loc>');
    expect(xml).toContain('xmlns:xhtml');
    expect(xml).toContain('hreflang="en"');
    expect(sitemapIndexXml([{ loc: 'https://www.roboapply.io/sitemaps/static.xml' }])).toMatch(/<sitemapindex[\s\S]*<loc>https:\/\/www\.roboapply\.io\/sitemaps\/static\.xml<\/loc>/);
  });
});

describe('llms.txt per host', () => {
  it.each(['roboapply', 'goapply'] as const)('%s: accurate, no auto-apply claims, no prices', (brand) => {
    const text = llmsTxt(brand, { campus: true });
    expect(text).toMatchSnapshot();
    expect(text).not.toMatch(/auto[- ]?apply|autopilot|apply (?:for|on behalf of) (?:you|the user)|submits? (?:applications? )?for you|自动投递|一键投递|代投|\$\d|¥\d|每月\d/i);
    expect(text).toMatch(/never (?:submits an application|applies) for you/);
    expect(text.startsWith(`# ${brand === 'goapply' ? 'GoApply' : 'RoboApply'}`)).toBe(true);
    // Only the host's own pages are listed as pages.
    const own = brand === 'goapply' ? 'https://www.goapply.top' : 'https://www.roboapply.io';
    for (const m of text.matchAll(/\]\((https:[^)]+)\)/g)) expect(m[1]!.startsWith(own)).toBe(true);
  });
});
