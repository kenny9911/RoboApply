// Localized landing route (app/[locale]/page.tsx). `/en` must render English
// rather than redirect to the content-negotiated `/`: it is the only URL a
// link can use to force English (RoboHire's job-seeker link relies on it).
// Its canonical stays `/`, so search engines still see one EN document.

import type React from 'react';
import { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';

const { notFound, redirect, brand } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
  brand: { id: 'roboapply' as 'roboapply' | 'goapply' },
}));

vi.mock('next/navigation', () => ({ notFound, redirect }));
vi.mock('../../lib/server/brand', () => ({ getServerBrandId: async () => brand.id }));
vi.mock('../../lib/serverMarket', () => ({
  resolveVisitorMarket: vi.fn(async () => 'other'),
}));

import LocalizedLandingPage, { generateMetadata } from '../../app/[locale]/page';
import RootLandingPage, { generateMetadata as rootMetadata } from '../../app/page';
import { RememberLocale } from '../../components/landing/RememberLocale';
import { GoApplyHome, RoboApplyHome } from '../../components/features/marketing';
import { JobTicker } from '../../components/features/seo/server';

const params = (locale: string) => ({ params: Promise.resolve({ locale }) });

describe('localized landing route', () => {
  it('renders /en as an English landing instead of redirecting to /', async () => {
    await expect(LocalizedLandingPage(params('en'))).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it('remembers the landing language for the pages that follow', async () => {
    const page = (await LocalizedLandingPage(params('zh'))) as React.ReactElement<{
      children: React.ReactElement<{ locale?: string }>[];
    }>;
    const remember = page.props.children.find((child) => child.type === RememberLocale);
    expect(remember?.props.locale).toBe('zh');
  });

  it('canonicalizes /en to the root, and other locales to their own path', async () => {
    const en = await generateMetadata(params('en'));
    expect(en.alternates?.canonical).toBe('https://www.roboapply.io/');
    const zh = await generateMetadata(params('zh'));
    expect(zh.alternates?.canonical).toBe('https://www.roboapply.io/zh');
  });

  it('404s an unknown locale segment', async () => {
    await expect(LocalizedLandingPage(params('xx'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(await generateMetadata(params('xx'))).toEqual({});
  });

  // Each brand renders its own home: GoApply's copy, prices, sources and
  // languages are its own (D3), so a GoApply host never renders the RoboApply
  // landing. Since WP-40 a GoApply host renders GoApplyHome instead of
  // redirecting to /login; since the D5 parity wave that home offers the same
  // visitor functions over GoApply data (components/features/marketing
  // home.test.tsx covers the page itself).
  it('never serves the RoboApply landing on the GoApply brand', async () => {
    brand.id = 'goapply';
    const kids = (page: unknown) =>
      (page as React.ReactElement<{ children: React.ReactElement[] }>).props.children.flat();
    try {
      for (const page of [await LocalizedLandingPage(params('zh')), await RootLandingPage()]) {
        const types = kids(page).map((child) => child?.type);
        expect(types).toContain(GoApplyHome);
        expect(types).not.toContain(RoboApplyHome);
      }
      // D5: the GoApply home gets the same server-rendered job ticker slot as RoboApply's, on `/` and `/{locale}`.
      for (const page of [await LocalizedLandingPage(params('zh')), await RootLandingPage()]) {
        const home = kids(page).find((child) => child?.type === GoApplyHome) as React.ReactElement<{ ticker?: React.ReactElement<{ children?: React.ReactElement }> }>;
        expect(home.props.ticker?.type).toBe(Suspense);
        expect(home.props.ticker?.props.children?.type).toBe(JobTicker);
      }
      const zh = await generateMetadata(params('zh'));
      expect(String(zh.alternates?.canonical ?? '')).not.toContain('roboapply.io');
      const root = await rootMetadata();
      expect(String(root.alternates?.canonical ?? '')).not.toContain('roboapply.io');
      expect(redirect).not.toHaveBeenCalled();
    } finally {
      brand.id = 'roboapply';
    }
  });
});
