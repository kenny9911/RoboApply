// WP-66 — rubric unit tests: STAR completeness and filler-word counting on zh
// transcripts (plus the English fallbacks), and the three areas.

import { describe, expect, it } from 'vitest';

import {
  answerLength,
  checkStar,
  countFillers,
  isChineseText,
  isFollowUp,
  isStoryQuestion,
  scoreAreas,
  summarizeStar,
} from '../index.js';

describe('filler words (zh)', () => {
  it('counts 嗯 / 呃 / 唔 always, one per run', () => {
    expect(countFillers('嗯，我觉得呃这个嗯嗯方案可以。').total).toBe(3);
    expect(countFillers('唔……好的').top).toEqual([{ word: '唔', count: 1 }]);
  });

  it('counts 额 / 啊 / 哎 only alone between pauses', () => {
    expect(countFillers('额，我先说一下。').total).toBe(1);
    expect(countFillers('啊，这个问题，啊，我想想。').top).toEqual([{ word: '啊', count: 2 }]);
    expect(countFillers('金额很大，额度也提高了。').total).toBe(0);
    expect(countFillers('是啊。好啊！').total).toBe(0);
    expect(countFillers('哎，我当时很紧张。').total).toBe(1);
  });

  it('counts 那个 / 就是 / 然后 only before a pause or when repeated', () => {
    expect(countFillers('那个项目是我负责的，然后我做了测试，就是这样的结果。').total).toBe(0);
    expect(countFillers('那个，我负责的是，就是，然后，测试。').total).toBe(3);
    expect(countFillers('那个那个项目').top).toEqual([{ word: '那个', count: 1 }]);
    expect(countFillers('就是就是').top).toEqual([{ word: '就是', count: 2 }]);
    expect(countFillers('最后就是').top).toEqual([{ word: '就是', count: 1 }]);
  });

  it('counts the fixed phrases always and does not double-count 就是说', () => {
    const c = countFillers('就是说，这个怎么说呢，你知道吧，挺难的对吧，你懂吧');
    expect(c.top).toEqual([
      { word: '就是说', count: 1 },
      { word: '怎么说呢', count: 1 },
      { word: '你知道吧', count: 1 },
      { word: '你懂吧', count: 1 },
      { word: '对吧', count: 1 },
    ]);
    expect(c.total).toBe(5);
  });

  it('orders the top list by count, then by rule order', () => {
    const c = countFillers('嗯，那个，嗯，那个，嗯');
    expect(c.top).toEqual([{ word: '嗯', count: 3 }, { word: '那个', count: 2 }]);
  });

  it('counts nothing in an empty or clean answer', () => {
    expect(countFillers('')).toEqual({ total: 0, top: [] });
    expect(countFillers('我负责数据分析，最后把转化率提高了百分之十。').total).toBe(0);
  });
});

describe('filler words (en)', () => {
  it('counts um/uh/erm/hmm, and "you know" / "I mean" / "like," only before a pause', () => {
    const c = countFillers('Um, I think, uh, the plan, you know, was fine. I mean, I like the team. Like, really. Basically done.');
    expect(Object.fromEntries(c.top.map((h) => [h.word, h.count]))).toEqual({
      um: 1, uh: 1, 'you know': 1, 'I mean': 1, like: 1, basically: 1,
    });
    expect(countFillers('Do you know the answer? I like it. Umbrella.').total).toBe(0);
  });
});

