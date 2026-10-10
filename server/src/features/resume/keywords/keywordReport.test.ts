// @vitest-environment node
//
// WP-22: the deterministic keyword report (F-RES-08). No second scale: the
// only score is the MATCH row's 0–100 fit score as a Sourced value, or null.

import { describe, expect, it } from 'vitest';
import { parseResume } from '../check/resumeText.js';
import { buildKeywordReport, displayTerm, educationFrom, plausibleSkill, requiredYearsFrom, resumeEducation, resumeYears, showsTerm, termsFromPosting } from './keywordReport.js';

const NOW = new Date('2026-10-10T12:00:00Z');

const RESUME = [
  '# Ada Lovelace',
  '*ada@example.test · +1 415 555 0100*',
  '## Summary',
  'Backend engineer building payment systems.',
  '## Experience',
  '### Analytical Engines · Senior Backend Engineer · 01/2020 – Present',
  '- Built services in Python and PostgreSQL on AWS.',
  '### Difference Co · Engineer · 06/2017 – 12/2019',
  '- Shipped tools with Kafka.',
  '## Education',
  '### BS Computer Science · University of London · 2013 – 2017',
  '## Skills',
  'Python · PostgreSQL · Kafka · AWS',
].join('\n');

describe('helpers', () => {
  it('reads years, education and terms', () => {
    expect(requiredYearsFrom('You have 5+ years of professional experience')).toBe(5);
    expect(requiredYearsFrom('3年以上工作经验')).toBe(3);
    expect(requiredYearsFrom('No experience needed')).toBeNull();
    expect(educationFrom("Bachelor's degree in CS or similar")).toBe('bachelor');
    expect(educationFrom('硕士及以上学历')).toBe('master');
    const r = parseResume(RESUME);
    expect(resumeEducation(r)).toBe('bachelor');
    expect(resumeYears(r, NOW)).toBeCloseTo(9.3, 0);
    expect(termsFromPosting('We use Python, Kubernetes and GCP. GCP experience. The USA team and EEO EEO.')).toEqual(
      ['python', 'gcp', 'kubernetes'],
    );
    expect(termsFromPosting('USA USA EEO EEO')).toEqual([]);
  });
});

