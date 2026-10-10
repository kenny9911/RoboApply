'use client';

// ThreadList — saved chats, newest first, with "Remove chat" (asks first).

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { useArchiveThread, useThreads } from '../../../hooks/copilot';
import type { ThreadView } from '../../../lib/api/contracts/copilot';
import { Btn, IconTrash } from '../../v3/primitives';
import { shortDate } from '../feed';
import styles from './copilot.module.css';

export interface ThreadListProps {
  currentId: string | null;
  onOpen: (thread: ThreadView) => void;
  /** Called after the open thread was removed. */
  onRemovedCurrent?: () => void;
}

export function ThreadList({ currentId, onOpen, onRemovedCurrent }: ThreadListProps) {
  const t = useTranslations('assistant.threads');
  const locale = useLocale();
  const threads = useThreads();
  const archive = useArchiveThread();
  const [confirming, setConfirming] = useState<string | null>(null);

  if (threads.isError) {
    return (
      <div className={styles.panel}>
        <p className={styles.alert} role="alert">
          {t('loadFailed')}
        </p>
        <Btn onClick={() => void threads.refetch()}>{t('retry')}</Btn>
      </div>
    );
  }
  if (!threads.data) return null;
  if (threads.data.length === 0) return <p className={styles.muted}>{t('empty')}</p>;

  return (
    <ul className={styles.threadList} aria-label={t('title')} data-testid="assistant-threads">
      {threads.data.map((th) => {
        const title = th.title?.trim() || t('untitled');
        const date = shortDate(th.updatedAt, locale);
        return (
          <li key={th.id}>
            <div className={styles.threadRow} data-current={th.id === currentId}>
              <button type="button" className={styles.threadOpen} aria-current={th.id === currentId ? 'true' : undefined} onClick={() => onOpen(th)}>
                <span className={styles.threadTitle}>{title}</span>
                {date ? <span className={styles.threadDate}>{t('updated', { date })}</span> : null}
              </button>
              <button type="button" className={styles.iconBtn} aria-label={t('removeAria', { title })} title={t('remove')} onClick={() => setConfirming(th.id)}>
                <IconTrash size={16} />
              </button>
            </div>
            {confirming === th.id ? (
              <div className={styles.confirm} role="group" aria-label={t('removeConfirm')}>
                <span>{t('removeConfirm')}</span>
                <Btn
                  variant="primary"
                  onClick={() => {
                    setConfirming(null);
                    archive.mutate(th.id, { onSuccess: () => (th.id === currentId ? onRemovedCurrent?.() : undefined) });
                  }}
                >
                  {t('removeYes')}
                </Btn>
                <Btn variant="ghost" onClick={() => setConfirming(null)}>
                  {t('removeNo')}
                </Btn>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
