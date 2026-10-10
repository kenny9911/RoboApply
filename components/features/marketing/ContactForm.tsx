'use client';

// ContactForm — the in-app / public "Contact support" form (F-TRUST-07),
// POST /support/contact. Works signed in or out. It only says "sent" when the
// API confirms the email went to the support inbox; otherwise it shows the
// inbox address so the visitor can write directly. No reply time is promised.

import { useLocale, useTranslations } from 'next-intl';
import { useId, useState, type FormEvent } from 'react';

import { sendSupportMessage } from '../../../lib/api/support';
import { apiErrorCode, apiErrorDetails } from '../../../lib/api/contracts/wire';
import styles from './marketing.module.css';

export const CONTACT_TOPICS = ['account', 'billing', 'jobs', 'resume', 'practice', 'extension', 'privacy', 'bug', 'other'] as const;
type Topic = (typeof CONTACT_TOPICS)[number];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type Status = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; key: 'rateLimited' | 'notSent'; email: string };

export function ContactForm({ supportEmail }: { supportEmail: string }) {
  const t = useTranslations('landing.contact');
  const locale = useLocale();
  const id = useId();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState<Topic>('other');
  const [message, setMessage] = useState('');
  const [touched, setTouched] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const emailInvalid = !EMAIL_RE.test(email.trim());
  const messageInvalid = message.trim().length < 10;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (emailInvalid || messageInvalid || status.kind === 'sending') return;
    setStatus({ kind: 'sending' });
    try {
      await sendSupportMessage({
        email: email.trim(),
        name: name.trim() || undefined,
        topic,
        message: message.trim(),
        pageUrl: typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : undefined,
        locale,
      });
      setStatus({ kind: 'sent' });
    } catch (err) {
      const inbox = apiErrorDetails<{ supportEmail?: string }>(err)?.supportEmail ?? supportEmail;
      setStatus({ kind: 'error', key: apiErrorCode(err) === 'rate_limited' ? 'rateLimited' : 'notSent', email: inbox });
    }
  }

  if (status.kind === 'sent') {
    return (
      <div className={styles.form}>
        <h2 className={styles.h2} id="contact-title">
          {t('title')}
        </h2>
        <p className={styles.success} role="status">
          {t('sent')}
        </p>
        <div>
          <button
            type="button"
            className={styles.ctaSecondary}
            onClick={() => {
              setMessage('');
              setTouched(false);
              setStatus({ kind: 'idle' });
            }}
          >
            {t('sendAnother')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-labelledby="contact-title">
      <h2 className={styles.h2} id="contact-title">
        {t('title')}
      </h2>
      <p className={styles.muted}>{t('sub')}</p>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-email`}>
          {t('email')}
        </label>
        <input
          id={`${id}-email`}
          className={styles.input}
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={(touched && emailInvalid) || undefined}
          aria-describedby={touched && emailInvalid ? `${id}-email-error` : undefined}
          maxLength={254}
          required
        />
        {touched && emailInvalid ? (
          <span className={styles.error} id={`${id}-email-error`}>
            {t('invalidEmail')}
          </span>
        ) : null}
      </div>
      <label className={styles.field}>
        <span className={styles.label}>{t('name')}</span>
        <input className={styles.input} name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>{t('topic')}</span>
        <select className={styles.select} name="topic" value={topic} onChange={(e) => setTopic(e.target.value as Topic)}>
          {CONTACT_TOPICS.map((k) => (
            <option key={k} value={k}>
              {t(`topics.${k}`)}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-message`}>
          {t('message')}
        </label>
        <textarea
          id={`${id}-message`}
          className={styles.textarea}
          name="message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={5000}
          aria-invalid={(touched && messageInvalid) || undefined}
          aria-describedby={`${id}-message-hint`}
          required
        />
        <span className={touched && messageInvalid ? styles.error : styles.muted} id={`${id}-message-hint`}>
          {touched && messageInvalid ? t('tooShort') : t('messageHint')}
        </span>
      </div>
      {status.kind === 'error' ? (
        <p className={styles.error} role="alert">
          {t(status.key, { email: status.email })}
        </p>
      ) : null}
      <div>
        <button type="submit" className={styles.ctaPrimary} disabled={status.kind === 'sending'}>
          {status.kind === 'sending' ? t('sending') : t('send')}
        </button>
      </div>
    </form>
  );
}