describe('skills the job asks for (tailoring offers these to confirm)', () => {
  const RESUME_PY = [
    '# Maya Lindqvist',
    '## Experience',
    '### Northwind Freight · Data Analyst · 06/2022 – Present',
    '- Automated a monthly cost report in Python (pandas).',
    '## Skills',
    'SQL · PostgreSQL · Python · pandas · Tableau · Excel',
  ].join('\n');

  it('never offers frequent words of the posting as skills (EN)', () => {
    // QA: "curiosity, paid, status, it's, benefits", "r or python", "angeles, children's, clphei".
    const report = buildKeywordReport({
      resumeMarkdown: RESUME_PY,
      job: {
        title: 'Data Science Analyst',
        text: "Children's Hospital Los Angeles (CLPHEI) pays well. Benefits and paid leave. You bring curiosity, SQL, R or Python, and Snowflake. It's a great status.",
        skills: ['sql', 'r or python', 'snowflake'],
      },
      extraction: {
        keywords: [
          { keyword: 'sql', importance: 'high' },
          { keyword: 'r or python', importance: 'high' },
          { keyword: 'snowflake', importance: 'medium' },
          { keyword: 'curiosity', importance: 'medium' },
          { keyword: 'paid', importance: 'medium' },
          { keyword: 'status', importance: 'low' },
          { keyword: "it's", importance: 'low' },
          { keyword: 'benefits', importance: 'medium' },
          { keyword: 'fraudulent', importance: 'low' },
          { keyword: 'angeles', importance: 'medium' },
          { keyword: "children's", importance: 'medium' },
          { keyword: 'clphei', importance: 'low' },
        ],
      },
      now: NOW,
      casing: 'posting',
    });
    // The resume has Python, so "R or Python" is met; only Snowflake is missing, in the posting's casing.
    expect(report.skillGaps).toEqual(['Snowflake']);
    expect(report.hardSkills.matched).toEqual(['SQL', 'R or Python']);
    const shown = [...report.keywords.matched, ...report.keywords.missing, ...report.hardSkills.matched, ...report.hardSkills.missing].join(' | ').toLowerCase();
    for (const junk of ['curiosity', 'paid', 'status', "it's", 'benefits', 'fraudulent', 'angeles', "children's", 'clphei']) expect(shown).not.toContain(junk);
  });

  it('never offers frequent words of the posting as skills (zh)', () => {
    // QA (GoApply): 了解 / 协作 / 常用 / 28k / acm / 一种.
    const report = buildKeywordReport({
      resumeMarkdown: '# 林知远\n## 专业技能\n**技术：** Python · SQL\n',
      job: { title: '数据分析师', text: '了解常用的数据分析方法，熟悉 Python 与 Tableau，有 ACM 获奖经历优先。薪资 20k-28k，团队协作，是一种成长。', skills: [] },
      extraction: {
        keywords: [
          { keyword: '了解', importance: 'medium' },
          { keyword: '协作', importance: 'low' },
          { keyword: '常用', importance: 'low' },
          { keyword: '28k', importance: 'low' },
          { keyword: 'acm', importance: 'low' },
          { keyword: '一种', importance: 'low' },
          { keyword: '专业', importance: 'medium' },
        ],
      },
      now: NOW,
      casing: 'posting',
    });
    expect(report.skillGaps).toEqual(['Tableau', '数据分析']);
    expect(report.hardSkills.matched).toEqual(['Python']);
    // Only vocabulary terms the posting names: none of the frequent words.
    expect(report.keywords).toEqual({ matched: ['Python'], missing: ['Tableau', '数据分析'] });
  });

  it('a pasted posting gets the same list from the vocabulary (Snowflake, dbt, Looker)', () => {
    const report = buildKeywordReport({
      resumeMarkdown: RESUME_PY,
      job: { title: 'Analytics Engineer', text: 'We model data in Snowflake with dbt and build Looker dashboards. SQL and Python daily. NYT NYT NYT.' },
      now: NOW,
      casing: 'posting',
    });
    // A caller that does not ask for the posting's casing keeps the lower-case lists (the free tool).
    const plain = buildKeywordReport({ resumeMarkdown: RESUME_PY, job: { title: 'Analytics Engineer', text: 'Snowflake with dbt and Looker. SQL and Python daily.' }, now: NOW });
    expect(plain.skillGaps).toEqual(['dbt', 'snowflake', 'looker']);
    expect(report.keywordSource).toBe('posting');
    expect(report.skillGaps).toEqual(['dbt', 'Snowflake', 'Looker']);
    expect(report.hardSkills.matched).toEqual(['Python', 'SQL']);
    // The employer's initials are not a skill, however often they appear.
    expect(JSON.stringify(report)).not.toContain('NYT');
  });

  it('a job with its own skill list is not padded with words of its boilerplate (zh)', () => {
    const report = buildKeywordReport({
      resumeMarkdown: '# 林知远\n## 专业技能\n**技术：** Python · SQL\n',
      job: { title: '数据分析师', text: '本次招聘 3 人。配合销售团队和测试团队完成数据可视化，英语读写熟练。熟悉 Python、SQL、Tableau。', skills: ['Python', 'SQL', 'Tableau'] },
      extraction: {
        keywords: [
          { keyword: 'python', importance: 'high' },
          { keyword: 'sql', importance: 'high' },
          { keyword: 'tableau', importance: 'high' },
          { keyword: '招聘', importance: 'medium' },
          { keyword: '销售', importance: 'medium' },
          { keyword: '测试', importance: 'low' },
        ],
      },
      now: NOW,
      casing: 'posting',
    });
    expect(report.skillGaps).toEqual(['Tableau']);
    expect(report.keywords).toEqual({ matched: ['Python', 'SQL'], missing: ['Tableau'] });
    // Without stored rows the text is scanned, and still never offers the team names.
    const scanned = buildKeywordReport({
      resumeMarkdown: '# 林知远\n## 专业技能\n**技术：** Python · SQL\n',
      job: { title: '数据分析师', text: '本次招聘 3 人。配合销售团队和测试团队完成数据可视化，英语读写熟练。熟悉 Python、SQL、Tableau。', skills: ['Python', 'SQL', 'Tableau'] },
      now: NOW,
      casing: 'posting',
    });
    for (const noise of ['招聘', '销售', '测试']) expect(scanned.skillGaps).not.toContain(noise);
    expect(scanned.skillGaps).toEqual(['Tableau', '英语', '数据可视化']);
  });

  it('a pasted posting: everyday words are not skills unless the title or a name says so (EN)', () => {
    const text = 'Our team values unity. You will work with our sales and accounting teams, read our public API docs and sketch out ideas. We need SQL, Tableau and Figma.';
    const report = buildKeywordReport({ resumeMarkdown: RESUME_PY, job: { title: 'Operations Analyst', text }, now: NOW, casing: 'posting' });
    expect(report.skillGaps).toEqual(['Figma']);
    expect(report.hardSkills.matched).toEqual(['SQL', 'Tableau']);
    for (const noise of ['unity', 'sales', 'accounting', 'api', 'sketch']) expect(JSON.stringify(report).toLowerCase()).not.toContain(`"${noise}"`);

    // The same words as real requirements: the title names them, or the posting writes the tool name.
    expect(termsFromPosting('Grow sales in the region.', new Set(), 'Sales Manager')).toEqual(['sales']);
    expect(termsFromPosting('3 years building games in Unity and C#. Mockups in Sketch or Figma.')).toEqual(['c#', 'figma', 'sketch', 'unity']);
    expect(termsFromPosting('Excel, SQL and Tableau required.')).toEqual(['sql', 'excel', 'tableau']);
    expect(termsFromPosting('Excel at working with people. Unity is one of our values. Spark new ideas.')).toEqual([]);
    expect(termsFromPosting('Maintain our public API.', new Set(['api']))).toEqual(['api']);
    expect(termsFromPosting('负责招聘流程与候选人沟通。', new Set(), '招聘专员')).toEqual(['招聘']);
  });

  it('plausibleSkill / showsTerm / displayTerm', () => {
    for (const junk of ['28k', "it's", "children's", 'paid', '了解', '一种', '', '15']) expect(plausibleSkill(junk), junk).toBe(false);
    for (const ok of ['SQL', 'r', 'c++', 'A/B testing', '数据分析', 'power bi']) expect(plausibleSkill(ok), ok).toBe(true);
    expect(showsTerm('Built reports in Python.', 'R or Python')).toBe(true);
    expect(showsTerm('Built reports in Excel.', 'R or Python')).toBe(false);
    expect(displayTerm('power bi', 'Dashboards in Power BI.')).toBe('Power BI');
    expect(displayTerm('dbt', 'Models in dbt.')).toBe('dbt');
    expect(displayTerm('kubernetes', 'No mention.')).toBe('kubernetes');
  });
});

