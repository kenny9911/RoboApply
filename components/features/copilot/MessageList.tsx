'use client';

// MessageList — the conversation (WP-51; harvests components/chat/MessageBubble
// and components/ui/StreamingText, and renders answers through the sanitized
// Markdown primitive).
//
// Assistant answers: the brand symbol (no name, face or emoji persona), the
// "AI generated" badge on GoApply, streaming text with a cursor, what a tool
// is doing ("Looking up jobs…"), the cards, Stop / error states with Try
// again, and thumbs up/down once the answer is saved. The list is a polite
// log that stays quiet (aria-busy) while text streams.

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

import { runningTool, type ChatMessage } from '../../../hooks/copilot';
import { MessageBubble } from '../../chat/MessageBubble';
import { StreamingText } from '../../ui/StreamingText';
import { Btn, Markdown } from '../../v3/primitives';
import { AiGeneratedBadge } from '../market';
import { AssistantAvatar } from './AssistantAvatar';
import { CopilotCardView, type CardContext } from './cards';
import { MessageFeedback } from './MessageFeedback';
import styles from './copilot.module.css';

const TOOL_KEYS = [
  'search_jobs',
  'top_fit_jobs',
  'added_jobs',
  'get_current_filters',
  'propose_filter_change',
  'analyze_fit',
  'company_insights',
  'find_connections',
  'interview_prep',
  'salary_context',
  'application_summary',
  'get_profile_gaps',
];
const ERROR_KEYS = [
  'credits_exhausted',
  'copilot_budget_exhausted',
  'ai_unavailable',
  'feature_disabled',
  'rate_limited',
  'thread_not_found',
  'content_blocked',
  'phone_binding_required',
  'save_failed',
];

/** The stored "Stopped." notice of a reply the user stopped (the live line is not shown twice). */
function isStoppedNotice(card: { type: string; data: unknown }): boolean {
  return card.type === 'notice' && (card.data as { code?: unknown } | null)?.code === 'stopped';
}

export interface MessageListProps {
  messages: ChatMessage[];
  ctx: CardContext;
  onRetry: () => void;
  onFeedback: (messageId: string, value: 'up' | 'down', note?: string) => Promise<boolean>;
}

function AssistantMessage({ m, isLast, ctx, onRetry, onFeedback }: { m: ChatMessage; isLast: boolean } & Omit<MessageListProps, 'messages'>) {
  const t = useTranslations('assistant');
  const tool = runningTool(m);
  const streaming = m.status === 'streaming';
  // A suggestion can be used once its answer is finished and stored; never from an answer that could not be stored.
  const turn = streaming ? ('streaming' as const) : m.status === 'error' && m.error?.code === 'save_failed' ? ('unsaved' as const) : undefined;
  const cardCtx: CardContext = turn ? { ...ctx, turn } : ctx;
  return (
    <li className={styles.item} data-role="assistant" data-status={m.status}>
      <AssistantAvatar />
      <div className={styles.itemBody}>
        <div className={styles.metaRow}>
          <span>{t('short')}</span>
          <AiGeneratedBadge />
        </div>
        {m.content || !streaming ? (
          m.content ? (
            <MessageBubble role="ai" className={styles.bubble}>
              {streaming ? <StreamingText text={m.content} done={false} /> : <Markdown block>{m.content}</Markdown>}
            </MessageBubble>
          ) : null
        ) : null}
        {streaming && tool ? (
          <p className={styles.status} role="status">
            {t(`tools.${TOOL_KEYS.includes(tool.name) ? tool.name : 'other'}`)}
          </p>
        ) : streaming && !m.content ? (
          <p className={styles.status} role="status">
            {t('message.thinking')}
          </p>
        ) : null}
        {m.cards.map((card) => (
          <CopilotCardView key={card.id} card={card} ctx={cardCtx} />
        ))}
        {m.status === 'stopped' && !m.cards.some(isStoppedNotice) ? <p className={styles.status}>{t('message.stopped')}</p> : null}
        {m.status === 'error' && m.error ? (
          <div className={styles.errorRow}>
            <p className={`${styles.status} ${styles.statusError}`} role="alert">
              {t(`errors.${ERROR_KEYS.includes(m.error.code) ? m.error.code : 'default'}`)}
            </p>
            {m.error.retryable && isLast ? (
              <Btn onClick={onRetry} data-testid="assistant-retry">
                {t('errors.retry')}
              </Btn>
            ) : null}
          </div>
        ) : null}
        {m.status === 'done' && !m.local && (m.content || m.cards.length) ? (
          <MessageFeedback value={m.feedback} onSend={(v, note) => onFeedback(m.id, v, note)} />
        ) : null}
      </div>
    </li>
  );
}

export function MessageList({ messages, ctx, onRetry, onFeedback }: MessageListProps) {
  const t = useTranslations('assistant');
  const endRef = useRef<HTMLLIElement>(null);
  const last = messages[messages.length - 1];
  const busy = last?.status === 'streaming';

  // Keep the newest text in view while it streams.
  useEffect(() => {
    const el = endRef.current;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'end' });
  }, [messages.length, last?.content.length, last?.cards.length]);

  return (
    <ol className={styles.list} role="log" aria-live="polite" aria-busy={busy} aria-label={t('short')}>
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <li key={m.id} className={`${styles.item} ${styles.itemUser}`} data-role="user">
            <div className={styles.itemBody}>
              <MessageBubble role="user" className={styles.bubble}>
                <span className="sr-only">{t('message.you')}: </span>
                <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
              </MessageBubble>
            </div>
          </li>
        ) : (
          <AssistantMessage key={m.id} m={m} isLast={i === messages.length - 1} ctx={ctx} onRetry={onRetry} onFeedback={onFeedback} />
        ),
      )}
      <li ref={endRef} aria-hidden="true" />
    </ol>
  );
}
