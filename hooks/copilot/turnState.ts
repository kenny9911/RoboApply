// hooks/copilot/turnState.ts — the conversation state of one Assistant thread
// as a pure reducer (WP-51), so streaming, Stop, errors and retries are
// unit-tested without React.
//
// One turn = a local user message plus an assistant message that fills as the
// SSE events arrive (`meta` → ids, `delta` → text, `tool` → "Looking up jobs…",
// `card` → cards, `done` / `error` → final status). Stop keeps the partial
// text and marks the message `stopped`.
//
// `done.content` is the reply after the server's guard, i.e. what was stored:
// it REPLACES the streamed text, so the conversation on screen is the one a
// reload shows (a sentence the guard removed does not linger). An error ends
// the turn; `save_failed` (the reply could not be stored, no `done` follows,
// nothing was charged) is retryable like a dropped connection.

import type { CopilotCard, CopilotSseEvent, MessageView } from '../../lib/api/contracts/copilot';
import type { TurnOutcome } from '../../lib/api/copilot';

export type MessageStatus = 'done' | 'streaming' | 'stopped' | 'error';

export interface ToolActivity {
  id: string;
  name: string;
  running: boolean;
  ok?: boolean;
}

export interface TurnError {
  code: string;
  retryable: boolean;
}

export interface ChatMessage {
  /** Server id once known; a local id (`local:…`) until then. */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards: CopilotCard[];
  createdAt: string;
  feedback: 'up' | 'down' | null;
  status: MessageStatus;
  tools: ToolActivity[];
  error: TurnError | null;
  /** True while the id is local (no feedback can be sent yet). */
  local: boolean;
}

export interface ChatState {
  threadId: string | null;
  messages: ChatMessage[];
  /** Id of the assistant message being streamed, or null. */
  streamingId: string | null;
  /** The text of the last user turn (for Try again). */
  lastTurn: { text: string; chip?: string } | null;
}

export const INITIAL_CHAT: ChatState = { threadId: null, messages: [], streamingId: null, lastTurn: null };

/**
 * Error codes that always offer "Try again", whatever the event's flag says:
 * the reply was not stored (`save_failed`: no `done` follows and the turn was
 * not charged) or the stream broke before it ended.
 */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set(['save_failed', 'stream_interrupted']);

export type ChatAction =
  | { type: 'reset'; threadId?: string | null }
  | { type: 'load'; threadId: string; messages: MessageView[] }
  | { type: 'cards'; threadId: string; messages: MessageView[] }
  | { type: 'user_sent'; text: string; chip?: string; userId: string; assistantId: string; at: string }
  | { type: 'thread'; threadId: string }
  | { type: 'event'; event: CopilotSseEvent }
  | { type: 'outcome'; outcome: TurnOutcome }
  | { type: 'failed'; error: TurnError }
  | { type: 'feedback'; messageId: string; value: 'up' | 'down' | null }
  | { type: 'drop_last_turn' };

/** Server messages → chat messages, oldest first. Pure. */
export function fromServer(messages: readonly MessageView[]): ChatMessage[] {
  return [...messages]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content ?? '',
      cards: Array.isArray(m.cards) ? m.cards : [],
      createdAt: m.createdAt,
      feedback: m.feedback ?? null,
      status: 'done' as const,
      tools: [],
      error: null,
      local: false,
    }));
}

function updateStreaming(state: ChatState, fn: (m: ChatMessage) => ChatMessage): ChatState {
  if (!state.streamingId) return state;
  return { ...state, messages: state.messages.map((m) => (m.id === state.streamingId ? fn(m) : m)) };
}

