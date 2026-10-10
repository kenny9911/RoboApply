'use client';

// CompetitivenessReport — the /jobs/report page body (WP-77; flag
// `competitiveness`). Reached from the /jobs header link (WP-33) and the
// Assistant's competitiveness card (WP-50/51, `?job=<id>`).
//
//   ?search=<id>   which saved search (default: the active one)
//   ?job=<id>      the job the user came from: its own requirement rows
//                  (the free keyword check) above the report
//
// The report is counted from job posts (no AI, no AI label). Creating one
// spends a `competitiveness` credit through the shared gate; the server
// reuses an identical report from the same day free. "Broaden your search"
// removes one filter from the saved search with one PATCH (baseVersion).

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { Btn, CreditNotice, EmptyState, PageHeader } from '../../v3/primitives';
import { useCapabilities } from '../../../lib/flags';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import type { BroadenOption } from '../../../lib/api/contracts/match';
import { useApplyFilters, useSearchProfiles, pickActiveProfile, type FilterSetPatch, type SearchProfile } from '../../../hooks/search';
import { competitivenessKey, useCreateCompetitiveness, useLatestCompetitiveness } from '../../../hooks/match';
import { CompetitivenessReportView, type BroadenState } from './CompetitivenessReportView';
import { JobKeywordCheck } from './KeywordCheck';
import styles from './competitiveness.module.css';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function param(value: string | null | undefined): string | null {
  return value && ID.test(value) ? value : null;
}

export function CompetitivenessReport() {
  const t = useTranslations('competitiveness');
  const { flags, status: flagStatus } = useCapabilities();
  const enabled = flags?.competitiveness === true;

  if (!flags && flagStatus === 'loading') {
    return (
      <p className={styles.muted} role="status">
        {t('loading')}
      </p>
    );
  }
  if (!enabled) {
    return (
      <div className={styles.page}>
        <EmptyState
          title={t('unavailable.title')}
          sub={t('unavailable.sub')}
          action={
            <Link href="/jobs" className={styles.link}>
              {t('unavailable.back')}
            </Link>
          }
        />
      </div>
    );
  }
  return <ReportPage />;
}

