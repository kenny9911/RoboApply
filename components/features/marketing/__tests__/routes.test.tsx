// WP-40 route files: the home per brand × locale (canonical + hreflang per
// brand, FAQPage JSON-LD, 404 outside the brand's locales), feature pages
// per brand (cross-brand slug → 404, gated → noindex), and the subpages'
// canonical on the brand origin.

import { Suspense } from 'react';
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
// The static sitemap asks the API which surfaces are live; no API in a unit test.
vi.mock('../../../../lib/server/publicApi', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadSitemapIndex: async () => ({ status: 'ok', data: { surfaces: { browse: false, campus: false } } }),
}));

import RootPage, { generateMetadata as rootMetadata } from '../../../../app/page';
import LocalePage, { generateMetadata as localeMetadata } from '../../../../app/[locale]/page';
import FeatureRoute, { generateMetadata as featureMetadata } from '../../../../app/features/[slug]/page';
import PricingRoute, { generateMetadata as pricingMetadata } from '../../../../app/pricing/page';
import HelpRoute from '../../../../app/help/page';
import HelpRankingRoute, { generateMetadata as rankingMetadata } from '../../../../app/help/ranking/page';
import { GET as sitemapRoute } from '../../../../app/sitemaps/[file]/route';
import { brandLanguageAlternates, homeMetadata } from '../../../../lib/seo';
import { HybridShell } from '../../../v3/shell/HybridShell';
import { JobTicker } from '../../seo/server';
import { featuresFor, indexableFeaturePaths, isFeatureIndexable } from '../catalog';
import { GoApplyHome } from '../GoApplyHome';
import { JsonLd } from '../JsonLd';
import { RoboApplyHome } from '../RoboApplyHome';

type El = React.ReactElement<{ children?: unknown; json?: string; locale?: string; ticker?: React.ReactElement }>;
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

  // INT-06 (wave4 WP-93 #13) and D5: the live job ticker on both homes, `/` and `/{locale}`.
  // The slot is its own Suspense boundary: the page is sent without waiting for the job read.
  it('both homes get a streamed <JobTicker /> (Suspense, no fallback), on / and on /{locale}', async () => {
    const isTicker = (slot: unknown) => {
      const s = slot as React.ReactElement<{ fallback?: unknown; children?: React.ReactElement }>;
      expect(s.type).toBe(Suspense);
      expect(s.props.fallback).toBeNull();
      expect(s.props.children?.type).toBe(JobTicker);
    };
    isTicker(kids((await RootPage()) as El).find((c) => c.type === RoboApplyHome)!.props.ticker);
    isTicker(kids((await LocalePage(params('zh'))) as El).find((c) => c.type === RoboApplyHome)!.props.ticker);
    brand.id = 'goapply';
    isTicker(kids((await RootPage()) as El).find((c) => c.type === GoApplyHome)!.props.ticker);
    isTicker(kids((await LocalePage(params('en'))) as El).find((c) => c.type === GoApplyHome)!.props.ticker);
  });

  // The server cannot read the capabilities, so the structured data lists only the questions that hold
  // whatever the operator switched off: the one about listed jobs is on the page (while jobs.feed is on)
  // but never in the JSON-LD, which therefore never says more than the page.
  it('GoApply / and /en carry a FAQPage with the five questions the page always renders (not the jobs question)', async () => {
    brand.id = 'goapply';
    const json = JSON.parse(kids((await RootPage()) as El).find((c) => c.type === JsonLd)!.props.json!);
    const faq = json['@graph'].find((n: { '@type': string }) => n['@type'] === 'FAQPage');
    expect(faq.mainEntity).toHaveLength(5);
    const names = faq.mainEntity.map((q: { name: string }) => q.name);
    expect(names).toContain('What does it cost?');
    expect(names).not.toContain('Where do the jobs come from?');
    expect(JSON.stringify(faq)).not.toMatch(/Every job shows its source/);
    const localized = JSON.parse(kids((await LocalePage(params('en'))) as El).find((c) => c.type === JsonLd)!.props.json!);
    expect(localized['@graph'].find((n: { '@type': string }) => n['@type'] === 'FAQPage').mainEntity).toHaveLength(5);
    expect(JSON.stringify(faq)).not.toMatch(/RoboApply|%BRAND%/);
    expect(JSON.stringify(json)).not.toMatch(/"@type":"(Offer|AggregateOffer|AggregateRating|Review)"|"price"/);
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

  it('no home metadata, on either brand, carries the retired auto-apply tagline', () => {
    for (const [id, locale] of [['roboapply', 'en'], ['roboapply', 'zh-TW'], ['goapply', 'zh'], ['goapply', 'en']] as const) {
      expect(JSON.stringify(homeMetadata(id, locale))).not.toMatch(/We apply|applies for you|while you sleep|auto[- ]?apply|自动投递|自動投遞/i);
    }
  });

  // INT-06 (wave5 WP-93 #54): the legacy landing and its pre-brand helpers are gone.
  // Names are assembled here so a repo-wide search for them finds no file at all.
  it('the legacy landing is deleted: its two components, its page test and its seo helpers', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const legacy = 'Landing';
    for (const f of [`components/landing/${legacy}Content.tsx`, `components/landing/${legacy}JsonLd.tsx`, '__tests__/pages/landing.test.tsx']) {
      expect(existsSync(join(process.cwd(), f))).toBe(false);
    }
    const seo = (await import('../../../../lib/seo')) as Record<string, unknown>;
    for (const name of ['landing' + 'JsonLd', 'landing' + 'MetaStrings', 'language' + 'Alternates', 'landing' + 'Metadata', 'SITE_' + 'URL', 'SITE_' + 'NAME']) {
      expect(seo[name]).toBeUndefined();
    }
  });
});

