// streamTurn — the Assistant's SSE-over-fetch reader (lib/api/copilot.ts, WP-51).
// Partial chunks (an event cut anywhere, a multi-byte character cut in half,
// CRLF line ends), heartbeat comments, the error event, unknown and malformed
// events, abort (Stop), a dropped stream, and an HTTP error before streaming.
// WP-93 #1: `done.content` (the reply after the server's guard) replaces the
// streamed text; `save_failed` (no `done` follows) ends the turn retryable.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getNudge, streamTurn, toCopilotEvent } from '../../lib/api/copilot';
import { INITIAL_CHAT, RETRYABLE_CODES, chatReducer, type ChatState } from './turnState';
import type { CopilotSseEvent } from '../../lib/api/contracts/copilot';
import { RoboApiError } from '../../lib/api/client';
import { apiErrorCode } from '../../lib/api/contracts/wire';
import { fail, installFetch, ok, pieces, sse, streamResponse } from '../../components/features/copilot/__tests__/testkit';

const PATH = '/api/v1/roboapply/copilot/threads/th_1/messages';

const TURN =
  sse('meta', { threadId: 'th_1', messageId: 'msg_1' }) +
  ': ping\n\n' +
  sse('tool', { id: 't1', name: 'search_jobs', phase: 'start' }) +
  sse('tool', { id: 't1', name: 'search_jobs', phase: 'end', ok: true }) +
  sse('card', { type: 'job_list', id: 'c1', data: { items: [] } }) +
  sse('delta', { text: '两份工作 ' }) +
  ': ping\n\n' +
  sse('delta', { text: 'fit your search.' }) +
  sse('done', { messageId: 'msg_1', usage: { inputTokens: 10, outputTokens: 20 }, creditsRemaining: 29 });

