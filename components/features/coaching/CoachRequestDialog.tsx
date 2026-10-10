'use client';

// CoachRequestDialog — "Request a session" (WP-72; F-COACH-01). For a coach
// without their own booking page: the request is emailed to the coach (who
// replies to the user directly) and to staff. Only what the user types is
// sent; no resume or account data. Nothing is charged; the coach and the
// user agree on time and price themselves.

import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Modal } from '../../v3/primitives/Modal';
import { Btn } from '../../v3/primitives/Btn';
import { useAuth } from '../../../lib/auth/useAuth';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { apiErrorCode, apiErrorDetails, apiErrorReason } from '../../../lib/api/contracts/wire';
import type { CoachView } from '../../../lib/api/contracts/coaching';
import { useRequestCoach } from '../../../hooks/coaching/useCoaching';
import styles from './coaching.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Placeholder addresses (e.g. GoApply phone-only accounts) are never offered as a reply address. */
function usableEmail(email: string | null | undefined): string {
  if (!email || /\.invalid$/i.test(email)) return '';
  return email;
}

export interface CoachRequestDialogProps {
  coach: CoachView;
  open: boolean;
  onClose: () => void;
}

type ErrorKey = 'invalid' | 'consent' | 'limit' | 'notConfigured' | 'useLink' | 'notFound' | 'length' | 'generic';

function errorKeyFor(err: unknown): ErrorKey {
  const code = apiErrorCode(err);
  const reason = apiErrorReason(err);
  if (code === 'rate_limited') return 'limit';
  if (code === 'provider_not_configured') return 'notConfigured';
  if (reason === 'use_booking_link') return 'useLink';
  if (reason === 'coach_not_found' || code === 'not_found') return 'notFound';
  if (reason === 'duration_not_offered') return 'length';
  if (reason === 'share_consent_required') return 'consent';
  if (code === 'invalid_request') return 'invalid';
  return 'generic';
}

export function CoachRequestDialog({ coach, open, onClose }: CoachRequestDialogProps) {
  const t = useTranslations('coaching.request');
  const tc = useTranslations('coaching.card');
  const { user } = useAuth();
  const id = useId();
  const mutation = useRequestCoach(coach.id);
  // GoApply (PIPL Art. 23): sending the user's name, email and message to the
  // coach, an independent third party, needs its own explicit consent.
  const needsShareConsent = useBrand().market === 'cn';
  const [shareConsent, setShareConsent] = useState(false);

  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(usableEmail(user?.email));
  const [topic, setTopic] = useState('');
  const [length, setLength] = useState('');
  const [times, setTimes] = useState('');
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState<ErrorKey | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const serverError = mutation.isError ? errorKeyFor(mutation.error) : null;
  const errorKey = localError ?? serverError;
  const bookingUrl = serverError === 'useLink' ? apiErrorDetails<{ bookingUrl?: string }>(mutation.error)?.bookingUrl : undefined;

  function submit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    const contactEmail = email.trim();
    if (!topic.trim() || !EMAIL_RE.test(contactEmail)) {
      setLocalError('invalid');
      return;
    }
    if (needsShareConsent && !shareConsent) {
      setLocalError('consent');
      return;
    }
    mutation.mutate(
      {
        ...(name.trim() ? { name: name.trim() } : {}),
        topic: topic.trim(),
        contactEmail,
        ...(length ? { durationMin: Number(length) } : {}),
        ...(times.trim() ? { preferredTimes: times.trim() } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(needsShareConsent ? { shareConsent: true as const } : {}),
      },
      { onSuccess: () => setSentTo(contactEmail) },
    );
  }

  if (sentTo) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={t('title', { name: coach.displayName })}
        footer={
          <div className={styles.actions}>
            <Btn variant="primary" onClick={onClose}>
              {t('close')}
            </Btn>
          </div>
        }
      >
        <p className={styles.success} role="status">
          {t('sent', { name: coach.displayName, email: sentTo })}
        </p>
      </Modal>
    );
  }

  const formId = `${id}-form`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('title', { name: coach.displayName })}
      description={t('description', { name: coach.displayName })}
      maxWidth="lg"
      footer={
        <div className={styles.actions}>
          <Btn variant="primary" type="submit" form={formId} disabled={mutation.isPending}>
            {mutation.isPending ? t('sending') : t('send')}
          </Btn>
          <Btn variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Btn>
        </div>
      }
    >
      <form id={formId} className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span className={styles.label}>{t('topic')}</span>
            <input
              className={styles.input}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t('topicPlaceholder')}
              maxLength={200}
              required
              aria-invalid={errorKey === 'invalid' && !topic.trim() ? true : undefined}
            />
          </label>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-email`}>
              {t('email')}
            </label>
            <input
              id={`${id}-email`}
              className={styles.input}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              required
              aria-describedby={`${id}-email-hint`}
              aria-invalid={errorKey === 'invalid' && !EMAIL_RE.test(email.trim()) ? true : undefined}
            />
            <p className={styles.hint} id={`${id}-email-hint`}>
              {t('emailHint')}
            </p>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-name`}>
              {t('name')}
            </label>
            <input
              id={`${id}-name`}
              className={styles.input}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              aria-describedby={`${id}-name-hint`}
            />
            <p className={styles.hint} id={`${id}-name-hint`}>
              {t('nameHint')}
            </p>
          </div>
          {coach.sessions.length > 0 ? (
            <label className={styles.field}>
              <span className={styles.label}>{t('length')}</span>
              <select className={styles.select} value={length} onChange={(e) => setLength(e.target.value)}>
                <option value="">{t('lengthAny')}</option>
                {coach.sessions.map((s) => (
                  <option key={s.minutes} value={String(s.minutes)}>
                    {tc('sessionLength', { minutes: s.minutes })}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className={`${styles.field} ${styles.wide}`}>
            <span className={styles.label}>{t('times')}</span>
            <input className={styles.input} value={times} onChange={(e) => setTimes(e.target.value)} placeholder={t('timesPlaceholder')} maxLength={500} />
          </label>
          <label className={`${styles.field} ${styles.wide}`}>
            <span className={styles.label}>{t('message')}</span>
            <textarea className={styles.textarea} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} />
          </label>
        </div>
        <p className={styles.note}>{t('shareNote')}</p>
        {needsShareConsent ? (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={shareConsent}
              onChange={(e) => setShareConsent(e.target.checked)}
              required
              aria-invalid={errorKey === 'consent' && !shareConsent ? true : undefined}
              data-testid="coach-share-consent"
            />
            <span>{t('shareConsent', { name: coach.displayName })}</span>
          </label>
        ) : null}
        {errorKey ? (
          <p className={styles.error} role="alert">
            {t(`errors.${errorKey}`)}
            {bookingUrl ? (
              <>
                {' '}
                <a className={styles.link} href={bookingUrl} target="_blank" rel="noopener noreferrer">
                  {bookingUrl}
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
