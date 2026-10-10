'use client';

// StudentVerification — confirm a school email for the student price
// (F-ACCT-02, V2; PRODUCT_PLAN.md §6.3). Shown in /settings#billing above the
// plan sheet when the `student` capability is on (RoboApply). School address
// → 6-digit code by email → confirmed for 12 months; the student plans then
// appear in the plan sheet. Renders nothing when the capability is off or the
// storage is not there yet (`available: false`).

import { useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { accountV2Api } from '../../../lib/api/accountV2';
import { CodeInput } from './TwoFactorSettings';
import { STUDENT_KEY, errorKey, useInvalidate, useMutation, useStudentStatus } from './queries';
import styles from './accountV2.module.css';

const KNOWN = ['school_domain_not_eligible', 'school_email_in_use', 'student_code_invalid', 'student_code_expired', 'email_unavailable'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function StudentVerification() {
  const t = useTranslations('accountV2');
  const format = useFormatter();
  const status = useStudentStatus();
  const invalidate = useInvalidate(STUDENT_KEY);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [changeAddress, setChangeAddress] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (schoolEmail: string) => accountV2Api.sendStudentEmailCode({ schoolEmail }),
    onSuccess: () => {
      setSentTo(email.split('@')[1] ?? null);
      setChangeAddress(false);
      setCode('');
      void invalidate();
    },
    onError: (err) => setError(errorKey(err, 'student', KNOWN)),
  });
  const confirm = useMutation({
    mutationFn: (c: string) => accountV2Api.confirmStudentEmail({ code: c }),
    onSuccess: () => {
      setSentTo(null);
      void invalidate();
    },
    onError: (err) => setError(errorKey(err, 'student', KNOWN)),
  });

  const s = status.data;
  if (!s || !s.available) return null;

  const pendingDomain = changeAddress ? null : (sentTo ?? s.pendingDomain);

  if (s.verified && !sentTo) {
    const until = s.expiresAt ? format.dateTime(new Date(s.expiresAt), { dateStyle: 'medium' }) : '—';
    return (
      <section className={styles.card} aria-labelledby="student-title" data-testid="student-verification">
        <h2 className={styles.h2} id="student-title">
          {t('student.title')}
        </h2>
        <p className={styles.ok}>{t('student.verified', { domain: s.schoolDomain ?? '—', date: until })}</p>
        <p className={styles.muted}>{t('student.verifiedNote')}</p>
      </section>
    );
  }

  function onSend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (EMAIL_RE.test(email.trim())) send.mutate(email.trim());
  }

  function onConfirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (/^\d{6}$/.test(code)) confirm.mutate(code);
  }

  return (
    <section className={styles.card} aria-labelledby="student-title" data-testid="student-verification">
      <h2 className={styles.h2} id="student-title">
        {t('student.title')}
      </h2>
      <p className={styles.body}>{t('student.sub')}</p>
      {pendingDomain ? (
        <form className={styles.stack} onSubmit={onConfirm}>
          <p className={styles.body}>{t('student.codeSent', { domain: pendingDomain })}</p>
          <CodeInput label={t('student.codeLabel')} value={code} onChange={setCode} />
          {error ? (
            <p className={styles.error} role="alert">
              {t(error)}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Btn type="submit" variant="primary" disabled={!/^\d{6}$/.test(code) || confirm.isPending} aria-busy={confirm.isPending || undefined}>
              {confirm.isPending ? t('student.confirming') : t('student.confirm')}
            </Btn>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                // A pending code stays valid until it expires; a new address replaces it.
                setSentTo(null);
                setChangeAddress(true);
                setError(null);
                setEmail('');
              }}
            >
              {t('student.resend')}
            </button>
          </div>
        </form>
      ) : (
        <form className={styles.stack} onSubmit={onSend}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="school-email">
              {t('student.emailLabel')}
            </label>
            <input
              id="school-email"
              className={styles.input}
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby="school-email-hint"
            />
            <p className={styles.muted} id="school-email-hint">
              {t('student.emailHint')}
            </p>
          </div>
          {error ? (
            <p className={styles.error} role="alert">
              {t(error)}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Btn type="submit" variant="primary" disabled={!EMAIL_RE.test(email.trim()) || send.isPending} aria-busy={send.isPending || undefined}>
              {send.isPending ? t('student.sending') : t('student.send')}
            </Btn>
          </div>
        </form>
      )}
      <p className={styles.muted}>{t('student.privacy')}</p>
    </section>
  );
}

export default StudentVerification;
