// hooks/copilot — the conversation reducer, proposal helpers, the
// one-nudge-per-session rule, and parity with the server contract (WP-51).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  INITIAL_CHAT,
  __resetNudges,
  chatReducer,
  clearAssistantNudge,
  fromServer,
  isExpired,
  markNudgeShown,
  offerAssistantNudge,
  proposalFailure,
  runningTool,
  type ChatState,
} from './index';
import { RoboApiError } from '../../lib/api/client';
import { COPILOT_MEMORY_MAX, SendMessageBodySchema, COPILOT_CHIPS } from '../../server/src/features/copilot/contract';
import { MEMORY_MAX } from '../../components/features/copilot/SettingsSection';
import { COMPOSER_MAX } from '../../components/features/copilot/Composer';
import { ASK_CHIPS } from '../../components/features/copilot/ChipBar';

const sent = (s: ChatState = INITIAL_CHAT) =>
  chatReducer(s, { type: 'user_sent', text: 'Why do I fit?', chip: 'why_fit', userId: 'local:u', assistantId: 'local:a', at: '2026-10-10T10:00:00.000Z' });

describe('chatReducer', () => {
  it('adds the user message and a streaming answer', () => {
    const s = sent();
    expect(s.streamingId).toBe('local:a');
    expect(s.lastTurn).toEqual({ text: 'Why do I fit?', chip: 'why_fit' });
    expect(s.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'streaming'],
    ]);
  });

  it('meta sets the thread and the server id; deltas append; done finishes', () => {
    let s = sent();
    s = chatReducer(s, { type: 'event', event: { event: 'meta', data: { threadId: 'th_1', messageId: 'msg_1' } } });
    expect(s.threadId).toBe('th_1');
    expect(s.streamingId).toBe('msg_1');
    s = chatReducer(s, { type: 'event', event: { event: 'delta', data: { text: 'Your Go ' } } });
    s = chatReducer(s, { type: 'event', event: { event: 'delta', data: { text: 'work lines up.' } } });
    s = chatReducer(s, { type: 'event', event: { event: 'done', data: { messageId: 'msg_1', usage: { inputTokens: 1, outputTokens: 1 }, creditsRemaining: 3 } } });
    const a = s.messages[1];
    expect(a).toMatchObject({ id: 'msg_1', content: 'Your Go work lines up.', status: 'done', local: false });
    expect(s.streamingId).toBeNull();
  });

  it('tracks tool activity and replaces a card with the same id', () => {
    let s = sent();
    s = chatReducer(s, { type: 'event', event: { event: 'tool', data: { id: 't1', name: 'search_jobs', phase: 'start' } } });
    expect(runningTool(s.messages[1])?.name).toBe('search_jobs');
    s = chatReducer(s, { type: 'event', event: { event: 'tool', data: { id: 't1', name: 'search_jobs', phase: 'end', ok: true } } });
    expect(runningTool(s.messages[1])).toBeNull();
    s = chatReducer(s, { type: 'event', event: { event: 'card', data: { type: 'notice', id: 'c1', data: { code: 'rate_limited' } } } });
    s = chatReducer(s, { type: 'event', event: { event: 'card', data: { type: 'notice', id: 'c1', data: { code: 'ai_unavailable' } } } });
    expect(s.messages[1].cards).toEqual([{ type: 'notice', id: 'c1', data: { code: 'ai_unavailable' } }]);
  });

  it('Stop keeps the partial text and marks it stopped', () => {
    let s = sent();
    s = chatReducer(s, { type: 'event', event: { event: 'delta', data: { text: 'Partial' } } });
    s = chatReducer(s, { type: 'outcome', outcome: { status: 'aborted' } });
    expect(s.messages[1]).toMatchObject({ content: 'Partial', status: 'stopped' });
    expect(s.streamingId).toBeNull();
  });

  it('error event and incomplete streams are errors (retryable as the server says)', () => {
    let s = chatReducer(sent(), { type: 'event', event: { event: 'error', data: { code: 'content_blocked', message: '', retryable: false } } });
    expect(s.messages[1].error).toEqual({ code: 'content_blocked', retryable: false });
    s = chatReducer(sent(), { type: 'outcome', outcome: { status: 'incomplete' } });
    expect(s.messages[1].error).toEqual({ code: 'stream_interrupted', retryable: true });
  });

  it('a failure before streaming marks the answer failed', () => {
    const s = chatReducer(sent(), { type: 'failed', error: { code: 'credits_exhausted', retryable: false } });
    expect(s.messages[1]).toMatchObject({ status: 'error', error: { code: 'credits_exhausted', retryable: false } });
  });

  it('drop_last_turn removes the failed answer and its question', () => {
    let s = chatReducer(sent(), { type: 'failed', error: { code: 'network_error', retryable: true } });
    s = chatReducer(s, { type: 'drop_last_turn' });
    expect(s.messages).toEqual([]);
  });

  it('load never replaces a streaming conversation, and sorts oldest first', () => {
    const streaming = sent();
    expect(chatReducer(streaming, { type: 'load', threadId: 'x', messages: [] })).toBe(streaming);
    const loaded = chatReducer(INITIAL_CHAT, {
      type: 'load',
      threadId: 'th',
      messages: [
        { id: 'b', role: 'assistant', content: 'B', cards: [], createdAt: '2026-10-10T10:01:00.000Z', feedback: 'up' },
        { id: 'a', role: 'user', content: 'A', cards: [], createdAt: '2026-10-10T10:00:00.000Z', feedback: null },
      ],
    });
    expect(loaded.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(loaded.messages[1].feedback).toBe('up');
  });

  it('feedback updates one message', () => {
    const s = chatReducer({ ...INITIAL_CHAT, messages: fromServer([{ id: 'm', role: 'assistant', content: 'x', cards: [], createdAt: 'z', feedback: null }]) }, { type: 'feedback', messageId: 'm', value: 'down' });
    expect(s.messages[0].feedback).toBe('down');
  });
});

