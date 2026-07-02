'use client';

// OnboardingChat — the S1–S4 conversation container. Renders the message
// list (MessageBubble + sanitized Markdown), the live streaming bubble
// (StreamingText), inline job-card stacks, the status shimmer, the captured
// preference tray, the chip row (suggestion chips + machine-id quick
// replies), the composer (pre-filled with the editable LLM opening prompt on
// turn 0), and the wrap CTA. All state is driven by `useOnboardingChat`'s
// stream events — the server owns every transition; this component only
// echoes it (page-flow rule in the design spec §9.1).

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { MessageBubble } from '../../chat/MessageBubble';
import { StreamingText } from '../../ui/StreamingText';
import { Markdown } from '../primitives/Markdown';
import { IconArrow, IconBolt } from '../primitives/Iconset';
import { raV2Api } from '../../../lib/api/v2';
import type {
  IngestRow,
  OnboardingJobCard as OnboardingJobCardData,
  RAAggressiveness,
  RAOnboardingQuickReply,
} from '../../../lib/api/v2/types';
import type { UseOnboardingChatReturn } from '../../../hooks/useOnboardingChat';
import { ChipRow } from './ChipRow';
import { IngestRecap } from './IngestRecap';
import { JobCardStack } from './JobCardStack';
import { PreferenceTray } from './PreferenceTray';

/** Quick-reply ids that short-circuit the wrap straight to /complete —
 *  the aggressiveness pills never round-trip through the chat (E10). */
const AGGRESSIVENESS_IDS: ReadonlySet<string> = new Set([
  'manual',
  'balanced',
  'aggressive',
]);

interface Props {
  chat: UseOnboardingChatReturn;
  /** Real ingest rows (null while the bootstrap is in flight → skeleton). */
  ingestRows: IngestRow[] | null;
  /** LLM opener in the user's voice — pre-fills the composer on turn 0. */
  openingPrompt: string | null;
  /** Pass-state rehydrated from a restored session. */
  initialPassedJobIds?: string[];
  /** True when this chat was restored from a previous session. */
  restored?: boolean;
  onComplete: (aggressiveness: RAAggressiveness) => void;
  completing: boolean;
}

