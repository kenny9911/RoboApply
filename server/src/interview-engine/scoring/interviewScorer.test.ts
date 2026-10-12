// @vitest-environment node
//
// FIX-6 — the free text-check scorer says only what happened:
//   - questions that got no answer are counted (the written practice knows
//     how many it asked), so "engaged with every prompt" is never claimed
//     after a skip, and the skip is named under "what to work on";
//   - a criticism is never listed as a strength;
//   - the prose follows the session language (a Chinese answer is not "one word");
//   - the overall is scaled by how many of the questions were answered, and a
//     practice with most questions skipped leads with the skips, not praise;
//   - lines shared with voice sessions never say the answers were written.
// Run: npx vitest run server/src/interview-engine/scoring/interviewScorer.test.ts

import { describe, expect, it } from 'vitest';

import { scoreTranscript } from './interviewScorer.js';
import type { TranscriptTurn } from '../types.js';

const turn = (role: TranscriptTurn['role'], text: string): TranscriptTurn => ({ role, text, ts: 0 });

const ZH_ANSWER =
  '我会先确认几个约束：日志的规模和每秒条数、取值域有多大、可用内存、结果要精确还是允许近似。' +
  '如果允许近似，我会用 Count-Min Sketch 加一个大小为 K 的小顶堆，因为内存只有 256MB；结果在实习中每日约两千万条日志的清洗任务里验证过。';

const EN_ANSWER =
  'We had a checkout bug that dropped 3% of orders. I traced it to a race in the cart service, then shipped a fix behind a flag, ' +
  'which cut failed orders from 3% to 0.2% within a week.';

describe('scoreTranscript: unanswered questions', () => {
  it('never says every prompt was answered when questions were skipped (zh)', () => {
    const score = scoreTranscript([turn('interviewer', '第一题'), turn('candidate', ZH_ANSWER)], 3, 'zh', { unanswered: 4 });
    const roleFit = score.breakdown.find((b) => b.key === 'Role fit')!;
    expect(roleFit.note).toBe('5 道题中有 4 道没有作答——每道题都作答，结果才完整。');
    expect(roleFit.note).not.toContain('每个问题都有认真回应');
    // 1 of 5 answered: the completeness value reflects it.
    expect(roleFit.value).toBeLessThan(60);
    // The skip is named under gaps and never under strengths.
    expect(score.gaps.some((g) => g.includes('4 道没有作答'))).toBe(true);
    expect(score.strengths.some((s) => s.includes('没有作答'))).toBe(false);
    // Every line is in the session language.
    for (const line of [...score.strengths, ...score.gaps, ...score.breakdown.map((b) => b.note), score.summary]) {
      expect(line).toMatch(/[一-鿿]/);
      expect(line).not.toMatch(/Engaged with every prompt|Answers were very short|Role fit/);
    }
  });

  it('a long Chinese answer is not called "very short"', () => {
    const score = scoreTranscript([turn('candidate', ZH_ANSWER)], 3, 'zh', { unanswered: 0 });
    expect(score.breakdown.find((b) => b.key === 'Communication')!.note).not.toBe('回答过于简短——信息量要足够支撑评估。');
  });

  it('a mostly complete practice still names the skipped question as a gap, not a strength (en)', () => {
    const turns = Array.from({ length: 4 }, () => turn('candidate', EN_ANSWER));
    const score = scoreTranscript(turns, 3, 'en', { unanswered: 1 });
    const roleFit = score.breakdown.find((b) => b.key === 'Role fit')!;
    expect(roleFit.note).toBe('1 of 5 questions went unanswered. Answer every question for a complete result.');
    expect(score.strengths.some((s) => s.startsWith('Role fit'))).toBe(false);
    expect(score.gaps).toContain(`Role fit: ${roleFit.note}`);
    expect(score.gaps.length).toBeLessThanOrEqual(3);
  });

  it('with every question answered the full-engagement note still applies', () => {
    const turns = Array.from({ length: 3 }, () => turn('candidate', EN_ANSWER));
    const score = scoreTranscript(turns, 3, 'en', { unanswered: 0 });
    expect(score.breakdown.find((b) => b.key === 'Role fit')!.note).toBe('Engaged with every prompt.');
  });

  it('without the option the score is what it was (voice sessions do not know the count)', () => {
    const turns = Array.from({ length: 3 }, () => turn('candidate', EN_ANSWER));
    expect(scoreTranscript(turns, 3, 'en')).toEqual(scoreTranscript(turns, 3, 'en', { unanswered: 0 }));
  });

  it('a thin answer is a gap, never a strength', () => {
    const turns = [...Array.from({ length: 4 }, () => turn('candidate', EN_ANSWER)), turn('candidate', 'Yes.')];
    const score = scoreTranscript(turns, 3, 'en');
    expect(score.breakdown.find((b) => b.key === 'Role fit')!.note).toBe('1 answer was thin — fuller engagement strengthens fit.');
    expect(score.strengths.some((s) => s.startsWith('Role fit'))).toBe(false);
  });

  it('nothing answered: no score is made up', () => {
    const score = scoreTranscript([turn('interviewer', '第一题')], 3, 'zh', { unanswered: 5 });
    expect(score.overall).toBe(0);
    expect(score.gaps).toEqual(['没有记录到任何回答。请完整进行一次面试以获得真实评分。']);
  });

  it('the fallback strength does not claim every question was answered', () => {
    // One short, plain answer: no dimension reaches the strengths bar.
    for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de']) {
      const score = scoreTranscript([turn('candidate', 'ok fine sure')], 5, locale, { unanswered: 4 });
      expect(score.strengths).toHaveLength(1);
      expect(score.strengths[0]).not.toMatch(/every|每个问题|每個問題|すべて|모든|todas|toutes|jede/i);
    }
  });
});

