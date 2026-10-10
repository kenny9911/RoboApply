'use client';

// hooks/copilot/useCopilotChat.ts — one Assistant conversation (WP-51;
// ARCHITECTURE.md §5.7 `useCopilot`).
//
//   const chat = useCopilotChat();
//   chat.send('Why do I fit this job?', { chip: 'why_fit' });
//   chat.stop();            // Stop: aborts the stream, keeps the partial answer
//   chat.retry();           // Try again after a retryable error
//   chat.newChat({ jobId }) // New chat (optionally about a job)
//   chat.openThread(id)     // continue a saved thread
//
// A thread is created on the first message, with the job context if any.
// Credits: one `assistant` credit per user turn, charged by the server; a 402
// before the stream opens the out-of-credits sheet (useCreditGate's store)
// and the turn shows a plain notice. The credit summary is refetched after
// every turn so "N left" stays true. A turn that ends in `ai_unavailable`
// (GoApply without AI consent, or no model) hides the AI actions for the rest
// of the session (useCopilotAvailability).

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { createThread, listMessages, sendMessageFeedback, streamTurn } from '../../lib/api/copilot';
import { apiErrorCode, type Items } from '../../lib/api/contracts/wire';
import type { COPILOT_CHIPS, MessageView } from '../../lib/api/contracts/copilot';
import { creditsExhaustedFrom, reportCreditsExhausted } from '../shared/useCreditGate';
import { useInvalidateCredits } from '../shared/useCredits';
import { copilotKeys } from './keys';
import { markAssistantAiUnavailable } from './useCopilotAvailability';
import { INITIAL_CHAT, chatReducer, type ChatMessage } from './turnState';

export type CopilotChip = (typeof COPILOT_CHIPS)[number];

export interface SendOptions {
  chip?: CopilotChip;
}

export interface CopilotChat {
  threadId: string | null;
  /** The job this conversation is about (chips show for it). */
  contextJobId: string | null;
  messages: ChatMessage[];
  /** True while an answer streams. */
  streaming: boolean;
  /** True while a saved thread's messages load. */
  loading: boolean;
  loadError: boolean;
  send: (text: string, opts?: SendOptions) => Promise<void>;
  stop: () => void;
  retry: () => Promise<void>;
  newChat: (opts?: { jobId?: string | null }) => void;
  openThread: (threadId: string, opts?: { jobId?: string | null }) => void;
  feedback: (messageId: string, value: 'up' | 'down', note?: string) => Promise<boolean>;
}

let localSeq = 0;
const localId = (kind: string) => `local:${kind}:${Date.now().toString(36)}:${(localSeq += 1)}`;

/** Codes that mean "nothing more can be done in this chat right now". */
const FINAL_CODES = new Set(['credits_exhausted', 'copilot_budget_exhausted', 'ai_unavailable', 'feature_disabled', 'thread_not_found', 'phone_binding_required']);

export function useCopilotChat(initial: { threadId?: string | null; jobId?: string | null } = {}): CopilotChat {
  const [state, dispatch] = useReducer(chatReducer, { ...INITIAL_CHAT, threadId: initial.threadId ?? null });
  const [contextJobId, setContextJobId] = useState<string | null>(initial.jobId ?? null);
  // A thread whose messages must be read from the server (opened, not created here).
  const [loadThreadId, setLoadThreadId] = useState<string | null>(initial.threadId ?? null);
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const qc = useQueryClient();
  const invalidateCredits = useInvalidateCredits();

  const history = useQuery({
    queryKey: copilotKeys.messages(loadThreadId ?? ''),
    queryFn: ({ signal }) => listMessages(loadThreadId as string, { limit: 100 }, { signal }),
    enabled: !!loadThreadId,
    retry: false,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (loadThreadId && history.data) dispatch({ type: 'load', threadId: loadThreadId, messages: history.data.items });
  }, [loadThreadId, history.data]);

  // Abort a running stream when the conversation unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const runTurn = useCallback(
    async (text: string, opts: SendOptions = {}) => {
      const clean = text.trim();
      if (!clean || stateRef.current.streamingId) return;
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: 'user_sent', text: clean, chip: opts.chip, userId: localId('u'), assistantId: localId('a'), at: new Date().toISOString() });
      try {
        let threadId = stateRef.current.threadId;
        if (!threadId) {
          const thread = await createThread(contextJobId ? { contextJobId } : {}, { signal: controller.signal });
          threadId = thread.id;
          dispatch({ type: 'thread', threadId });
        }
        const outcome = await streamTurn(
          threadId,
          { text: clean, ...(opts.chip ? { chip: opts.chip } : {}), ...(contextJobId ? { contextJobId } : {}) },
          { signal: controller.signal, onEvent: (event) => dispatch({ type: 'event', event }) },
        );
        dispatch({ type: 'outcome', outcome });
        if (outcome.status === 'error' && outcome.code === 'ai_unavailable') markAssistantAiUnavailable();
      } catch (err) {
        if (controller.signal.aborted) {
          dispatch({ type: 'outcome', outcome: { status: 'aborted' } });
        } else {
          const exhausted = creditsExhaustedFrom(err, 'assistant');
          if (exhausted) reportCreditsExhausted(exhausted);
          const code = exhausted ? 'credits_exhausted' : (apiErrorCode(err) ?? 'network_error');
          dispatch({ type: 'failed', error: { code, retryable: !FINAL_CODES.has(code) } });
          if (code === 'ai_unavailable') markAssistantAiUnavailable();
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        void invalidateCredits();
        void qc.invalidateQueries({ queryKey: copilotKeys.threads() });
      }
    },
    [contextJobId, invalidateCredits, qc],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const retry = useCallback(async () => {
    const last = stateRef.current.lastTurn;
    if (!last || stateRef.current.streamingId) return;
    dispatch({ type: 'drop_last_turn' });
    await runTurn(last.text, last.chip ? { chip: last.chip as CopilotChip } : {});
  }, [runTurn]);

  const newChat = useCallback((opts: { jobId?: string | null } = {}) => {
    abortRef.current?.abort();
    setLoadThreadId(null);
    setContextJobId(opts.jobId ?? null);
    dispatch({ type: 'reset' });
  }, []);

  const openThread = useCallback((threadId: string, opts: { jobId?: string | null } = {}) => {
    abortRef.current?.abort();
    setContextJobId(opts.jobId ?? null);
    dispatch({ type: 'reset', threadId });
    setLoadThreadId(threadId);
    // Already read once: show the cached messages at once (the effect only
    // fires when the query's data object changes), then refresh.
    const cached = qc.getQueryData<Items<MessageView>>(copilotKeys.messages(threadId));
    if (cached) dispatch({ type: 'load', threadId, messages: cached.items });
    void qc.invalidateQueries({ queryKey: copilotKeys.messages(threadId) });
  }, [qc]);

  const feedback = useCallback(async (messageId: string, value: 'up' | 'down', note?: string) => {
    const before = stateRef.current.messages.find((m) => m.id === messageId)?.feedback ?? null;
    dispatch({ type: 'feedback', messageId, value });
    try {
      await sendMessageFeedback(messageId, { value, ...(note ? { note } : {}) });
      return true;
    } catch {
      dispatch({ type: 'feedback', messageId, value: before });
      return false;
    }
  }, []);

  return {
    threadId: state.threadId,
    contextJobId,
    messages: state.messages,
    streaming: state.streamingId !== null,
    loading: !!loadThreadId && history.isLoading,
    loadError: !!loadThreadId && history.isError,
    send: runTurn,
    stop,
    retry,
    newChat,
    openThread,
    feedback,
  };
}