export function OnboardingChat({
  chat,
  ingestRows,
  openingPrompt,
  initialPassedJobIds,
  restored = false,
  onComplete,
  completing,
}: Props) {
  const t = useTranslations('onboarding.chat');
  const { state, sendMessage } = chat;

  const [composer, setComposer] = useState('');
  const composerTouched = useRef(false);
  const [savedJobIds, setSavedJobIds] = useState<string[]>([]);
  const [passedJobIds, setPassedJobIds] = useState<string[]>(
    initialPassedJobIds ?? [],
  );
  const listRef = useRef<HTMLDivElement>(null);

  // Pre-fill the composer with the opening prompt once it arrives — only on
  // turn 0 and only while the user hasn't typed anything themselves.
  useEffect(() => {
    if (
      openingPrompt &&
      !composerTouched.current &&
      state.turnCount === 0 &&
      composer === ''
    ) {
      setComposer(openingPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openingPrompt, state.turnCount]);

  // Keep the transcript pinned to the bottom as content streams in.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [state.items.length, state.streamingText, state.status]);

  function handleSend(text?: string) {
    const message = (text ?? composer).trim();
    // No session yet (bootstrap still in flight / failed) → bail BEFORE
    // clearing the composer, or the user's typed text is silently destroyed.
    if (!message || !state.sessionId || state.isStreaming || completing) return;
    setComposer('');
    composerTouched.current = false;
    void sendMessage(message);
  }

  function handleQuickReply(option: RAOnboardingQuickReply) {
    if (state.isStreaming || completing) return;
    // Aggressiveness at wrap short-circuits straight to complete (E10).
    if (state.state === 'wrap' && AGGRESSIVENESS_IDS.has(option.id)) {
      onComplete(option.id as RAAggressiveness);
      return;
    }
    void sendMessage(option.label, option.id);
  }

  function handleEditField(fieldLabel: string) {
    composerTouched.current = true;
    setComposer(t('tray_edit_prefix', { field: fieldLabel }));
  }

  function handleSave(job: OnboardingJobCardData) {
    setSavedJobIds((cur) => (cur.includes(job.id) ? cur : [...cur, job.id]));
    raV2Api.jobs.save(job.id).catch(() => {
      // Roll the optimistic flag back so the user can retry.
      setSavedJobIds((cur) => cur.filter((id) => id !== job.id));
    });
  }

  function handlePass(job: OnboardingJobCardData) {
    if (!state.sessionId) return;
    setPassedJobIds((cur) => (cur.includes(job.id) ? cur : [...cur, job.id]));
    raV2Api.onboarding
      .pass({ sessionId: state.sessionId, jobId: job.id })
      .catch(() => {
        setPassedJobIds((cur) => cur.filter((id) => id !== job.id));
      });
  }

  function retryLastTurn() {
    const lastUser = [...state.items]
      .reverse()
      .find((item) => item.kind === 'user');
    if (lastUser && lastUser.kind === 'user') {
      void sendMessage(lastUser.content);
    }
  }

  const errorNotice = state.error
    ? state.error.code === 'session_superseded' ||
      state.error.code === 'session_not_active'
      ? // Both mean this session can never accept another turn — a Retry
        // button here could never succeed.
        { text: t('superseded_notice'), retry: false }
      : state.error.code === 'session_daily_limit'
        ? { text: t('error_daily_limit'), retry: false }
        : { text: t('error_turn_failed'), retry: true }
    : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        textAlign: 'left',
        width: '100%',
        maxWidth: 760,
        flex: 1,
        minHeight: 0,
      }}
    >
      {restored ? (
        <div
          style={{
            fontSize: 12.5,
            color: 'var(--muted)',
            fontFamily: 'var(--mono)',
          }}
        >
          {t('restore_notice')}
        </div>
      ) : null}

      <IngestRecap rows={ingestRows} />

      {/* ── Transcript ── */}
      <div
        ref={listRef}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          overflowY: 'auto',
          flex: 1,
          minHeight: 180,
          paddingRight: 4,
        }}
      >
        {state.items.map((item, i) => {
          if (item.kind === 'cards') {
            return (
              <JobCardStack
                key={`cards-${i}`}
                jobs={item.jobs}
                savedJobIds={savedJobIds}
                passedJobIds={passedJobIds}
                onSave={handleSave}
                onPass={handlePass}
              />
            );
          }
          return (
            <MessageBubble
              key={`msg-${i}`}
              role={item.kind === 'user' ? 'user' : 'ai'}
            >
              {item.kind === 'assistant' ? (
                <Markdown block>{item.content}</Markdown>
              ) : (
                item.content
              )}
            </MessageBubble>
          );
        })}

        {state.streamingText ? (
          <MessageBubble role="ai">
            <StreamingText text={state.streamingText} done={false} />
          </MessageBubble>
        ) : null}

        {state.status ? (
          <div
            role="status"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12.5,
              color: 'var(--muted)',
              fontFamily: 'var(--mono)',
            }}
          >
            <div className="spinner" style={{ width: 12, height: 12 }} />
            {t(`status_${state.status}`)}
          </div>
        ) : null}

        {errorNotice ? (
          <p role="alert" style={{ color: 'var(--warn)', fontSize: 13, margin: 0 }}>
            {errorNotice.text}
            {errorNotice.retry ? (
              <button
                type="button"
                className="btn ghost"
                style={{ marginLeft: 10, fontSize: 12, padding: '4px 10px' }}
                onClick={retryLastTurn}
              >
                {t('error_retry')}
              </button>
            ) : null}
          </p>
        ) : null}
      </div>

      <ChipRow
        chips={state.chips}
        quickReplies={state.quickReplies}
        disabled={!state.sessionId || state.isStreaming || completing}
        onChip={(text) => handleSend(text)}
        onQuickReply={handleQuickReply}
      />

      <PreferenceTray
        draft={state.draft}
        captured={state.captured}
        unconfirmed={state.unconfirmed}
        onEditField={handleEditField}
      />

      {/* ── Wrap CTA ── */}
      {state.state === 'wrap' ? (
        <button
          type="button"
          className="btn primary"
          disabled={completing}
          style={{ alignSelf: 'flex-start' }}
          onClick={() => onComplete('balanced')}
        >
          {t('wrap_cta')} <IconBolt size={14} />
        </button>
      ) : null}

      {/* ── Composer ── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
        <textarea
          className="intent-input"
          style={{ minHeight: 64, flex: 1 }}
          value={composer}
          placeholder={t('composer_placeholder')}
          aria-label={t('composer_placeholder')}
          onChange={(e) => {
            composerTouched.current = true;
            setComposer(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          type="button"
          className="btn primary"
          disabled={!state.sessionId || state.isStreaming || completing || !composer.trim()}
          onClick={() => handleSend()}
        >
          {t('send')} <IconArrow size={14} />
        </button>
      </div>
      {state.turnCount === 0 && openingPrompt ? (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
          {t('opening_prompt_hint')}
        </p>
      ) : null}
    </div>
  );
}
