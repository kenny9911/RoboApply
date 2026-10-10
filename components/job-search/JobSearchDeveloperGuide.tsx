'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BrandSymbol } from '../chrome/BrandSymbol';
import { Btn } from '../v3/primitives';
import { jobSearchExamples, JOB_SEARCH_OPENAPI_URL } from '../../lib/api/job-search';
import { useBrand } from '../../lib/brand/BrandProvider';
import { jobSearchBrandExamples } from './countries';
import { JobSearchUnavailable, useJobSearchOff } from './ApiKeyWorkspace';
import { CN_RECRUITER_BANK_NAME } from '../features/market';

/**
 * The public API reference, for the brand of the request. The sections are
 * the same on both brands. What differs is the market: the examples, and on
 * GoApply the three lines that describe its source (its own index of mainland
 * postings, which a key reads only once the operator has turned that on) and
 * what the natural-language route needs (the AI consent, and a verified phone
 * for an account that signed in with WeChat).
 */
export function JobSearchDeveloperGuide() {
  const t = useTranslations('jobSearchApi');
  const search = useTranslations('jobSearch');
  const cn = useTranslations('jobsCn.searchApi');
  const brand = useBrand();
  const off = useJobSearchOff();
  const mainland = brand.market === 'cn';
  const examples = jobSearchExamples(jobSearchBrandExamples(brand));
  const exampleNote = mainland ? cn('exampleNote', { origin: examples.originVar, key: examples.keyVar }) : t('example_note');
  if (off) return <main className="job-search-developer-guide"><JobSearchUnavailable /></main>;
  return (
    <main className="job-search-developer-guide">
      <nav className="job-search-public-nav" aria-label={t('docs')}><Link className="job-search-brand" href="/"><BrandSymbol size={28} /><span>{brand.name}</span></Link><div><Link href="/job-search">{t('search')}</Link><Btn as="a" href="/job-search/developers" variant="primary">{t('manage')} →</Btn></div></nav>
      <header className="job-search-developer-hero"><span className="job-search-eyebrow">{t('eyebrow')}</span><h1>{t('title')}</h1><p>{t('intro')}</p><div><Btn as="a" href="/job-search/developers" variant="primary">{t('manage')} →</Btn><Btn as="a" href={JOB_SEARCH_OPENAPI_URL} target="_blank" rel="noopener noreferrer">{t('openapi')} ↗</Btn></div></header>
      <section className="job-search-feature-grid" aria-label={t('docs')}>{(['contract', 'reliability', 'access'] as const).map((feature, index) => <article key={feature}><span aria-hidden="true" className="job-search-feature-number">0{index + 1}</span><h2>{t(`${feature}_title`)}</h2><p>{t(`${feature}_body`)}</p></article>)}</section>
      <section className="job-search-quickstart" aria-labelledby="job-search-quickstart-title"><div><span className="job-search-eyebrow">{t('docs')}</span><h2 id="job-search-quickstart-title">{t('quickstart')}</h2><p>{t('quickstart_body')}</p><Link href="/job-search/developers">{t('manage')} →</Link></div><div className="job-search-code"><div>{t('example')}</div><pre role="region" aria-label={t('example')} tabIndex={0}><code>{examples.curl}</code></pre><p>{exampleNote}</p></div></section>
      <section className="job-search-quickstart" aria-labelledby="job-search-agent-api-title"><div><span className="job-search-eyebrow">{t('docs')}</span><h2 id="job-search-agent-api-title">{search('eyebrow')}</h2><p>{mainland ? cn('agentIntro') : search('intro')}</p><p>{search('plan_unverified_hint')}</p></div><div className="job-search-code"><div>{t('example')}</div><pre role="region" aria-label={search('eyebrow')} tabIndex={0}><code>{examples.agentCurl}</code></pre><p>{exampleNote}</p></div></section>
      <section className="job-search-api-notes"><article><h2>{t('response_title')}</h2><p>{t('response_body')}</p><a href={JOB_SEARCH_OPENAPI_URL} target="_blank" rel="noopener noreferrer">{t('openapi')} ↗</a></article><article><h2>{t('terms_title')}</h2><p>{mainland ? cn('sources', { sourceName: CN_RECRUITER_BANK_NAME }) : t('terms_body')}</p></article></section>
    </main>
  );
}
