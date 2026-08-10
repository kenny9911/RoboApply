// AnalyzerPanel — the issue list behind the toolbar strength meter.
//
// The analyzer hands this panel an i18n key per issue, so the render site is
// where a message can still go wrong: next-intl answers a missing key with the
// dotted path itself, which reads as "resume.analyzer.issue.skills_few" on the
// screen and fails nothing. These tests render real issues through the real
// en.json bundle and assert the sentence, not the key.

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';

import { AnalyzerPanel } from '../../components/v3/resume-editor/AnalyzerPanel';
import { analyzeResume } from '../../lib/resumeAnalyzer';
import {
  blankExperience,
  blankStructuredResume,
  parseResumeMarkdown,
} from '../../lib/resumeStructure';
import { renderWithProviders } from '../utils/renderWithProviders';

const EMPTY_RESUME = parseResumeMarkdown('');

function renderPanel(markdown: string) {
  const onIntlError = vi.fn();
  const report = analyzeResume(parseResumeMarkdown(markdown));
  renderWithProviders(
    <AnalyzerPanel report={report} onJump={() => {}} onClose={() => {}} />,
    { onIntlError },
  );
  return { report, onIntlError };
}

describe('AnalyzerPanel', () => {
  it('renders translated sentences, never a raw message key', () => {
    const { report, onIntlError } = renderPanel('');

    expect(report.issues.length).toBeGreaterThan(0);
    expect(onIntlError).not.toHaveBeenCalled();
    expect(
      screen.getByText('Add your full name so recruiters know who this resume belongs to.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Write a 2-3 sentence summary. This is the first thing a recruiter reads.'),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('analyzer.issue');
  });

  it('fills the count and word placeholders from the report', () => {
    const { onIntlError } = renderPanel(
      [
        '# Ada Lovelace',
        '*ada@example.com · +1 555 0100 · London · linkedin.com/in/ada*',
        '',
        '## Summary',
        '',
        'Engineer.',
        '',
        '## Experience',
        '',
        '### Analytical Engines · Lead · 01/2020 – Present',
        '- Was responsible for various things across the team',
        '- Helped with the punch card program',
        '',
        '## Skills',
        '',
        'Mathematics, Notation',
      ].join('\n'),
    );

    expect(onIntlError).not.toHaveBeenCalled();
    // Plural arm + count, keyed off the entry's company name.
    expect(
      screen.getByText(/Analytical Engines: 2 bullets start with a passive or weak verb/),
    ).toBeInTheDocument();
    // Word count from the summary rule.
    expect(screen.getByText(/Your summary is 1 words\./)).toBeInTheDocument();
    // Skill count, singular-versus-plural handled by ICU.
    expect(screen.getByText(/You list 2 skills\./)).toBeInTheDocument();
  });

  it('labels an unnamed experience entry by position', () => {
    // What "Add a role" produces: an entry with no company and no title yet,
    // so there is nothing to put in front of the issue but its position.
    const resume = blankStructuredResume();
    resume.experiences = [blankExperience(), blankExperience()];
    const onIntlError = vi.fn();
    renderWithProviders(
      <AnalyzerPanel report={analyzeResume(resume)} onJump={() => {}} onClose={() => {}} />,
      { onIntlError },
    );

    expect(onIntlError).not.toHaveBeenCalled();
    expect(
      screen.getByText('Role 1: fill in both the company and the role title.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Role 2: fill in both the company and the role title.'),
    ).toBeInTheDocument();
  });

  it('shows the empty state when a resume has no issues', () => {
    const report = { ...analyzeResume(EMPTY_RESUME), issues: [], counts: { critical: 0, recommended: 0, optional: 0, total: 0 } };
    renderWithProviders(
      <AnalyzerPanel report={report} onJump={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByText('Nothing to fix. This resume reads clean.')).toBeInTheDocument();
  });
});
