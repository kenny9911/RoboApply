'use client';

// JobAlertsForm — /tools/job-alerts: logged-out job alerts (WP-78; F-NOTIF-03,
// F-TOOL-04). Email + one search (job, city or country, remote only) +
// daily/weekly + an unchecked consent line. Submitting only sends a
// confirmation link (double opt-in); the answer is the same whether or not
// the address already has alerts. No resume, no profile, no account.
// Shown only when `jobs.alerts` and `notify.email` are on (R-04); otherwise a
// plain "not available here" line.

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { apiErrorCode } from '../../../lib/api/contracts/wire';
import { createAnonAlert } from '../../../lib/api/visitor';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { useCapabilities } from '../../../lib/flags';
import { Btn, PageHeader } from '../../v3/primitives';
import { ALERT_COUNTRIES, alertFilters, looksLikeEmail, regionName, signupHref, type AlertFormValues } from './model';
import styles from './visitor.module.css';

export interface JobAlertsFormProps {
  /** Prefill from the page URL (`?role=&city=&country=`), e.g. from a browse page. */
  initial?: { role?: string; city?: string; country?: string };
}

type Phase = { kind: 'form' } | { kind: 'sending' } | { kind: 'sent'; email: string };
type FieldError = 'email' | 'consent' | null;

export function JobAlertsForm({ initial = {} }: JobAlertsFormProps) {
  const t = useTranslations('visitor.alerts');
  const locale = useLocale();
  const brand = useBrand();
  const { flags, status } = useCapabilities();
  const ids = { email: useId(), role: useId(), city: useId(), country: useId(), remote: useId(), consent: useId(), emailHint: useId(), err: useId() };
  const countries = ALERT_COUNTRIES[brand.market];
  const [values, setValues] = useState<AlertFormValues>({
    email: '',
    role: (initial.role ?? '').slice(0, 120),
    city: (initial.city ?? '').slice(0, 80),
    country: initial.country && countries.includes(initial.country) ? initial.country : '',
    remoteOnly: false,
    frequency: 'weekly',
    consent: false,
  });
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [fieldError, setFieldError] = useState<FieldError>(null);
  const [serverError, setServerError] = useState<'rateLimited' | 'generic' | null>(null);

  const on = flags?.['jobs.alerts'] === true && flags?.['notify.email'] === true;
  const set = <K extends keyof AlertFormValues>(k: K, v: AlertFormValues[K]) => setValues((s) => ({ ...s, [k]: v }));

  const header = <PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('sub')} />;

  if (status === 'loading') {
    return (
      <div className={styles.page}>
        <div className={styles.intro}>{header}</div>
        <p className={styles.muted} role="status">
          {t('loading')}
        </p>
      </div>
    );
  }
  if (!on) {
    return (
      <div className={styles.page}>
        <div className={styles.intro}>{header}</div>
        <p className={styles.notice} role="status" data-notice="unavailable">
          {t('unavailable')}
        </p>
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);
    if (!looksLikeEmail(values.email)) return setFieldError('email');
    if (!values.consent) return setFieldError('consent');
    setFieldError(null);
    setPhase({ kind: 'sending' });
    try {
      await createAnonAlert({ email: values.email.trim(), filters: alertFilters(values), frequency: values.frequency, locale, consent: true });
      setPhase({ kind: 'sent', email: values.email.trim() });
    } catch (err) {
      const code = apiErrorCode(err);
      setServerError(code === 'rate_limited' ? 'rateLimited' : 'generic');
      if (code === 'invalid_request') setFieldError('email');
      setPhase({ kind: 'form' });
    }
  }

  if (phase.kind === 'sent') {
    return (
      <div className={styles.page}>
        <div className={styles.intro}>{header}</div>
        <div className={styles.panel} role="status" data-alerts-sent="true">
          <h2 className={styles.h2}>{t('sentTitle')}</h2>
          <p className={styles.body}>{t('sentBody', { email: phase.email })}</p>
          <div className={styles.gateActions}>
            <Btn onClick={() => setPhase({ kind: 'form' })}>{t('another')}</Btn>
            <Link href={signupHref('job-alerts')} className={styles.gateSecondary}>
              {t('signupInstead')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const sending = phase.kind === 'sending';
  return (
    <div className={styles.page} data-job-alerts={brand.id}>
      <div className={styles.intro}>{header}</div>
      <form className={styles.panel} onSubmit={onSubmit} noValidate aria-describedby={serverError ? ids.err : undefined}>
        <div className={styles.field}>
          <label htmlFor={ids.email} className={styles.label}>
            {t('email')}
          </label>
          <input
            id={ids.email}
            className={styles.textInput}
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            maxLength={254}
            value={values.email}
            onChange={(e) => set('email', e.target.value)}
            aria-invalid={fieldError === 'email'}
            aria-describedby={ids.emailHint}
          />
          <p id={ids.emailHint} className={styles.muted}>
            {fieldError === 'email' ? <span className={styles.error}>{t('errors.email')} </span> : null}
            {t('emailHint')}
          </p>
        </div>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor={ids.role} className={styles.label}>
              {t('role')}
            </label>
            <input id={ids.role} className={styles.textInput} maxLength={120} placeholder={t('rolePlaceholder')} value={values.role} onChange={(e) => set('role', e.target.value)} />
          </div>
          <div className={styles.field}>
            <label htmlFor={ids.city} className={styles.label}>
              {t('city')}
            </label>
            <input id={ids.city} className={styles.textInput} maxLength={80} placeholder={t('cityPlaceholder')} value={values.city} onChange={(e) => set('city', e.target.value)} />
          </div>
          <div className={styles.field}>
            <label htmlFor={ids.country} className={styles.label}>
              {t('country')}
            </label>
            <select id={ids.country} className={styles.textInput} value={values.country} onChange={(e) => set('country', e.target.value)}>
              <option value="">{t('countryAny')}</option>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {regionName(c, locale)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label htmlFor={ids.remote} className={styles.check}>
          <input id={ids.remote} type="checkbox" checked={values.remoteOnly} onChange={(e) => set('remoteOnly', e.target.checked)} />
          <span>{t('remote')}</span>
        </label>
        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>{t('frequency')}</legend>
          <div className={styles.radios}>
            {(['daily', 'weekly'] as const).map((f) => (
              <label key={f} className={styles.check}>
                <input type="radio" name="frequency" value={f} checked={values.frequency === f} onChange={() => set('frequency', f)} />
                <span>{t(f)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label htmlFor={ids.consent} className={styles.check}>
          <input id={ids.consent} type="checkbox" checked={values.consent} onChange={(e) => set('consent', e.target.checked)} aria-invalid={fieldError === 'consent'} />
          <span>{t('consent')}</span>
        </label>
        {fieldError === 'consent' ? <p className={styles.error}>{t('errors.consent')}</p> : null}
        <p className={styles.muted}>{t('privacy')}</p>
        {serverError ? (
          <p id={ids.err} className={styles.error} role="alert">
            {t(`errors.${serverError}`)}
          </p>
        ) : null}
        <div className={styles.gateActions}>
          <Btn type="submit" variant="primary" disabled={sending}>
            {sending ? t('submitting') : t('submit')}
          </Btn>
          <Link href={signupHref('job-alerts')} className={styles.gateSecondary}>
            {t('signupInstead')}
          </Link>
        </div>
      </form>
    </div>
  );
}
