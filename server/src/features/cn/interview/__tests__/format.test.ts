// WP-66 — the AI-interview format: zh question sets, the 20–30 minute script,
// deterministic selection, and the honesty rules (no vendor names, no outcome
// claims).

import { describe, expect, it } from 'vitest';

import {
  CN_AI_INTERVIEW_FORMAT_ID,
  CN_FORMAT_BLUEPRINT_DIRECTIVE,
  CN_FORMAT_EVALUATION_LENS,
  CN_QUESTION_SETS,
  CN_SECTION_IDS,
  allCnQuestions,
  buildCnScript,
  clampCnMinutes,
  cnScriptLanguage,
  cnStrategyPhases,
  isStoryQuestion,
  questionHint,
  questionText,
  questionTip,
  scriptSeconds,
  storyQuestionCount,
  usesCnFormat,
} from '../index.js';

const VENDOR_NAMES = ['北森', '牛客', 'HireVue', 'Beisen', 'Nowcoder', 'Moka', '智联', '猎聘', 'BOSS直聘'];
const TAIWAN_TERMS = ['履歷', '職缺', '面議'];

describe('zh question sets (fixture)', () => {
  it('every section has a set, ids are unique, every question has zh, en and hints', () => {
    const all = allCnQuestions();
    expect(new Set(all.map((q) => q.id)).size).toBe(all.length);
    for (const id of CN_SECTION_IDS) expect(CN_QUESTION_SETS[id].length, id).toBeGreaterThan(0);
    for (const q of all) {
      expect(q.zh.trim(), q.id).not.toBe('');
      expect(q.en.trim(), q.id).not.toBe('');
      expect(q.hintZh.trim(), q.id).not.toBe('');
      expect(q.hintEn.trim(), q.id).not.toBe('');
      expect(/[一-鿿]/.test(q.zh), q.id).toBe(true);
    }
  });

  it('has enough story questions for the longest plan, all flagged as stories', () => {
    expect(CN_QUESTION_SETS.behavioral.length).toBeGreaterThanOrEqual(storyQuestionCount(30));
    for (const q of CN_QUESTION_SETS.behavioral) expect(q.story, q.id).toBe(true);
  });

  it('the story flag agrees with the story-question check in both languages', () => {
    for (const q of allCnQuestions()) {
      expect(isStoryQuestion(q.zh), `${q.id} zh`).toBe(q.story);
      expect(isStoryQuestion(q.en), `${q.id} en`).toBe(q.story);
    }
  });

  it('names no vendor and uses mainland wording', () => {
    const text = JSON.stringify(CN_QUESTION_SETS) + CN_FORMAT_BLUEPRINT_DIRECTIVE + CN_FORMAT_EVALUATION_LENS;
    for (const name of VENDOR_NAMES) expect(text.includes(name), name).toBe(false);
    for (const term of TAIWAN_TERMS) expect(text.includes(term), term).toBe(false);
  });

  it('makes no claim about real interview outcomes', () => {
    const text = JSON.stringify(CN_QUESTION_SETS);
    for (const claim of ['通过率', '保证', '一定能', 'guarantee', 'pass rate']) expect(text.includes(claim), claim).toBe(false);
    expect(CN_FORMAT_BLUEPRINT_DIRECTIVE).toMatch(/never say the result predicts a real hiring decision/);
  });
});

