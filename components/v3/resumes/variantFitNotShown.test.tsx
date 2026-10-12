// M2 gate (match-retrieval): a resume version's fit for its target job is the
// "With this version" number. It is shown only in tailoring, read live through
// `getVariantFit` (MARKET_STRATEGY §2.2; MKT-2F item 3). The Resumes hub, the
// Settings resume picker and the editor's quick-score meter used to print the
// stored copy (`matchScoreCached`): no label, no kind, no date, frozen at the
// last model call. The editor even fell back to the literal 72 (D3).

import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '../../../__tests__/utils/renderWithProviders';
import type { RAResumeVariantSummary } from '../../../lib/api/v2/types';
import type { RAPreferences } from '../../../lib/api/v2';

vi.mock('../../features/resume', () => ({ ResumeCheckEntry: () => null }));

import { ResumeCard } from './ResumeCard';
import { ResumeSection } from '../preferences/sections/ResumeSection';
import { EditorToolbar } from '../resume-editor/EditorToolbar';

/** A tailored version whose row still holds a stored fit of 91 (an older server, a cached list). */
const tailored = (over: Partial<RAResumeVariantSummary> = {}): RAResumeVariantSummary =>
  ({
    id: 'rv_t',
    name: 'For Acme',
    kind: 'tailored_for_jd',
    targetJobId: 'job_1',
    targetJobTitle: 'Platform Engineer',
    targetJobCompany: 'Acme',
    matchScoreCached: 91,
    isPrimary: false,
    sourceKind: 'tailor',
    lastEditedAt: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }) as RAResumeVariantSummary;

describe('a stored variant fit is not printed outside tailoring', () => {
  it('the Resumes hub card of a tailored version names the job and the edit time, and no number', () => {
    const { container } = renderWithProviders(<ResumeCard resume={tailored()} version="v2" editedLabel="Edited today" baseLabel="Main" onOpen={() => {}} />);
    expect(screen.getByText(/Acme · Platform Engineer/)).toBeInTheDocument();
    expect(screen.getByText('Edited today')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/91|\/100/);
    expect(container.querySelector('.rb-card-score')).toBeNull();
  });

  it('the Settings resume picker names the target company and no number', () => {
    const p = { defaultResumeId: 'rv_t' } as unknown as RAPreferences;
    const { container } = renderWithProviders(<ResumeSection p={p} set={() => {}} resumes={[tailored(), tailored({ id: 'rv_b', name: 'Main', kind: 'base', targetJobCompany: null, targetJobTitle: null, matchScoreCached: 77 })]} />);
    expect(screen.getByText('→ Acme')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/91|77|\/100/);
  });

  it('the editor shows its quick score only when the resume was analysed: no meter for null, never a stand-in number', () => {
    const props = { name: 'For Acme', onRename: () => {}, saveState: 'saved' as const, coachOpen: false, onToggleCoach: () => {}, onDownload: () => {}, onTailor: () => {}, onDelete: () => {}, onBack: () => {} };
    const { container, rerender } = renderWithProviders(<EditorToolbar {...props} strength={null} report={null} />);
    expect(container.querySelector('.rb-strength')).toBeNull();
    expect(container.textContent).not.toMatch(/72|91/);
    rerender(<EditorToolbar {...props} strength={64} report={null} />);
    expect(container.querySelector('.rb-strength-num')?.textContent).toBe('64');
  });
});