function applyEvent(state: ChatState, event: CopilotSseEvent): ChatState {
  switch (event.event) {
    case 'meta': {
      const { threadId, messageId } = event.data;
      const next = updateStreaming({ ...state, threadId }, (m) => ({ ...m, id: messageId, local: false }));
      return { ...next, streamingId: state.streamingId ? messageId : null };
    }
    case 'delta':
      return updateStreaming(state, (m) => ({ ...m, content: m.content + event.data.text }));
    case 'tool':
      return updateStreaming(state, (m) => {
        const { id, name, phase, ok } = event.data;
        const exists = m.tools.some((t) => t.id === id);
        const tools = exists
          ? m.tools.map((t) => (t.id === id ? { ...t, running: phase === 'start', ...(ok !== undefined ? { ok } : {}) } : t))
          : [...m.tools, { id, name, running: phase === 'start', ...(ok !== undefined ? { ok } : {}) }];
        return { ...m, tools };
      });
    case 'card':
      return updateStreaming(state, (m) => {
        const card = event.data;
        const at = m.cards.findIndex((c) => c.id === card.id);
        const cards = at === -1 ? [...m.cards, card] : m.cards.map((c, i) => (i === at ? card : c));
        return { ...m, cards };
      });
    case 'error': {
      const next = updateStreaming(state, (m) => ({
        ...m,
        status: 'error',
        tools: m.tools.map((t) => ({ ...t, running: false })),
        error: { code: event.data.code, retryable: event.data.retryable || RETRYABLE_CODES.has(event.data.code) },
      }));
      return { ...next, streamingId: null };
    }
    case 'done': {
      const id = event.data.messageId;
      const final = event.data.content;
      const next = updateStreaming(state, (m) => ({
        ...m,
        id,
        local: false,
        status: 'done',
        // The guarded reply replaces whatever streamed (older servers send no content: keep the stream).
        ...(typeof final === 'string' ? { content: final } : {}),
        tools: m.tools.map((t) => ({ ...t, running: false })),
      }));
      return { ...next, streamingId: null };
    }
    default:
      return state;
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return { ...INITIAL_CHAT, threadId: action.threadId ?? null };
    case 'load':
      // Never replace a conversation that is streaming.
      if (state.streamingId) return state;
      return { ...state, threadId: action.threadId, messages: fromServer(action.messages) };
    case 'cards': {
      // The stored cards of the answers already on screen (a result an earlier click left in the
      // thread shows up). Nothing else changes: local messages and the streaming answer stay.
      if (state.threadId !== action.threadId) return state;
      const stored = new Map(action.messages.map((m) => [m.id, m.cards] as const));
      return {
        ...state,
        messages: state.messages.map((m) => {
          const cards = stored.get(m.id);
          return m.role === 'assistant' && m.id !== state.streamingId && Array.isArray(cards) ? { ...m, cards } : m;
        }),
      };
    }
    case 'thread':
      return { ...state, threadId: action.threadId };
    case 'user_sent': {
      const base = { cards: [], createdAt: action.at, feedback: null, tools: [], error: null, local: true };
      return {
        ...state,
        streamingId: action.assistantId,
        lastTurn: { text: action.text, ...(action.chip ? { chip: action.chip } : {}) },
        messages: [
          ...state.messages,
          { ...base, id: action.userId, role: 'user', content: action.text, status: 'done' },
          { ...base, id: action.assistantId, role: 'assistant', content: '', status: 'streaming' },
        ],
      };
    }
    case 'event':
      return applyEvent(state, action.event);
    case 'outcome': {
      const o = action.outcome;
      if (!state.streamingId) return state;
      if (o.status === 'aborted') {
        const next = updateStreaming(state, (m) => ({ ...m, status: 'stopped', tools: m.tools.map((t) => ({ ...t, running: false })) }));
        return { ...next, streamingId: null };
      }
      if (o.status === 'incomplete') {
        const next = updateStreaming(state, (m) => ({ ...m, status: 'error', error: { code: 'stream_interrupted', retryable: true } }));
        return { ...next, streamingId: null };
      }
      // done / error normally arrive as events first; this closes the turn either way.
      if (o.status === 'done') {
        return applyEvent(state, {
          event: 'done',
          data: { messageId: o.messageId, usage: { inputTokens: 0, outputTokens: 0 }, creditsRemaining: o.creditsRemaining, ...(o.content !== undefined ? { content: o.content } : {}) },
        });
      }
      return applyEvent(state, { event: 'error', data: { code: o.code, message: o.message, retryable: o.retryable } });
    }
    case 'failed': {
      const next = updateStreaming(state, (m) => ({ ...m, status: 'error', error: action.error }));
      return { ...next, streamingId: null };
    }
    case 'feedback':
      return { ...state, messages: state.messages.map((m) => (m.id === action.messageId ? { ...m, feedback: action.value } : m)) };
    case 'drop_last_turn': {
      // Try again: remove the failed answer and the question it answered.
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant' && last.status !== 'streaming') msgs.pop();
      if (msgs[msgs.length - 1]?.role === 'user') msgs.pop();
      return { ...state, messages: msgs };
    }
    default:
      return state;
  }
}

/** True while any tool of the message is running. Pure. */
export function runningTool(m: ChatMessage): ToolActivity | null {
  for (let i = m.tools.length - 1; i >= 0; i -= 1) if (m.tools[i].running) return m.tools[i];
  return null;
}