function ReportPage() {
  const t = useTranslations('competitiveness');
  const format = useFormatter();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/jobs/report';
  const client = useQueryClient();

  const jobId = param(params?.get('job'));
  const requested = param(params?.get('search'));
  const profiles = useSearchProfiles();
  const list = profiles.data?.profiles ?? [];
  const profile: SearchProfile | null = (requested ? list.find((p) => p.id === requested) : null) ?? pickActiveProfile(profiles.data);

  const latest = useLatestCompetitiveness(profile?.id);
  const create = useCreateCompetitiveness();
  const filtersApi = useApplyFilters();
  const [broaden, setBroaden] = useState<Record<string, BroadenState>>({});

  const report = latest.data ?? null;
  const running = create.status === 'running';

  const selectSearch = (id: string) => {
    const next = new URLSearchParams(params?.toString() ?? '');
    next.set('search', id);
    setBroaden({});
    router.replace(`${pathname}?${next.toString()}`);
  };

  const run = useCallback(async () => {
    if (!profile) return;
    setBroaden({});
    await create.run(profile.id);
  }, [create, profile]);

  const onBroaden = useCallback(
    async (option: BroadenOption) => {
      if (!profile) return;
      setBroaden((s) => ({ ...s, [option.field]: 'applying' }));
      const res = await filtersApi.apply({ profile, patch: option.patch as FilterSetPatch, defaultCountry: profile.filters.country ?? '' });
      if (res.ok) {
        setBroaden((s) => ({ ...s, [option.field]: 'applied' }));
        void client.invalidateQueries({ queryKey: competitivenessKey(profile.id) });
      } else {
        setBroaden((s) => ({ ...s, [option.field]: res.conflict || apiErrorCode(res.error) === 'version_conflict' ? 'conflict' : 'error' }));
      }
    },
    [client, filtersApi, profile],
  );

  return (
    <div className={styles.page}>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('intro')} />
      <p className={styles.honesty}>{t('honesty')}</p>

      {jobId ? (
        <section className={styles.section} aria-labelledby="cmp-job">
          <h2 id="cmp-job" className={styles.heading}>
            {t('job.title')}
          </h2>
          <p className={styles.text}>{t('job.intro')}</p>
          <JobKeywordCheck jobId={jobId} />
          <Link href={`/jobs/${encodeURIComponent(jobId)}`} className={styles.link}>
            {t('job.open')}
          </Link>
        </section>
      ) : null}

      {profiles.isPending ? (
        <p className={styles.muted} role="status">
          {t('loading')}
        </p>
      ) : profiles.isError ? (
        <p className={styles.alert} role="alert">
          {t('loadError')}
        </p>
      ) : !profile ? (
        <EmptyState
          title={t('search.none')}
          action={
            <Link href="/jobs" className={styles.link}>
              {t('search.setUp')}
            </Link>
          }
        />
      ) : (
        <>
          <div className={styles.toolbar}>
            {list.length > 1 ? (
              <label className={styles.selectLabel}>
                {t('search.label')}
                <select className={styles.select} value={profile.id} onChange={(e) => selectSearch(e.target.value)}>
                  {list.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className={styles.muted}>{t('search.single', { name: profile.name })}</p>
            )}
          </div>

          {latest.isPending ? (
            <p className={styles.muted} role="status">
              {t('loading')}
            </p>
          ) : latest.isError ? (
            <div className={styles.actions}>
              <p className={styles.alert} role="alert">
                {t('loadError')}
              </p>
              <Btn className={styles.action} onClick={() => void latest.refetch()}>
                {t('retry')}
              </Btn>
            </div>
          ) : !report ? (
            <section className={styles.section} aria-labelledby="cmp-start" data-testid="competitiveness-start">
              <h2 id="cmp-start" className={styles.heading}>
                {t('start.title')}
              </h2>
              <p className={styles.text}>{t('start.intro')}</p>
              <ul className={styles.points}>
                <li>{t('start.point1')}</li>
                <li>{t('start.point2')}</li>
                <li>{t('start.point3')}</li>
              </ul>
              <p className={styles.muted}>{t('start.noAi')}</p>
              <div className={styles.actions}>
                <Btn variant="primary" className={styles.action} onClick={() => void run()} disabled={running} aria-busy={running}>
                  {running ? t('start.running') : t('start.run')}
                </Btn>
                <CreditNotice bucket={create.gate.summary} />
              </div>
              <RunStatus status={create.status} />
            </section>
          ) : (
            <>
              {create.status === 'done' && report.reused ? (
                <p className={styles.muted} role="status" data-testid="report-reused">
                  {t('reused')}
                </p>
              ) : create.status === 'done' && !report.charged && report.suppressed ? (
                <p className={styles.muted} role="status" data-testid="report-not-charged">
                  {t('notCharged')}
                </p>
              ) : null}
              <CompetitivenessReportView report={report} filters={profile.filters} onBroaden={(o) => void onBroaden(o)} broadenState={broaden} />
              <div className={styles.footer}>
                <p className={styles.muted}>
                  {t('footer.created', { date: format.dateTime(new Date(report.createdAt), { dateStyle: 'medium', timeStyle: 'short' }) })}
                  {report.charged ? ` · ${t('footer.charged')}` : ''}
                </p>
                <div className={styles.actions}>
                  <Btn
                    variant={report.stale ? 'primary' : 'default'}
                    className={styles.action}
                    onClick={() => void run()}
                    disabled={running}
                    aria-busy={running}
                  >
                    {running ? t('start.running') : t('footer.rerun')}
                  </Btn>
                  <CreditNotice bucket={create.gate.summary} />
                </div>
              </div>
              <RunStatus status={create.status} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function RunStatus({ status }: { status: ReturnType<typeof useCreateCompetitiveness>['status'] }) {
  const t = useTranslations('competitiveness.error');
  if (status === 'error') {
    return (
      <p className={styles.alert} role="alert">
        {t('generic')}
      </p>
    );
  }
  if (status === 'not_found') {
    return (
      <p className={styles.alert} role="alert">
        {t('notFound')}
      </p>
    );
  }
  if (status === 'out_of_credits') {
    return (
      <p className={styles.alert} role="status">
        {t('outOfCredits')}
      </p>
    );
  }
  return null;
}
