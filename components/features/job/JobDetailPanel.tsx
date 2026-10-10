'use client';

// JobDetailPanel — one job's detail: header, Overview, Company, People and
// the "Get ready for this job" checklist (PRODUCT_PLAN.md §5.5 F-JOB-01…08;
// TASK_PLAN.md WP-34). Two consumers share it:
//   - the feed's desktop split view, `/jobs?job=<id>` (WP-33)  → mode 'split'
//   - the full page `/jobs/[id]` (app/(auth)/jobs/[id]/page.tsx) → mode 'page'
// The panel loads its own data from `jobId` (lib/api/jobs.ts via hooks/job);
// callers pass nothing else, so the feed never fetches detail on its behalf.
//
// D1: "Apply on company site" opens the employer's page; the user applies
// there. The job moves to Applied at once with an inline "Undo · I didn't
// apply" (rulings R1/C11), offered only when this click changed something
// (`alreadyApplied` false). When no resume is tailored for the job, the
// first click offers "Tailor first" once per job (until "Don't ask again"),
// and only while the brand's text model is usable (`ai.text`). Similar jobs
// show only while `jobs.recommendations` is on (R-14).

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn, Tabs, tabPanelProps, toast, type TabItem } from '../../v3/primitives';
import { CompanyTab } from '../company';
import { useJob, useApplyIntercept } from '../../../hooks/job';
import { useJobFit } from '../../../hooks/match';
import { useJobActions } from '../../../hooks/shared/useJobActions';
import { useCapabilities, useFlag, useHiringContactsMode, type FlagKey } from '../../../lib/flags';
import { useBrand } from '../../../lib/brand';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import { RoboApiError } from '../../../lib/api/client';
import { cn } from '../../../lib/utils';
import type { JobDetailResponse } from '../../../lib/api/contracts/jobs/detail';
import { ApplyInterceptSheet } from './ApplyInterceptSheet';
import { GetReadyChecklist } from './GetReadyChecklist';
import { JobHeader, JobHeaderActions } from './JobHeader';
import { JobOverview } from './JobOverview';
import { PeopleTab } from './PeopleTab';
import { SimilarJobs, jobDetailHref } from './SimilarJobs';
import { validDate } from './format';
import styles from './job.module.css';

export interface JobDetailPanelProps {
  jobId: string;
  /** 'split' = beside the feed list (desktop); 'page' = the whole page. */
  mode: 'split' | 'page';
  /** Split view only: close the panel (the feed drops `?job=`). */
  onClose?: () => void;
}

type TabId = 'overview' | 'company' | 'people';

/** The V2 news flag; resolves false until the flag resolver knows the key (INT). */
const COMPANY_NEWS_FLAG = 'companyNews' as FlagKey;

function Skeleton({ mode }: { mode: JobDetailPanelProps['mode'] }) {
  const t = useTranslations('jobDetail');
  return (
    <div className={cn(styles.panel, mode === 'page' ? styles.page : styles.split)} aria-busy="true" data-testid="job-loading">
      <div className={styles.header}>
        <span className={styles.skeleton} />
        <span className={styles.skeleton} />
        <span className={styles.skeleton} />
      </div>
      <div className={cn(styles.skeleton, styles.skeletonTall)} />
      <p className={styles.muted} role="status">
        {t('loading')}
      </p>
    </div>
  );
}

function useOpenJob(mode: JobDetailPanelProps['mode']): (jobId: string) => void {
  const router = useRouter();
  const pathname = usePathname();
  return (jobId: string) => {
    if (mode === 'split') {
      // Read the query at click time (no useSearchParams: the feed page may be static).
      const next = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
      next.set('job', jobId);
      router.replace(`${pathname ?? '/jobs'}?${next.toString()}`, { scroll: false });
    } else {
      router.push(jobDetailHref(jobId));
    }
  };
}

