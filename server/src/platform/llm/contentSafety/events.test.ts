// @vitest-environment node
//
// WP-24: RAContentSafetyEvent rows and the excerpt policy (hash + ≤200 characters).

import { afterEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn(async () => ({}));
vi.mock('../../../lib/prisma.js', () => ({ default: { rAContentSafetyEvent: { create } } }));

import {
  EXCERPT_MAX_CHARS,
  buildContentSafetyEvent,
  excerptOf,
  recordContentSafetyEvent,
  setContentSafetyEventWriter,
  sha256Hex,
} from './events.js';
import { goapplyCtx } from './__tests__/fixtures.js';

afterEach(() => {
  setContentSafetyEventWriter(null);
  vi.unstubAllEnvs();
  create.mockClear();
});

describe('excerptOf', () => {
  it('keeps at most 200 code points and never splits an emoji', () => {
    const text = '😀'.repeat(500);
    const e = excerptOf(text);
    expect(Array.from(e)).toHaveLength(EXCERPT_MAX_CHARS);
    expect(e).toBe('😀'.repeat(200));
  });

  it('centres on the hit with 60 characters of lead, clamped to the end', () => {
    const text = 'a'.repeat(300) + 'HIT' + 'b'.repeat(300);
    const e = excerptOf(text, 300);
    expect(e.startsWith('a'.repeat(60) + 'HIT')).toBe(true);
    const tail = excerptOf('x'.repeat(250) + 'END', 251);
    expect(tail.endsWith('END')).toBe(true);
    expect(Array.from(tail)).toHaveLength(200);
  });

  it('converts UTF-16 offsets to code points and blanks control characters', () => {
    const text = '😀'.repeat(300) + 'X' + 'y'.repeat(300);
    expect(excerptOf(text, 600).startsWith('😀'.repeat(60) + 'X')).toBe(true);
    // Short texts are kept whole.
    expect(excerptOf('😀'.repeat(10) + 'X', 20)).toBe('😀'.repeat(10) + 'X');
    expect(excerptOf('a\u0000b\nc')).toBe('a b c');
    expect(excerptOf('short', 0)).toBe('short');
  });
});

describe('buildContentSafetyEvent', () => {
  it('defaults: pass → reason clean; error → its cause; missing task → unknown; surface capped at 64', () => {
    const pass = buildContentSafetyEvent({ stage: 'input', text: 'hi', ctx: goapplyCtx({ callId: undefined, userId: undefined }), verdict: 'pass' });
    expect(pass).toEqual({
      brand: 'goapply',
      userId: null,
      surface: 'copilot',
      direction: 'input',
      verdict: 'pass',
      provider: null,
      matched: { reason: 'clean', labels: [], textSha256: sha256Hex('hi'), textLength: 2 },
    });
    const err = buildContentSafetyEvent({ stage: 'output', text: 'x', ctx: goapplyCtx({ task: '' }), verdict: 'error', cause: 'timeout', provider: 'p' });
    expect(err).toMatchObject({ surface: 'unknown', provider: 'p', matched: { reason: 'timeout', callId: 'call_1' } });
    expect(err.matched).not.toHaveProperty('excerpt');
    const unknownErr = buildContentSafetyEvent({ stage: 'output', text: 'x', ctx: goapplyCtx(), verdict: 'error' });
    expect(unknownErr.matched.reason).toBe('provider_error');
    const long = buildContentSafetyEvent({ stage: 'input', text: 'x', ctx: goapplyCtx({ task: 't'.repeat(100) }), verdict: 'pass' });
    expect(long.surface).toHaveLength(64);
  });

  it('a provider block without a reason is recorded as provider_label with an excerpt', () => {
    const row = buildContentSafetyEvent({
      stage: 'output',
      text: 'z'.repeat(1000),
      ctx: goapplyCtx(),
      verdict: 'block',
      result: { verdict: 'block', labels: ['abuse'], provider: 'aliyun_green' },
    });
    expect(row.matched).toMatchObject({ reason: 'provider_label', labels: ['abuse'], textLength: 1000 });
    expect(row.matched.excerpt).toHaveLength(200);
    expect(row.matched.excerptAnchor).toBe('text_start');
    expect(row.provider).toBe('aliyun_green');
  });

  it('anchors: centred on a known hit; at the slice start (marked approximate) when only the slice is known', () => {
    const text = 'a'.repeat(2000) + 'b'.repeat(500) + 'HIT' + 'c'.repeat(1497);
    const hit = buildContentSafetyEvent({
      stage: 'output',
      text,
      ctx: goapplyCtx(),
      verdict: 'review',
      result: { verdict: 'review', labels: ['ad'], provider: 'aliyun_green', hitOffset: 2500 },
    });
    expect(hit.matched).toMatchObject({ excerptAnchor: 'hit' });
    expect(hit.matched).not.toHaveProperty('slice');
    expect(hit.matched.excerpt).toBe('b'.repeat(60) + 'HIT' + 'c'.repeat(137));

    const slice = buildContentSafetyEvent({
      stage: 'output',
      text,
      ctx: goapplyCtx(),
      verdict: 'block',
      result: { verdict: 'block', labels: ['abuse'], provider: 'aliyun_green', hitOffset: 2000, hitSlice: { index: 1, start: 2000, length: 2000 } },
    });
    expect(slice.matched).toMatchObject({ excerptAnchor: 'slice_start', slice: { index: 1, length: 2000 } });
    // The excerpt is the slice's first 200 characters, not 60 characters of the previous slice.
    expect(slice.matched.excerpt).toBe('b'.repeat(200));
    expect(JSON.stringify(slice)).not.toContain('"start"');
  });
});

describe('writers', () => {
  const row = buildContentSafetyEvent({ stage: 'input', text: '文本', ctx: goapplyCtx(), verdict: 'block', result: { verdict: 'block', labels: ['k'], provider: 'keyword_only', reason: 'keyword' } });

  it('under Vitest the default writer never touches the database', async () => {
    await recordContentSafetyEvent(row);
    expect(create).not.toHaveBeenCalled();
  });

  it('outside tests the default writer creates a typed RAContentSafetyEvent row', async () => {
    vi.stubEnv('VITEST', '');
    await recordContentSafetyEvent(row);
    expect(create).toHaveBeenCalledWith({
      data: {
        brand: 'goapply',
        userId: 'user_cn_1',
        surface: 'copilot',
        direction: 'input',
        verdict: 'block',
        provider: 'keyword_only',
        matched: {
          reason: 'keyword',
          labels: ['k'],
          textSha256: sha256Hex('文本'),
          textLength: 2,
          excerpt: '文本',
          excerptAnchor: 'text_start',
          callId: 'call_1',
        },
      },
    });
  });

  it('pass rows are written without being awaited; failures are logged and swallowed', async () => {
    let resolveWrite: () => void = () => {};
    const writer = vi.fn(() => new Promise<void>((r) => (resolveWrite = r)));
    setContentSafetyEventWriter(writer);
    const passRow = { ...row, verdict: 'pass' as const };
    await recordContentSafetyEvent(passRow); // resolves although the write is still pending
    expect(writer).toHaveBeenCalledWith(passRow);
    resolveWrite();

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setContentSafetyEventWriter(async () => {
      throw new Error('db down');
    });
    await expect(recordContentSafetyEvent(row)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