describe('the script', () => {
  it('clamps to 20–30 minutes (default 25)', () => {
    expect(clampCnMinutes(undefined)).toBe(25);
    expect(clampCnMinutes(Number.NaN)).toBe(25);
    expect(clampCnMinutes(5)).toBe(20);
    expect(clampCnMinutes(45)).toBe(30);
    expect(clampCnMinutes(26.4)).toBe(26);
  });

  it.each([20, 25, 30])('a %i-minute plan fits its time limits inside the plan, in section order', (minutes) => {
    const script = buildCnScript({ seed: 'fixture-seed', minutes, language: 'zh' });
    expect(script.formatId).toBe(CN_AI_INTERVIEW_FORMAT_ID);
    expect(script.minutes).toBe(minutes);
    const seconds = scriptSeconds(script.questions);
    expect(seconds).toBeLessThanOrEqual(minutes * 60);
    expect(seconds).toBeGreaterThanOrEqual((minutes - 6) * 60);
    expect(script.questions.filter((q) => q.section === 'behavioral')).toHaveLength(storyQuestionCount(minutes));
    const order = script.questions.map((q) => CN_SECTION_IDS.indexOf(q.section));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(script.questions.map((q) => q.order)).toEqual(script.questions.map((_, i) => i));
    expect(script.questions[0]!.section).toBe('self_intro');
    expect(script.questions[script.questions.length - 1]!.section).toBe('closing');
  });

  it('is deterministic per seed and varies across seeds', () => {
    const a = buildCnScript({ seed: 'session-a' });
    expect(buildCnScript({ seed: 'session-a' })).toEqual(a);
    const ids = new Set<string>();
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      ids.add(buildCnScript({ seed }).questions.filter((q) => q.section === 'behavioral').map((q) => q.id).join(','));
    }
    expect(ids.size).toBeGreaterThan(1);
  });

  it('never repeats a question in one plan', () => {
    const script = buildCnScript({ seed: 'x', minutes: 30 });
    expect(new Set(script.questions.map((q) => q.id)).size).toBe(script.questions.length);
  });

  it('uses a role question written for the job when given, flagged by the story check', () => {
    const story = '请讲一次你用数据分析解决业务问题的经历。';
    const script = buildCnScript({ seed: 'x', roleQuestions: [story, '另一个问题'] });
    const role = script.questions.filter((q) => q.section === 'role');
    expect(role).toHaveLength(1);
    expect(role[0]!.zh).toBe(story);
    expect(role[0]!.story).toBe(true);
  });

  it('runs the zh set by default and English only for an English session', () => {
    expect(cnScriptLanguage(undefined)).toBe('zh');
    expect(cnScriptLanguage('zh-CN')).toBe('zh');
    expect(cnScriptLanguage('en-US')).toBe('en');
    const q = CN_QUESTION_SETS.self_intro[0]!;
    expect(questionText(q, 'zh')).toBe(q.zh);
    expect(questionText(q, 'en')).toBe(q.en);
    expect(questionHint(q, 'en')).toBe(q.hintEn);
  });

  it('answer tips carry no timing (the UI renders it from the plan numbers)', () => {
    for (const story of [true, false]) {
      for (const lang of ['zh', 'en'] as const) {
        const tip = questionTip({ story }, lang);
        expect(tip.length).toBeGreaterThan(0);
        expect(tip).not.toMatch(/\d|秒|分钟|second|minute/i);
      }
    }
    expect(questionTip({ story: true }, 'zh')).not.toBe(questionTip({ story: false }, 'zh'));
  });

  it('strategy phases cover the plan length', () => {
    for (const minutes of [20, 25, 30]) {
      const total = cnStrategyPhases(minutes).reduce((s, p) => s + p.minutes, 0);
      expect(total).toBe(minutes);
    }
  });
});

describe('usesCnFormat', () => {
  it('runs general types on the cn market in the format; skill exercises and intl keep theirs', () => {
    expect(usesCnFormat({ market: 'cn', typeId: 'behavioral' })).toBe(true);
    expect(usesCnFormat({ market: 'cn', typeId: 'screening' })).toBe(true);
    expect(usesCnFormat({ market: 'cn', typeId: 'technical' })).toBe(false);
    expect(usesCnFormat({ market: 'intl', typeId: 'behavioral' })).toBe(false);
    expect(usesCnFormat({ market: null, typeId: CN_AI_INTERVIEW_FORMAT_ID })).toBe(true);
  });

  it('with a planned length, a general type runs the format only inside 20–30 minutes', () => {
    expect(usesCnFormat({ market: 'cn', typeId: 'behavioral', minutes: 15 })).toBe(false);
    expect(usesCnFormat({ market: 'cn', typeId: 'behavioral', minutes: 45 })).toBe(false);
    expect(usesCnFormat({ market: 'cn', typeId: 'behavioral', minutes: 20 })).toBe(true);
    expect(usesCnFormat({ market: 'cn', typeId: 'screening', minutes: 30 })).toBe(true);
    expect(usesCnFormat({ market: 'cn', typeId: 'culture', minutes: Number.NaN })).toBe(false);
    expect(usesCnFormat({ market: 'cn', typeId: 'behavioral', minutes: null })).toBe(true);
    expect(usesCnFormat({ market: 'intl', typeId: CN_AI_INTERVIEW_FORMAT_ID, minutes: 45 })).toBe(true);
  });
});
