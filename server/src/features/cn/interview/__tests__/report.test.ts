// WP-66 — the report block on the zh fixture, from both practice paths.

import { describe, expect, it } from 'vitest';

import { buildCnPracticeReport, groupAnswers, normalizeCnTurns } from '../index.js';
import { ZH_BREAKDOWN, ZH_ENGINE_TRANSCRIPT, ZH_EXPECTED, ZH_TEXT_TRANSCRIPT } from './fixtures.js';

const NOW = '2026-10-10T08:00:00.000Z';

function build(rows: unknown) {
  return buildCnPracticeReport({
    turns: normalizeCnTurns(rows),
    breakdown: ZH_BREAKDOWN,
    basis: 'ai_review',
    language: 'zh',
    now: NOW,
  });
}

describe('normalizeCnTurns', () => {
  it('keeps interviewer and candidate lines, drops system, interim and empty ones', () => {
    const turns = normalizeCnTurns([...ZH_ENGINE_TRANSCRIPT, { role: 'candidate', text: '   ' }, null, 'x']);
    expect(turns.every((t) => t.role === 'interviewer' || t.role === 'candidate')).toBe(true);
    expect(turns.some((t) => t.text === '我做')).toBe(false);
    expect(turns.some((t) => t.text === 'session started')).toBe(false);
    expect(normalizeCnTurns(undefined)).toEqual([]);
  });

  it('reads the text-practice shape the same way', () => {
    expect(normalizeCnTurns(ZH_TEXT_TRANSCRIPT)).toEqual(normalizeCnTurns(ZH_ENGINE_TRANSCRIPT));
  });
});

describe('groupAnswers', () => {
  it('merges consecutive candidate turns and folds a follow-up answer into its story', () => {
    const answers = groupAnswers(normalizeCnTurns(ZH_ENGINE_TRANSCRIPT));
    expect(answers).toHaveLength(ZH_EXPECTED.answers);
    expect(answers[0]!.text).toContain('那个，我在一家互联网公司');
    expect(answers[2]!.text).toContain('最后活动取消了');
    expect(answers.map((a) => a.story)).toEqual([false, true, true, false]);
  });

  it('records no question for an answer before any interviewer line', () => {
    const answers = groupAnswers([{ role: 'candidate', text: '你好' }]);
    expect(answers).toEqual([{ question: null, story: false, text: '你好' }]);
  });
});

describe('buildCnPracticeReport on the zh fixture', () => {
  const report = build(ZH_ENGINE_TRANSCRIPT);

  it('counts fillers per answer and in total, per 100 characters', () => {
    expect(report.answers.map((a) => a.fillers.total)).toEqual([...ZH_EXPECTED.fillersPerAnswer]);
    expect(report.fillers.total).toBe(ZH_EXPECTED.fillerTotal);
    expect(report.fillers.unit).toBe('chars');
    const chars = report.answers.reduce((s, a) => s + a.length, 0);
    expect(report.fillers.per100).toBe(Math.round((ZH_EXPECTED.fillerTotal / chars) * 1000) / 10);
    expect(report.fillers.top[0]).toEqual({ word: '那个', count: 3 });
  });

  it('checks STAR on story answers only', () => {
    expect(report.answers.map((a) => (a.star ? a.star.parts : null))).toEqual([...ZH_EXPECTED.stars]);
    expect(report.answers.map((a) => (a.star ? a.star.missing : null))).toEqual(ZH_EXPECTED.missing.map((m) => (m ? [...m] : null)));
    expect(report.star).toEqual({
      storyAnswers: ZH_EXPECTED.storyAnswers,
      complete: ZH_EXPECTED.complete,
      missingMost: ZH_EXPECTED.missingMost,
    });
  });

  it('scores the three areas', () => {
    expect(report.areas).toEqual([
      { key: 'communication', value: ZH_EXPECTED.communication, basis: 'ai_review' },
      { key: 'logic', value: ZH_EXPECTED.logic, basis: 'ai_review' },
      { key: 'behaviour', value: ZH_EXPECTED.behaviour, basis: 'star_check' },
    ]);
  });

  it('carries the format, language and time', () => {
    expect(report).toMatchObject({ version: 1, formatId: 'cn_ai_interview', language: 'zh', generatedAt: NOW });
    expect(report.answers[1]!.question).toContain('团队');
  });

  it('gives the same block from the text-practice transcript', () => {
    expect(build(ZH_TEXT_TRANSCRIPT)).toEqual(report);
  });

  it('an empty practice reports unknowns, not zeros', () => {
    const empty = buildCnPracticeReport({ turns: [], breakdown: ZH_BREAKDOWN, basis: 'text_checks', language: 'zh', now: NOW });
    expect(empty.areas.map((a) => a.value)).toEqual([null, null, null]);
    expect(empty.fillers).toEqual({ total: 0, per100: null, unit: 'words', top: [] });
    expect(empty.star).toEqual({ storyAnswers: 0, complete: 0, missingMost: null });
  });
});
