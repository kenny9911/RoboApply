// @vitest-environment node
//
// WP-64: AI text may only repeat numbers it was given.

import { describe, expect, it } from 'vitest';
import { checkNumbers, extractNumbers, mergeAllowed, numbersInText, parseCjkInteger } from './numberGuard.js';

const NOW = new Date('2026-10-10T00:00:00Z');

describe('extractNumbers', () => {
  it('reads separators, decimals, units and percents', () => {
    const toks = extractNumbers('Base $120,000, or 120k; 1.5万 a month; 20w; 8% below; 3 million; 2,5');
    expect(toks.map((t) => [t.value, t.percent])).toEqual([
      [120000, false],
      [120000, false],
      [15000, false],
      [200000, false],
      [8, true],
      [3_000_000, false],
      [2, false],
      [5, false],
    ]);
    expect(toks[0]!.scaled).toBe(true);
    expect(toks[6]!.scaled).toBe(false);
  });

  it('does not read a unit out of a following word', () => {
    expect(extractNumbers('12 months')[0]!.value).toBe(12);
    expect(extractNumbers('5 weeks')[0]!.value).toBe(5);
  });
});

describe('checkNumbers', () => {
  const allowed = mergeAllowed({ values: [120000, 132000, 140000, 24], percents: [-8] }, numbersInText(['10% target']));

  it('passes numbers from the facts (with formatting and rounding within 2%)', () => {
    expect(checkNumbers('Thank you for the $120,000 offer. Posted pay (24 postings) has a median of $132k, up to 140,000. That is 8% below. Bonus 10% target.', allowed, NOW)).toEqual({
      ok: true,
      unsupported: [],
    });
  });

  it('tolerates small counts and nearby calendar years', () => {
    expect(checkNumbers('Three points: 1. base 2. start date. I can start in 2027.', allowed, NOW).ok).toBe(true);
  });

  it('flags invented market numbers and percents', () => {
    const r = checkNumbers('The typical salary is $150,000 and most people get a 15% raise.', allowed, NOW);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toEqual(['150,000', '15%']);
  });

  it('a year written with a separator or far away is a number like any other', () => {
    expect(checkNumbers('$2,026 more', allowed, NOW).ok).toBe(false);
    expect(checkNumbers('since 1999', allowed, NOW).ok).toBe(false);
  });

  it('accepts a known percent written without the sign', () => {
    expect(checkNumbers('about 8 below the median', allowed, NOW).ok).toBe(true);
  });
});

describe('numbers written without ASCII digits (review: zh output must not slip past the guard)', () => {
  const allowed = { values: [25000, 300000], percents: [] };

  it('parses Chinese numerals, including spoken shorthand and 亿', () => {
    expect(parseCjkInteger('三万五千')).toBe(35000);
    expect(parseCjkInteger('三万五')).toBe(35000);
    expect(parseCjkInteger('四十万')).toBe(400000);
    expect(parseCjkInteger('一百四十万')).toBe(1_400_000);
    expect(parseCjkInteger('一百五')).toBe(150);
    expect(parseCjkInteger('十三')).toBe(13);
    expect(parseCjkInteger('一万零五')).toBe(10005);
    expect(parseCjkInteger('一亿三千万')).toBe(130_000_000);
    expect(parseCjkInteger('三a')).toBeNull();
  });

  it.each([
    ['市场上同类岗位月薪中位数约三万五千元', '三万五千'],
    ['同类岗位一般年薪四十万', '四十万'],
    ['市场中位数为３５０００元', '35000'],
    ['市场中位数约三点五万', '三点五万'],
    ['around one hundred forty thousand dollars', 'one hundred forty thousand'],
    ['a hundred and twenty thousand a year', 'a hundred and twenty thousand'],
    ['most people get twenty percent more', 'twenty'],
    ['通常涨薪百分之十五', '十五'],
    ['that is 1.4x the median', '1.4x'],
    ['高出1.5倍', '1.5倍'],
    ['是对方的两倍', '两'],
    ['two times what they offer', 'two'],
    ['median ٣٥٠٠٠', '٣٥٠٠٠'],
  ])('flags an invented figure in %s', (text, raw) => {
    const r = checkNumbers(text, allowed, NOW);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain(raw);
  });

  it('passes the same figures when they are in the facts', () => {
    const facts = mergeAllowed({ values: [35000, 400000], percents: [15] }, numbersInText(['签字费为月薪的1.5倍']));
    expect(checkNumbers('月薪三万五千，年薪四十万，签字费为月薪的1.5倍，比中位数高百分之十五。', facts, NOW)).toEqual({ ok: true, unsupported: [] });
    expect(checkNumbers('月薪３５０００元', facts, NOW).ok).toBe(true);
  });

  it('does not read ordinary words as numbers', () => {
    expect(checkNumbers('千万不要着急，万一对方拒绝，可以一起再谈。五险一金和三四个月年终都要问清楚。', allowed, NOW).ok).toBe(true);
    expect(checkNumbers('One of the two offers starts sooner; ask about it once.', allowed, NOW).ok).toBe(true);
    expect(checkNumbers('计划二〇二七年入职', allowed, NOW).ok).toBe(true);
  });

  it('reads tokens in text order across scripts', () => {
    expect(extractNumbers('三万五千 then 120k then twenty').map((t) => t.value)).toEqual([35000, 120000, 20]);
  });
});
