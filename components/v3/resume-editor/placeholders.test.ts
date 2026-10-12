// Unfilled placeholders: the editor's detector and the Resume check's are the
// same rule (two copies: the server cannot import from lib/). Plus the
// editor-side list of lines.

import { describe, expect, it } from 'vitest';

import { findPlaceholders, resumePlaceholders } from '../../../lib/resumeAnalyzer';
import { parseResumeMarkdown } from '../../../lib/resumeStructure';
import { findPlaceholders as serverFindPlaceholders } from '../../../server/src/features/resume/check/placeholders';
import { resumePlainText } from './plainText';

const LINES = [
  'Contributed to inventory forecasting for [X] products across [n=__] planning periods.',
  'Cut latency [before → after] with [XX] engineers; budget [TBD], team [#], [??].',
  '节省 [数量] 小时，覆盖 [n=__] 个团队，提升 [百分比]。',
  'See [my portfolio](https://example.test) and the [Redacted] program.',
  'Array access a[0], grade [A], [2023], [Confidential].',
  'Reduced costs by [ x ] and grew [number] accounts over [__] months.',
  '',
];

describe('findPlaceholders', () => {
  it('the editor and the Resume check agree on every line', () => {
    for (const line of LINES) expect(findPlaceholders(line), line).toEqual(serverFindPlaceholders(line));
  });

  it('finds the blanks an AI suggestion leaves, and nothing a person wrote on purpose', () => {
    expect(findPlaceholders(LINES[0]!)).toEqual(['[X]', '[n=__]']);
    expect(findPlaceholders(LINES[1]!)).toEqual(['[before → after]', '[XX]', '[TBD]', '[#]', '[??]']);
    expect(findPlaceholders(LINES[2]!)).toEqual(['[数量]', '[n=__]', '[百分比]']);
    expect(findPlaceholders(LINES[3]!)).toEqual([]);
    expect(findPlaceholders(LINES[4]!)).toEqual([]);
    expect(findPlaceholders(LINES[5]!)).toEqual(['[ x ]', '[number]', '[__]']);
  });

  it('lists every line of a resume that still has one, with where to jump', () => {
    const resume = parseResumeMarkdown(
      ['# Maya', '## Summary', 'Analyst with [X] years of experience.', '## Experience', '### Harbor Lane · Junior Analyst · 2020 – 2022', '- Maintained Excel sales reports for 8 stores.', `- ${LINES[0]}`, '## Projects', '- Route planner used by [n=__] drivers.'].join('\n'),
    );
    const found = resumePlaceholders(resume);
    expect(found.map((f) => f.placeholders)).toEqual([['[X]'], ['[X]', '[n=__]'], ['[n=__]']]);
    expect(found[0]!.anchor).toBe('section-summary');
    expect(found[1]!.anchor).toBe(`exp-${resume.experiences[0]!.id}`);
    expect(found[1]!.text).toBe(LINES[0]);
    expect(resumePlaceholders(parseResumeMarkdown('# A\n## Experience\n### Co · Role · 2020 – 2021\n- Built 3 tools.'))).toEqual([]);
  });
});

describe('resumePlainText', () => {
  it('removes markup, keeps every word and number', () => {
    const md = '# 林知远\n\nlin@example.com · 上海\n\n## 专业技能\n\n**框架：** pandas · PyTorch\n\n## 实习经历\n\n**数据分析实习生 — 星河科技** · 2025.06 - 2025.09\n- 负责 *12* 个团队的周报。\n\n---\n';
    expect(resumePlainText(md)).toBe('林知远\n\nlin@example.com · 上海\n\n专业技能\n\n框架： pandas · PyTorch\n\n实习经历\n\n数据分析实习生 — 星河科技 · 2025.06 - 2025.09\n- 负责 12 个团队的周报。\n');
    expect(resumePlainText('')).toBe('\n');
    // An asterisk that is not emphasis stays.
    expect(resumePlainText('- 5 * 4 = 20 units; rated 4* by users')).toBe('- 5 * 4 = 20 units; rated 4* by users\n');
  });
});
