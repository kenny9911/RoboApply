// Localized landing route (app/[locale]/page.tsx). `/en` must render English
// rather than redirect to the content-negotiated `/`: it is the only URL a
// link can use to force English (RoboHire's job-seeker link relies on it).
// Its canonical stays `/`, so search engines still see one EN document.

import { describe, it, expect, vi } from 'vitest';

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({ notFound }));
vi.mock('../../lib/serverMarket', () => ({
  resolveVisitorMarket: vi.fn(async () => 'other'),
}));

import LocalizedLandingPage, { generateMetadata } from '../../app/[locale]/page';

const params = (locale: string) => ({ params: Promise.resolve({ locale }) });

describe('localized landing route', () => {
  it('renders /en as an English landing instead of redirecting to /', async () => {
    await expect(LocalizedLandingPage(params('en'))).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
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
});
