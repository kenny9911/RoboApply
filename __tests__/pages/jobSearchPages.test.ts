// INT gate — the Job Search API pages are a RoboApply product: the title
// carries the request's brand name (no fixed product name), and on GoApply,
// where the API answers 404 feature_disabled, both pages are a 404.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BRANDS } from '../../lib/brand/registry.generated';

const { brand } = vi.hoisted(() => ({ brand: { id: 'roboapply' as 'roboapply' | 'goapply' } }));
vi.mock('../../lib/server/brand', async () => {
  const { getBrand } = await import('../../lib/brand/registry.generated');
  return { getServerBrandId: async () => brand.id, getServerBrand: async () => getBrand(brand.id) };
});
vi.mock('../../lib/serverLocale', () => ({ resolveLocale: async () => 'en' }));

import { jobSearchAvailable, jobSearchAvailableFor, jobSearchMetadata } from '../../components/job-search/metadata';

afterEach(() => {
  brand.id = 'roboapply';
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

  it('GoApply: not offered; no product title, no canonical, never indexed', async () => {
    brand.id = 'goapply';
    expect(await jobSearchAvailable()).toBe(false);
    for (const surface of ['api', 'keys', 'search'] as const) {
      const meta = await jobSearchMetadata(surface);
      expect(meta.title).toBe(BRANDS.goapply.name);
      expect(String(meta.title)).not.toMatch(/RoboApply/);
      expect(meta.alternates).toBeUndefined();
      expect(meta.description).toBeUndefined();
      expect(meta.robots).toEqual({ index: false, follow: false });
    }
  });

  it('the rule is the market, as on the server (job-search/routes.ts roboApplyOnly)', () => {
    expect(jobSearchAvailableFor(BRANDS.roboapply)).toBe(true);
    expect(jobSearchAvailableFor(BRANDS.goapply)).toBe(false);
    const server = readFileSync(join(process.cwd(), 'server/src/job-search/routes.ts'), 'utf8');
    expect(server).toMatch(/brandOf\(req\)\.market === 'cn'/);
  });

  it.each(['app/developers/job-search/page.tsx', 'app/(auth)/job-search/developers/page.tsx'])('%s answers notFound() when the product is not offered', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src).toMatch(/if \(!\(await jobSearchAvailable\(\)\)\) notFound\(\);/);
  });

  it('no literal product name in the title', () => {
    const src = readFileSync(join(process.cwd(), 'components/job-search/metadata.ts'), 'utf8');
    expect(src).not.toMatch(/\| RoboApply/);
  });
});
