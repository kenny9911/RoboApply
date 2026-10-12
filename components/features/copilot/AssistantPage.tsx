'use client';

// AssistantPage — /assistant, the Assistant full page (PRODUCT_PLAN.md §3.4;
// on a phone this IS the full-screen Assistant). Saved chats on the left
// (a "Chats" toggle below 1000px), the conversation on the right.
//
//   /assistant?thread=<id>   continue a chat
//   /assistant?job=<id>      start a chat about a job (chips show)
//
// With the `copilot` capability off there is no Assistant: a plain notice,
// no conversation and no API calls. On GoApply the user's AI consent is
// checked first (useCopilotAvailability, fails closed): nothing renders while
// unknown, and with it off the page says so and links to the privacy
// settings. After an `ai_unavailable` turn the conversation stays readable
// without the composer and chips.

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import Link from 'next/link';

import { useCopilotAvailability, useCopilotChat } from '../../../hooks/copilot';
import { useCapabilities } from '../../../lib/flags';
import { cn } from '../../../lib/utils';
import { EmptyState } from '../../v3/primitives';
import { AssistantAvatar } from './AssistantAvatar';
import { CopilotThread } from './CopilotThread';
import { ThreadList } from './ThreadList';
import styles from './copilot.module.css';

function AssistantWorkspace({ threadId, jobId, canAsk }: { threadId: string | null; jobId: string | null; canAsk: boolean }) {
  const t = useTranslations('assistant');
  const chat = useCopilotChat({ threadId, jobId });
  const [showChats, setShowChats] = useState(false);
  const applied = useRef(`${threadId ?? ''}|${jobId ?? ''}`);

  // A new ?thread / ?job (client navigation) switches the conversation.
  useEffect(() => {
    const key = `${threadId ?? ''}|${jobId ?? ''}`;
    if (key === applied.current) return;
    applied.current = key;
    if (threadId) chat.openThread(threadId, { jobId });
    else chat.newChat({ jobId });
    // chat callbacks are stable
  }, [threadId, jobId]);

  return (
    <div className={styles.page} data-testid="assistant-page">
      <aside className={cn(styles.pageAside, !showChats && styles.pageAsideHidden)} aria-label={t('threads.title')}>
        <h2 className={styles.panelTitle}>{t('threads.title')}</h2>
        <ThreadList
          currentId={chat.threadId}
          onOpen={(th) => {
            chat.openThread(th.id, { jobId: th.contextJobId });
            setShowChats(false);
          }}
          onRemovedCurrent={() => chat.newChat()}
        />
      </aside>
      <div className={styles.pageMain}>
        <div className={styles.pageHead}>
          <AssistantAvatar size={18} />
          <h1 className={styles.pageTitle}>{t('name')}</h1>
        </div>
        <CopilotThread
          chat={chat}
          variant="page"
          canAsk={canAsk}
          toolbarExtra={
            <button type="button" className={cn(styles.toolBtn, 'min-[1001px]:hidden')} aria-pressed={showChats} onClick={() => setShowChats((s) => !s)}>
              {t('toolbar.chats')}
            </button>
          }
        />
      </div>
    </div>
  );
}

export function AssistantPage() {
  const t = useTranslations('assistant.page');
  const params = useSearchParams();
  const availability = useCopilotAvailability();
  const { status } = useCapabilities();
  if (!availability.capability) {
    if (status === 'loading') return null;
    return (
      <div className={styles.page}>
        <EmptyState title={t('unavailable')} />
      </div>
    );
  }
  if (availability.loading) return null;
  if (!availability.canAsk && !availability.blocked) {
    return (
      <div className={styles.page} data-testid="assistant-unavailable">
        {availability.consentOff ? (
          <EmptyState
            title={t('aiOff')}
            action={
              <Link href="/settings#consents" className={styles.link}>
                {t('aiOffLink')}
              </Link>
            }
          />
        ) : (
          <EmptyState title={t('unavailable')} />
        )}
      </div>
    );
  }
  return <AssistantWorkspace threadId={params?.get('thread') ?? null} jobId={params?.get('job') ?? null} canAsk={availability.canAsk} />;
}

export default AssistantPage;
