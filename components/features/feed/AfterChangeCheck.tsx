'use client';

// components/features/feed/AfterChangeCheck.tsx — "Looks better / Not quite"
// after the Assistant changed the saved search (PRODUCT F-FEED-09).
//
// The Assistant (WP-51) records the change with `noteAssistantFilterChange()`
// (hooks/feed) after the user confirmed it. On the next /jobs view this card
// asks once (through the popup gate). "Not quite" puts the previous filters
// back in one PATCH; "Looks better" keeps them.

import { useTranslations } from 'next-intl';

import { Btn, toast } from '../../v3/primitives';
import { clearAssistantFilterChange, useAssistantFilterChange } from '../../../hooks/feed/useCalibration';
import { usePopupGate } from '../../../lib/ui/popupGate';
import { useProposalApply } from './useProposalApply';
import styles from './feed.module.css';

export function AfterChangeCheck() {
  const t = useTranslations('jobs.afterChange');
  const change = useAssistantFilterChange();
  const proposal = useProposalApply();
  const { granted } = usePopupGate('feed:afterChange', 'survey', { enabled: change !== null });
  if (!change || !granted) return null;

  const better = () => {
    clearAssistantFilterChange();
    toast({ message: t('thanks'), tone: 'ok' });
  };

  const notQuite = async () => {
    const result = await proposal.replace(change.before, change.searchProfileId);
    clearAssistantFilterChange();
    toast(result === 'saved' ? { message: t('reverted'), tone: 'ok' } : { message: t('revertFailed'), tone: 'warn' });
  };

  return (
    <section className={styles.prompt} aria-label={t('title')} data-testid="after-change">
      <h2 className={styles.promptTitle}>{t('title')}</h2>
      <div className={styles.row}>
        <Btn variant="primary" className={styles.actionBtn} onClick={better}>
          {t('better')}
        </Btn>
        <Btn className={styles.actionBtn} disabled={proposal.isPending} onClick={() => void notQuite()}>
          {t('notQuite')}
        </Btn>
      </div>
    </section>
  );
}
