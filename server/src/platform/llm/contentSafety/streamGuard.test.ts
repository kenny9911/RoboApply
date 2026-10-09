// @vitest-environment node
//
// WP-24: streamed GoApply output is released only after it is checked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_KEYWORD_LIST,
  ContentBlockedError,
  ContentSafetyUnavailableError,
  createOutputStreamGuard,
  setContentSafetyEventWriter,
  setContentSafetyProvider,
  type ContentSafetyEventRow,
  type ContentSafetyProvider,
} from './index.js';
import { sha256Hex } from './events.js';
import { MAX_TERM_LENGTH, compileKeywordLists, type KeywordList } from './keywordList.js';
import { createKeywordOnlyProvider } from './keywordOnly.js';
import { overlapTail, releasableLength } from './streamGuard.js';
import { PRIVATE_LIST, goapplyCtx, roboapplyCtx } from './__tests__/fixtures.js';

let events: ContentSafetyEventRow[] = [];
let checked: string[] = [];

const LONG_CJK_TERM = '甲乙丙丁戊己庚辛壬癸'.repeat(4); // 40 characters
const LONG_ASCII_TERM = 'the quick brown fox jumps over a lazy dog'; // 41 characters
const STREAM_TEST_LIST: KeywordList = {
  version: 'stream-test',
  entries: [
    { id: 's-1', term: LONG_CJK_TERM, category: 'test_block', action: 'block' },
    { id: 's-2', term: LONG_ASCII_TERM, category: 'test_block', action: 'block' },
    { id: 's-3', term: 'ass', category: 'test_block', action: 'block' },
  ],
};

/** Spies on segment checks; has no keywordProvider, so finish() runs no final scan. */
function spyingKeywordProvider(): ContentSafetyProvider {
  const compiled = compileKeywordLists([BUILTIN_KEYWORD_LIST, PRIVATE_LIST, STREAM_TEST_LIST]);
  const inner = createKeywordOnlyProvider({ kind: 'builtin+private', get: async () => compiled });
  return {
    id: inner.id,
    checkInput: inner.checkInput,
    checkOutput: async (text, ctx, opts) => {
      checked.push(text);
      return inner.checkOutput(text, ctx, opts);
    },
  };
}

beforeEach(() => {
  events = [];
  checked = [];
  setContentSafetyEventWriter(async (row) => {
    events.push(row);
  });
  setContentSafetyProvider(spyingKeywordProvider());
});

afterEach(() => {
  setContentSafetyProvider(null);
  setContentSafetyEventWriter(null);
});

async function drain(guard: ReturnType<typeof createOutputStreamGuard>, deltas: string[]) {
  const released: string[] = [];
  for (const d of deltas) released.push(await guard.push(d));
  released.push(await guard.finish());
  return released;
}

