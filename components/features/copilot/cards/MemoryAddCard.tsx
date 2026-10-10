'use client';

// memory_add — "Remember this for later chats?" (F-ORION-09). The fact is
// stored only when the user confirms. On GoApply the `copilot_memory`
// consent is asked FIRST, with its exact text: nothing is saved until the
// user allows it (PIPL; WP-51 acceptance). Saved facts are listed and
// deletable in Settings → Assistant.

import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { copilotKeys, isExpired, useMemoryConsent, useProposal } from '../../../../hooks/copilot';
import { Btn } from '../../../v3/primitives';
import { CardFrame } from './CardFrame';
import { parseMemoryAdd } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function MemoryAddCard({ card }: CardProps) {
  const t = useTranslations('assistant.cards');
  const qc = useQueryClient();
  const data = parseMemoryAdd(card.data);
  const consent = useMemoryConsent();
  const proposal = useProposal(data?.proposalId ?? card.id, {
    initial: data?.status === 'applied' ? 'applied' : data?.status === 'dismissed' ? 'dismissed' : data && (data.status === 'expired' || isExpired(data.expiresAt)) ? 'expired' : 'pending',
  });
  if (!data) return null;

  const remember = async () => {
    if (consent.required && consent.granted !== true) {
      const ok = await consent.set(true);
      if (!ok) return;
    }
    const out = await proposal.apply();
    if (out.kind === 'applied') void qc.invalidateQueries({ queryKey: copilotKeys.memory() });
  };

  const { status } = proposal;
  const needsConsent = consent.required && consent.granted !== true;
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
          {status === 'failed' ? (
            <p className={styles.alert} role="alert">
              {t('failed')}
            </p>
          ) : null}
          <div className={styles.cardActions}>
            <Btn variant="primary" disabled={busy || (needsConsent && !consent.item)} onClick={() => void remember()}>
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
    </CardFrame>
  );
}
