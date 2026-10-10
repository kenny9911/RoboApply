'use client';

// CopilotThread — one Assistant conversation view, shared by the rail and the
// full page (WP-51): toolbar (New chat · Chats · What you can ask), the
// per-job chips, the message list with cards, and the composer.
//
// The conversation state lives in the caller (`useCopilotChat`), so closing
// the rail never loses the chat. Nothing is sent without the user pressing
// Send: prompts from the cheatsheet, nudges or other pages only fill the box.
//
// `canAsk` false (no AI consent, AI unavailable this session, or still
// checking): the AI actions — composer, chips, prompt list — are not shown;
// saved chats and the conversation so far stay readable.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { CopilotChat } from '../../../hooks/copilot';
import { cn } from '../../../lib/utils';
import { IconChat, IconHistory, IconInfo } from '../../v3/primitives';
import { ChipBar } from './ChipBar';
import { Cheatsheet } from './Cheatsheet';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { ThreadList } from './ThreadList';
import styles from './copilot.module.css';

export type ThreadView = 'chat' | 'threads' | 'cheatsheet';

export interface CopilotThreadProps {
  chat: CopilotChat;
  variant: 'rail' | 'page';
  /** Text to put in the box; a new `seq` replaces the box content. */
  prefill?: { text: string; seq: number } | null;
  /** Called before something in the thread navigates away. */
  onNavigate?: () => void;
  /** Extra toolbar items (the rail's "Open full page", "Hide the floating button"). */
  toolbarExtra?: ReactNode;
  /** The user may ask (useCopilotAvailability). False hides every AI action. Default true. */
  canAsk?: boolean;
  /** Still checking whether the user may ask: no notice yet. */
  checking?: boolean;
}

export function CopilotThread({ chat, variant, prefill, onNavigate, toolbarExtra, canAsk = true, checking = false }: CopilotThreadProps) {
  const t = useTranslations('assistant');
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<ThreadView>('chat');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!prefill) return;
    setDraft(prefill.text);
    setView('chat');
  }, [prefill]);

  const focusInput = () => {
    // After the view switches back to the chat.
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const pick = (text: string) => {
    setDraft(text);
    setView('chat');
    focusInput();
  };

  const send = () => {
    const text = draft;
    setDraft('');
    void chat.send(text);
  };

  const empty = chat.messages.length === 0 && !chat.loading;
  const inRail = variant === 'rail';

  return (
    <div className={cn(styles.thread, !inRail && styles.threadPage)} data-variant={variant}>
      <div className={styles.toolbar} role="toolbar" aria-label={t('short')}>
        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => {
            chat.newChat();
            setDraft('');
            setView('chat');
            focusInput();
          }}
          data-testid="assistant-new-chat"
        >
          <IconChat size={15} />
          {t('toolbar.newChat')}
        </button>
        {inRail ? (
          <button type="button" className={styles.toolBtn} aria-pressed={view === 'threads'} onClick={() => setView(view === 'threads' ? 'chat' : 'threads')}>
            <IconHistory size={15} />
            {t('toolbar.chats')}
          </button>
        ) : null}
        {canAsk ? (
          <button type="button" className={styles.toolBtn} aria-pressed={view === 'cheatsheet'} onClick={() => setView(view === 'cheatsheet' ? 'chat' : 'cheatsheet')} data-testid="assistant-cheatsheet-toggle">
            <IconInfo size={15} />
            {t('toolbar.cheatsheet')}
          </button>
        ) : null}
        <span className={styles.spacer} />
        {toolbarExtra}
      </div>

      {view === 'threads' ? (
        <ThreadList
          currentId={chat.threadId}
          onOpen={(th) => {
            chat.openThread(th.id, { jobId: th.contextJobId });
            setView('chat');
          }}
          onRemovedCurrent={() => chat.newChat()}
        />
      ) : null}

      {view === 'cheatsheet' && canAsk ? <Cheatsheet onPick={pick} wide={!inRail} /> : null}

      {view === 'chat' || (view === 'cheatsheet' && !canAsk) ? (
        <>
          {chat.contextJobId && canAsk ? (
            <ChipBar jobId={chat.contextJobId} disabled={chat.streaming} onAsk={(text, chip) => void chat.send(text, { chip })} onNavigate={onNavigate} />
          ) : null}
          {chat.loading ? <p className={styles.muted}>{t('message.loading')}</p> : null}
          {chat.loadError ? (
            <p className={styles.alert} role="alert">
              {t('errors.loadFailed')}
            </p>
          ) : null}
          {empty ? (
            <>
              {canAsk ? (
                <>
                  <div className={styles.empty}>
                    <h3 className={styles.emptyTitle}>{t('empty.title')}</h3>
                    <p className={styles.emptyBody}>{t('empty.body')}</p>
                  </div>
                  <Cheatsheet onPick={pick} wide={!inRail} />
                </>
              ) : null}
            </>
          ) : (
            <MessageList messages={chat.messages} ctx={{ prefill: pick, onNavigate }} onRetry={() => void chat.retry()} onFeedback={chat.feedback} />
          )}
          {canAsk ? (
            <Composer ref={inputRef} value={draft} onChange={setDraft} onSend={send} onStop={chat.stop} streaming={chat.streaming} />
          ) : checking ? null : (
            <p className={styles.muted} role="status" data-testid="assistant-cannot-ask">
              {t('cannotAsk')}
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}

/** The rail's link to the full page. */
export function FullPageLink({ onNavigate, threadId }: { onNavigate?: () => void; threadId: string | null }) {
  const t = useTranslations('assistant.toolbar');
  const href = threadId ? `/assistant?thread=${encodeURIComponent(threadId)}` : '/assistant';
  return (
    <Link href={href} className={styles.toolBtn} onClick={onNavigate}>
      {t('fullPage')}
    </Link>
  );
}
