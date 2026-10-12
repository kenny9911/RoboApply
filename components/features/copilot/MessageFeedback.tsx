'use client';

// MessageFeedback — thumbs up / down on an answer, with an optional reason on
// "Not helpful" (F-ORION-10). Feedback goes to the admin review queue
// (WP-74 reads it through WP-50's listFeedback()).

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import styles from './copilot.module.css';

const REASONS = ['wrong', 'unhelpful', 'tooLong', 'other'] as const;
type Reason = (typeof REASONS)[number];

export interface MessageFeedbackProps {
  value: 'up' | 'down' | null;
  onSend: (value: 'up' | 'down', note?: string) => Promise<boolean>;
}

function Thumb({ down = false }: { down?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={down ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Zm0 0 4-7a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.3l-1.3 8a2 2 0 0 1-2 1.7H7" />
    </svg>
  );
}

export function MessageFeedback({ value, onSend }: MessageFeedbackProps) {
  const t = useTranslations('assistant.feedback');
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState<Reason>('wrong');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<'thanks' | 'failed' | null>(null);
  const noteId = useId();

  const send = async (v: 'up' | 'down', text?: string) => {
    const ok = await onSend(v, text);
    setMsg(ok ? 'thanks' : 'failed');
  };

  return (
    <div className={styles.feedback}>
      <button type="button" className={styles.iconBtn} aria-pressed={value === 'up'} aria-label={t('up')} title={t('up')} onClick={() => void send('up')}>
        <Thumb />
      </button>
      <button type="button" className={styles.iconBtn} aria-pressed={value === 'down'} aria-label={t('down')} title={t('down')} aria-expanded={asking} onClick={() => setAsking((a) => !a)}>
        <Thumb down />
      </button>
      {msg ? (
        <span className={msg === 'failed' ? styles.alert : styles.label} role="status">
          {t(msg)}
        </span>
      ) : null}
      {asking ? (
        <form
          className={styles.reasonForm}
          onSubmit={(e) => {
            e.preventDefault();
            setAsking(false);
            const text = [reason, note.trim()].filter(Boolean).join(': ').slice(0, 1000);
            void send('down', text);
          }}
        >
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('reasonTitle')}</legend>
            {REASONS.map((r) => (
              <label key={r} className={styles.radio}>
                <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
                {t(`reasons.${r}`)}
              </label>
            ))}
          </fieldset>
          <label htmlFor={noteId} className={styles.label}>
            {t('note')}
          </label>
          <textarea id={noteId} className={styles.textarea} maxLength={900} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className={styles.row}>
            <Btn type="submit" variant="primary">
              {t('send')}
            </Btn>
            <Btn type="button" variant="ghost" onClick={() => setAsking(false)}>
              {t('cancel')}
            </Btn>
          </div>
        </form>
      ) : null}
    </div>
  );
}
