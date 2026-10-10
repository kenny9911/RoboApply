// Parity gate (D5): the Job Search API pages are offered on both brands. The
// title and description carry the request's brand name (no fixed product
// name), the examples come from the brand's market, and neither page answers
// 404 because of the brand.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BRANDS } from '../../lib/brand/registry.generated';
import { clientBrandFor } from '../../lib/brand/client';

const { brand, locale } = vi.hoisted(() => ({ brand: { id: 'roboapply' as 'roboapply' | 'goapply' }, locale: { value: 'en' } }));
vi.mock('../../lib/server/brand', async () => {
  const { getBrand } = await import('../../lib/brand/registry.generated');
  return { getServerBrandId: async () => brand.id, getServerBrand: async () => getBrand(brand.id) };
});
vi.mock('../../lib/serverLocale', () => ({ resolveLocale: async () => locale.value }));

import { jobSearchAvailable, jobSearchAvailableFor, jobSearchMetadata } from '../../components/job-search/metadata';
import { countryOptionsFor, jobSearchBrandExamples } from '../../components/job-search/countries';
import { JOB_SEARCH_AGENT_CURL_EXAMPLE, JOB_SEARCH_CURL_EXAMPLE, jobSearchExamples } from '../../lib/api/job-search';
import { isProtectedPath } from '../../lib/proxyPaths';

afterEach(() => {
  brand.id = 'roboapply';
  locale.value = 'en';
});

describe('job-search pages per brand', () => {
  it('RoboApply: offered, titled with the brand name, the API reference has its canonical', async () => {
    expect(await jobSearchAvailable()).toBe(true);
    const api = await jobSearchMetadata('api');
    expect(String(api.title)).toMatch(/ \| RoboApply$/);
    expect(api.alternates).toEqual({ canonical: '/developers/job-search' });
    const keys = await jobSearchMetadata('keys');
    expect(String(keys.title)).toMatch(/ \| RoboApply$/);
    expect(keys.robots).toEqual({ index: false, follow: false });
  });

  it('GoApply: offered, with its own name in the title and the description and Chinese copy', async () => {
    brand.id = 'goapply';
    locale.value = 'zh';
    expect(await jobSearchAvailable()).toBe(true);
    const api = await jobSearchMetadata('api');
    expect(String(api.title)).toMatch(new RegExp(` \\| ${BRANDS.goapply.name}$`));
    expect(String(api.title)).toMatch(/API 参考文档/);
    expect(api.alternates).toEqual({ canonical: '/developers/job-search' });
    expect(api.description).toBeTruthy();
    const keys = await jobSearchMetadata('keys');
    expect(keys.robots).toEqual({ index: false, follow: false });
    expect(String(keys.description)).toContain(BRANDS.goapply.name);
    for (const surface of ['api', 'keys', 'search'] as const) {
      const meta = await jobSearchMetadata(surface);
      expect(`${String(meta.title)} ${String(meta.description)}`).not.toMatch(/RoboApply|%BRAND%/);
    }
  });

  it('the pages are offered whatever the market; the server gate is the jobs.feed capability, not the brand', () => {
    expect(jobSearchAvailableFor(BRANDS.roboapply)).toBe(true);
    expect(jobSearchAvailableFor(BRANDS.goapply)).toBe(true);
    const server = readFileSync(join(process.cwd(), 'server/src/job-search/routes.ts'), 'utf8');
    expect(server).toMatch(/isEnabledForBrand\('jobs\.feed'/);
    expect(server).not.toMatch(/market === 'cn'/);
  });

  it.each(['app/developers/job-search/page.tsx', 'app/(auth)/job-search/developers/page.tsx'])('%s never answers notFound() for a brand', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src).not.toMatch(/notFound/);
  });

  it('no literal product name in the title, the guide or the key page', () => {
    for (const file of ['components/job-search/metadata.ts', 'components/job-search/JobSearchDeveloperGuide.tsx', 'components/job-search/ApiKeyWorkspace.tsx']) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src, file).not.toMatch(/\| RoboApply|>RoboApply<|brand="roboapply"/);
    }
  });

  it('the key page stays a signed-in page and the reference stays public, on both brands', () => {
    expect(isProtectedPath('/job-search/developers')).toBe(true);
    expect(isProtectedPath('/developers/job-search')).toBe(false);
  });
});

describe('request examples per brand', () => {
  it('RoboApply: the two examples are exactly what they were', () => {
    const ra = jobSearchExamples(jobSearchBrandExamples(clientBrandFor('roboapply')));
    expect(ra.curl).toBe(JOB_SEARCH_CURL_EXAMPLE);
    expect(ra.agentCurl).toBe(JOB_SEARCH_AGENT_CURL_EXAMPLE);
    expect(ra.curl).toBe(`curl --request POST "$ROBOAPPLY_ORIGIN/api/v1/job-search/search" \\
  --header "Authorization: Bearer $ROBOAPPLY_JOB_SEARCH_KEY" \\
  --header "Content-Type: application/json" \\
  --data '{"query":"software engineer","country":"US","remote":true,"datePosted":"week","limit":20}'`);
    expect(ra.agentCurl).toContain('"linkedinOnly":true');
  });

  it('GoApply: mainland examples, its own variable names, no LinkedIn and no other brand', () => {
    const go = jobSearchExamples(jobSearchBrandExamples(clientBrandFor('goapply')));
    expect(go.originVar).toBe('GOAPPLY_ORIGIN');
    expect(go.keyVar).toBe('GOAPPLY_JOB_SEARCH_KEY');
    expect(go.curl).toContain('"country":"CN"');
    expect(go.curl).toContain('上海');
    expect(go.agentCurl).toContain('数据分析师');
    expect(`${go.curl}${go.agentCurl}`).not.toMatch(/ROBOAPPLY|linkedin|Taiwan/i);
  });

  it('the country list puts the brand country first', () => {
    expect(countryOptionsFor('zh', clientBrandFor('goapply'))[0].code).toBe('CN');
    expect(countryOptionsFor('en', clientBrandFor('roboapply'))[0].code).toBe('US');
    expect(countryOptionsFor('en', clientBrandFor('roboapply'))).toHaveLength(249);
  });
});
