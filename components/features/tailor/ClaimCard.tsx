'use client';

// ClaimCard — one "Verify details" line (WP-36a; F-RES-15; ruling C12).
// The line says something the base resume did not; the user decides:
//   Yes, keep · Remove · I did something similar (→ write what they did).
// Nothing is used or exported while any line is still pending. A line the AI
// wrote in several places is one card; the choice applies to every copy.

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import type { TailorClaim } from '../../../lib/api/contracts/resume';
import styles from './Tailor.module.css';

export interface ClaimCardProps {
  claim: TailorClaim;
  busy?: boolean;
  onDecide: (decision: { status: 'kept' | 'removed' | 'edited'; text?: string }) => void | Promise<unknown>;
}

const EDIT_MAX = 1000;

export function ClaimCard({ claim, busy = false, onDecide }: ClaimCardProps) {
  const t = useTranslations('tailor.verify');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(claim.text);
  const fieldId = useId();
  const removed = claim.status === 'removed';
  const terms = (claim.terms ?? []).filter(Boolean);
  /** The AI wrote this same line in more than one place; the decision applies to each. */
  const copies = claim.copies?.length ?? 1;

  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    await onDecide({ status: 'edited', text });
    setEditing(false);
  };

  return (
    <li className={styles.claim} data-status={claim.status} data-claim-id={claim.id}>
      <div className={styles.row}>
        {(claim.reasons ?? []).map((r) => (
          <span key={r} className={styles.reason}>
            {t(`reason.${r}`)}
          </span>
        ))}
        {claim.status !== 'pending' ? <span className={styles.statusTag}>{t(`status.${claim.status}`)}</span> : null}
      </div>
      <p className={styles.claimText}>{claim.text}</p>
      {terms.length > 0 ? <p className={styles.sub}>{t('terms', { terms: terms.join(', ') })}</p> : null}
      {claim.original ? <p className={styles.sub}>{t('was', { text: claim.original })}</p> : null}
      {copies > 1 ? (
        <p className={styles.sub} data-testid="claim-copies">
          {t('copies', { count: copies })}
        </p>
      ) : null}

      {editing ? (
        <div className={styles.section}>
          <label className={styles.label} htmlFor={fieldId}>
            {t('editLabel')}
          </label>
          <textarea
            id={fieldId}
            className={styles.textarea}
            value={draft}
            maxLength={EDIT_MAX}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className={styles.claimActions}>
            <Btn variant="primary" onClick={() => void save()} disabled={busy || !draft.trim()}>
              {t('save')}
            </Btn>
            <Btn
              variant="ghost"
              onClick={() => {
                setDraft(claim.text);
                setEditing(false);
              }}
              disabled={busy}
            >
              {t('cancel')}
            </Btn>
          </div>
        </div>
      ) : removed ? null : (
        <div className={styles.claimActions} role="group" aria-label={claim.text}>
          {claim.status !== 'kept' ? (
            <Btn variant="primary" onClick={() => void onDecide({ status: 'kept' })} disabled={busy}>
              {t('keep')}
            </Btn>
          ) : null}
          <Btn onClick={() => void onDecide({ status: 'removed' })} disabled={busy}>
            {t('remove')}
          </Btn>
          <Btn variant="ghost" onClick={() => setEditing(true)} disabled={busy}>
            {t('similar')}
          </Btn>
        </div>
      )}
    </li>
  );
}
