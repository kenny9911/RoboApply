// useOnboardingChat — unit tests for the two pure pieces of the NDJSON
// consumer: the byte-stream line splitter (`consumeNdjsonStream`) and the
// stream-event reducer (`applyStreamEvent`).
//
// The splitter tests deliberately tear JSON objects across chunk boundaries —
// including a multi-byte CJK character split mid-codepoint — because that is
// exactly what a real network stream does and what the stub's async-generator
// fake can never exercise.

import { describe, it, expect } from 'vitest';

import {
  applyStreamEvent,
  consumeNdjsonStream,
  createInitialChatState,
  type ByteReader,
} from '../../hooks/useOnboardingChat';
import type {
  OnboardingJobCard,
  RAOnboardingStreamEvent,
} from '../../lib/api/v2/types';

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function readerFromChunks(chunks: Uint8Array[]): ByteReader {
  let i = 0;
  return {
    read: async () =>
      i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true },
  };
}

async function collect(
  chunks: Uint8Array[],
): Promise<RAOnboardingStreamEvent[]> {
  const events: RAOnboardingStreamEvent[] = [];
  await consumeNdjsonStream(readerFromChunks(chunks), (e) => events.push(e));
  return events;
}

const enc = new TextEncoder();

function makeCard(id: string, external = false): OnboardingJobCard {
  return {
    id,
    title: 'Senior Backend Engineer',
    companyName: 'Acme',
    companyLogoUrl: null,
    location: 'Taipei, TW',
    workType: 'remote',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    postedAt: null,
    isBookmarked: false,
    matchScoreCached: 82,
    matchScore: 82,
    whyMatched: 'Strong overlap.',
    source: external ? 'jsearch' : 'internal',
    ...(external
      ? { sourcePublisher: 'LinkedIn', applyUrl: 'https://example.com/j' }
      : {}),
    isExternal: external,
  };
}

// ─────────────────────────────────────────────────────────────────────
// consumeNdjsonStream — reader path
// ─────────────────────────────────────────────────────────────────────

