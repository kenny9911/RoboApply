'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Btn, EmptyState, PageHeader } from '../v3/primitives';
import { RoboApiError } from '../../lib/api/client';
import { failedSearchResult, jobSearchApi } from '../../lib/api/job-search';
import type { DatePosted, EmploymentType, ProviderInfo, SearchResult } from '../../lib/api/job-search-types';
import { JobResultCard } from './JobResultCard';
import { countryOptions } from './countries';

const EMPLOYMENT = { full_time: 'fulltime', part_time: 'parttime', contract: 'contractor', internship: 'intern' } as const;

export function JobSearchWorkspace() {
  const t = useTranslations('jobSearch');
  const locale = useLocale();
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [providerError, setProviderError] = useState(false);
  const [providerReload, setProviderReload] = useState(0);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState('');
  const [country, setCountry] = useState('US');
  const [datePosted, setDatePosted] = useState<DatePosted>('all');
  const [employment, setEmployment] = useState<EmploymentType | ''>('');
  const [remote, setRemote] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [submittedQuery, setSubmittedQuery] = useState('');
  const searchController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setProviderError(false);
    setProviders(null);
    jobSearchApi.providers(controller.signal).then(({ providers: catalogue }) => {
      if (controller.signal.aborted) return;
      setProviders(catalogue);
      setSelectedProviders(catalogue.filter((provider) => provider.enabled).map((provider) => provider.id));
    }).catch(() => { if (!controller.signal.aborted) setProviderError(true); });
    return () => controller.abort();
  }, [providerReload]);

  useEffect(() => () => searchController.current?.abort(), []);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!selectedProviders.length) { setError('no_sources'); return; }
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setError(null);
    setResult(null);
    setPending(true);
    setSubmittedQuery(query.trim());
    try {
      const data = await jobSearchApi.search({ query: query.trim(), location: location.trim() || undefined, country: country.trim().toUpperCase(), datePosted, remote: remote || undefined, employmentTypes: employment ? [employment] : undefined, providers: selectedProviders, limit: 40 }, controller.signal);
      if (!controller.signal.aborted) setResult(data);
    } catch (failure) {
      if (controller.signal.aborted) return;
      const diagnostics = failedSearchResult(failure);
      if (diagnostics) setResult(diagnostics);
      setError(failure instanceof RoboApiError && failure.status === 429 ? 'rate_limited' : diagnostics ? 'all_failed' : 'error_body');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  function resetFilters() {
    setLocation(''); setCountry('US'); setDatePosted('all'); setEmployment(''); setRemote(false);
    setSelectedProviders(providers?.filter((provider) => provider.enabled).map((provider) => provider.id) ?? []);
  }

  const configured = providers?.some((provider) => provider.enabled) ?? false;
  const temporarilyUnavailable = providers?.some((provider) => provider.reason === 'budget_or_circuit') ?? false;
  return (
    <div className="job-search-workspace">
      <nav className="job-search-nav" aria-label={t('title')}><Link href="/jobs">← {t('back')}</Link><Link href="/developers/job-search">{t('developers')} ↗</Link></nav>
      <div className="job-search-hero"><PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('intro')} /></div>
      <form className="job-search-form" onSubmit={search}>
        <fieldset disabled={pending} className="job-search-primary-fields">
          <label className="job-search-field job-search-query">{t('query')}<input name="query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('query_placeholder')} minLength={2} maxLength={200} required autoComplete="off" /></label>
          <label className="job-search-field">{t('location')}<input name="location" value={location} onChange={(event) => setLocation(event.target.value)} placeholder={t('location_placeholder')} maxLength={120} autoComplete="off" /></label>
          <Btn type="submit" variant="primary" disabled={!configured || pending}>{pending ? t('searching') : t('search')}<span aria-hidden="true">→</span></Btn>
        </fieldset>
        <details className="job-search-filter-panel" open>
          <summary>{t('filters')}</summary>
          <fieldset disabled={pending} className="job-search-filter-grid">
            <div className="job-search-field"><label htmlFor="job-search-country">{t('country')}</label><select id="job-search-country" name="country" value={country} onChange={(event) => setCountry(event.target.value)} aria-describedby="job-search-country-hint" autoComplete="country">{countries.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select><span id="job-search-country-hint" className="job-search-field-hint">{t('country_hint')}</span></div>
            <label className="job-search-field">{t('date')}<select name="datePosted" value={datePosted} onChange={(event) => setDatePosted(event.target.value as DatePosted)}>{(['all', 'today', '3days', 'week', 'month'] as const).map((date) => <option key={date} value={date}>{t(`date_${date}`)}</option>)}</select></label>
            <label className="job-search-field">{t('employment')}<select name="employment" value={employment} onChange={(event) => setEmployment(event.target.value as EmploymentType | '')}><option value="">{t('employment_all')}</option>{Object.entries(EMPLOYMENT).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label>
            <div className="job-search-filter-actions"><label className="job-search-checkbox"><input type="checkbox" checked={remote} onChange={(event) => setRemote(event.target.checked)} />{t('remote_only')}</label><Btn variant="ghost" onClick={resetFilters}>{t('reset')}</Btn></div>
          </fieldset>
        </details>
        <fieldset className="job-search-provider-picker" disabled={pending}>
          <legend>{t('sources')}</legend>
          <p>{t('sources_hint')}</p>
          {providerError ? <div role="alert" className="job-search-notice">{t('sources_error')}<Btn onClick={() => setProviderReload((value) => value + 1)}>{t('retry')}</Btn></div> : providers === null ? <p role="status">{t('loading_sources')}</p> : <div className="job-search-providers">{providers.map((provider) => <label key={provider.id} className={`job-search-provider ${provider.enabled ? '' : 'is-unavailable'}`}><input type="checkbox" checked={selectedProviders.includes(provider.id)} disabled={!provider.enabled} onChange={(event) => setSelectedProviders((selected) => event.target.checked ? [...selected, provider.id] : selected.filter((id) => id !== provider.id))} /><span><strong>{provider.name}</strong><small>{provider.enabled ? t('available') : provider.reason === 'budget_or_circuit' ? t('status_unavailable') : t('unavailable')}</small></span></label>)}</div>}
        </fieldset>
      </form>

      <section className="job-search-results" aria-busy={pending} aria-label={t('title')}>
        {pending ? <div className="job-search-loading" role="status"><span className="job-search-spinner" aria-hidden="true" />{t('searching')}</div> : null}
        {error ? <div role="alert" className="job-search-notice is-warning">{t(error)}</div> : null}
        {!pending && providers !== null && !configured ? <EmptyState title={t(temporarilyUnavailable ? 'status_unavailable' : 'unconfigured_title')} sub={t(temporarilyUnavailable ? 'error_body' : 'unconfigured_body')} action={temporarilyUnavailable ? <Btn onClick={() => setProviderReload((value) => value + 1)}>{t('retry')}</Btn> : <Btn as="a" href="/jobs">{t('back')}</Btn>} /> : null}
        {!pending && !result && !error && configured ? <EmptyState title={t('start_title')} sub={t('start_body')} /> : null}
        {!pending && result ? <>
          {!error || result.jobs.length > 0 ? <div className="job-search-results-header" aria-live="polite"><div><h2>{t('results', { count: result.jobs.length })}</h2><p>{t('results_for', { query: submittedQuery })}</p></div>{result.meta.cache === 'hit' ? <span className="job-search-source-tag">{t('cached')}</span> : null}</div> : null}
          {result.meta.partial && !error ? <div role="status" className="job-search-notice is-warning">{t('partial')}</div> : null}
          <details className="job-search-coverage"><summary>{t('coverage')}</summary><ul>{result.meta.providers.map((provider) => <li key={provider.id}><strong>{provider.name}</strong><span>{t(`status_${provider.status}`)}</span><span>{t('source_count', { count: provider.resultCount })}</span></li>)}</ul>{result.meta.requestId ? <p>{t('request_id', { id: result.meta.requestId })}</p> : null}</details>
          {!result.jobs.length && !error ? <EmptyState title={t('empty_title')} sub={t('empty_body')} action={<Btn onClick={resetFilters}>{t('reset')}</Btn>} /> : null}
          <div className="job-search-list">{result.jobs.map((job) => <JobResultCard key={job.id} job={job} providers={providers ?? []} />)}</div>
        </> : null}
      </section>
    </div>
  );
}