describe('createOutputStreamGuard', () => {
  it('RoboApply streams pass straight through, unchecked', async () => {
    const guard = createOutputStreamGuard(roboapplyCtx());
    expect(await drain(guard, ['网上', '赌场'])).toEqual(['网上', '赌场', '']);
    expect(checked).toEqual([]);
    expect(events).toEqual([]);
  });

  it('holds deltas back until a checked segment, then releases them in order', async () => {
    const guard = createOutputStreamGuard(goapplyCtx(), { segmentChars: 10, overlapChars: 3 });
    const released = await drain(guard, ['一二三四五', '六七八九十', '甲乙']);
    expect(released).toEqual(['', '一二三四五六七八九十', '', '甲乙']);
    expect(checked).toEqual(['一二三四五六七八九十', '八九十甲乙']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verdict: 'pass', direction: 'output', matched: { segments: 2, textLength: 12 } });
    expect(events[0].matched).not.toHaveProperty('excerpt');
  });

  it('catches a keyword split across two segments through the overlap, and releases nothing of the bad segment', async () => {
    const guard = createOutputStreamGuard(goapplyCtx(), { segmentChars: 6, overlapChars: 4 });
    expect(await guard.push('你好，可以去出售')).toBe('你好，可以去出售');
    const err = await guard.push('冰毒看看呀，好').catch((e) => e);
    expect(err).toBeInstanceOf(ContentBlockedError);
    expect(err.details).toEqual({ stage: 'output', labels: ['keyword:drugs'] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verdict: 'block', matched: { reason: 'keyword', ruleIds: ['b-drg-01'], segments: 2, excerptAnchor: 'hit' } });
    expect(events[0].matched.excerpt).toContain('出售冰毒');
    // The row describes the whole reply produced so far, not just the blocked segment.
    const whole = '你好，可以去出售冰毒看看呀，好';
    expect(events[0].matched).toMatchObject({ textSha256: sha256Hex(whole), textLength: Array.from(whole).length });
    expect(events[0].matched.excerpt).toBe(whole);
    // The guard is closed after a block.
    await expect(guard.push('more')).rejects.toThrow(/closed/);
  });

  it('default overlap: a separator-padded term spread far across the boundary is still caught', async () => {
    const pad = ' . '.repeat(12); // 36 raw characters, none of them count for matching
    const guard = createOutputStreamGuard(goapplyCtx());
    const first = '好'.repeat(280) + '出' + pad + '售' + pad + '冰' + pad;
    expect(Array.from(first).length).toBeGreaterThan(300);
    expect(await guard.push(first)).toBe(first);
    const err = await guard.push('毒' + '好'.repeat(330)).catch((e) => e);
    expect(err).toBeInstanceOf(ContentBlockedError);
    // The re-checked overlap held more than 32 raw characters: the whole padded term.
    expect(checked[1].startsWith('好')).toBe(true);
    expect(checked[1]).toContain('出' + pad + '售' + pad + '冰' + pad + '毒');
  });

  it('default overlap: a 40-character term split across the boundary is caught (CJK and ASCII)', async () => {
    const cjk = createOutputStreamGuard(goapplyCtx());
    expect(await cjk.push('好'.repeat(280) + LONG_CJK_TERM.slice(0, 30))).not.toBe('');
    await expect(cjk.push(LONG_CJK_TERM.slice(30) + '好'.repeat(300))).rejects.toBeInstanceOf(ContentBlockedError);

    const ascii = createOutputStreamGuard(goapplyCtx());
    const head = 'Here is your cover letter draft. '.repeat(9) + LONG_ASCII_TERM.slice(0, 22); // ends mid-word: "...fox ju"
    const out = await ascii.push(head);
    expect(out.endsWith('fox ')).toBe(true); // the partial word "ju" is held back
    await expect(ascii.push(LONG_ASCII_TERM.slice(22) + ' and more text. '.repeat(20))).rejects.toBeInstanceOf(ContentBlockedError);
    expect(MAX_TERM_LENGTH).toBeGreaterThanOrEqual(LONG_ASCII_TERM.length);
  });

  it('a whole-word English term is never matched against half a word at a segment edge', async () => {
    const guard = createOutputStreamGuard(goapplyCtx(), { segmentChars: 10, overlapChars: 3 });
    const released = await drain(guard, ['Read the ass', 'ignment notes in the cl', 'assroom today.']);
    expect(released.join('')).toBe('Read the assignment notes in the classroom today.');
    expect(released[0]).toBe('Read the ');
    expect(events[0]).toMatchObject({ verdict: 'pass' });
  });

  it('a block in the final remainder throws from finish()', async () => {
    const guard = createOutputStreamGuard(goapplyCtx({ task: 'cover_letter' }), { segmentChars: 100 });
    expect(await guard.push('出售冰')).toBe('');
    expect(await guard.push('毒')).toBe('');
    await expect(guard.finish()).rejects.toBeInstanceOf(ContentBlockedError);
    await expect(guard.push('more')).rejects.toThrow(/closed/);
  });

  it('a review hit is released, and the summary row carries the excerpt around it', async () => {
    const guard = createOutputStreamGuard(goapplyCtx(), { segmentChars: 5, overlapChars: 2 });
    const released = await drain(guard, ['这份工作需要', '高强度加班哦']);
    expect(released.join('')).toBe('这份工作需要高强度加班哦');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verdict: 'review', matched: { reason: 'keyword', labels: ['keyword:labour_risk'] } });
    expect(events[0].matched.excerpt).toContain('高强度加班');
  });

  it('fails closed when the provider errors mid-stream, with one error row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setContentSafetyProvider({
      id: 'down',
      checkInput: async () => ({ verdict: 'pass', labels: [], provider: 'down' }),
      checkOutput: async () => {
        throw new Error('down');
      },
    });
    const guard = createOutputStreamGuard(goapplyCtx(), { segmentChars: 2 });
    const err = await guard.push('你好').catch((e) => e);
    expect(err).toBeInstanceOf(ContentSafetyUnavailableError);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verdict: 'error', matched: { reason: 'provider_error', segments: 1 } });
    await expect(guard.finish()).rejects.toThrow(/closed/);
    warn.mockRestore();
  });

  it('serialises concurrent pushes', async () => {
    const guard = createOutputStreamGuard(goapplyCtx(), { segmentChars: 2, overlapChars: 0 });
    const out = await Promise.all([guard.push('ab'), guard.push('cd'), guard.push('e')]);
    expect(out).toEqual(['ab', 'cd', '']);
    expect(await guard.finish()).toBe('e');
    expect(checked).toEqual(['ab', 'cd', 'e']);
  });

  it('finish() with nothing pending only writes the summary', async () => {
    const guard = createOutputStreamGuard(goapplyCtx());
    expect(await guard.finish()).toBe('');
    expect(checked).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verdict: 'pass', provider: 'unknown', matched: { segments: 0, textLength: 0 } });
  });

  it('finish() runs the keyword list over the whole released text and holds back the last segment on a hit', async () => {
    const compiled = compileKeywordLists([BUILTIN_KEYWORD_LIST, PRIVATE_LIST]);
    const keywordProvider = createKeywordOnlyProvider({ kind: 'builtin', get: async () => compiled });
    // Segment checks that miss everything stand in for a cross-segment miss.
    setContentSafetyProvider({
      id: 'keyword_only+blind',
      checkInput: async () => ({ verdict: 'pass', labels: [], provider: 'blind' }),
      checkOutput: async () => ({ verdict: 'pass', labels: [], provider: 'keyword_only+blind' }),
      keywordProvider,
    });
    const guard = createOutputStreamGuard(goapplyCtx(), { segmentChars: 4, overlapChars: 0 });
    expect(await guard.push('你好出售')).toBe('你好出售');
    expect(await guard.push('冰毒')).toBe('');
    await expect(guard.finish()).rejects.toBeInstanceOf(ContentBlockedError);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verdict: 'block',
      provider: 'keyword_only+blind',
      matched: { finalScan: true, ruleIds: ['b-drg-01'], textSha256: sha256Hex('你好出售冰毒') },
    });
    expect(events[0].matched.excerpt).toContain('出售冰毒');
    await expect(guard.push('x')).rejects.toThrow(/closed/);
  });

  it('a review found only by the final scan upgrades the summary row', async () => {
    const compiled = compileKeywordLists([BUILTIN_KEYWORD_LIST, PRIVATE_LIST]);
    setContentSafetyProvider({
      id: 'blind',
      checkInput: async () => ({ verdict: 'pass', labels: [], provider: 'blind' }),
      checkOutput: async () => ({ verdict: 'pass', labels: [], provider: 'blind' }),
      keywordProvider: createKeywordOnlyProvider({ kind: 'builtin', get: async () => compiled }),
    });
    const guard = createOutputStreamGuard(goapplyCtx(), { segmentChars: 3, overlapChars: 0 });
    const released = await drain(guard, ['需要高强', '度加班']);
    expect(released.join('')).toBe('需要高强度加班');
    expect(events[0]).toMatchObject({ verdict: 'review', matched: { finalScan: true, labels: ['keyword:labour_risk'], excerptAnchor: 'hit' } });
  });

  it('the final scan fails closed too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setContentSafetyProvider({
      id: 'p',
      checkInput: async () => ({ verdict: 'pass', labels: [], provider: 'p' }),
      checkOutput: async () => ({ verdict: 'pass', labels: [], provider: 'p' }),
      keywordProvider: {
        id: 'keyword_only',
        checkInput: async () => ({ verdict: 'pass', labels: [], provider: 'keyword_only' }),
        checkOutput: async () => {
          throw new Error('list gone');
        },
      },
    });
    const guard = createOutputStreamGuard(goapplyCtx(), { segmentChars: 2 });
    expect(await guard.push('你好')).toBe('你好');
    await expect(guard.finish()).rejects.toBeInstanceOf(ContentSafetyUnavailableError);
    expect(events).toEqual([expect.objectContaining({ verdict: 'error', matched: expect.objectContaining({ reason: 'provider_error' }) })]);
    warn.mockRestore();
  });

  it('a provider that only names the flagged slice gives a slice-start excerpt, shifted into stream coordinates', async () => {
    let n = 0;
    setContentSafetyProvider({
      id: 'aliyun_green',
      checkInput: async () => ({ verdict: 'pass', labels: [], provider: 'aliyun_green' }),
      checkOutput: async (text) =>
        ++n === 2
          ? { verdict: 'block', labels: ['abuse'], provider: 'aliyun_green', hitOffset: 0, hitSlice: { index: 0, start: 0, length: Array.from(text).length } }
          : { verdict: 'pass', labels: [], provider: 'aliyun_green' },
    });
    const guard = createOutputStreamGuard(goapplyCtx(), { segmentChars: 300, overlapChars: 2 });
    expect(await guard.push('甲'.repeat(300))).toBe('甲'.repeat(300));
    await expect(guard.push('一二三四五' + '乙'.repeat(295))).rejects.toBeInstanceOf(ContentBlockedError);
    // The flagged slice is the second segment (with its 2-character overlap), at stream offset 298.
    expect(events[0].matched).toMatchObject({ excerptAnchor: 'slice_start', slice: { index: 0, length: 302 }, textLength: 600 });
    expect(events[0].matched.excerpt).toBe('甲甲一二三四五' + '乙'.repeat(193));
  });
});

