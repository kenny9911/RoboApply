import { describe, it, expect } from 'vitest';
import {
  parseResumeMarkdown,
  serializeResumeMarkdown,
} from '../../lib/resumeStructure';
import { analyzeResume } from '../../lib/resumeAnalyzer';
import { formatDateString } from '../../lib/resumeTheme';

const SAMPLE = `# David Poole
*AI Software Engineer · david.poole@example.com · (555) 123-4567 · San Francisco, CA · linkedin.com/in/dpoole*

## Summary

AI-focused software engineer with 6 years building production ML systems. Shipped retrieval, evaluation, and inference platforms used by millions.

## Experience

### Stability AI · Senior ML Engineer · 04/2022 – Present
- Led research projects exploring transformer architectures for multilingual language models, resulting in a paper accepted by a top AI conference (ICLR 2024).
- Developed innovative reinforcement learning algorithms to improve robotic manipulation tasks, achieving a 25% increase in task success rates.

### DataTech · ML Scientist · 09/2018 – 03/2022
- Conducted research on generative adversarial networks (GANs) for realistic image synthesis and domain adaptation.

## Education

### National Taiwan University · PhD Computer Science · 09/2015 – 06/2019

## Skills

Python · PyTorch · vLLM · LLM evaluation
`;

describe('resumeStructure', () => {
  it('parses Teal-style markdown into structured fields', () => {
    const s = parseResumeMarkdown(SAMPLE);
    expect(s.contact.fullName).toBe('David Poole');
    expect(s.contact.email).toBe('david.poole@example.com');
    expect(s.contact.phone).toContain('555');
    expect(s.contact.location).toContain('San Francisco');
    expect(s.contact.links.length).toBeGreaterThan(0);
    expect(s.summary).toMatch(/AI-focused software engineer/);
    expect(s.experiences.length).toBe(2);
    expect(s.experiences[0].company).toBe('Stability AI');
    expect(s.experiences[0].bullets.length).toBe(2);
    expect(s.experiences[0].startDate).toBe('04/2022');
    expect(s.experiences[0].endDate).toBe('Present');
    expect(s.education.length).toBe(1);
    expect(s.skills.length).toBe(4);
  });

  it('round-trips through serializer without losing data', () => {
    const s = parseResumeMarkdown(SAMPLE);
    const md = serializeResumeMarkdown(s);
    const s2 = parseResumeMarkdown(md);
    expect(s2.contact.fullName).toBe(s.contact.fullName);
    expect(s2.contact.email).toBe(s.contact.email);
    expect(s2.experiences.length).toBe(s.experiences.length);
    expect(s2.experiences[0].company).toBe(s.experiences[0].company);
    expect(s2.experiences[0].bullets.length).toBe(s.experiences[0].bullets.length);
    expect(s2.skills.length).toBe(s.skills.length);
  });

  it('analyzer flags missing summary as critical', () => {
    const s = parseResumeMarkdown(SAMPLE);
    s.summary = '';
    const report = analyzeResume(s);
    expect(report.counts.critical).toBeGreaterThan(0);
    expect(report.issues.some((i) => i.id === 'summary.missing')).toBe(true);
  });

  it('formatDateString reformats numeric dates per theme', () => {
    expect(formatDateString('04/2022', 'MM/YYYY')).toBe('04/2022');
    expect(formatDateString('04/2022', 'Mon YYYY')).toBe('Apr 2022');
    expect(formatDateString('04/2022', 'YYYY')).toBe('2022');
    expect(formatDateString('Present', 'MM/YYYY')).toBe('Present');
    expect(formatDateString('present', 'YYYY')).toBe('Present');
    expect(formatDateString('', 'MM/YYYY')).toBe('');
    expect(formatDateString('Apr 2022', 'MM/YYYY')).toBe('Apr 2022');
  });

  it('analyzer rewards quantified bullets with a higher score', () => {
    const s = parseResumeMarkdown(SAMPLE);
    const withNumbers = analyzeResume(s);
    s.experiences[0].bullets = ['Did things', 'Was responsible for stuff'];
    s.experiences[1].bullets = ['Worked on projects'];
    const withoutNumbers = analyzeResume(s);
    expect(withNumbers.score).toBeGreaterThan(withoutNumbers.score);
  });
});
