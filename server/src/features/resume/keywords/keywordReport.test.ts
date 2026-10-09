// @vitest-environment node
//
// WP-22: the deterministic keyword report (F-RES-08). No second scale: the
// only score is the MATCH row's 0–100 fit score as a Sourced value, or null.

import { describe, expect, it } from 'vitest';
import { parseResume } from '../check/resumeText.js';
import { buildKeywordReport, educationFrom, requiredYearsFrom, resumeEducation, resumeYears, termsFromPosting } from './keywordReport.js';

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

describe('buildKeywordReport', () => {
  it('builds the five rows from the job record and the stored extraction', () => {
    const report = buildKeywordReport({
      resumeMarkdown: RESUME,
      job: { title: 'Senior Backend Engineer', text: 'Payments team.', minYears: 5, educationLevel: 'bachelor', skills: ['python', 'postgresql', 'kubernetes'] },
      extraction: { keywords: [{ keyword: 'payment', importance: 'low' }, { keyword: 'Kafka', importance: 'high' }, { keyword: 'gRPC', importance: 'medium' }] },
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
    expect(report.keywords.matched).toEqual(['Kafka', 'payment']);
    expect(report.keywords.missing).toEqual(['gRPC']);
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
