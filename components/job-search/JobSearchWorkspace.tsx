'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Btn, EmptyState, PageHeader } from '../v3/primitives';
import { RoboApiError } from '../../lib/api/client';
import { failedSearchResult, jobSearchApi } from '../../lib/api/job-search';
import type { AgentSearchResult, DatePosted, EmploymentType, ProviderInfo, ProviderStatus, SearchResult } from '../../lib/api/job-search-types';
import { JobResultCard } from './JobResultCard';
import { countryOptions } from './countries';

const EMPLOYMENT = { full_time: 'fulltime', part_time: 'parttime', contract: 'contractor', internship: 'intern' } as const;

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof RoboApiError) || !error.payload || typeof error.payload !== 'object') return undefined;
  const code = (error.payload as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function ProviderOutcomes({ providers }: { providers: ProviderStatus[] }) {
  const t = useTranslations('jobSearch');
  if (!providers.length) return null;
  return <ul>{providers.map((provider) => (
    <li key={provider.id}>
      <strong>{provider.name}</strong>
      <span>{t(`status_${provider.status}`)}</span>
      <span>{provider.status === 'ok' || provider.status === 'empty' ? t('source_count', { count: provider.resultCount }) : '—'}</span>
    </li>
  ))}</ul>;
}

function SearchPlan({ result }: { result: AgentSearchResult }) {
  const t = useTranslations('jobSearch');
  const locale = useLocale();
  const regionNames = useMemo(() => new Intl.DisplayNames([locale], { type: 'region' }), [locale]);
  const { agent } = result;
  return (
    <section className="job-search-plan" aria-labelledby="job-search-plan-title">
      <header><h2 id="job-search-plan-title">{t('plan_title')}</h2><p>{t('plan_hint')}</p></header>
      <div className="job-search-plan-grid">
        <div>
          <h3>{t('plan_queries')}</h3>
          <ul className="job-search-query-chips">{agent.queries.map((query, index) => <li key={`${query}-${index}`}>{query}</li>)}</ul>
        </div>
        <div>
          <h3>{t('plan_criteria')}</h3>
          <dl className="job-search-criteria">
            <div><dt>{t('country')}</dt><dd>{regionNames.of(agent.criteria.country.toUpperCase()) ?? agent.criteria.country}</dd></div>
            {agent.criteria.location ? <div><dt>{t('location')}</dt><dd>{agent.criteria.location}</dd></div> : null}
            {agent.criteria.remote !== undefined ? <div><dt>{t('work_arrangement')}</dt><dd>{t(agent.criteria.remote ? 'remote_only' : 'work_any')}</dd></div> : null}
            {agent.criteria.datePosted ? <div><dt>{t('date')}</dt><dd>{t(`date_${agent.criteria.datePosted}`)}</dd></div> : null}
            {agent.criteria.employmentTypes?.length ? <div><dt>{t('employment')}</dt><dd>{agent.criteria.employmentTypes.map((value) => t(EMPLOYMENT[value])).join(' · ')}</dd></div> : null}
            {agent.linkedinOnly ? <div><dt>{t('sources')}</dt><dd>{t('linkedin_only')}</dd></div> : null}
          </dl>
        </div>
      </div>
      {agent.unverifiedPreferences.length ? (
        <div className="job-search-unverified">
          <h3>{t('plan_unverified')}</h3><p>{t('plan_unverified_hint')}</p>
          <ul>{agent.unverifiedPreferences.map((preference, index) => <li key={`${preference}-${index}`}>{preference}</li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}

export function JobSearchWorkspace() {
  const t = useTranslations('jobSearch');
  const locale = useLocale();
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [providerError, setProviderError] = useState(false);
  const [providerReload, setProviderReload] = useState(0);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [request, setRequest] = useState('');
  const [location, setLocation] = useState('');
  const [country, setCountry] = useState('');
  const [datePosted, setDatePosted] = useState<DatePosted | ''>('');
  const [employment, setEmployment] = useState<EmploymentType | ''>('');
  const [workArrangement, setWorkArrangement] = useState<'' | 'remote' | 'any'>('');
  // Undefined follows the request; either explicit checkbox choice overrides it.
  const [linkedinOnly, setLinkedinOnly] = useState<boolean | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [submittedRequest, setSubmittedRequest] = useState('');
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
    if (request.trim().length < 10) { setError('request_invalid'); return; }
    if (!selectedProviders.length) { setError('no_sources'); return; }
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setError(null); setNotice(null); setResult(null); setPending(true);
    setSubmittedRequest(request.trim());
    try {
      const data = await jobSearchApi.agentSearch({
        request: request.trim(),
        country: country || undefined,
        location: location.trim() || undefined,
        datePosted: datePosted || undefined,
        remote: workArrangement === '' ? undefined : workArrangement === 'remote',
        employmentTypes: employment ? [employment] : undefined,
        providers: selectedProviders,
        linkedinOnly,
        locale,
        limit: 40,
      }, controller.signal);
      if (!controller.signal.aborted) setResult(data);
    } catch (failure) {
      if (controller.signal.aborted) return;
      const diagnostics = failedSearchResult(failure);
      if (diagnostics) setResult(diagnostics);
      const code = errorCode(failure);
      setError(code === 'agent_unavailable' ? 'agent_unavailable'
        : code === 'invalid_request' ? 'request_invalid'
        : failure instanceof RoboApiError && failure.status === 429 ? 'rate_limited'
          : diagnostics ? 'all_failed' : 'error_body');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  function stopSearch() {
    searchController.current?.abort();
    setPending(false); setError(null); setNotice('search_stopped');
  }

  function resetFilters() {
    setLocation(''); setCountry(''); setDatePosted(''); setEmployment(''); setWorkArrangement(''); setLinkedinOnly(undefined);
    setSelectedProviders(providers?.filter((provider) => provider.enabled).map((provider) => provider.id) ?? []);
  }

  const configured = providers?.some((provider) => provider.enabled) ?? false;
  const temporarilyUnavailable = providers?.some((provider) => provider.reason === 'budget_or_circuit') ?? false;
  const agentResult = result && 'agent' in result ? result as AgentSearchResult : null;

  return (
    <div className="job-search-workspace">
      <nav className="job-search-nav" aria-label={t('title')}>
        <Link href="/jobs">← {t('back')}</Link><Link href="/developers/job-search">{t('developers')} ↗</Link>
      </nav>
      <div className="job-search-hero"><PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('intro')} /></div>
      <form className="job-search-form" onSubmit={search}>
        <fieldset disabled={pending} className="job-search-agent-input">
          <div className="job-search-field">
            <label htmlFor="job-search-request">{t('request_label')}</label>
            <textarea id="job-search-request" name="request" value={request} onChange={(event) => setRequest(event.target.value)} placeholder={t('request_placeholder')} minLength={10} maxLength={2000} rows={4} required aria-describedby="job-search-request-hint" />
            <p id="job-search-request-hint" className="job-search-field-hint">{t('request_hint')}</p>
          </div>
          <div className="job-search-agent-actions">
            <div className="job-search-linkedin-option">
              <label className="job-search-checkbox"><input type="checkbox" checked={linkedinOnly ?? agentResult?.agent.linkedinOnly ?? false} onChange={(event) => setLinkedinOnly(event.target.checked)} aria-describedby="job-search-linkedin-hint" />{t('linkedin_only')}</label>
              <p id="job-search-linkedin-hint">{t('linkedin_hint')}</p>
            </div>
            <Btn type="submit" variant="primary" className="job-search-agent-submit" disabled={!configured || pending}>
              {pending ? t('searching') : t('search')}<span aria-hidden="true">→</span>
            </Btn>
          </div>
        </fieldset>
        {pending ? <div className="job-search-pending-actions"><Btn onClick={stopSearch}>{t('cancel_search')}</Btn></div> : null}
        <details className="job-search-filter-panel">
          <summary>{t('advanced')}</summary>
          <p className="job-search-override-hint">{t('overrides_hint')}</p>
          <fieldset disabled={pending} className="job-search-filter-grid">
            <div className="job-search-field">
              <label htmlFor="job-search-country">{t('country')}</label>
              <select id="job-search-country" name="country" value={country} onChange={(event) => setCountry(event.target.value)} aria-describedby="job-search-country-hint" autoComplete="country">
                <option value="">{t('auto')}</option>{countries.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
              </select>
              <span id="job-search-country-hint" className="job-search-field-hint">{t('country_hint')}</span>
            </div>
            <label className="job-search-field">{t('location')}<input name="location" value={location} onChange={(event) => setLocation(event.target.value)} placeholder={t('auto')} maxLength={120} autoComplete="off" /></label>
            <label className="job-search-field">{t('date')}
              <select name="datePosted" value={datePosted} onChange={(event) => setDatePosted(event.target.value as DatePosted | '')}>
                <option value="">{t('auto')}</option>{(['all', 'today', '3days', 'week', 'month'] as const).map((date) => <option key={date} value={date}>{t(`date_${date}`)}</option>)}
              </select>
            </label>
            <label className="job-search-field">{t('employment')}
              <select name="employment" value={employment} onChange={(event) => setEmployment(event.target.value as EmploymentType | '')}>
                <option value="">{t('auto')}</option>{Object.entries(EMPLOYMENT).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
              </select>
            </label>
            <label className="job-search-field">{t('work_arrangement')}
              <select value={workArrangement} onChange={(event) => setWorkArrangement(event.target.value as '' | 'remote' | 'any')}>
                <option value="">{t('auto')}</option><option value="remote">{t('remote_only')}</option><option value="any">{t('work_any')}</option>
              </select>
            </label>
            <div className="job-search-filter-actions"><Btn variant="ghost" onClick={resetFilters}>{t('reset')}</Btn></div>
          </fieldset>
          <fieldset className="job-search-provider-picker" disabled={pending}>
            <legend>{t('sources')}</legend><p>{t('sources_hint')}</p>
            <div className="job-search-providers">{providers?.map((provider) => (
              <label key={provider.id} className={`job-search-provider ${provider.enabled ? '' : 'is-unavailable'}`}>
                <input type="checkbox" checked={selectedProviders.includes(provider.id)} disabled={!provider.enabled} onChange={(event) => setSelectedProviders((selected) => event.target.checked ? [...selected, provider.id] : selected.filter((id) => id !== provider.id))} />
                <span><strong>{provider.name}</strong><small>{provider.enabled ? t('available') : provider.reason === 'budget_or_circuit' ? t('status_unavailable') : t('unavailable')}</small></span>
              </label>
            ))}</div>
          </fieldset>
        </details>
        {providerError ? <div role="alert" className="job-search-notice">{t('sources_error')}<Btn onClick={() => setProviderReload((value) => value + 1)}>{t('retry')}</Btn></div>
          : providers === null ? <p className="job-search-source-loading" role="status">{t('loading_sources')}</p> : null}
      </form>

      {pending ? <div className="job-search-loading" role="status"><span className="job-search-spinner" aria-hidden="true" />{t('agent_pending')}</div> : null}
      {notice ? <p role="status" className="job-search-notice">{t(notice)}</p> : null}
      <section className="job-search-results" aria-busy={pending} aria-label={t('title')}>
        {error ? <div role="alert" className="job-search-notice is-warning">{t(error)}</div> : null}
        {!pending && providers !== null && !configured ? <EmptyState title={t(temporarilyUnavailable ? 'status_unavailable' : 'unconfigured_title')} sub={t(temporarilyUnavailable ? 'error_body' : 'unconfigured_body')} action={temporarilyUnavailable ? <Btn onClick={() => setProviderReload((value) => value + 1)}>{t('retry')}</Btn> : <Btn as="a" href="/jobs">{t('back')}</Btn>} /> : null}
        {!pending && !result && !error && !notice && configured ? <EmptyState title={t('start_title')} sub={t('start_body')} /> : null}
        {!pending && result ? <>
          {agentResult ? <SearchPlan result={agentResult} /> : null}
          {!error || result.jobs.length > 0 ? (
            <div className="job-search-results-header" aria-live="polite">
              <div><h2>{t('results', { count: result.jobs.length })}</h2><p>{t('agent_results_for')}</p></div>
              {result.meta.cache === 'hit' ? <span className="job-search-source-tag">{t('cached')}</span> : null}
            </div>
          ) : null}
          <details className="job-search-request-review"><summary>{t('request_review')}</summary><p>{submittedRequest}</p></details>
          {result.meta.partial && !error ? <div role="status" className="job-search-notice is-warning">{t('partial')}</div> : null}
          <details className="job-search-coverage">
            <summary>{t(agentResult ? 'query_coverage' : 'coverage')}</summary>
            {agentResult ? agentResult.searches.map((search, index) => (
              <section className="job-search-query-outcome" key={`${search.query}-${index}`}>
                <h3>{search.query}</h3>
                {search.error ? <p className="job-search-query-error">{t(/limit|quota/i.test(search.error.code) ? 'query_limited' : 'query_failed')}</p> : null}
                <ProviderOutcomes providers={search.providers} />
              </section>
            )) : <ProviderOutcomes providers={result.meta.providers} />}
            {result.meta.requestId ? <p>{t('request_id', { id: result.meta.requestId })}</p> : null}
          </details>
          {!result.jobs.length && !error ? <EmptyState title={t('empty_title')} sub={t(agentResult?.agent.linkedinOnly ? 'linkedin_empty' : 'empty_body')} action={<Btn onClick={resetFilters}>{t('reset')}</Btn>} /> : null}
          <div className="job-search-list">{result.jobs.map((job) => <JobResultCard key={job.id} job={job} providers={providers ?? []} />)}</div>
        </> : null}
      </section>
    </div>
  );
}
