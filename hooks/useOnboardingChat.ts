'use client';

// useOnboardingChat — the NDJSON stream consumer for the Onboarding Chat v4
// (`POST /api/v1/roboapply/v2/onboarding/chat/stream`).
//
// The shared `lib/api/client.ts` wrapper unwraps JSON bodies, so it can't
// stream — this hook raw-fetches instead (the `_real.ts` multipart-bypass
// precedent): `credentials: 'include'`, `API_BASE` prefix, `X-Robo-Locale`
// from the `robo_locale` cookie and the localStorage Bearer fallback (both
// copied from lib/api/client.ts). The body is read via `getReader()` +
// `TextDecoder(stream: true)` with partial-line buffering — a JSON event (or
// a multi-byte CJK codepoint) split across chunk boundaries reassembles
// cleanly.
//
// Under NEXT_PUBLIC_USE_STUB_API (or NODE_ENV=test) the hook consumes the
// stub's `onboardingStreamFake` async generator instead — shape-identical
// events, no backend.
//
// State transitions are a pure reducer over `RAOnboardingStreamEvent`
// (`applyStreamEvent`, exported for tests). Client `state` is an echo of
// server events — no client-side transition logic.

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { API_BASE } from '../lib/config';
import { LOCALE_COOKIE } from '../lib/localeConfig';
import { isStubApi } from '../lib/api/v2';
import { onboardingStreamFake } from '../lib/stub/raV2.stub';
import type {
  OnboardingBootstrapResponse,
  OnboardingChatStreamBody,
  OnboardingDraftPreferences,
  OnboardingJobCard,
  OnboardingSessionResponse,
  RAOnboardingQuickReply,
  RAOnboardingState,
  RAOnboardingStatusKey,
  RAOnboardingStreamEvent,
} from '../lib/api/v2/types';

// ─────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────

/** One transcript item. Job-card stacks live inline in the transcript so a
 *  restored session re-renders rounds in their original positions. */
export type OnboardingChatItem =
  | { kind: 'user'; content: string }
  | { kind: 'assistant'; content: string }
  | { kind: 'cards'; jobs: OnboardingJobCard[] };

export interface OnboardingChatState {
  sessionId: string | null;
  state: RAOnboardingState;
  items: OnboardingChatItem[];
  /** The in-flight assistant text (text-deltas accumulate here; flushed to
   *  `items` on `done`/`error`). */
  streamingText: string;
  isStreaming: boolean;
  draft: OnboardingDraftPreferences;
  /** Every field captured so far (union across turns). */
  captured: string[];
  /** Fields awaiting confirmation — the tray suppresses these (R7). */
  unconfirmed: string[];
  chips: string[];
  quickReplies: RAOnboardingQuickReply[];
  status: RAOnboardingStatusKey | null;
  turnCount: number;
  error: { code: string; message: string } | null;
}