describe('scoreTranscript: coverage', () => {
  const all = Array.from({ length: 5 }, () => turn('candidate', ZH_ANSWER));
  const full = scoreTranscript(all, 3, 'zh', { unanswered: 0 });
  const oneOfFive = scoreTranscript([turn('candidate', ZH_ANSWER)], 3, 'zh', { unanswered: 4 });

  it('one good answer out of five is not scored like five good answers', () => {
    expect(full.overall).toBeGreaterThanOrEqual(80);
    // Coverage 1/5 keeps 0.4 + 0.6 × 0.2 = 52% of the mean of the five dimensions.
    const mean = oneOfFive.breakdown.reduce((a, b) => a + b.value, 0) / oneOfFive.breakdown.length;
    expect(oneOfFive.overall).toBe(Math.round(mean * 0.52));
    expect(oneOfFive.overall).toBeLessThan(50);
    // The dimension values themselves are measured over the answer given, unscaled.
    expect(oneOfFive.breakdown.find((b) => b.key === 'Structure')!.value).toBe(full.breakdown.find((b) => b.key === 'Structure')!.value);
  });

  it('with most questions unanswered the summary is the skip count and no dimension is praised', () => {
    expect(oneOfFive.summary).toBe('5 道题中有 4 道没有作答——每道题都作答，结果才完整。');
    expect(oneOfFive.strengths).toEqual(['你给出的回答是一个可以继续打磨的基础。']);
    expect(oneOfFive.strengths.join('')).not.toContain('大多数回答');
  });

  it('the score falls step by step as more questions are skipped', () => {
    const overalls = [0, 1, 2, 3, 4].map((skipped) =>
      scoreTranscript(all.slice(0, 5 - skipped), 3, 'zh', { unanswered: skipped }).overall);
    for (let i = 1; i < overalls.length; i++) expect(overalls[i]!).toBeLessThan(overalls[i - 1]!);
  });

  it('one skip out of five keeps the praise for what was answered and a band summary', () => {
    const score = scoreTranscript(all.slice(0, 4), 3, 'zh', { unanswered: 1 });
    expect(score.strengths.some((s) => s.startsWith('结构') || s.startsWith('具体性'))).toBe(true);
    expect(score.summary).not.toContain('没有作答');
    expect(score.gaps.some((g) => g.includes('1 道没有作答'))).toBe(true);
  });

  it('a voice session (no count given) is not scaled', () => {
    const voice = scoreTranscript([turn('candidate', ZH_ANSWER)], 3, 'zh');
    const mean = voice.breakdown.reduce((a, b) => a + b.value, 0) / voice.breakdown.length;
    expect(voice.overall).toBe(Math.round(mean));
  });
});

describe('scoreTranscript: lines shared with voice sessions', () => {
  it('the fallback strength does not say the answers were written or spoken', () => {
    const lines: Record<string, string> = {};
    for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de']) {
      // No `unanswered`: this is how the voice engine calls the scorer. One
      // thin answer, so no dimension reaches the strengths bar.
      const score = scoreTranscript([turn('candidate', 'ok')], 5, locale);
      expect(score.strengths).toHaveLength(1);
      lines[locale] = score.strengths[0]!;
    }
    expect(lines.ko).toBe('답변하신 내용은 여기서부터 쌓아갈 수 있는 기반입니다.');
    for (const line of Object.values(lines)) {
      expect(line).not.toMatch(/typed|wrote|written|spoke|said|输入|書い|写|작성|쓴|말한|escri|écri|schrieb|geschrieben|digit|tapé/i);
    }
  });
});
