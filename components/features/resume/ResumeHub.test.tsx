// WP-36b — resume hub UI: tabs, base slots, primary + target title, tailored
// versions per job, the Layout panel (templates incl. the two-column
// warning), the live paper following the layout, and the export dialog
// (ruling C12 block, file-name presets, AI note, WeChat banner). Renders
// through the real en.json + staged English, so a missing key fails here.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithProviders } from '../../../__tests__/utils/renderWithProviders';
import type { ResumeSummary } from '../../../lib/api/resumes';

const api = vi.hoisted(() => ({ downloadResumeExport: vi.fn() }));
vi.mock('../../../lib/api/resumes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api/resumes')>();
  return { ...actual, downloadResumeExport: api.downloadResumeExport };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const wechat = vi.hoisted(() => ({ inWechat: false }));
vi.mock('../auth-cn', () => ({
  WechatBrowserBanner: ({ action }: { action: string }) => (wechat.inWechat ? <div data-testid={`wechat-${action}`} /> : null),
}));
vi.mock('../market', () => ({ AiGeneratedBadge: () => <span data-testid="ai-badge">AI generated</span> }));

import { BaseSlots, ResumeHubMeta, ResumeHubTabs, TailoredVersions, groupTailored, verifyDetailsHref } from './ResumeHub';
import { LayoutPanel } from './LayoutPanel';
import { resolveLayout } from './layout';
import { DownloadModal } from '../../v3/resume-editor/DownloadModal';
import { ResumePaper } from '../../v3/resume-editor/ResumePaper';
import { parseResumeMarkdown } from '../../../lib/resumeStructure';
import { RoboApiError } from '../../../lib/api/client';

const summary = (over: Partial<ResumeSummary>): ResumeSummary => ({
  id: 'r1',
  name: 'Main',
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
  api.downloadResumeExport.mockReset();
  wechat.inWechat = false;
});

