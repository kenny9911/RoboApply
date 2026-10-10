// WP-40 route files: the home per brand × locale (canonical + hreflang per
// brand, FAQPage JSON-LD, 404 outside the brand's locales), feature pages
// per brand (cross-brand slug → 404, gated → noindex), and the subpages'
// canonical on the brand origin.

import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { notFound, brand } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  brand: { id: 'roboapply' as 'roboapply' | 'goapply' },
}));

vi.mock('next/navigation', () => ({ notFound, redirect: vi.fn() }));
vi.mock('../../../../lib/server/brand', () => ({ getServerBrandId: async () => brand.id }));

import RootPage, { generateMetadata as rootMetadata } from '../../../../app/page';
import LocalePage, { generateMetadata as localeMetadata } from '../../../../app/[locale]/page';
import FeatureRoute, { generateMetadata as featureMetadata } from '../../../../app/features/[slug]/page';
import PricingRoute, { generateMetadata as pricingMetadata } from '../../../../app/pricing/page';
import { generateMetadata as rankingMetadata } from '../../../../app/help/ranking/page';
import { brandLanguageAlternates, homeMetadata, landingMetaStrings } from '../../../../lib/seo';
import { GoApplyHome } from '../GoApplyHome';
import { JsonLd } from '../JsonLd';
import { RoboApplyHome } from '../RoboApplyHome';

type El = React.ReactElement<{ children?: unknown; json?: string; locale?: string }>;
const params = (locale: string) => ({ params: Promise.resolve({ locale }) });
const slug = (s: string) => ({ params: Promise.resolve({ slug: s }) });
const kids = (el: El) => (Array.isArray(el.props.children) ? (el.props.children as El[]) : [el.props.children as El]).filter(Boolean);

afterEach(() => {
  brand.id = 'roboapply';
});

describe('home routes', () => {
  it('RoboApply / renders the RoboApply home with a FAQPage graph and root canonical', async () => {
    const page = (await RootPage()) as El;
    const children = kids(page);
    expect(children.some((c) => c.type === RoboApplyHome)).toBe(true);
    const json = JSON.parse(children.find((c) => c.type === JsonLd)!.props.json!);
    const types = json['@graph'].map((n: { '@type': string }) => n['@type']);
    expect(types).toEqual(['Organization', 'WebSite', 'WebPage', 'FAQPage']);
    expect(JSON.stringify(json)).not.toMatch(/"@type":"(Offer|AggregateOffer|AggregateRating|Review)"|"price"/);
    const meta = await rootMetadata();
    expect(meta.alternates?.canonical).toBe('https://www.roboapply.io/');
    expect(meta.title).toBe("Find out why you're not getting interviews | RoboApply");
  });

  it('GoApply / renders the GoApply home (no redirect) with GoApply canonical and cross-domain hreflang', async () => {
    brand.id = 'goapply';
    const page = (await RootPage()) as El;
    expect(kids(page).some((c) => c.type === GoApplyHome)).toBe(true);
    const meta = await rootMetadata();
    expect(meta.alternates?.canonical).toBe('https://www.goapply.top/');
    expect(meta.alternates?.languages).toMatchObject({
      'zh-CN': 'https://www.goapply.top/',
      en: 'https://www.roboapply.io/',
      'zh-Hant': 'https://www.roboapply.io/zh-TW',
      'x-default': 'https://www.goapply.top/',
    });
    // zh-Hans belongs to RoboApply's /zh (ARCH §1.6); GoApply declares zh-CN only.
    expect(meta.alternates?.languages).not.toHaveProperty('zh-Hans');
    expect(String(meta.title)).toMatch(/GoApply/);
    expect(String(meta.title)).not.toMatch(/RoboApply/);
    expect(meta.openGraph?.siteName).toBe('GoApply');
    expect(meta.robots).toMatchObject({ index: true });
  });

  it('/{locale} keeps RememberLocale, canonicalizes per brand and 404s outside the brand locales', async () => {
    const zh = (await LocalePage(params('zh'))) as El;
    expect(kids(zh).find((c) => c.props.locale === 'zh')).toBeTruthy();
    expect((await localeMetadata(params('zh'))).alternates?.canonical).toBe('https://www.roboapply.io/zh');
    expect((await localeMetadata(params('en'))).alternates?.canonical).toBe('https://www.roboapply.io/');
    const tw = await localeMetadata(params('zh-TW'));
    expect(tw.alternates?.canonical).toBe('https://www.roboapply.io/zh-TW');
    expect(tw.alternates?.languages).toMatchObject({ 'zh-Hant': 'https://www.roboapply.io/zh-TW', 'zh-CN': 'https://www.goapply.top/' });

    brand.id = 'goapply';
    await expect(LocalePage(params('ja'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(await localeMetadata(params('ja'))).toEqual({});
    const en = await localeMetadata(params('en'));
    expect(en.alternates?.canonical).toBe('https://www.goapply.top/en');
    expect(en.robots).toEqual({ index: false, follow: true });
    const page = (await LocalePage(params('en'))) as El;
    expect(kids(page).some((c) => c.type === GoApplyHome)).toBe(true);
  });

  it('the RoboApply cluster lists every translated locale and points zh-CN at GoApply', () => {
    const langs = brandLanguageAlternates('roboapply');
    expect(langs['x-default']).toBe('https://www.roboapply.io/');
    expect(langs['zh-CN']).toBe('https://www.goapply.top/');
    expect(langs.en).toBe('https://www.roboapply.io/');
    expect(homeMetadata('roboapply', 'ja').robots).toMatchObject({ index: true });
  });

  it('the retired auto-apply tagline is gone from the metadata fallbacks', () => {
    const strings = landingMetaStrings('en');
    expect(JSON.stringify(strings)).not.toMatch(/We apply|applies for you|while you sleep/i);
  });
});

describe('feature and subpage routes', () => {
  it('a feature page of this brand renders; the other brand’s slug 404s', async () => {
    expect(await FeatureRoute(slug('job-matches'))).toBeTruthy();
    await expect(FeatureRoute(slug('form-filler'))).rejects.toThrow('NEXT_NOT_FOUND');
    brand.id = 'goapply';
    expect(await FeatureRoute(slug('form-filler'))).toBeTruthy();
    await expect(FeatureRoute(slug('chrome-extension'))).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('feature metadata: brand canonical, gated pages noindex', async () => {
    const open = await featureMetadata(slug('job-matches'));
    expect(open.alternates?.canonical).toBe('https://www.roboapply.io/features/job-matches');
    expect(open.title).toBe('Jobs that fit your resume, with the reasons | RoboApply');
    expect(open.robots).toMatchObject({ index: true });
    expect((await featureMetadata(slug('ready-to-apply'))).robots).toMatchObject({ index: false });
    expect((await featureMetadata(slug('nope'))).robots).toMatchObject({ index: false });
  });

  it('subpages canonicalize on the request brand origin', async () => {
    expect((await pricingMetadata()).alternates?.canonical).toBe('https://www.roboapply.io/pricing');
    brand.id = 'goapply';
    expect((await pricingMetadata()).alternates?.canonical).toBe('https://www.goapply.top/pricing');
    expect((await rankingMetadata()).title).toBe('How ranking works | GoApply');
    expect(await PricingRoute()).toBeTruthy();
  });
});