describe('feature and subpage routes', () => {
  it('a feature page of this brand renders; the other brand’s slug 404s', async () => {
    expect(await FeatureRoute(slug('job-matches'))).toBeTruthy();
    await expect(FeatureRoute(slug('form-filler'))).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(FeatureRoute(slug('referral-codes'))).rejects.toThrow('NEXT_NOT_FOUND');
    brand.id = 'goapply';
    expect(await FeatureRoute(slug('form-filler'))).toBeTruthy();
    await expect(FeatureRoute(slug('chrome-extension'))).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(FeatureRoute(slug('visa-sponsorship'))).rejects.toThrow('NEXT_NOT_FOUND');
  });

  // D5 (G118): the pages for the capabilities both brands share, plus 内推码.
  it('GoApply answers /features/job-matches, resume-tailoring, cover-letters, ready-to-apply and referral-codes with its own Chinese metadata', async () => {
    brand.id = 'goapply';
    const titles: Record<string, string> = {
      'job-matches': '与你的简历匹配的职位，每个都注明来源 | GoApply',
      'resume-tailoring': '为每个职位定制简历 | GoApply',
      'cover-letters': '根据职位描述和你的简历写求职信 | GoApply',
      'ready-to-apply': '每周备好申请材料，由你自己提交 | GoApply',
      'referral-codes': '其他求职者分享的内推码 | GoApply',
    };
    const zh = (await import('../../../../i18n/staging/landing.zh.json')).default.landing.features.goapply as Record<string, { metaTitle: string }>;
    for (const [s, title] of Object.entries(titles)) {
      expect(await FeatureRoute(slug(s)), s).toBeTruthy();
      const meta = await featureMetadata(slug(s));
      expect(meta.alternates?.canonical, s).toBe(`https://www.goapply.top/features/${s}`);
      // The page title is the staged copy: English until the locale merge, the staged Chinese after it.
      const def = featuresFor('goapply').find((f) => f.slug === s)!;
      expect(`${zh[def.key]!.metaTitle} | GoApply`, s).toBe(title);
      expect(String(meta.title), s).toMatch(/\| GoApply$/);
      expect(String(meta.title), s).not.toMatch(/landing\.features|RoboApply/);
    }
    // Ungated pages are indexable; the two gated ones are noindex, as their RoboApply twins are.
    for (const s of ['job-matches', 'resume-tailoring', 'cover-letters']) expect((await featureMetadata(slug(s))).robots, s).toMatchObject({ index: true });
    for (const s of ['ready-to-apply', 'referral-codes']) expect((await featureMetadata(slug(s))).robots, s).toMatchObject({ index: false });
  });

  it('feature metadata: brand canonical, gated pages noindex', async () => {
    const open = await featureMetadata(slug('job-matches'));
    expect(open.alternates?.canonical).toBe('https://www.roboapply.io/features/job-matches');
    expect(open.title).toBe('Jobs that fit your resume, with the reasons | RoboApply');
    expect(open.robots).toMatchObject({ index: true });
    expect((await featureMetadata(slug('ready-to-apply'))).robots).toMatchObject({ index: false });
    expect((await featureMetadata(slug('nope'))).robots).toMatchObject({ index: false });
  });

  // FIX-7: /sitemaps/static.xml lists four RoboApply feature pages while the
  // footer links more. That is the rule, not a gap: a gated page is noindex,
  // and a sitemap never lists a URL its own page marks noindex.
  it('the static sitemap lists exactly the feature pages that are indexable, on both brands', async () => {
    for (const id of ['roboapply', 'goapply'] as const) {
      brand.id = id;
      const xml = await (await sitemapRoute(new Request('https://example.test/sitemaps/static.xml'), { params: Promise.resolve({ file: 'static.xml' }) })).text();
      const listed = [...xml.matchAll(/<loc>[^<]*?(\/features\/[a-z-]+)<\/loc>/g)].map((m) => m[1]!);
      expect(listed.sort()).toEqual(indexableFeaturePaths(id).sort());
      for (const def of featuresFor(id)) {
        const robots = (await featureMetadata(slug(def.slug))).robots as { index: boolean };
        expect([def.slug, robots.index]).toEqual([def.slug, isFeatureIndexable(def)]);
        expect([def.slug, listed.includes(`/features/${def.slug}`)]).toEqual([def.slug, robots.index]);
      }
    }
    expect(indexableFeaturePaths('roboapply')).toEqual(['/features/job-matches', '/features/resume-tailoring', '/features/cover-letters', '/features/visa-sponsorship']);
    expect(indexableFeaturePaths('goapply')).toEqual(['/features/job-matches', '/features/resume-tailoring', '/features/cover-letters', '/features/resume']);
    for (const gated of ['ready-to-apply', 'interview-practice', 'assistant']) expect(indexableFeaturePaths('roboapply')).not.toContain(`/features/${gated}`);
  });

  // FIX-7: "How ranking works" is reached from the signed-in job list. The
  // route renders inside HybridShell, which gives a visitor with a session the
  // app shell (rail, top bar, bottom bar — the way back to the app) and shows
  // Sign in / Get started only without one (__tests__/shell/layout.test.tsx).
  it('/help and /help/ranking render inside HybridShell, never a signed-out-only header', async () => {
    for (const route of [await HelpRankingRoute(), await HelpRoute()] as El[]) {
      expect(route.type).toBe(HybridShell);
      expect((route.props as { from?: string }).from).toBe('help');
    }
  });

  it('subpages canonicalize on the request brand origin', async () => {
    expect((await pricingMetadata()).alternates?.canonical).toBe('https://www.roboapply.io/pricing');
    brand.id = 'goapply';
    expect((await pricingMetadata()).alternates?.canonical).toBe('https://www.goapply.top/pricing');
    // GoApply's default locale is zh: the title is its own Chinese (in zh.json since WP-91 merged the staged strings).
    expect((await rankingMetadata()).title).toBe('排序规则说明 | GoApply');
    expect(await PricingRoute()).toBeTruthy();
  });
});
