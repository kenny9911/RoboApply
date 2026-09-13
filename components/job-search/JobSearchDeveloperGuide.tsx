'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BrandSymbol } from '../chrome/BrandSymbol';
import { Btn } from '../v3/primitives';
import { JOB_SEARCH_AGENT_CURL_EXAMPLE, JOB_SEARCH_CURL_EXAMPLE, JOB_SEARCH_OPENAPI_URL } from '../../lib/api/job-search';

export function JobSearchDeveloperGuide() {
  const t = useTranslations('jobSearchApi');
  const search = useTranslations('jobSearch');
  return (
    <main className="job-search-developer-guide">
      <nav className="job-search-public-nav" aria-label={t('docs')}><Link className="job-search-brand" href="/"><BrandSymbol size={28} /><span>RoboApply</span></Link><div><Link href="/job-search">{t('search')}</Link><Btn as="a" href="/job-search/developers" variant="primary">{t('manage')} →</Btn></div></nav>
      <header className="job-search-developer-hero"><span className="job-search-eyebrow">{t('eyebrow')}</span><h1>{t('title')}</h1><p>{t('intro')}</p><div><Btn as="a" href="/job-search/developers" variant="primary">{t('manage')} →</Btn><Btn as="a" href={JOB_SEARCH_OPENAPI_URL} target="_blank" rel="noopener noreferrer">{t('openapi')} ↗</Btn></div></header>
      <section className="job-search-feature-grid" aria-label={t('docs')}>{(['contract', 'reliability', 'access'] as const).map((feature, index) => <article key={feature}><span aria-hidden="true" className="job-search-feature-number">0{index + 1}</span><h2>{t(`${feature}_title`)}</h2><p>{t(`${feature}_body`)}</p></article>)}</section>
      <section className="job-search-quickstart" aria-labelledby="job-search-quickstart-title"><div><span className="job-search-eyebrow">{t('docs')}</span><h2 id="job-search-quickstart-title">{t('quickstart')}</h2><p>{t('quickstart_body')}</p><Link href="/job-search/developers">{t('manage')} →</Link></div><div className="job-search-code"><div>{t('example')}</div><pre role="region" aria-label={t('example')} tabIndex={0}><code>{JOB_SEARCH_CURL_EXAMPLE}</code></pre><p>{t('example_note')}</p></div></section>
      <section className="job-search-quickstart" aria-labelledby="job-search-agent-api-title"><div><span className="job-search-eyebrow">{t('docs')}</span><h2 id="job-search-agent-api-title">{search('eyebrow')}</h2><p>{search('intro')}</p><p>{search('plan_unverified_hint')}</p></div><div className="job-search-code"><div>{t('example')}</div><pre role="region" aria-label={search('eyebrow')} tabIndex={0}><code>{JOB_SEARCH_AGENT_CURL_EXAMPLE}</code></pre><p>{t('example_note')}</p></div></section>
      <section className="job-search-api-notes"><article><h2>{t('response_title')}</h2><p>{t('response_body')}</p><a href={JOB_SEARCH_OPENAPI_URL} target="_blank" rel="noopener noreferrer">{t('openapi')} ↗</a></article><article><h2>{t('terms_title')}</h2><p>{t('terms_body')}</p></article></section>
    </main>
  );
}