describe('consumeNdjsonStream', () => {
  it('parses one event per line across a single chunk', async () => {
    const wire =
      '{"type":"session","sessionId":"s1","state":"elicitation"}\n' +
      '{"type":"done","turnCount":3}\n';
    const events = await collect([enc.encode(wire)]);
    expect(events).toEqual([
      { type: 'session', sessionId: 's1', state: 'elicitation' },
      { type: 'done', turnCount: 3 },
    ]);
  });

  it('reassembles a JSON object split across chunk boundaries', async () => {
    const wire = '{"type":"text-delta","delta":"Got it — remote it is."}\n';
    const bytes = enc.encode(wire);
    // Tear in the middle of the JSON object (inside the delta string).
    const splitAt = wire.indexOf('remote');
    const events = await collect([
      bytes.slice(0, splitAt),
      bytes.slice(splitAt),
    ]);
    expect(events).toEqual([
      { type: 'text-delta', delta: 'Got it — remote it is.' },
    ]);
  });

  it('reassembles a multi-byte CJK character split mid-codepoint', async () => {
    const delta = '已收到您的偏好,馬上找職缺';
    const wire = `{"type":"text-delta","delta":"${delta}"}\n`;
    const bytes = enc.encode(wire);
    // '已' is a 3-byte UTF-8 codepoint starting right after the ASCII prefix;
    // split one byte INTO it so each chunk holds a torn codepoint.
    const prefixBytes = enc.encode('{"type":"text-delta","delta":"').length;
    const splitAt = prefixBytes + 1;
    const events = await collect([
      bytes.slice(0, splitAt),
      bytes.slice(splitAt),
    ]);
    expect(events).toEqual([{ type: 'text-delta', delta }]);
  });

  it('handles many events torn arbitrarily across many chunks', async () => {
    const wire =
      '{"type":"session","sessionId":"s1","state":"greeting"}\n' +
      '{"type":"prefs-update","draft":{"workModes":["remote"]},"captured":["workModes"],"unconfirmed":[]}\n' +
      '{"type":"chips","chips":["遠端職缺","Show me jobs now"]}\n' +
      '{"type":"done","turnCount":1}\n';
    const bytes = enc.encode(wire);
    // 7-byte chunks tear lines AND codepoints at arbitrary offsets.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) {
      chunks.push(bytes.slice(i, i + 7));
    }
    const events = await collect(chunks);
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'prefs-update',
      'chips',
      'done',
    ]);
    expect(events[2]).toEqual({
      type: 'chips',
      chips: ['遠端職缺', 'Show me jobs now'],
    });
  });

  it('flushes an unterminated trailing line at EOF', async () => {
    const wire = '{"type":"done","turnCount":2}'; // no trailing newline
    const events = await collect([enc.encode(wire)]);
    expect(events).toEqual([{ type: 'done', turnCount: 2 }]);
  });

  it('skips malformed lines without killing the stream', async () => {
    const wire =
      '{"type":"session","sessionId":"s1","state":"greeting"}\n' +
      '{not json}\n' +
      '\n' +
      '{"type":"done","turnCount":1}\n';
    const events = await collect([enc.encode(wire)]);
    expect(events.map((e) => e.type)).toEqual(['session', 'done']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// applyStreamEvent — one case per event type
// ─────────────────────────────────────────────────────────────────────

describe('applyStreamEvent', () => {
  it('session: sets sessionId and state', () => {
    const next = applyStreamEvent(createInitialChatState(), {
      type: 'session',
      sessionId: 's9',
      state: 'elicitation',
    });
    expect(next.sessionId).toBe('s9');
    expect(next.state).toBe('elicitation');
  });

  it('text-delta: accumulates streaming text and clears the status shimmer', () => {
    let state = createInitialChatState();
    state = applyStreamEvent(state, { type: 'status', key: 'scoring' });
    state = applyStreamEvent(state, { type: 'text-delta', delta: 'Hello ' });
    state = applyStreamEvent(state, { type: 'text-delta', delta: 'there' });
    expect(state.streamingText).toBe('Hello there');
    expect(state.status).toBeNull();
  });

  it('status: sets the shimmer key', () => {
    const next = applyStreamEvent(createInitialChatState(), {
      type: 'status',
      key: 'searching_external',
    });
    expect(next.status).toBe('searching_external');
  });

  it('prefs-update: replaces the draft, unions captured, replaces unconfirmed', () => {
    let state = createInitialChatState();
    state = applyStreamEvent(state, {
      type: 'prefs-update',
      draft: { targetRoles: ['Senior PM'] },
      captured: ['targetRoles'],
      unconfirmed: [],
    });
    state = applyStreamEvent(state, {
      type: 'prefs-update',
      draft: {
        targetRoles: ['Senior PM'],
        salary: { min: 150000, currency: 'USD', period: 'year' },
      },
      captured: ['salary'],
      unconfirmed: ['salary'],
    });
    expect(state.captured).toEqual(['targetRoles', 'salary']);
    expect(state.unconfirmed).toEqual(['salary']);
    expect(state.draft.salary?.currency).toBe('USD');

    // A later confirming update clears the unconfirmed list.
    state = applyStreamEvent(state, {
      type: 'prefs-update',
      draft: state.draft,
      captured: [],
      unconfirmed: [],
    });
    expect(state.unconfirmed).toEqual([]);
  });

  it('chips: replaces the chip row', () => {
    let state = applyStreamEvent(createInitialChatState(), {
      type: 'chips',
      chips: ['a', 'b'],
    });
    state = applyStreamEvent(state, { type: 'chips', chips: ['c'] });
    expect(state.chips).toEqual(['c']);
  });

  it('quick-replies: replaces the option set', () => {
    const next = applyStreamEvent(createInitialChatState(), {
      type: 'quick-replies',
      options: [{ id: 'no_preference', label: 'No preference' }],
    });
    expect(next.quickReplies).toEqual([
      { id: 'no_preference', label: 'No preference' },
    ]);
  });

  it('job-cards: appends a cards transcript item', () => {
    const cards = [makeCard('j1'), makeCard('j2', true)];
    const next = applyStreamEvent(createInitialChatState(), {
      type: 'job-cards',
      jobs: cards,
    });
    expect(next.items).toEqual([{ kind: 'cards', jobs: cards }]);
  });

  it('state: echoes the server state', () => {
    const next = applyStreamEvent(createInitialChatState(), {
      type: 'state',
      state: 'wrap',
    });
    expect(next.state).toBe('wrap');
  });

  it('done: flushes streaming text into an assistant message and stops streaming', () => {
    let state = { ...createInitialChatState(), isStreaming: true };
    state = applyStreamEvent(state, { type: 'text-delta', delta: 'All set.' });
    state = applyStreamEvent(state, { type: 'done', turnCount: 4 });
    expect(state.items).toEqual([{ kind: 'assistant', content: 'All set.' }]);
    expect(state.streamingText).toBe('');
    expect(state.isStreaming).toBe(false);
    expect(state.turnCount).toBe(4);
  });

  it('done with no accumulated text adds no empty assistant message', () => {
    const next = applyStreamEvent(
      { ...createInitialChatState(), isStreaming: true },
      { type: 'done', turnCount: 1 },
    );
    expect(next.items).toEqual([]);
  });

  it('error: keeps any streamed apology text and records the machine code', () => {
    let state = { ...createInitialChatState(), isStreaming: true };
    state = applyStreamEvent(state, {
      type: 'text-delta',
      delta: 'Sorry — that turn failed on my side.',
    });
    state = applyStreamEvent(state, {
      type: 'error',
      code: 'turn_failed',
      message: 'chat agent failed',
    });
    expect(state.items).toEqual([
      { kind: 'assistant', content: 'Sorry — that turn failed on my side.' },
    ]);
    expect(state.error).toEqual({
      code: 'turn_failed',
      message: 'chat agent failed',
    });
    expect(state.isStreaming).toBe(false);
  });
});