describe('hub tabs and slots', () => {
  it('links Resumes and Cover letters and marks the current tab', () => {
    renderWithProviders(<ResumeHubTabs active="resumes" />);
    const nav = screen.getByRole('navigation', { name: 'Resume sections' });
    expect(within(nav).getByRole('link', { name: 'Resumes' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Cover letters' })).toHaveAttribute('href', '/resume/letters');
  });

  it('counts base resumes against 5 and says when all slots are used', () => {
    const { rerender } = renderWithProviders(<BaseSlots used={3} />);
    expect(screen.getByText('3 of 5 resumes')).toBeInTheDocument();
    rerender(<BaseSlots used={5} />);
    expect(screen.getByText(/All slots used/)).toBeInTheDocument();
  });
});

describe('ResumeHubMeta', () => {
  it('shows the primary badge, or a Make primary button', () => {
    const onMakePrimary = vi.fn();
    const { rerender } = renderWithProviders(
      <ResumeHubMeta resume={summary({ isPrimary: true })} onMakePrimary={onMakePrimary} onSaveTargetTitle={vi.fn()} />,
    );
    expect(screen.getByText('Primary')).toBeInTheDocument();
    rerender(<ResumeHubMeta resume={summary({ isPrimary: false })} onMakePrimary={onMakePrimary} onSaveTargetTitle={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Make primary' }));
    expect(onMakePrimary).toHaveBeenCalled();
  });

  it('saves the target title on Enter and reports the result', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<ResumeHubMeta resume={summary({ targetTitle: null })} onMakePrimary={vi.fn()} onSaveTargetTitle={save} />);
    const input = screen.getByLabelText("Job title you're aiming for");
    fireEvent.change(input, { target: { value: '  Data Analyst ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(save).toHaveBeenCalledWith('Data Analyst'));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });
});

describe('tailored versions per job', () => {
  const rows = [
    summary({ id: 'b1', name: 'Main' }),
    summary({ id: 't1', name: 'Acme v1', kind: 'tailored_for_jd', targetJobId: 'j1', targetJobCompany: 'Acme', targetJobTitle: 'Engineer', basedOnVariantId: 'b1', lastEditedAt: '2026-10-02T00:00:00.000Z' }),
    summary({ id: 't2', name: 'Acme v2', kind: 'tailored_for_jd', targetJobId: 'j1', targetJobCompany: 'Acme', targetJobTitle: 'Engineer', basedOnVariantId: 'b1', unverifiedClaims: 2, lastEditedAt: '2026-10-05T00:00:00.000Z' }),
    summary({ id: 't3', name: 'Globex', kind: 'tailored_for_jd', targetJobId: 'j2', targetJobCompany: 'Globex', targetJobTitle: 'Analyst', lastEditedAt: '2026-10-03T00:00:00.000Z' }),
  ];

  it('groups by job, newest first, and leaves base resumes out', () => {
    const groups = groupTailored(rows);
    expect(groups.map((g) => g.company)).toEqual(['Acme', 'Globex']);
    expect(groups[0]!.versions.map((v) => v.id)).toEqual(['t2', 't1']);
  });

  it('lists each version with its base and the details still to check', () => {
    renderWithProviders(<TailoredVersions resumes={rows} baseNames={new Map([['b1', 'Main']])} formatDate={() => 'Oct 5, 2026'} />);
    expect(screen.getByRole('heading', { name: 'Acme · Engineer' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acme v2' })).toHaveAttribute('href', '/resume/t2');
    expect(screen.getByText('2 details to check')).toBeInTheDocument();
    expect(screen.getAllByText(/From Main/)).toHaveLength(2);
  });

  describe('"Verify details" on tailored copies (INT-10)', () => {
    const versions = (over: Array<Partial<ResumeSummary>>) => over.map((o, i) => summary({ id: `t${i + 1}`, name: `Version ${i + 1}`, kind: 'tailored_for_jd', targetJobId: 'j1', targetJobCompany: 'Acme', targetJobTitle: 'Engineer', basedOnVariantId: 'b1', ...o }));

    it('a copy with details to check is marked "Verify details" and links to ?tailorSession=<id>', () => {
      renderWithProviders(
        <TailoredVersions resumes={versions([{ unverifiedClaims: 2, tailorSessionId: 'ts_42' }])} baseNames={new Map([['b1', 'Main']])} formatDate={() => 'Oct 5, 2026'} />,
      );
      const link = screen.getByRole('link', { name: 'Verify details in Version 1' });
      expect(link).toHaveTextContent('Verify details');
      expect(link).toHaveAttribute('href', '/resume?tailorSession=ts_42');
      expect(verifyDetailsHref('ts 4/2')).toBe('/resume?tailorSession=ts%204%2F2');
      // The count stays next to it.
      expect(screen.getByText('2 details to check')).toBeInTheDocument();
      // The version itself still opens in the editor.
      expect(screen.getByRole('link', { name: 'Version 1' })).toHaveAttribute('href', '/resume/t1');
    });

    it('only copies with unverified details are marked; a finished copy carries no mark even with a session id', () => {
      renderWithProviders(
        <TailoredVersions
          resumes={versions([
            { unverifiedClaims: 1, tailorSessionId: 'ts_a' },
            { unverifiedClaims: 0, tailorSessionId: 'ts_b' },
            { tailorSessionId: null },
          ])}
          baseNames={new Map()}
          formatDate={() => 'Oct 5, 2026'}
        />,
      );
      const links = screen.getAllByRole('link', { name: /^Verify details in/ });
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute('href', '/resume?tailorSession=ts_a');
      expect(screen.getByText('1 detail to check')).toBeInTheDocument();
      expect(document.querySelectorAll('[data-verify]')).toHaveLength(1);
    });

    it('a copy with details to check but no session to re-open (an older row) shows the count without a dead link', () => {
      renderWithProviders(<TailoredVersions resumes={versions([{ unverifiedClaims: 3, tailorSessionId: null }])} baseNames={new Map()} formatDate={() => ''} />);
      expect(screen.getByText('3 details to check')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /^Verify details/ })).toBeNull();
    });
  });

  it('explains the empty state', () => {
    renderWithProviders(<TailoredVersions resumes={[rows[0]!]} baseNames={new Map()} formatDate={() => ''} />);
    expect(screen.getByText(/Tailor a resume from any job/)).toBeInTheDocument();
  });
});

describe('LayoutPanel', () => {
  it('offers six templates (Campus since WP-65), Standard recommended, and warns on Two-column', () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(<LayoutPanel value={resolveLayout(null, 'a4')} defaultPage="a4" onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Template' });
    expect(within(group).getAllByRole('radio')).toHaveLength(6);
    expect(within(group).getByRole('radio', { name: /Campus/ })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: /Standard/ })).toBeChecked();
    expect(within(group).getByText('Recommended')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(within(group).getByRole('radio', { name: /Two-column/ }));
    expect(onChange).toHaveBeenCalledWith({ template: 'two_column' });
    rerender(<LayoutPanel value={resolveLayout({ template: 'two_column' }, 'a4')} defaultPage="a4" onChange={onChange} />);
    expect(screen.getByRole('note')).toHaveTextContent(/read two columns out of order/);
  });

  it('defaults the paper size by country and changes page, spacing, accent and dates', () => {
    const onChange = vi.fn();
    renderWithProviders(<LayoutPanel value={resolveLayout(null, 'a4')} defaultPage="a4" onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'A4' })).toBeChecked();
    expect(screen.getByText('Usual size where you are: A4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Letter' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Roomy' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Navy' }));
    fireEvent.change(screen.getByLabelText('Dates'), { target: { value: 'MM/YYYY' } });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([{ page: 'letter' }, { spacing: 'roomy' }, { accent: '#1f3a68' }, { dateFormat: 'MM/YYYY' }]);
  });
});

describe('ResumePaper follows the layout', () => {
  const resume = parseResumeMarkdown(
    '# Ada\n\nada@example.com\n\n## Experience\n\n### Engineer · Acme\n_March 2021 – Present_\n- Built things\n\n## Skills\n\nTypeScript · SQL\n',
  );

  it('puts skills in the sidebar for Two-column and marks the page size', () => {
    const { container } = renderWithProviders(<ResumePaper resume={resume} layout={resolveLayout({ template: 'two_column', page: 'a4' })} />);
    const paper = container.querySelector('.rb-paper')!;
    expect(paper).toHaveAttribute('data-template', 'two_column');
    expect(paper).toHaveAttribute('data-page', 'a4');
    expect(within(container.querySelector('[data-column="side"]') as HTMLElement).getByText('Skills')).toBeInTheDocument();
    expect(within(container.querySelector('[data-column="main"]') as HTMLElement).getByText('Experience')).toBeInTheDocument();
  });

  it('renders one column without a layout (unchanged editor default)', () => {
    const { container } = renderWithProviders(<ResumePaper resume={resume} />);
    expect(container.querySelector('[data-column]')).toBeNull();
  });
});

describe('DownloadModal', () => {
  it('blocks every format while details are unverified (ruling C12): plain text and Markdown are the same unchecked text', () => {
    renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown="# A" unverifiedClaims={1} onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('1 detail in this tailored resume has not been checked yet. Check it in Verify details before you download.');
    expect(screen.getByRole('button', { name: /^PDF/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^DOCX/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Plain text/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Markdown/ })).toBeDisabled();
    expect(api.downloadResumeExport).not.toHaveBeenCalled();
  });

  it('downloads with the chosen file-name preset and the application record', async () => {
    api.downloadResumeExport.mockResolvedValue({ fileName: 'x.pdf', artifactId: 'a1' });
    const onClose = vi.fn();
    renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown="# A" trackerEntryId="tr1" onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'company_role_name' } });
    fireEvent.click(screen.getByRole('button', { name: /^PDF/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.downloadResumeExport).toHaveBeenCalledWith('r1', { format: 'pdf', nameStyle: 'company_role_name', trackerEntryId: 'tr1' }, 'Main');
  });

  it('WP-65: sends the device photo with the download when one is placed', async () => {
    api.downloadResumeExport.mockResolvedValue({ fileName: 'x.pdf', artifactId: null });
    const onClose = vi.fn();
    renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown="# A" photo="data:image/jpeg;base64,AAAA" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /^PDF/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.downloadResumeExport).toHaveBeenCalledWith('r1', expect.objectContaining({ format: 'pdf', photo: 'data:image/jpeg;base64,AAAA' }), 'Main');
  });

  it('shows the C12 message when the server refuses with unverified_claims', async () => {
    api.downloadResumeExport.mockRejectedValue(
      new RoboApiError('unverified_claims', { code: 'unverified_claims', status: 409, payload: { code: 'unverified_claims', details: { count: 3 } } }),
    );
    renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown="# A" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^DOCX/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('3 details in this tailored resume have not been checked yet.');
    expect(screen.getByRole('button', { name: /^DOCX/ })).toBeDisabled();
  });

  it('notes AI-written resumes with the AI badge and shows the WeChat banner on downloads', () => {
    wechat.inWechat = true;
    renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown="# A" aiAssisted onClose={vi.fn()} />);
    expect(screen.getByTestId('ai-badge')).toBeInTheDocument();
    expect(screen.getByText(/AI wrote part of this resume/)).toBeInTheDocument();
    expect(screen.getByTestId('wechat-download')).toBeInTheDocument();
  });
});
