'use client';

// memory_add — "Remember this for later chats?" (F-ORION-09). The fact is
// stored only when the user confirms. On GoApply the `copilot_memory`
// consent is asked FIRST, with its exact text: nothing is saved until the
// user allows it (PIPL; WP-51 acceptance). Saved facts are listed and
// deletable in Settings → Assistant.
//
// When the consent is needed: the brand rule (GoApply) with the consent not
// granted, OR the server said so — `data.consentRequired` on the card, or a
// 403 with reason `copilot_memory_consent_required` on apply (the proposal
// stays pending). The server's word wins over what this page has cached, so a
// consent withdrawn in another tab is asked again instead of failing silently.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { copilotKeys, isExpired, useMemoryConsent, useProposal } from '../../../../hooks/copilot';
import { Btn } from '../../../v3/primitives';
import { CardFrame } from './CardFrame';
import { initialProposalStatus, parseMemoryAdd } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function MemoryAddCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards');
  const qc = useQueryClient();
  const data = parseMemoryAdd(card.data);
  const consent = useMemoryConsent();
  const proposal = useProposal(data?.proposalId ?? card.id, {
    initial: data ? initialProposalStatus(data.status, isExpired(data.expiresAt)) : 'pending',
  });
  // The server refused an apply for the missing consent (403): ask it, whatever the cache says.
  const [refused, setRefused] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  if (!data) return null;

  // Where the consent applies (GoApply) it is asked when not granted, when the card says it is
  // missing, or after the server refused for it. Elsewhere the catalog has no such consent.
  const needsConsent = consent.required && (consent.granted !== true || refused || (data.consentRequired && consent.granted === null));

  const remember = async () => {
    setCode(null);
    if (needsConsent) {
      const ok = await consent.set(true);
      if (!ok) return;
      setRefused(false);
    }
    const out = await proposal.apply();
    // Saved now, or by an earlier click (the card then shows the closed line): the list in Settings is read again.
    if (out.kind === 'applied' || (out.kind === 'closed' && out.status === 'applied')) void qc.invalidateQueries({ queryKey: copilotKeys.memory() });
    else if (out.kind === 'consent') setRefused(true);
    else if (out.kind === 'failed') setCode(out.code);
  };

  const { status } = proposal;
  const busy = status === 'applying' || consent.saving;
  return (
    <CardFrame card={card} title={t('memory.title')}>
      <p className={styles.fact}>{data.fact}</p>
      {status === 'pending' || status === 'applying' || status === 'failed' ? (
        <>
          {needsConsent ? (
            <div className={styles.consent} data-testid="memory-consent">
              <h4 className={styles.subTitle}>{t('memory.consentTitle')}</h4>
              {consent.loading ? <p className={styles.cardText}>{t('memory.consentLoading')}</p> : null}
              {consent.error ? (
                <p className={styles.alert} role="alert">
                  {t('memory.consentFailed')}
                </p>
              ) : null}
              {consent.item ? (
                <p className={styles.cardText} lang={consent.item.proseLocale === 'zh' ? 'zh-CN' : 'en'}>
                  {consent.item.prose}
                </p>
              ) : null}
            </div>
          ) : null}
          {refused && !consent.required ? (
            // The server asks for a permission this page has no text for: nothing is saved.
            <p className={styles.alert} role="alert" data-testid="memory-consent-refused">
              {t('memory.consentNeeded')}
            </p>
          ) : null}
          {status === 'failed' ? (
            <p className={styles.alert} role="alert">
              {code === 'memory_full' ? t('memory.full') : t('failed')}
            </p>
          ) : null}
          {ctx.turn === 'streaming' && !busy ? (
            <p className={styles.cardText} data-testid="proposal-waiting">
              {t('waitForAnswer')}
            </p>
          ) : proposal.inProgress && !busy ? (
            <p className={styles.cardText} role="status" data-testid="proposal-in-progress">
              {t('inProgress')}
            </p>
          ) : null}
          <div className={styles.cardActions}>
            <Btn variant="primary" disabled={busy || ctx.turn === 'streaming' || (needsConsent && !consent.item)} onClick={() => void remember()}>
              {needsConsent ? t('memory.allow') : t('memory.remember')}
            </Btn>
            <Btn variant="ghost" disabled={busy} onClick={() => void proposal.dismiss()}>
              {t('memory.dontRemember')}
            </Btn>
          </div>
        </>
      ) : null}
      {status === 'applied' ? (
        <p className={styles.cardText} role="status">
          {t('memory.saved')}
        </p>
      ) : null}
      {status === 'dismissed' ? <p className={styles.cardText}>{t('memory.dismissed')}</p> : null}
      {status === 'expired' ? <p className={styles.cardText}>{t('proposalExpired')}</p> : null}
      {status === 'conflict' ? <p className={styles.cardText}>{t('proposalClosed')}</p> : null}
    </CardFrame>
  );
}