describe('proposal helpers', () => {
  const err = (code: string, details?: unknown) => new RoboApiError(code, { code, status: 409, payload: { code, details } });

  it('maps server errors', () => {
    expect(proposalFailure(err('proposal_expired'))).toEqual({ kind: 'expired' });
    expect(proposalFailure(err('conflict', { reason: 'proposal_expired' }))).toEqual({ kind: 'expired' });
    expect(proposalFailure(err('conflict', { reason: 'version_conflict', version: 4 }))).toEqual({ kind: 'conflict', details: { reason: 'version_conflict', version: 4 } });
    // The server's own shape: code version_conflict, details { currentVersion, card }.
    expect(proposalFailure(err('version_conflict', { currentVersion: 4, card: null }))).toEqual({ kind: 'conflict', details: { currentVersion: 4, card: null } });
    // Already used or dismissed: closed, not a version conflict.
    expect(proposalFailure(err('conflict', { reason: 'proposal_closed', status: 'applied' }))).toEqual({ kind: 'closed' });
    // GoApply memory without the consent: ask it; the proposal stays pending.
    expect(proposalFailure(err('forbidden', { reason: 'copilot_memory_consent_required', consent: 'copilot_memory' }))).toEqual({ kind: 'consent' });
    expect(proposalFailure(err('conflict', { reason: 'memory_full', max: 50 }))).toEqual({ kind: 'failed', code: 'memory_full' });
    expect(proposalFailure(err('credits_exhausted'))).toEqual({ kind: 'credits' });
    expect(proposalFailure(err('ai_unavailable'))).toEqual({ kind: 'failed', code: 'ai_unavailable' });
    expect(proposalFailure(new Error('x'))).toEqual({ kind: 'failed', code: null });
  });

  it('isExpired', () => {
    expect(isExpired(null)).toBe(false);
    expect(isExpired('2026-10-10T00:00:00.000Z', Date.parse('2026-10-11T00:00:00.000Z'))).toBe(true);
    expect(isExpired('2026-10-12T00:00:00.000Z', Date.parse('2026-10-11T00:00:00.000Z'))).toBe(false);
  });
});

describe('nudges: at most one per session', () => {
  beforeEach(() => __resetNudges());
  afterEach(() => __resetNudges());

  it('queues one, refuses a second while waiting and after one was shown', () => {
    expect(offerAssistantNudge({ kind: 'low_rating' })).toBe(true);
    expect(offerAssistantNudge({ kind: 'pay_filter' })).toBe(false);
    markNudgeShown();
    clearAssistantNudge();
    expect(offerAssistantNudge({ kind: 'pay_filter' })).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(offerAssistantNudge({ kind: 'win_back' as never })).toBe(false);
  });
});

describe('parity with the server contract', () => {
  it('memory cap, message length and chips', () => {
    expect(MEMORY_MAX).toBe(COPILOT_MEMORY_MAX);
    expect(SendMessageBodySchema.safeParse({ text: 'x'.repeat(COMPOSER_MAX) }).success).toBe(true);
    expect(SendMessageBodySchema.safeParse({ text: 'x'.repeat(COMPOSER_MAX + 1) }).success).toBe(false);
    for (const chip of ASK_CHIPS) expect(COPILOT_CHIPS).toContain(chip);
  });
});
