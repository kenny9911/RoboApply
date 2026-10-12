// WP-66 — the client mirror of the rubric (components/features/practice-cn/
// rubric.ts) must give exactly what the server gives
// (server/src/features/cn/interview/{rubric,report}.ts). Change the server,
// copy the change to the mirror, and this test stays green.

import { describe, expect, it } from 'vitest';

import * as client from '../rubric';
import * as clientFormat from '../format';
import * as server from '../../../../server/src/features/cn/interview/index';
import { ZH_BREAKDOWN, ZH_ENGINE_TRANSCRIPT, ZH_TEXT_TRANSCRIPT } from '../../../../server/src/features/cn/interview/__tests__/fixtures';

const SAMPLES = [
  '嗯，那个，我当时在社团负责招新，目标是五十人。我首先做了海报，结果来了六十人。',
  '呃，就是说，就是，然后，那个那个……最后取消了。',
  '金额很大，额度也提高了。是啊。',
  'Um, at my last job the goal was to cut tickets. I decided to write docs, you know, and as a result tickets fell 20%.',
  'I like it. Like, really. Basically done.',
  '',
];

const QUESTIONS = ['请讲一次你失败的经历。', '结果呢？', 'Tell me about a time you led.', '你为什么想申请这个岗位？', null];

describe('rubric parity (client mirror = server)', () => {
  it('same rules: filler patterns, STAR cues, order', () => {
    expect(client.FILLER_RULES.map((r) => [r.word, r.re.source, r.re.flags])).toEqual(
      server.FILLER_RULES.map((r) => [r.word, r.re.source, r.re.flags]),
    );
    for (const part of client.STAR_PART_ORDER) {
      expect(client.STAR_CUES[part].map((r) => [r.source, r.flags])).toEqual(server.STAR_CUES[part].map((r) => [r.source, r.flags]));
    }
    expect(client.STAR_PART_ORDER).toEqual(server.STAR_PART_ORDER);
    expect(client.CN_AI_INTERVIEW_FORMAT_ID).toBe(server.CN_AI_INTERVIEW_FORMAT_ID);
  });

  it.each(SAMPLES)('same checks on %j', (text) => {
    expect(client.countFillers(text)).toEqual(server.countFillers(text));
    expect(client.checkStar(text)).toEqual(server.checkStar(text));
    expect(client.isChineseText(text)).toBe(server.isChineseText(text));
    expect(client.answerLength(text, 'chars')).toBe(server.answerLength(text, 'chars'));
    expect(client.answerLength(text, 'words')).toBe(server.answerLength(text, 'words'));
  });

  it.each(QUESTIONS)('same question kinds for %j', (q) => {
    expect(client.isStoryQuestion(q)).toBe(server.isStoryQuestion(q));
    expect(client.isFollowUp(q)).toBe(server.isFollowUp(q));
  });

  it.each(['ai_review', 'text_checks'] as const)('same report on the zh fixture (%s)', (basis) => {
    for (const rows of [ZH_ENGINE_TRANSCRIPT, ZH_TEXT_TRANSCRIPT]) {
      const input = { breakdown: ZH_BREAKDOWN, basis, language: 'zh', now: '2026-10-10T00:00:00Z' };
      expect(client.buildCnPracticeReport({ ...input, turns: client.normalizeCnTurns(rows) })).toEqual(
        server.buildCnPracticeReport({ ...input, turns: server.normalizeCnTurns(rows) }),
      );
    }
  });
});

// INT-09 — the format's id and length rule on the client (format.ts) equal the server's.
describe('format parity (client mirror = server)', () => {
  it('same id and the same 20–30 minute range, default 25', () => {
    expect(clientFormat.CN_FORMAT_MIN_MINUTES).toBe(server.CN_FORMAT_MIN_MINUTES);
    expect(clientFormat.CN_FORMAT_MAX_MINUTES).toBe(server.CN_FORMAT_MAX_MINUTES);
    expect(clientFormat.CN_FORMAT_DEFAULT_MINUTES).toBe(server.CN_FORMAT_DEFAULT_MINUTES);
    expect(clientFormat.isCnFormatType(server.CN_AI_INTERVIEW_FORMAT_ID)).toBe(true);
    expect(clientFormat.isCnFormatType('behavioral')).toBe(false);
    expect(clientFormat.isCnFormatType(null)).toBe(false);
  });

  it.each([null, undefined, Number.NaN, 0, 5, 19.4, 20, 22.5, 25, 30, 30.6, 45, 120])('same clamp for %j minutes', (minutes) => {
    expect(clientFormat.clampCnFormatMinutes(minutes as number)).toBe(server.clampCnMinutes(minutes as number));
  });

  it('every length the setup offers already fits the format (so the server never re-times it)', () => {
    for (const minutes of clientFormat.CN_FORMAT_DURATIONS) {
      expect(server.fitsCnFormatMinutes(minutes)).toBe(true);
      expect(server.usesCnFormat({ market: 'cn', typeId: server.CN_AI_INTERVIEW_FORMAT_ID, minutes })).toBe(true);
    }
    expect(clientFormat.plannedMinutesForType(server.CN_AI_INTERVIEW_FORMAT_ID, 60)).toBe(30);
    expect(clientFormat.plannedMinutesForType('behavioral', 60)).toBe(60);
  });

  it('a timing is read only from a plan with one entry per question', () => {
    const plan = { questions: [{ prepSeconds: 30, answerSeconds: 90 }, { prepSeconds: 60, answerSeconds: 150 }] };
    expect(clientFormat.cnTimingFor(plan, 1, 2)).toEqual({ prepSeconds: 60, answerSeconds: 150 });
    expect(clientFormat.cnTimingFor(plan, 0, 3)).toBeNull();
    expect(clientFormat.cnTimingFor(plan, 5, 2)).toBeNull();
    expect(clientFormat.cnTimingFor(null, 0, 2)).toBeNull();
    expect(clientFormat.cnTimingFor({ questions: null }, 0, 0)).toBeNull();
  });

  it('a stored report block is recognised; anything else is not', () => {
    const block = server.buildCnPracticeReport({ turns: [], breakdown: null, basis: 'text_checks', language: 'zh', now: '2026-10-10T00:00:00Z' });
    expect(clientFormat.asCnPracticeReport(block)).toBe(block);
    for (const bad of [null, undefined, 'x', {}, { version: 2 }, { version: 1, areas: [] }]) expect(clientFormat.asCnPracticeReport(bad)).toBeNull();
  });
});