describe('overlap helpers', () => {
  it('overlapTail counts compact characters and never starts inside a Latin word', () => {
    expect(overlapTail('一二三四五', 2)).toBe('四五');
    expect(overlapTail('好 . . . 坏', 2)).toBe('好 . . . 坏');
    expect(overlapTail('we met in the classroom', 3)).toBe('classroom');
    expect(overlapTail('上中classroom', 3)).toBe('中classroom');
    expect(overlapTail('abc', 5)).toBe('abc');
    expect(overlapTail('abc', 0)).toBe('');
    expect(overlapTail('𠀀𠀀x', 2)).toBe('𠀀x');
    expect(overlapTail('😀😀x', 1)).toBe('x'); // emoji are symbols: separators, they do not count
    // A Latin run longer than 2 × MAX_TERM_LENGTH: its partial start is dropped.
    expect(overlapTail('好' + 'a'.repeat(200) + '。好', 3)).toBe('。好');
  });

  it('releasableLength holds back a trailing partial Latin word only', () => {
    expect(releasableLength('')).toBe(0);
    expect(releasableLength('你好世界')).toBe(4);
    expect(releasableLength('hello wor')).toBe(6);
    expect(releasableLength('中文ass')).toBe(2);
    expect(releasableLength('hello.')).toBe(6);
    expect(releasableLength('onlyoneword')).toBe(11);
  });
});
