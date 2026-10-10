// WP-36b — /resume hub page: base resumes vs tailored versions, the 5-slot
// limit, primary first, and no LinkedIn door on GoApply.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import { renderWithProviders } from '../../../__tests__/utils/renderWithProviders';
import type { ResumeSummary } from '../../../lib/api/resumes';

const state = vi.hoisted(() => ({ resumes: [] as unknown[], market: 'intl' as 'intl' | 'cn', setPrimary: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../../../lib/brand', () => ({ useBrand: () => ({ id: state.market === 'cn' ? 'goapply' : 'roboapply', market: state.market }) }));
vi.mock('../../../hooks/useResumes', () => {
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useResumeList: () => ({ data: { resumes: state.resumes }, isLoading: false, isError: false, refetch: vi.fn() }),
    useCreateResumeMutation: mut,
    useUploadResumeMutation: mut,
    useImportLinkedInMutation: mut,
    useDeleteResumeMutation: mut,
    useSetPrimaryResumeMutation: () => ({ mutate: state.setPrimary, isPending: false }),
  };
});
// The per-card resume check entry is WP-22's; keep it out of this page test.
vi.mock('./ResumeCheckEntry', () => ({ ResumeCheckEntry: () => null, resumeCheckHref: () => '' }));

import ResumesPage from '../../../app/(auth)/resume/page';

const row = (over: Partial<ResumeSummary>): ResumeSummary => ({
  id: 'r',
  name: 'Resume',
  kind: 'base',
  targetJobId: null,
  targetJobTitle: null,
  targetJobCompany: null,
  matchScoreCached: null,
  isPrimary: false,
  sourceKind: 'upload',
  lastEditedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  state.market = 'intl';
  state.setPrimary.mockReset();
  state.resumes = [
    row({ id: 'b1', name: 'Older base', lastEditedAt: '2026-10-03T00:00:00.000Z' }),
    row({ id: 'b2', name: 'Primary base', isPrimary: true, targetTitle: 'Analyst' }),
    row({ id: 't1', name: 'For Acme', kind: 'tailored_for_jd', targetJobId: 'j1', targetJobCompany: 'Acme', targetJobTitle: 'Engineer', basedOnVariantId: 'b2' }),
  ];
});

describe('/resume hub', () => {
  it('shows tabs, counts only base resumes, puts the primary first and lists tailored versions per job', () => {
    renderWithProviders(<ResumesPage />);
    expect(screen.getByRole('link', { name: 'Cover letters' })).toHaveAttribute('href', '/resume/letters');
    expect(screen.getByText('2 of 5 resumes')).toBeInTheDocument();
    const cards = screen.getAllByRole('button', { name: /base/i }).filter((b) => b.classList.contains('rb-card'));
    expect(cards[0]).toHaveTextContent('Primary base');
    expect(screen.getByText('Aimed at Analyst')).toBeInTheDocument();
    const tailored = screen.getByRole('region', { name: 'Versions for specific jobs' });
    expect(within(tailored).getByRole('link', { name: 'For Acme' })).toBeInTheDocument();
    expect(within(tailored).getByText(/From Primary base/)).toBeInTheDocument();
  });

  it('makes another resume primary', () => {
    renderWithProviders(<ResumesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Make primary' }));
    expect(state.setPrimary).toHaveBeenCalledWith('b1');
  });

  it('with 5 base resumes, a create card explains the limit instead of opening an import', () => {
    state.resumes = Array.from({ length: 5 }, (_, i) => row({ id: `b${i}`, name: `Base ${i}` }));
    renderWithProviders(<ResumesPage />);
    expect(screen.getByText(/All slots used/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Upload a resume/ }));
    expect(screen.getByText(/You can keep up to 5 resumes\. Delete one to add another\./)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers the LinkedIn PDF door on RoboApply only', () => {
    const { unmount } = renderWithProviders(<ResumesPage />);
    expect(screen.getByRole('button', { name: /Import from LinkedIn/ })).toBeInTheDocument();
    unmount();
    state.market = 'cn';
    renderWithProviders(<ResumesPage />);
    expect(screen.queryByRole('button', { name: /Import from LinkedIn/ })).toBeNull();
  });
});