describe('buildKeywordReport', () => {
  it('builds the five rows from the job record and the stored extraction', () => {
    const report = buildKeywordReport({
      resumeMarkdown: RESUME,
      job: { title: 'Senior Backend Engineer', text: 'Payments team.', minYears: 5, educationLevel: 'bachelor', skills: ['python', 'postgresql', 'kubernetes'] },
      // 'payment' and 'status' are plain frequent words of the text (TF-IDF rows): never shown.
      extraction: {
        keywords: [
          { keyword: 'payment', importance: 'low' },
          { keyword: 'Kafka', importance: 'high' },
          { keyword: 'gRPC', importance: 'high' },
          { keyword: 'status', importance: 'medium' },
        ],
      },
      fit: { score: 78.4, tier: 'good', generatedAt: NOW, stale: false },
      now: NOW,
    });
    expect(report.rows.map((r) => [r.key, r.status])).toEqual([
      ['title', 'pass'],
      ['years', 'pass'],
      ['education', 'pass'],
      ['skills', 'warn'],
      ['keywords', 'warn'],
    ]);
    expect(report.hardSkills).toEqual({ matched: ['python', 'postgresql'], missing: ['kubernetes'] });
    expect(report.keywords.matched).toEqual(['Kafka']);
    expect(report.keywords.missing).toEqual(['gRPC']);
    expect(report.skillGaps).toEqual(['kubernetes', 'gRPC']);
    expect(report.keywordSource).toBe('extraction');
    expect(report.rows[3]!.params).toEqual({ met: 2, total: 3 });
    expect(report.fit).toEqual({ value: 78, source: 'ai', asOf: NOW.toISOString(), method: 'fit_score' });
    expect(report.fitTier).toBe('good');
    expect(report).not.toHaveProperty('score10');
  });

  it('says "unknown" instead of guessing, and drops a stale fit score', () => {
    const report = buildKeywordReport({
      resumeMarkdown: '## Experience\n- Did things.',
      job: { title: 'Data Analyst', text: 'Join us to analyse things with SQL and Tableau.' },
      fit: { score: 50, tier: 'possible', generatedAt: NOW, stale: true },
      now: NOW,
    });
    const byKey = Object.fromEntries(report.rows.map((r) => [r.key, r]));
    expect(byKey.years!.status).toBe('unknown');
    expect(byKey.education!.status).toBe('unknown');
    expect(byKey.skills!.status).toBe('fail');
    expect(report.keywordSource).toBe('posting');
    expect(report.hardSkills.missing).toEqual(expect.arrayContaining(['sql', 'tableau']));
    expect(report.fit).toBeNull();
  });

  it('fails education below the listed level and years well below', () => {
    const report = buildKeywordReport({
      resumeMarkdown: '## Experience\n### A · Analyst · 2024 – 2025\n## Education\n### 大专 · 某学院 · 2020 – 2023',
      job: { title: '数据分析师', text: '本科及以上学历，5年以上工作经验，熟悉数据分析。' },
      now: NOW,
    });
    const byKey = Object.fromEntries(report.rows.map((r) => [r.key, r]));
    expect(byKey.education!.status).toBe('fail');
    expect(byKey.years!.status).toBe('fail');
    expect(byKey.title!.status).toBe('fail');
  });
});