describe('STAR completeness', () => {
  it('finds all four parts in a complete zh story', () => {
    const c = checkStar(
      '当时我在学校的社团负责招新，目标是一周招到五十人。我首先设计了海报，然后我联系了各个班长。结果招到了六十二人。',
    );
    expect(c).toEqual({ situation: true, task: true, action: true, result: true, parts: 4, missing: [] });
  });

  it('lists the missing parts in STAR order', () => {
    const c = checkStar('有一次我们小组的作业没做完，最后老师给了低分。');
    expect(c.situation).toBe(true);
    expect(c.result).toBe(true);
    expect(c.missing).toEqual(['task', 'action']);
    expect(c.parts).toBe(2);
  });

  it('a vague answer has no parts', () => {
    expect(checkStar('我觉得我是一个很有团队精神的人。').parts).toBe(0);
  });

  it('counts a number with a unit as a result', () => {
    expect(checkStar('用户增长了30%').result).toBe(true);
    expect(checkStar('节约了两天').result).toBe(false);
    expect(checkStar('一共来了３００人').result).toBe(true);
  });

  it('works on English stories', () => {
    const c = checkStar('At my last internship the goal was to cut support tickets. I decided to write a FAQ. As a result tickets fell 20%.');
    expect(c.parts).toBe(4);
  });

  it('summarises story answers and the part missed most', () => {
    const s = summarizeStar([
      null,
      checkStar('当时目标是上线，我首先拆分任务，结果按时上线。'),
      checkStar('有一次活动失败了，最后取消了。'),
      checkStar('那时候我负责宣传，结果来了很多人。'),
    ]);
    expect(s).toEqual({ storyAnswers: 3, complete: 1, missingMost: 'action' });
    expect(summarizeStar([null, null])).toEqual({ storyAnswers: 0, complete: 0, missingMost: null });
  });
});

describe('question kinds', () => {
  it('recognises story questions and short follow-ups', () => {
    expect(isStoryQuestion('请讲一次你和同事意见不一致的经历。')).toBe(true);
    expect(isStoryQuestion('能举个例子吗？')).toBe(true);
    expect(isStoryQuestion('Tell me about a time you failed.')).toBe(true);
    expect(isStoryQuestion('你为什么想申请这个岗位？')).toBe(false);
    expect(isStoryQuestion(null)).toBe(false);
    expect(isFollowUp('结果呢？')).toBe(true);
    expect(isFollowUp('你具体做了什么？')).toBe(true);
    expect(isFollowUp('What was the result?')).toBe(true);
    expect(isFollowUp('如果你负责的项目在截止日期前一周发现严重问题，你会怎么做？')).toBe(false);
    expect(isFollowUp('')).toBe(false);
  });
});

describe('lengths', () => {
  it('counts Chinese characters without punctuation, and words otherwise', () => {
    expect(isChineseText('我负责前端 React 开发')).toBe(true);
    expect(isChineseText('I led the React work')).toBe(false);
    expect(answerLength('我负责，前端。', 'chars')).toBe(5);
    expect(answerLength('I led the work — twice.', 'words')).toBe(5);
    expect(answerLength('   ', 'chars')).toBe(0);
  });
});

describe('areas', () => {
  const star = [checkStar('当时目标是上线，我首先拆分任务，结果按时上线。'), null];

  it('maps the review to communication and logic, and STAR to behaviour', () => {
    const areas = scoreAreas({
      breakdown: [
        { key: 'communication', value: 80 },
        { key: 'confidence', value: 61 },
        { key: 'structure', value: 50 },
        { key: 'specificity', value: 71 },
        { key: 'roleFit', value: 99 },
      ],
      basis: 'ai_review',
      star,
      answered: 2,
    });
    expect(areas).toEqual([
      { key: 'communication', value: 71, basis: 'ai_review' },
      { key: 'logic', value: 61, basis: 'ai_review' },
      { key: 'behaviour', value: 100, basis: 'star_check' },
    ]);
  });

  it('reads the scorer’s English keys too', () => {
    const areas = scoreAreas({
      breakdown: [{ key: 'Communication', value: 40 }, { key: 'Structure', value: 60 }, { key: 'Role fit', value: 10 }],
      basis: 'text_checks',
      star: [],
      answered: 1,
    });
    expect(areas.map((a) => a.value)).toEqual([40, 60, null]);
  });

  it('shows unknown, never 0, with no answers or no breakdown', () => {
    expect(scoreAreas({ breakdown: [{ key: 'communication', value: 0 }], basis: 'text_checks', star: [], answered: 0 }).map((a) => a.value))
      .toEqual([null, null, null]);
    expect(scoreAreas({ breakdown: null, basis: 'ai_review', star: [null], answered: 3 }).map((a) => a.value))
      .toEqual([null, null, null]);
  });
});