function Loaded({ detail, mode, onClose, refetch }: { detail: JobDetailResponse; mode: JobDetailPanelProps['mode']; onClose?: () => void; refetch: () => void }) {
  const t = useTranslations('jobDetail');
  const format = useFormatter();
  const brand = useBrand();
  const { job, company, checklist, tracker } = detail;
  const copilot = useFlag('copilot');
  const extension = useFlag('extension');
  const interviewBank = useFlag('interviewBank');
  const agent = useFlag('agent');
  const referralCodes = useFlag('cn.referralCodes');
  const aiText = useFlag('ai.text');
  const recommendations = useFlag('jobs.recommendations');
  const hiring = useHiringContactsMode();
  const { flags } = useCapabilities();
  const showNews = brand.market === 'intl' && flags?.[COMPANY_NEWS_FLAG] === true;
  const actions = useJobActions(job.id, { applyUrl: job.applyUrl, source: 'job_detail' });
  const intercept = useApplyIntercept(job.id, !!checklist.tailoredResumeId);
  const openJob = useOpenJob(mode);
  const [tab, setTab] = useState<TabId>('overview');
  const [askOpen, setAskOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  // Undo is offered only for a move to Applied this panel just made.
  const [undoable, setUndoable] = useState(false);

  // Keep "Why this job" in step with the fit block: when the full comparison
  // finishes after the page loaded from the cache, reload the page data once.
  const fitQ = useJobFit(job.id);
  const synced = useRef(false);
  useEffect(() => {
    const live = fitQ.data;
    if (!live || synced.current) return;
    if (!detail.fit || live.kind !== detail.fit.kind || live.score !== detail.fit.score) {
      synced.current = true;
      refetch();
    }
  }, [fitQ.data, detail.fit, refetch]);

  const open = job.status === 'open';
  const peopleTab = brand.market === 'intl' ? hiring !== 'off' && detail.people.mode !== 'off' : referralCodes;
  const tabs: TabItem<TabId>[] = [
    { id: 'overview', label: t('tabs.overview') },
    { id: 'company', label: t('tabs.company') },
    ...(peopleTab ? [{ id: 'people' as const, label: t('tabs.people') }] : []),
  ];
  const idBase = `job-${job.id}-${mode}`;
  const saved = tracker != null;
  const applied = checklist.applied || actions.lastApplied != null;

  const applyNow = async () => {
    const res = await actions.applyOnCompanySite();
    setUndoable(!!res && res.alreadyApplied !== true);
  };

  const apply = () => {
    if (aiText && intercept.shouldAsk) {
      setAskOpen(true);
      void intercept.markShown();
      return;
    }
    void applyNow();
  };

  const iApplied = () => {
    setUndoable(!checklist.applied);
    void actions.markApplied();
  };

  const undo = async () => {
    await actions.undoApplied();
    setUndoable(false);
  };

  const share = async () => {
    const res = await actions.share();
    if (!res) return;
    try {
      await navigator.clipboard.writeText(res.url);
      toast({ message: t('actions.shareCopied'), tone: 'ok' });
      setShareUrl(null);
    } catch {
      setShareUrl(res.url);
    }
  };

  const goPeople = () => {
    setTab('people');
  };

  const lastSeen = validDate(job.lastSeenAt);

  const headerActions = (
    <>
      <JobHeaderActions>
        {open && job.applyUrl && !applied ? (
          <Btn variant="primary" onClick={apply} disabled={actions.pending === 'apply'} data-testid="apply-button">
            {t('actions.apply')}
          </Btn>
        ) : null}
        {saved && !checklist.applied ? (
          <Btn aria-pressed="true" onClick={() => void actions.unsave()} disabled={actions.pending === 'unsave'} title={t('actions.unsave')}>
            {t('actions.saved')}
          </Btn>
        ) : saved ? (
          <Btn disabled>{t('actions.inApplications')}</Btn>
        ) : (
          <Btn aria-pressed="false" onClick={() => void actions.save()} disabled={actions.pending === 'save'}>
            {t('actions.save')}
          </Btn>
        )}
        <Btn variant="ghost" onClick={() => void share()} disabled={actions.pending === 'share'}>
          {t('actions.share')}
        </Btn>
        {copilot ? (
          <Btn variant="ghost" onClick={() => actions.askAboutJob()}>
            {t('actions.ask')}
          </Btn>
        ) : null}
      </JobHeaderActions>
      {open && job.applyUrl && !applied ? <p className={styles.hint}>{t('actions.applyHint')}</p> : null}
      {open && !job.applyUrl ? <p className={styles.hint}>{t('actions.noApplyLink')}</p> : null}
      {actions.lastApplied && undoable ? (
        <div className={styles.undoBar} role="status" data-testid="undo-bar">
          <span>{t('actions.movedToApplied')}</span>
          <button type="button" className={styles.linkBtn} onClick={() => void undo()} disabled={actions.pending === 'undoApplied'}>
            {t('actions.undo')}
          </button>
        </div>
      ) : null}
      {shareUrl ? (
        <div className={styles.shareBox}>
          <label htmlFor={`${idBase}-share`}>{t('actions.shareLabel')}</label>
          <input id={`${idBase}-share`} className={styles.shareInput} readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
        </div>
      ) : null}
      {actions.error ? (
        <p className={styles.alert} role="alert">
          {t('actions.error')}
        </p>
      ) : null}
    </>
  );

  return (
    <article className={cn(styles.panel, mode === 'page' ? styles.page : styles.split)} data-testid="job-detail" data-mode={mode} data-job-status={job.status}>
      <JobHeader detail={detail} mode={mode} onClose={onClose} actions={headerActions} />

      {!open ? (
        <section className={styles.notice} role="status" data-testid="job-closed">
          <h2 className={styles.sectionTitle}>{t('closed.title')}</h2>
          {lastSeen ? <p className={styles.body}>{t('closed.lastSeen', { date: format.dateTime(lastSeen, { dateStyle: 'medium' }) })}</p> : null}
          {tracker ? <p className={styles.muted}>{t('closed.kept')}</p> : null}
        </section>
      ) : null}

      {!open && recommendations ? <SimilarJobs jobId={job.id} title={t('closed.similarTitle')} onOpen={openJob} /> : null}

      <div className={styles.layout}>
        <div className={styles.main}>
          <Tabs ariaLabel={t('tabs.label')} idBase={idBase} tabs={tabs} value={tab} onChange={setTab} />
          <div {...tabPanelProps(idBase, 'overview')} hidden={tab !== 'overview'}>
            {tab === 'overview' ? <JobOverview detail={detail} /> : null}
          </div>
          <div {...tabPanelProps(idBase, 'company')} hidden={tab !== 'company'}>
            {tab === 'company' ? <CompanyTab jobId={job.id} company={company} showNews={showNews} onOpenJob={openJob} /> : null}
          </div>
          {peopleTab ? (
            <div {...tabPanelProps(idBase, 'people')} hidden={tab !== 'people'}>
              {tab === 'people' ? <PeopleTab detail={detail} /> : null}
            </div>
          ) : null}
        </div>
        <aside className={styles.rail}>
          <GetReadyChecklist
            detail={detail}
            flags={{ interviewBank, extension, agent, people: peopleTab && brand.market === 'intl', ai: aiText }}
            pending={actions.pending}
            onSave={() => void actions.save()}
            onTailor={() => actions.tailor()}
            onPractice={() => actions.practice()}
            onApply={apply}
            onIApplied={iApplied}
            onPeople={goPeople}
          />
        </aside>
      </div>

      {open && recommendations ? <SimilarJobs jobId={job.id} onOpen={openJob} /> : null}

      <ApplyInterceptSheet
        open={askOpen}
        onClose={() => setAskOpen(false)}
        onTailor={() => {
          setAskOpen(false);
          actions.tailor();
        }}
        onApplyNow={() => {
          setAskOpen(false);
          void applyNow();
        }}
        onNever={() => {
          setAskOpen(false);
          void intercept.neverAsk();
          void applyNow();
        }}
      />
    </article>
  );
}

export function JobDetailPanel({ jobId, mode, onClose }: JobDetailPanelProps) {
  const t = useTranslations('jobDetail');
  const q = useJob(jobId);

  if (q.isPending) return <Skeleton mode={mode} />;
  if (q.isError || !q.data) {
    const notFound = apiErrorCode(q.error) === 'not_found' || (q.error instanceof RoboApiError && q.error.status === 404);
    return (
      <div className={cn(styles.panel, mode === 'page' ? styles.page : styles.split)} data-testid={notFound ? 'job-not-found' : 'job-error'}>
        <section className={styles.section} role="alert">
          {notFound ? (
            <>
              <h2 className={styles.sectionTitle}>{t('notFound.title')}</h2>
              <p className={styles.body}>{t('notFound.body')}</p>
              {mode === 'split' && onClose ? (
                <Btn onClick={onClose}>{t('close')}</Btn>
              ) : (
                <Link className={styles.linkBtn} href="/jobs">
                  {t('notFound.back')}
                </Link>
              )}
            </>
          ) : (
            <>
              <p className={styles.body}>{t('error')}</p>
              <div className={styles.actions}>
                <Btn onClick={() => void q.refetch()}>{t('retry')}</Btn>
              </div>
            </>
          )}
        </section>
      </div>
    );
  }
  return <Loaded detail={q.data} mode={mode} onClose={onClose} refetch={() => void q.refetch()} />;
}

export default JobDetailPanel;