async function run(chunks: Array<string | Uint8Array>, signal?: AbortSignal) {
  installFetch({ [`POST ${PATH}`]: (c) => streamResponse(chunks, { signal: c.signal }) });
  const events: CopilotSseEvent[] = [];
  const outcome = await streamTurn('th_1', { text: 'hi' }, { onEvent: (e) => events.push(e), signal });
  return { events, outcome };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamTurn', () => {
  it('delivers every event in order and resolves done', async () => {
    const { events, outcome } = await run([TURN]);
    expect(events.map((e) => e.event)).toEqual(['meta', 'tool', 'tool', 'card', 'delta', 'delta', 'done']);
    expect(outcome).toEqual({ status: 'done', messageId: 'msg_1', creditsRemaining: 29 });
  });

  it.each([1, 2, 3, 7, 13, 64])('survives events cut into %i-character chunks', async (size) => {
    const { events, outcome } = await run(pieces(TURN, size));
    expect(events.map((e) => e.event)).toEqual(['meta', 'tool', 'tool', 'card', 'delta', 'delta', 'done']);
    const text = events.filter((e) => e.event === 'delta').map((e) => (e as { data: { text: string } }).data.text).join('');
    expect(text).toBe('两份工作 fit your search.');
    expect(outcome.status).toBe('done');
  });

  it('survives a multi-byte character split across two network chunks', async () => {
    const bytes = new TextEncoder().encode(sse('delta', { text: '已为你' }) + sse('done', { messageId: 'm', usage: {}, creditsRemaining: null }));
    // Cut inside the first CJK character (3 bytes in UTF-8).
    const cut = new TextEncoder().encode('event: delta\ndata: {"text":"').length + 1;
    const { events } = await run([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(events[0]).toEqual({ event: 'delta', data: { text: '已为你' } });
  });

  it('accepts CRLF line endings', async () => {
    const crlf = TURN.replace(/\n/g, '\r\n');
    const { events, outcome } = await run(pieces(crlf, 5));
    expect(events).toHaveLength(7);
    expect(outcome.status).toBe('done');
  });

  it('skips heartbeat comments only streams', async () => {
    const { events, outcome } = await run([': ping\n\n', ': ping\n\n', sse('done', { messageId: 'm', usage: {}, creditsRemaining: null })]);
    expect(events.map((e) => e.event)).toEqual(['done']);
    expect(outcome).toEqual({ status: 'done', messageId: 'm', creditsRemaining: null });
  });

  it('resolves the server error event and ignores anything after it', async () => {
    const { events, outcome } = await run([
      sse('delta', { text: 'Part of' }),
      sse('error', { code: 'content_blocked', message: 'blocked', retryable: false }),
      sse('delta', { text: ' more' }),
    ]);
    expect(events.map((e) => e.event)).toEqual(['delta', 'error']);
    expect(outcome).toEqual({ status: 'error', code: 'content_blocked', message: 'blocked', retryable: false });
  });

  it('drops unknown and malformed events', async () => {
    const { events } = await run([
      sse('progress', { pct: 50 }),
      'event: delta\ndata: not json\n\n',
      sse('delta', { nope: true }),
      sse('tool', { id: 't', name: 'x', phase: 'middle' }),
      sse('card', { id: 'no-type' }),
      sse('delta', { text: 'ok' }),
    ]);
    expect(events).toEqual([{ event: 'delta', data: { text: 'ok' } }]);
  });

  it('a stream that closes without done or error is incomplete', async () => {
    const { outcome } = await run([sse('delta', { text: 'half' })]);
    expect(outcome).toEqual({ status: 'incomplete' });
  });

  it('Stop (abort) resolves aborted and keeps what arrived', async () => {
    const controller = new AbortController();
    installFetch({ [`POST ${PATH}`]: (c) => streamResponse([sse('delta', { text: 'partial' })], { signal: c.signal, hold: true }) });
    const events: CopilotSseEvent[] = [];
    const pending = streamTurn('th_1', { text: 'hi' }, { onEvent: (e) => events.push(e), signal: controller.signal });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    controller.abort();
    await expect(pending).resolves.toEqual({ status: 'aborted' });
    expect(events[0]).toEqual({ event: 'delta', data: { text: 'partial' } });
  });

  it('rejects with the platform error before streaming (402 credits_exhausted)', async () => {
    installFetch({ [`POST ${PATH}`]: () => fail(402, 'credits_exhausted', { bucket: 'assistant', resetsAt: '2026-10-11T00:00:00.000Z' }) });
    const err = await streamTurn('th_1', { text: 'hi' }, { onEvent: () => undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoboApiError);
    expect(apiErrorCode(err)).toBe('credits_exhausted');
  });

  it('posts the turn body as JSON with Accept: text/event-stream', async () => {
    const http = installFetch({ [`POST ${PATH}`]: () => streamResponse([sse('done', { messageId: 'm', usage: {}, creditsRemaining: 1 })]) });
    await streamTurn('th_1', { text: 'Why do I fit?', chip: 'why_fit', contextJobId: 'job_1' }, { onEvent: () => undefined });
    expect(http.calls[0].body).toEqual({ text: 'Why do I fit?', chip: 'why_fit', contextJobId: 'job_1' });
    expect(http.calls[0].headers.Accept).toBe('text/event-stream');
  });
});

describe('done.content and save_failed (the server contract of a finished turn)', () => {
  /** Run a stream through streamTurn AND the conversation reducer, the way useCopilotChat does. */
  async function converse(chunks: string[]) {
    installFetch({ [`POST ${PATH}`]: (c) => streamResponse(chunks, { signal: c.signal }) });
    let state: ChatState = chatReducer(INITIAL_CHAT, { type: 'user_sent', text: 'What does it pay?', userId: 'local:u', assistantId: 'local:a', at: '2026-10-10T10:00:00.000Z' });
    const outcome = await streamTurn('th_1', { text: 'What does it pay?' }, { onEvent: (event) => (state = chatReducer(state, { type: 'event', event })) });
    state = chatReducer(state, { type: 'outcome', outcome });
    return { state, outcome, answer: state.messages[1]! };
  }

  it('done.content replaces the streamed text (a sentence the guard removed does not stay on screen)', async () => {
    const { answer, outcome, state } = await converse([
      sse('meta', { threadId: 'th_1', messageId: 'msg_1' }),
      sse('delta', { text: 'The role pays $250,000. ' }),
      sse('delta', { text: 'It is remote.' }),
      sse('done', { messageId: 'msg_1', usage: { inputTokens: 5, outputTokens: 9 }, creditsRemaining: 28, content: 'No source found for that number. It is remote.', guarded: true }),
    ]);
    expect(outcome).toEqual({ status: 'done', messageId: 'msg_1', creditsRemaining: 28, content: 'No source found for that number. It is remote.' });
    expect(answer).toMatchObject({ id: 'msg_1', status: 'done', local: false, content: 'No source found for that number. It is remote.' });
    expect(answer.content).not.toContain('$250,000');
    expect(state.streamingId).toBeNull();
  });

  it('an empty done.content is a real answer (cards only): the streamed text is cleared', async () => {
    const { answer } = await converse([
      sse('delta', { text: 'Here are jobs.' }),
      sse('card', { type: 'job_list', id: 'c1', data: { items: [] } }),
      sse('done', { messageId: 'msg_2', usage: {}, creditsRemaining: 3, content: '' }),
    ]);
    expect(answer.content).toBe('');
    expect(answer.cards).toHaveLength(1);
    expect(answer.status).toBe('done');
  });

  it('a done without content (an older server) keeps what streamed', async () => {
    const { answer, outcome } = await converse([sse('delta', { text: 'Kept as streamed.' }), sse('done', { messageId: 'msg_3', usage: {}, creditsRemaining: null })]);
    expect(outcome).toEqual({ status: 'done', messageId: 'msg_3', creditsRemaining: null });
    expect(answer.content).toBe('Kept as streamed.');
  });

  it('toCopilotEvent passes content and guarded through, and drops a non-string content', () => {
    expect(toCopilotEvent({ event: 'done', data: { messageId: 'm', content: 'Final.', guarded: false } })).toEqual({
      event: 'done',
      data: { messageId: 'm', usage: { inputTokens: 0, outputTokens: 0 }, creditsRemaining: null, content: 'Final.', guarded: false },
    });
    expect(toCopilotEvent({ event: 'done', data: { messageId: 'm', content: { html: '<b>x</b>' } } })!.data).not.toHaveProperty('content');
  });

  it('save_failed: the turn ends as a retryable error (no done follows) and the streamed text stays readable', async () => {
    const { answer, outcome, state } = await converse([
      sse('meta', { threadId: 'th_1', messageId: 'msg_9' }),
      sse('delta', { text: 'Your SQL work lines up.' }),
      sse('error', { code: 'save_failed', message: 'The reply could not be saved. Try again.', retryable: true }),
    ]);
    expect(outcome).toEqual({ status: 'error', code: 'save_failed', message: 'The reply could not be saved. Try again.', retryable: true });
    expect(answer).toMatchObject({ status: 'error', error: { code: 'save_failed', retryable: true }, content: 'Your SQL work lines up.' });
    expect(state.streamingId).toBeNull();
    // Try again drops the unsaved answer and its question, ready to resend.
    expect(state.lastTurn).toEqual({ text: 'What does it pay?' });
    expect(chatReducer(state, { type: 'drop_last_turn' }).messages).toEqual([]);
  });

  it('save_failed is retryable even if the event forgets to say so; nothing after it is read', async () => {
    const { answer, outcome } = await converse([
      sse('error', { code: 'save_failed', message: '' }),
      sse('done', { messageId: 'never', usage: {}, creditsRemaining: 1, content: 'ignored' }),
    ]);
    expect(outcome.status).toBe('error');
    expect(answer.error).toEqual({ code: 'save_failed', retryable: true });
    expect(answer.content).toBe('');
    expect(RETRYABLE_CODES.has('save_failed')).toBe(true);
    // A final error keeps the server's word.
    const blocked = chatReducer(
      chatReducer(INITIAL_CHAT, { type: 'user_sent', text: 'x', userId: 'u', assistantId: 'a', at: 'z' }),
      { type: 'event', event: { event: 'error', data: { code: 'content_blocked', message: '', retryable: false } } },
    );
    expect(blocked.messages[1]!.error).toEqual({ code: 'content_blocked', retryable: false });
  });
});

describe('getNudge', () => {
  it('reads GET /copilot/nudge', async () => {
    const http = installFetch({ 'GET /api/v1/roboapply/copilot/nudge': () => ok({ nudge: { kind: 'pay_filter', prompt: 'Add a minimum pay to my search.', facts: {} } }) });
    await expect(getNudge()).resolves.toEqual({ nudge: { kind: 'pay_filter', prompt: 'Add a minimum pay to my search.', facts: {} } });
    expect(http.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/roboapply/copilot/nudge']);
  });
});

describe('toCopilotEvent', () => {
  it('fills defaults on error and done', () => {
    expect(toCopilotEvent({ event: 'error', data: {} })).toEqual({ event: 'error', data: { code: 'stream_error', message: '', retryable: false } });
    expect(toCopilotEvent({ event: 'done', data: { messageId: 'm' } })).toEqual({
      event: 'done',
      data: { messageId: 'm', usage: { inputTokens: 0, outputTokens: 0 }, creditsRemaining: null },
    });
  });

  it('rejects non-object data and missing ids', () => {
    expect(toCopilotEvent({ event: 'delta', data: 'x' })).toBeNull();
    expect(toCopilotEvent({ event: 'meta', data: { threadId: 't' } })).toBeNull();
    expect(toCopilotEvent({ event: 'done', data: {} })).toBeNull();
  });
});
