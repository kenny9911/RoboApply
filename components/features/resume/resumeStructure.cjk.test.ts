// WP-65: lib/resumeStructure reads Chinese section titles, keeps titles and
// order, never merges two sections of one kind, reads a contact line without a
// title, and reorders sections without changing their content (F-RES-12).

import { describe, expect, it } from 'vitest';

import {
  applySectionSequence,
  moveSection,
  parseResumeMarkdown,
  sectionSequence,
  serializeResumeMarkdown,
} from '../../../lib/resumeStructure';

// The shape the guided builder writes for a GoApply 应届 resume.
const CN = `# 李同学
*li.test@example.test · 13800000000 · 上海*

## 求职意向

期望职位：数据分析实习生 ｜ 期望城市：上海、杭州

## 教育背景

### 本科 统计学 · 示例大学 · 2022.09 – 2026.06
- 成绩：3.6/4.0

## 实习经历

### 示例科技 · 数据分析实习生 · 2025.07 – 2025.09
- 整理销售数据并制作周报

## 项目经历

### 校园二手平台分析 · 负责人
- 平台交易量下降

## 技能证书

- CET-6（560）
- 技能：Python、SQL

## 自我评价

做事认真，喜欢用数据解决问题。
`;

describe('Chinese resumes in the structured editor', () => {
  it('reads 教育背景 / 实习经历 / 自我评价 as the known blocks and keeps their titles', () => {
    const s = parseResumeMarkdown(CN);
    expect(s.education[0]).toMatchObject({ degree: '本科 统计学', school: '示例大学', startDate: '2022.09', endDate: '2026.06' });
    expect(s.experiences[0]).toMatchObject({ company: '示例科技', title: '数据分析实习生' });
    expect(s.summary).toBe('做事认真，喜欢用数据解决问题。');
    expect(s.headings).toEqual({ education: '教育背景', experiences: '实习经历', summary: '自我评价' });
    // 技能证书 holds certificate lines: kept verbatim, not split into skills.
    expect(s.skills).toEqual([]);
    expect(s.extraSections.map((x) => x.heading)).toEqual(['求职意向', '项目经历', '技能证书']);
  });

  it('a contact line that starts with the email has no title; the rest is the location', () => {
    const s = parseResumeMarkdown(CN);
    expect(s.targetTitle).toBe('');
    expect(s.contact).toMatchObject({ email: 'li.test@example.test', phone: '13800000000', location: '上海' });
  });

  it('round-trips unchanged: titles and section order survive the autosave', () => {
    const once = serializeResumeMarkdown(parseResumeMarkdown(CN));
    expect(once).toBe(CN);
    expect(serializeResumeMarkdown(parseResumeMarkdown(once))).toBe(once);
  });

  it('a second section of the same kind stays verbatim (never merged away)', () => {
    const md = `# A\n\n## 工作经历\n\n### 甲公司 · 运营\n- 写周报\n\n## 实习经历\n\n### 乙公司 · 实习生\n- 做调研\n`;
    const s = parseResumeMarkdown(md);
    expect(s.experiences).toHaveLength(1);
    expect(s.extraSections[0]).toMatchObject({ heading: '实习经历', anchor: 'experiences' });
    const out = serializeResumeMarkdown(s);
    expect(out).toContain('### 乙公司 · 实习生');
    expect(out.indexOf('## 工作经历')).toBeLessThan(out.indexOf('## 实习经历'));
  });

  it('English resumes keep the default titles and order', () => {
    const md = `# Sam\n*Analyst · sam@example.test*\n\n## Summary\n\nLikes data.\n\n## Experience\n\n### Acme · Analyst · 2023 – 2024\n- Built dashboards\n\n## Education\n\n### BS · State U · 2020 – 2024\n\n## Skills\n\nSQL · Excel\n`;
    const s = parseResumeMarkdown(md);
    expect(s.headings).toBeUndefined();
    expect(s.order).toBeUndefined();
    expect(s.targetTitle).toBe('Analyst');
    expect(serializeResumeMarkdown(s)).toBe(md);
  });
});

describe('section order (F-RES-12)', () => {
  it('lists sections in document order and moves one without changing any content', () => {
    const s = parseResumeMarkdown(CN);
    const seq = sectionSequence(s);
    expect(seq.map((r) => (r.kind === 'known' ? r.key : s.extraSections.find((x) => x.id === r.id)!.heading))).toEqual([
      '求职意向',
      'education',
      'experiences',
      '项目经历',
      '技能证书',
      'summary',
    ]);
    // Move 自我评价 (summary) up to the top.
    let next = s;
    for (let i = 0; i < 5; i += 1) next = moveSection(next, { kind: 'known', key: 'summary' }, -1);
    const md = serializeResumeMarkdown(next);
    const titles = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(titles).toEqual(['自我评价', '求职意向', '教育背景', '实习经历', '项目经历', '技能证书']);
    // Same lines, different order.
    const sorted = (t: string) => t.split('\n').filter(Boolean).sort();
    expect(sorted(md)).toEqual(sorted(CN));
    // And it survives the next autosave.
    expect(serializeResumeMarkdown(parseResumeMarkdown(md))).toBe(md);
  });

  it('moving past either end does nothing; applySectionSequence keeps unlisted sections', () => {
    const s = parseResumeMarkdown(CN);
    const first = sectionSequence(s)[0]!;
    expect(moveSection(s, first, -1)).toBe(s);
    const kept = applySectionSequence(s, [{ kind: 'known', key: 'education' }]);
    expect(serializeResumeMarkdown(kept)).toContain('## 项目经历');
  });
});
