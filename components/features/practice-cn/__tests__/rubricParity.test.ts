// WP-66 — the client mirror of the rubric (components/features/practice-cn/
// rubric.ts) must give exactly what the server gives
// (server/src/features/cn/interview/{rubric,report}.ts). Change the server,
// copy the change to the mirror, and this test stays green.

import { describe, expect, it } from 'vitest';

import * as client from '../rubric';
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
