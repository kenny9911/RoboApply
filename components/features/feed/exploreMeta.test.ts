// INT-06 (wave3 WP-93 #18) — /jobs/explore has its own title, in the request's
// brand, and no longer borrows the retired job-search metadata module.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { brand } = vi.hoisted(() => ({ brand: { id: 'roboapply' as 'roboapply' | 'goapply' } }));
vi.mock('../../../lib/server/brand', () => ({ getServerBrandId: async () => brand.id }));

import { generateMetadata } from '../../../app/(auth)/jobs/explore/layout';

afterEach(() => {
  brand.id = 'roboapply';
});

describe('/jobs/explore metadata', () => {
  it('RoboApply: "Explore jobs | RoboApply", with a description, never indexed', async () => {
    const meta = await generateMetadata();
    expect(meta.title).toBe('Explore jobs | RoboApply');
    expect(meta.description).toBe('Browse open jobs by kind of work, or describe the job you want in your own words.');
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('GoApply: the title carries GoApply, not a fixed product name', async () => {
    brand.id = 'goapply';
    const meta = await generateMetadata();
    expect(String(meta.title)).toMatch(/ \| GoApply$/);
    expect(String(meta.title)).not.toMatch(/RoboApply/);
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('no longer imports the retired job-search metadata', () => {
    const src = readFileSync(join(process.cwd(), 'app/(auth)/jobs/explore/layout.tsx'), 'utf8');
    expect(src).not.toMatch(/job-search\/metadata|jobSearchMetadata/);
  });
});