export function createInitialChatState(): OnboardingChatState {
  return {
    sessionId: null,
    state: 'greeting',
    items: [],
    streamingText: '',
    isStreaming: false,
    draft: {},
    captured: [],
    unconfirmed: [],
    chips: [],
    quickReplies: [],
    status: null,
    turnCount: 0,
    error: null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Event reducer (pure — exported for tests)
// ─────────────────────────────────────────────────────────────────────

/** Flush the accumulated streaming text into the transcript. */
function flushStreaming(state: OnboardingChatState): OnboardingChatState {
  if (!state.streamingText) return state;
  return {
    ...state,
    items: [...state.items, { kind: 'assistant', content: state.streamingText }],
    streamingText: '',
  };
}

export function applyStreamEvent(
  state: OnboardingChatState,
  event: RAOnboardingStreamEvent,
): OnboardingChatState {
  switch (event.type) {
    case 'session':
      return { ...state, sessionId: event.sessionId, state: event.state };
    case 'text-delta':
      return {
        ...state,
        streamingText: state.streamingText + event.delta,
        status: null,
      };
    case 'status':
      return { ...state, status: event.key };
    case 'prefs-update': {
      const captured = [...state.captured];
      for (const field of event.captured) {
        if (!captured.includes(field)) captured.push(field);
      }
      return {
        ...state,
        draft: event.draft,
        captured,
        unconfirmed: event.unconfirmed,
      };
    }
    case 'chips':
      return { ...state, chips: event.chips };
    case 'quick-replies':
      return { ...state, quickReplies: event.options };
    case 'job-cards':
      // Cards arrive before the narration text-deltas, so appending here
      // keeps them ahead of the upcoming assistant bubble.
      return {
        ...state,
        items: [...state.items, { kind: 'cards', jobs: event.jobs }],
        status: null,
      };
    case 'state':
      return { ...state, state: event.state };
    case 'done':
      return {
        ...flushStreaming(state),
        isStreaming: false,
        status: null,
        turnCount: event.turnCount,
      };
    case 'error':
      // The catalog apology (if any) was already streamed as text — keep it.
      return {
        ...flushStreaming(state),
        isStreaming: false,
        status: null,
        error: { code: event.code, message: event.message },
      };
    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Local (non-stream) actions
// ─────────────────────────────────────────────────────────────────────

type ChatAction =
  | { type: 'stream-event'; event: RAOnboardingStreamEvent }
  | { type: 'user-message'; content: string }
  | { type: 'stream-failed'; code: string; message: string }
  | { type: 'seed-bootstrap'; bootstrap: OnboardingBootstrapResponse }
  | { type: 'hydrate-session'; session: OnboardingSessionResponse };

function chatReducer(
  state: OnboardingChatState,
  action: ChatAction,
): OnboardingChatState {
  switch (action.type) {
    case 'stream-event':
      return applyStreamEvent(state, action.event);
    case 'user-message':
      return {
        ...state,
        items: [...state.items, { kind: 'user', content: action.content }],
        streamingText: '',
        isStreaming: true,
        chips: [],
        quickReplies: [],
        status: null,
        error: null,
      };
    case 'stream-failed':
      return {
        ...flushStreaming(state),
        isStreaming: false,
        status: null,
        error: { code: action.code, message: action.message },
      };
    case 'seed-bootstrap': {
      const b = action.bootstrap;
      return {
        ...createInitialChatState(),
        sessionId: b.sessionId,
        state: b.state,
        items: [{ kind: 'assistant', content: b.greeting }],
        chips: b.chips,
      };
    }
    case 'hydrate-session': {
      const s = action.session;
      const items: OnboardingChatItem[] = s.transcript.map((m) =>
        m.role === 'user'
          ? { kind: 'user', content: m.content }
          : { kind: 'assistant', content: m.content },
      );
      if (s.surfacedJobs.length > 0) {
        items.push({ kind: 'cards', jobs: s.surfacedJobs });
      }
      return {
        ...createInitialChatState(),
        sessionId: s.sessionId,
        state: s.state,
        items,
        draft: s.draftPreferences,
        captured: s.capturedFields,
        chips: s.chips,
        turnCount: s.turnCount,
      };
    }
    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────
// NDJSON line splitter (exported for tests)
// ─────────────────────────────────────────────────────────────────────

/** The minimal reader surface we need — `ReadableStreamDefaultReader` and
 *  test fakes both satisfy it. */
export interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/**
 * Consume an NDJSON byte stream: decode with `stream: true` (multi-byte
 * codepoints split across chunks reassemble), buffer partial lines, parse one
 * JSON object per line, and flush any unterminated trailing line at EOF.
 * Malformed lines are skipped — a torn write must not kill the stream.
 */
export async function consumeNdjsonStream(
  reader: ByteReader,
  onEvent: (event: RAOnboardingStreamEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  const emit = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEvent(JSON.parse(trimmed) as RAOnboardingStreamEvent);
    } catch {
      // Skip malformed lines.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });
    let newlineAt = buffer.indexOf('\n');
    while (newlineAt >= 0) {
      emit(buffer.slice(0, newlineAt));
      buffer = buffer.slice(newlineAt + 1);
      newlineAt = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  emit(buffer);
}

// ─────────────────────────────────────────────────────────────────────
// Header helpers — copied from lib/api/client.ts (raw fetch can't reuse the
// wrapper, but the auth/locale behavior must match it exactly).
// ─────────────────────────────────────────────────────────────────────

function getLocaleFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${LOCALE_COOKIE}=`));
  if (!match) return null;
  const value = decodeURIComponent(match.slice(LOCALE_COOKIE.length + 1));
  return value || null;
}

function getBearerToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('auth_token');
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// The hook
// ─────────────────────────────────────────────────────────────────────

export interface UseOnboardingChatReturn {
  state: OnboardingChatState;
  /** Send a turn. `quickReplyId` carries the machine id when the turn came
   *  from a quick-reply pill (the label is the transcript `message`). */
  sendMessage: (message: string, quickReplyId?: string) => Promise<void>;
  /** Seed a fresh session from the bootstrap response. */
  seedFromBootstrap: (bootstrap: OnboardingBootstrapResponse) => void;
  /** Hydrate a restored session (GET /onboarding/session). */
  hydrateFromSession: (session: OnboardingSessionResponse) => void;
}

export function useOnboardingChat(): UseOnboardingChatReturn {
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialChatState);
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Abort any in-flight stream when the component unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const seedFromBootstrap = useCallback(
    (bootstrap: OnboardingBootstrapResponse) => {
      dispatch({ type: 'seed-bootstrap', bootstrap });
    },
    [],
  );

  const hydrateFromSession = useCallback(
    (session: OnboardingSessionResponse) => {
      dispatch({ type: 'hydrate-session', session });
    },
    [],
  );

  const sendMessage = useCallback(
    async (message: string, quickReplyId?: string) => {
      const current = stateRef.current;
      const sessionId = current.sessionId;
      const trimmed = message.trim();
      if (!sessionId || !trimmed || current.isStreaming) return;

      dispatch({ type: 'user-message', content: trimmed });

      // ── Stub path: consume the shape-identical fake generator. ──
      if (isStubApi) {
        try {
          for await (const event of onboardingStreamFake(
            sessionId,
            trimmed,
            quickReplyId,
          )) {
            dispatch({ type: 'stream-event', event });
          }
        } catch {
          dispatch({
            type: 'stream-failed',
            code: 'turn_failed',
            message: 'stub stream failed',
          });
        }
        return;
      }

      // ── Real path: raw NDJSON fetch. ──
      const controller = new AbortController();
      abortRef.current = controller;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      const locale = getLocaleFromCookie();
      if (locale) headers['X-Robo-Locale'] = locale;
      const bearer = getBearerToken();
      if (bearer) headers['Authorization'] = `Bearer ${bearer}`;

      const body: OnboardingChatStreamBody = {
        sessionId,
        message: trimmed,
        ...(quickReplyId ? { quickReplyId } : {}),
      };

      try {
        const res = await fetch(
          `${API_BASE}/api/v1/roboapply/v2/onboarding/chat/stream`,
          {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
            cache: 'no-store',
          },
        );

        if (!res.ok) {
          // Pre-stream validation errors arrive as plain JSON envelopes.
          let code = 'turn_failed';
          let msg = `HTTP ${res.status}`;
          try {
            const payload = await res.json();
            if (typeof payload?.code === 'string') code = payload.code;
            if (typeof payload?.error === 'string') msg = payload.error;
          } catch {
            // Non-JSON error body — keep the defaults.
          }
          dispatch({ type: 'stream-failed', code, message: msg });
          return;
        }

        if (!res.body) {
          dispatch({
            type: 'stream-failed',
            code: 'turn_failed',
            message: 'empty response body',
          });
          return;
        }

        await consumeNdjsonStream(res.body.getReader(), (event) => {
          dispatch({ type: 'stream-event', event });
        });
      } catch (err) {
        if (controller.signal.aborted) return; // unmount/abort — stay silent
        dispatch({
          type: 'stream-failed',
          code: 'network_error',
          message: err instanceof Error ? err.message : 'network error',
        });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [],
  );

  return { state, sendMessage, seedFromBootstrap, hydrateFromSession };
}
