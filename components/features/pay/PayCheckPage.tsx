'use client';

// PayCheckPage — /pay, "Pay check" (resume.io's Salary Analyzer, honestly):
// what live job posts of the last 90 days in this site's market state about
// pay for a job title, with an optional place. Read-only; no credits; no
// estimate and no prediction (D3). The figures come from the posts' own stated
// pay through GET /feed/pay-check (server feed/payCheck.ts), per currency,
// with N and the date (SourceNote); below the shared sample rule the page
// shows counts only and says so.
//
// The title is filled in from (first that applies): `?title=` (the job page's
// "See what postings pay for this title" link), else the first title of the
// active saved search, which is then checked at once. `?location=` fills the
// place; `remote` ticks "Remote jobs only". A check is sent when the form is
// submitted and keeps the URL in step (router.replace), so it can be shared
// and reloaded.
//
// Where the job feed is off (GoApply with CN_RECRUITMENT_INFO_MODE=off) the
// site shows no third-party posts: the page says it is not available, and the
// nav entry and the job page's link are absent with the same capability
// (`jobs.feed`; R-04). One primary button: "Check pay".

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Btn, EmptyState, PageHeader } from '../../v3/primitives';
import { useCapabilities } from '../../../lib/flags';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import { RoboApiError } from '../../../lib/api/client';
import { pickActiveProfile, useSearchProfiles } from '../../../hooks/search';
import { usePayCheck, type PayCheckAsk } from '../../../hooks/feed';
import { PAY_LOCATION_MAX, PAY_TITLE_MAX, REMOTE_LOCATION, isRemoteLocation, payCheckHref } from './format';
import { PayCheckResult } from './PayCheckResult';
import styles from './pay.module.css';

/** Days a pay check reads (the server's PAY_CHECK_WINDOW_DAYS; the answer carries its own). */
const WINDOW_DAYS = 90;

export interface PayCheckPageProps {
  /** `?title=` (trimmed, ≤ 120 characters), or null. */
  initialTitle?: string | null;
  /** `?location=` (trimmed, ≤ 120 characters; `remote` for remote jobs), or null. */
  initialLocation?: string | null;
}

/** The first title of a saved search, or null. Pure. */
export function savedSearchTitle(profile: { filters?: { titles?: readonly string[] | null } | null } | null | undefined): string | null {
  const first = profile?.filters?.titles?.find((x) => typeof x === 'string' && x.trim());
  return first ? first.trim().slice(0, PAY_TITLE_MAX) : null;
}

export function PayCheckPage({ initialTitle = null, initialLocation = null }: PayCheckPageProps) {
  const t = useTranslations('payCheck');
  const router = useRouter();
  const { flags, status: flagStatus } = useCapabilities();
  const feedOn = flags?.['jobs.feed'] === true;

  const startTitle = initialTitle?.trim() || '';
  const startRemote = isRemoteLocation(initialLocation);
  const startLocation = startRemote ? '' : (initialLocation?.trim() ?? '');

  const [title, setTitle] = useState(startTitle);
  const [location, setLocation] = useState(startLocation);
  const [remote, setRemote] = useState(startRemote);
  const [ask, setAsk] = useState<PayCheckAsk | null>(startTitle ? { title: startTitle, location: startRemote ? REMOTE_LOCATION : startLocation } : null);
  const [prefilled, setPrefilled] = useState(false);
  const touched = useRef(false);

  // No title in the link: the active saved search's first title, checked at once (until the person types).
  const profiles = useSearchProfiles({ enabled: feedOn && !startTitle });
  const savedTitle = savedSearchTitle(pickActiveProfile(profiles.data));
  useEffect(() => {
    if (startTitle || touched.current || !savedTitle) return;
    setTitle(savedTitle);
    setAsk({ title: savedTitle, location: '' });
    setPrefilled(true);
  }, [startTitle, savedTitle]);

  const result = usePayCheck(feedOn ? ask : null);

  if (!flags && flagStatus === 'loading') {
    return (
      <div className={styles.page}>
        <p className={styles.muted} role="status">
          {t('loading')}
        </p>
      </div>
    );
  }
  if (!feedOn) {
    return (
      <div className={styles.page}>
        <EmptyState
          title={t('unavailable.title')}
          sub={t('unavailable.sub')}
          action={
            <Link href="/dashboard" className={styles.link}>
              {t('unavailable.back')}
            </Link>
          }
        />
      </div>
    );
  }

  const run = (next: PayCheckAsk) => {
    touched.current = true;
    setPrefilled(false);
    setTitle(next.title);
    setRemote(isRemoteLocation(next.location));
    setLocation(isRemoteLocation(next.location) ? '' : next.location);
    setAsk(next);
    router.replace(payCheckHref(next), { scroll: false });
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const next = { title: title.trim(), location: remote ? REMOTE_LOCATION : location.trim() };
    if (!next.title) return;
    run(next);
  };

  const errorCode = result.isError ? apiErrorCode(result.error) : null;
  const notAvailable = errorCode === 'feature_disabled' || (result.error instanceof RoboApiError && result.error.status === 404);

  return (
    <div className={styles.page}>
      <PageHeader title={t('title')} sub={t('sub', { days: WINDOW_DAYS })} />

      <form className={styles.ask} onSubmit={submit} aria-label={t('form.label')} data-testid="pay-form">
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.label}>{t('form.title')}</span>
            <input
              className={styles.input}
              name="title"
              value={title}
              onChange={(e) => {
                touched.current = true;
                setPrefilled(false);
                setTitle(e.target.value);
              }}
              placeholder={t('form.titlePlaceholder')}
              maxLength={PAY_TITLE_MAX}
              autoComplete="off"
              required
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{t('form.location')}</span>
            <input
              className={styles.input}
              name="location"
              value={remote ? '' : location}
              onChange={(e) => {
                touched.current = true;
                setLocation(e.target.value);
              }}
              placeholder={t('form.locationPlaceholder')}
              maxLength={PAY_LOCATION_MAX}
              autoComplete="off"
              disabled={remote}
            />
          </label>
        </div>
        <div className={styles.formRow}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={remote}
              onChange={(e) => {
                touched.current = true;
                setRemote(e.target.checked);
              }}
            />
            <span>{t('form.remote')}</span>
          </label>
          <Btn type="submit" variant="primary" disabled={!title.trim() || result.isFetching} data-testid="pay-submit">
            {t('form.submit')}
          </Btn>
        </div>
        {prefilled ? (
          <p className={styles.muted} data-testid="pay-prefilled">
            {t('form.prefilled')}
          </p>
        ) : null}
      </form>

      <div className={styles.results} aria-live="polite" aria-busy={result.isFetching}>
        {!ask ? (
          <p className={styles.muted}>{t('start')}</p>
        ) : result.isPending ? (
          <p className={styles.muted} role="status">
            {t('reading')}
          </p>
        ) : result.isError ? (
          notAvailable ? (
            <p className={styles.text} role="alert">
              {t('unavailable.sub')}
            </p>
          ) : (
            <div className={styles.errorBox} role="alert">
              <p className={styles.text}>{errorCode === 'rate_limited' ? t('rateLimited') : t('error')}</p>
              <Btn onClick={() => void result.refetch()}>{t('retry')}</Btn>
            </div>
          )
        ) : result.data ? (
          <PayCheckResult data={result.data} asked={ask} onAsk={run} />
        ) : null}
      </div>
    </div>
  );
}
