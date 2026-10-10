'use client';

// AddJobPanel — "Add a job" (WP-35; F-TRK-04). Two ways in:
//   From a link   → we read the page (Firecrawl, server side) and show the
//                   details to check; boards that forbid copying, and links we
//                   cannot read, fall back to "Paste the job text";
//   Type it in    → the same form, blank.
// Saving spends one `job_import` credit unless the job already exists (the
// user's earlier import, or our own listing); the server decides. After
// saving: View job (fit score, once the job page ships) / Save to tracker /
// Tailor resume / Practice interview.

import { useId, useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn, Tabs, tabPanelProps } from '../../v3/primitives';
import { jobHref } from '../../v3/shell/destinations';
import { tailorHref } from '../../../hooks/shared/useLaunchTailor';
import { practiceHref } from '../../../hooks/shared/useLaunchPractice';
import { useJobImport, type ImportErrorView } from '../../../hooks/jobimport/useJobImport';
import type { ImportJobResponse, ManualJob } from '../../../lib/api/contracts/jobs/import';
import { ImportFieldsForm } from './ImportFieldsForm';
import { ImportWarnings } from './ImportWarnings';
import { TrackJobButton } from './TrackJobButton';
import styles from './JobImport.module.css';

type Mode = 'link' | 'manual';
const HTTP_RE = /^https?:\/\/\S+\.\S+/i;

function ErrorNotice({ error }: { error: ImportErrorView }) {
  const t = useTranslations('jobImport.errors');
  const format = useFormatter();
  let text: string;
  switch (error.kind) {
    case 'locked': {
      const until = error.until ? new Date(error.until) : null;
      text = until && !Number.isNaN(until.getTime()) ? t('locked', { time: format.dateTime(until, { dateStyle: 'medium', timeStyle: 'short' }) }) : t('lockedNoTime');
      break;
    }
    case 'hourly':
      text = error.retryAfterSec ? t('hourly', { minutes: Math.max(1, Math.ceil(error.retryAfterSec / 60)) }) : t('hourlyNoTime');
      break;
    case 'credits_exhausted':
      text = t('creditsExhausted');
      break;
    case 'invalid':
      text = t('invalid');
      break;
    default:
      text = t('generic');
  }
  return (
    <p className={`${styles.notice} ${styles.noticeError}`} role="alert">
      {text}
    </p>
  );
}

function DoneCard({ result, onAnother }: { result: ImportJobResponse; onAnother: () => void }) {
  const t = useTranslations('jobImport');
  const jobId = result.jobId!;
  const title = result.matched === 'public' ? t('done.public') : result.matched === 'yours' ? t('done.yours') : t('done.added');
  const sub = result.matched === 'public' ? t('done.publicSub') : result.matched === 'yours' ? t('done.yoursSub') : t('done.addedSub');
  return (
    <div className={styles.done} role="status" data-testid="import-done">
      <h3 className={styles.heading}>{title}</h3>
      <p className={styles.sub}>{sub}</p>
      <ImportWarnings warnings={result.warnings} />
      <div className={styles.actions}>
        <Btn as="a" href={jobHref(jobId)} variant="primary">
          {t('actions.view')}
        </Btn>
        <TrackJobButton jobId={jobId} />
        <Btn as="a" href={tailorHref({ jobId, from: 'job_import' })}>
          {t('actions.tailor')}
        </Btn>
        <Btn as="a" href={practiceHref({ jobId, from: 'job_import' })}>
          {t('actions.practice')}
        </Btn>
        <Btn variant="ghost" onClick={onAnother}>
          {t('add.addAnother')}
        </Btn>
      </div>
    </div>
  );
}

export interface AddJobPanelProps {
  /** Start on this tab (default: From a link). */
  initialMode?: Mode;
}

export function AddJobPanel({ initialMode = 'link' }: AddJobPanelProps) {
  const t = useTranslations('jobImport');
  const id = useId();
  const flow = useJobImport();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState(false);
  /** Bumped to remount the form with fresh values. */
  const [formKey, setFormKey] = useState(0);

  const result = flow.result;

  async function read(e: FormEvent) {
    e.preventDefault();
    if (!HTTP_RE.test(url.trim())) {
      setUrlError(true);
      return;
    }
    setUrlError(false);
    await flow.readLink(url);
    setFormKey((k) => k + 1);
  }

  async function save(job: ManualJob) {
    const importId = result && result.status !== 'done' ? result.importId : null;
    await flow.save(job, importId);
  }

  function startOver() {
    flow.reset();
    setUrl('');
    setUrlError(false);
    setFormKey((k) => k + 1);
  }

  const tabs = [
    { id: 'link' as const, label: t('add.tabLink') },
    { id: 'manual' as const, label: t('add.tabManual') },
  ];

  const idBase = `${id}-add`;

  let body: React.ReactNode;
  if (result?.status === 'done' && result.jobId) {
    body = <DoneCard result={result} onAnother={startOver} />;
  } else if (mode === 'manual') {
    body = <ImportFieldsForm key={`manual-${formKey}`} draft={null} mode="manual" saving={flow.pending === 'save'} onSave={save} />;
  } else {
    const draftShown = result && result.status !== 'done';
    body = (
      <>
        <form className={styles.linkRow} onSubmit={read} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-url`}>
              {t('add.linkLabel')}
            </label>
            <input
              id={`${id}-url`}
              className={styles.input}
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder={t('add.linkPlaceholder')}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (urlError) setUrlError(false);
              }}
              aria-invalid={urlError || undefined}
              aria-describedby={`${id}-url-help`}
              maxLength={2000}
            />
          </div>
          <Btn type="submit" variant={draftShown ? 'default' : 'primary'} disabled={flow.pending === 'read'}>
            {flow.pending === 'read' ? t('add.reading') : t('add.getDetails')}
          </Btn>
        </form>
        <p id={`${id}-url-help`} className={urlError ? styles.fieldError : styles.hint} role={urlError ? 'alert' : undefined}>
          {urlError ? t('add.invalidLink') : t('add.linkHelp')}
        </p>
        {draftShown && result.reason ? (
          <p className={result.status === 'failed' ? `${styles.notice} ${styles.noticeError}` : styles.notice} role="status" data-testid="import-reason">
            {t(`reason.${result.reason}`)}
          </p>
        ) : null}
        {draftShown ? <ImportWarnings warnings={result.warnings} /> : null}
        {draftShown ? (
          <ImportFieldsForm
            key={`draft-${formKey}`}
            draft={result.draft}
            missingFields={result.status === 'needs_fields' ? result.missingFields : []}
            mode={result.status === 'needs_fields' ? 'check' : 'manual'}
            saving={flow.pending === 'save'}
            onSave={save}
          />
        ) : null}
        {draftShown ? (
          <div className={styles.actions}>
            <Btn variant="ghost" onClick={startOver}>
              {t('add.startOver')}
            </Btn>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <section className={`${styles.panel} ${styles.panelSoft}`} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className={styles.heading}>
        {t('add.heading')}
      </h2>
      {result?.status === 'done' ? null : (
        <Tabs
          ariaLabel={t('add.tabsLabel')}
          idBase={idBase}
          value={mode}
          onChange={(m) => {
            setMode(m);
            flow.reset();
            setFormKey((k) => k + 1);
          }}
          tabs={tabs}
        />
      )}
      {flow.error ? <ErrorNotice error={flow.error} /> : null}
      <div {...(result?.status === 'done' ? {} : tabPanelProps(idBase, mode))}>{body}</div>
    </section>
  );
}
