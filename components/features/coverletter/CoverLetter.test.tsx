// WP-37 — cover letters UI: hub list + new-letter form, editor autosave,
// rewrite, sources, versions, AI label and the AI gate. Renders through the
// real en.json + staged English, so a missing key fails here instead of
// showing a dotted path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { RoboApiError } from '../../../lib/api/client';
import type { CoverLetterView, ListLettersResponse } from '../../../lib/api/contracts/coverletter';

const api = vi.hoisted(() => ({
  listCoverLetters: vi.fn(),
  createCoverLetter: vi.fn(),
  getCoverLetter: vi.fn(),
  patchCoverLetter: vi.fn(),
  deleteCoverLetter: vi.fn(),
  rewriteCoverLetter: vi.fn(),
  regenerateCoverLetter: vi.fn(),
  restoreCoverLetter: vi.fn(),
  coverLetterExportUrl: vi.fn((id: string, q: { format: string; trackerEntryId?: string }) => `/x/${id}/${q.format}/${q.trackerEntryId ?? ''}`),
}));
vi.mock('../../../lib/api/coverLetters', () => api);

const jobs = vi.hoisted(() => ({ getJob: vi.fn() }));
vi.mock('../../../lib/api/jobs', () => jobs);

const gate = vi.hoisted(() => ({ left: 2 as number | null }));
vi.mock('../../../hooks/shared/useCreditGate', () => ({
  useCreditGate: () => ({
    left: gate.left,
    summary: { window: 'day', remaining: gate.left ?? 0, grantRemaining: 0, resetsAt: '2026-10-11T00:00:00Z', cap: 2, used: 0 },
    run: async (fn: (key: string) => Promise<unknown>) => ({ ok: true, value: await fn('idem-key') }),
  }),
}));

vi.mock('../../../hooks/useResumes', () => ({
  useResumeList: () => ({
    isLoading: false,
    data: {
      resumes: [
        { id: 'rv_2', name: 'Data resume', isPrimary: false },
        { id: 'rv_1', name: 'Backend resume', isPrimary: true },
      ],
    },
  }),
}));

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ push: nav.push, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/resume/letters',
  useSearchParams: () => new URLSearchParams(),
}));

import { CoverLetterHub } from './CoverLetterHub';
import { CoverLetterEditor } from './CoverLetterEditor';
import { NewLetterForm } from './NewLetterForm';
import { coverLetterHref, newCoverLetterHref } from './links';
import { AUTOSAVE_MS, letterErrorKind } from '../../../hooks/coverletter/useCoverLetters';

const NOW = '2026-10-10T12:00:00.000Z';

function letterView(over: Partial<CoverLetterView> = {}): CoverLetterView {
  const body = 'Dear Hiring Manager,\n\nAt Acme Pay I led a migration of 7 Postgres clusters.\n\nSincerely,\nSam Lee';
  return {
    id: 'cl_1',
    title: 'Senior Backend Engineer · Stripe',
    jobId: 'job_1',
    resumeVariantId: 'rv_1',
    trackerEntryId: null,
    tone: 'plain',
    length: 'standard',
    locale: 'en',
    bodyMarkdown: body,
    citations: [],
    sentences: [
      { index: 1, text: 'At Acme Pay I led a migration of 7 Postgres clusters.', sources: [{ source: 'resume', ref: 'Led migration of 7 Postgres clusters to AWS Aurora.' }] },
      { index: 2, text: 'I enjoy hard problems.', sources: [{ source: 'user', ref: '' }] },
    ],
    versions: [
      { index: 0, reason: 'generated', createdAt: NOW, preview: 'Dear Hiring Manager, At Acme…', current: false },
      { index: 1, reason: 'edit', createdAt: NOW, preview: 'Dear Hiring Manager, I enjoy…', current: true },
    ],
    aiWritten: true,
    userEdited: true,
    aiAvailable: true,
    rewritesLeftToday: 19,
    postingAvailable: true,
    pdfAvailable: true,
    updatedAt: NOW,
    createdAt: NOW,
    ...over,
  };
}

const listOf = (items: ListLettersResponse['items'], aiAvailable = true): ListLettersResponse => ({ items, cursor: null, aiAvailable });
const apiError = (code: string, status: number, details?: Record<string, unknown>) =>
  new RoboApiError('x', { status, code, payload: { success: false, code, error: 'x', details } });

beforeEach(() => {
  for (const fn of Object.values(api)) if ('mockReset' in fn) fn.mockReset();
  api.coverLetterExportUrl.mockImplementation((id: string, q: { format: string; trackerEntryId?: string }) => `/x/${id}/${q.format}/${q.trackerEntryId ?? ''}`);
  jobs.getJob.mockResolvedValue({ job: { title: 'Senior Backend Engineer', companyName: 'Stripe' }, company: { name: 'Stripe' } });
  nav.push.mockReset();
  gate.left = 2;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CoverLetterHub', () => {
  it('lists letters newest first with links to the editor', async () => {
    api.listCoverLetters.mockResolvedValue(
      listOf([{ id: 'cl_1', title: 'Senior Backend Engineer · Stripe', jobId: 'job_1', trackerEntryId: null, tone: 'warm', length: 'short', locale: 'en', preview: 'Dear Hiring Manager…', updatedAt: NOW, createdAt: NOW }]),
    );
    renderWithBrand(<CoverLetterHub />);
    const link = await screen.findByRole('link', { name: 'Open Senior Backend Engineer · Stripe' });
    expect(link).toHaveAttribute('href', '/resume/letters/cl_1');
    expect(within(link).getByText(/Warm · Short/)).toBeInTheDocument();
    expect(document.querySelector('[data-ai-label]')).toBeNull(); // RoboApply: no badge
  });

  it('GoApply: every AI preview in the list carries the AI badge', async () => {
    const row = (id: string) => ({ id, title: `Letter ${id}`, jobId: 'job_1', trackerEntryId: null, tone: 'plain' as const, length: 'standard' as const, locale: 'zh', preview: '尊敬的招聘经理…', updatedAt: NOW, createdAt: NOW });
    api.listCoverLetters.mockResolvedValue(listOf([row('cl_1'), row('cl_2')]));
    renderWithBrand(<CoverLetterHub />, { brand: 'goapply' });
    const first = await screen.findByRole('link', { name: 'Open Letter cl_1' });
    expect(first.querySelector('[data-ai-label="document"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-ai-label="document"]')).toHaveLength(2);
  });

  it('shows an empty state with the write action', async () => {
    api.listCoverLetters.mockResolvedValue(listOf([]));
    renderWithBrand(<CoverLetterHub />);
    expect(await screen.findByText('No cover letters yet')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Write a cover letter' })[0]!);
    expect(screen.getByRole('heading', { name: 'Write a cover letter' })).toBeInTheDocument();
  });

  it('opens the form for ?jobId=, writes the letter with the chosen options and opens it', async () => {
    api.listCoverLetters.mockResolvedValue(listOf([]));
    api.createCoverLetter.mockResolvedValue(letterView({ id: 'cl_9' }));
    renderWithBrand(<CoverLetterHub jobId="job_1" trackerEntryId="te_1" />);
    expect(await screen.findByText('For Senior Backend Engineer at Stripe')).toBeInTheDocument();
    expect(screen.getByText(/Uses 1 of your 2 left/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^Formal/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Short/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Write the letter' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/resume/letters/cl_9?entry=te_1'));
    expect(api.createCoverLetter).toHaveBeenCalledWith(
      { jobId: 'job_1', resumeVariantId: 'rv_1', tone: 'formal', length: 'short', trackerEntryId: 'te_1' },
      { idempotencyKey: 'idem-key' },
    );
  });
});

describe('NewLetterForm', () => {
  it('pasted post: needs a title and 50+ characters before it can write', async () => {
    api.createCoverLetter.mockResolvedValue(letterView());
    const onCreated = vi.fn();
    renderWithBrand(<NewLetterForm aiAvailable onCreated={onCreated} />);
    const submit = screen.getByRole('button', { name: 'Write the letter' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Data Analyst' } });
    fireEvent.change(screen.getByLabelText('Job post'), { target: { value: 'We need weekly SQL reports for finance, and you will own the dashboards.' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createCoverLetter.mock.calls[0]![0]).toMatchObject({ jd: { title: 'Data Analyst', company: '' }, resumeVariantId: 'rv_1' });
  });

  it('AI off: explains it and offers no write action (no request)', () => {
    renderWithBrand(<NewLetterForm jobId="job_1" aiAvailable={false} onCreated={vi.fn()} />);
    expect(screen.getByText(/uses AI, which is off for your account/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write the letter' })).toBeNull();
    expect(api.createCoverLetter).not.toHaveBeenCalled();
  });

  it('explains a rejected letter and the content check in plain words', async () => {
    api.createCoverLetter.mockRejectedValueOnce(apiError('conflict', 409, { reason: 'cover_letter_claim_rejected' }));
    renderWithBrand(<NewLetterForm jobId="job_1" aiAvailable onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Write the letter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/lines your resume does not show, so the letter was not saved. No credit was used/);
    api.createCoverLetter.mockRejectedValueOnce(apiError('content_blocked', 422, { stage: 'input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Write the letter' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/content check stopped this request/));
  });

  it('GoApply: offers Chinese or English and sends the choice', async () => {
    api.createCoverLetter.mockResolvedValue(letterView());
    renderWithBrand(<NewLetterForm jobId="job_1" aiAvailable onCreated={vi.fn()} />, { brand: 'goapply' });
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write the letter' }));
    await waitFor(() => expect(api.createCoverLetter).toHaveBeenCalled());
    expect(api.createCoverLetter.mock.calls[0]![0]).toMatchObject({ locale: 'en' });
  });
});

describe('CoverLetterEditor', () => {
  it('labels the AI text, shows the GoApply badge, and never claims to send', async () => {
    api.getCoverLetter.mockResolvedValue(letterView());
    renderWithBrand(<CoverLetterEditor letterId="cl_1" />, { brand: 'goapply' });
    expect(await screen.findByText('Written from the job post and your resume.')).toBeInTheDocument();
    expect(screen.getByText(/never sends this letter/)).toBeInTheDocument();
    expect(document.querySelector('[data-ai-label="document"]')).not.toBeNull();
  });

  it('RoboApply: the AI line without the GoApply badge', async () => {
    api.getCoverLetter.mockResolvedValue(letterView());
    renderWithBrand(<CoverLetterEditor letterId="cl_1" />);
    expect(await screen.findByText('Written from the job post and your resume.')).toBeInTheDocument();
    expect(document.querySelector('[data-ai-label]')).toBeNull();
  });

  it('autosaves the text after a pause', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getCoverLetter.mockResolvedValue(letterView());
    api.patchCoverLetter.mockImplementation(async (_id: string, body: { bodyMarkdown: string }) => letterView({ bodyMarkdown: body.bodyMarkdown }));
    renderWithBrand(<CoverLetterEditor letterId="cl_1" />);
    const box = await screen.findByLabelText('Your cover letter');
    fireEvent.change(box, { target: { value: 'Dear team,\n\nNew text.' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(api.patchCoverLetter).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_MS + 10);
    });
    await waitFor(() => expect(api.patchCoverLetter).toHaveBeenCalledWith('cl_1', { bodyMarkdown: 'Dear team,\n\nNew text.' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('rewrite: quick prompt → new version; the daily limit is explained', async () => {
    api.getCoverLetter.mockResolvedValue(letterView());
    api.rewriteCoverLetter.mockResolvedValueOnce(letterView({ bodyMarkdown: 'Dear Hiring Manager,\n\nShorter.', rewritesLeftToday: 18 }));
    renderWithBrand(<CoverLetterEditor letterId="cl_1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Rewrite with AI' }));
    expect(screen.getByText(/19 rewrites left today for this letter · Rewrites do not use credits/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make it shorter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite' }));
    await waitFor(() => expect(api.rewriteCoverLetter).toHaveBeenCalledWith('cl_1', { instruction: 'Make it shorter' }));
    expect(await screen.findByDisplayValue(/Shorter\./)).toBeInTheDocument();

    api.rewriteCoverLetter.mockRejectedValueOnce(apiError('rate_limited', 429, { reason: 'cover_letter_rewrite_limit', retryAfterSec: 60 }));
    fireEvent.click(screen.getByRole('tab', { name: 'Rewrite with AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make it more formal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You can rewrite a letter 20 times a day');
  });

  it('AI off: the rewrite tab explains, the letter is still editable', async () => {
    api.getCoverLetter.mockResolvedValue(letterView({ aiAvailable: false, rewritesLeftToday: null }));
    renderWithBrand(<CoverLetterEditor letterId="cl_1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Rewrite with AI' }));
    expect(screen.getByText(/uses AI, which is off for your account/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rewrite' })).toBeNull();
    expect(screen.getByLabelText('Your cover letter')).toBeInTheDocument();
  });

  it('letter from a pasted post that was not kept: the rewrite tab explains and offers no AI action', async () => {
    api.getCoverLetter.mockResolvedValue(letterView({ jobId: null, postingAvailable: false }));
    renderWithBrand(<CoverLetterEditor letterId="cl_1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Rewrite with AI' }));
    expect(screen.getByText(/Rewriting needs the job post, and the post for this letter was not kept/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rewrite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Write a new version' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make it shorter' })).toBeNull();
    expect(api.rewriteCoverLetter).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Your cover letter')).toBeInTheDocument();
  });

  it('PDF not available for the language: the PDF button is off and Word is offered instead', async () => {
    api.getCoverLetter.mockResolvedValue(letterView({ locale: 'zh', pdfAvailable: false }));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    renderWithBrand(<CoverLetterEditor letterId="cl_1" />, { brand: 'goapply' });
    const pdf = await screen.findByRole('button', { name: 'Download PDF' });
    expect(pdf).toBeDisabled();
    expect(screen.getByText('PDF is not available for this language yet. Download Word instead.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download Word' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/x/cl_1/docx/'));
    vi.unstubAllGlobals();
  });

  it('sources show where each sentence comes from', async () => {
    api.getCoverLetter.mockResolvedValue(letterView());
    renderWithBrand(<CoverLetterEditor letterId="cl_1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Sources' }));
    expect(screen.getByText('From your resume')).toBeInTheDocument();
    expect(screen.getByText('“Led migration of 7 Postgres clusters to AWS Aurora.”')).toBeInTheDocument();
    expect(screen.getByText('Your words')).toBeInTheDocument();
  });

  it('versions: restore an older one', async () => {
    api.getCoverLetter.mockResolvedValue(letterView());
    api.restoreCoverLetter.mockResolvedValue(letterView());
    renderWithBrand(<CoverLetterEditor letterId="cl_1" />);
    fireEvent.click(await screen.findByRole('tab', { name: /Versions/ }));
    expect(screen.getByText('Showing now')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.restoreCoverLetter).toHaveBeenCalledWith('cl_1', { versionIndex: 0 }));
  });

  it('offers to attach to the application it was opened from; downloads carry the attached application', async () => {
    api.getCoverLetter.mockResolvedValue(letterView());
    api.patchCoverLetter.mockResolvedValue(letterView({ trackerEntryId: 'te_1' }));
    renderWithBrand(<CoverLetterEditor letterId="cl_1" trackerEntryId="te_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Attach to this application' }));
    await waitFor(() => expect(api.patchCoverLetter).toHaveBeenCalledWith('cl_1', { trackerEntryId: 'te_1' }));
    expect(await screen.findByText('Attached to your application')).toBeInTheDocument();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/x/cl_1/pdf/te_1'));
    vi.unstubAllGlobals();
  });

  it('a missing letter says so', async () => {
    api.getCoverLetter.mockRejectedValue(apiError('not_found', 404));
    renderWithBrand(<CoverLetterEditor letterId="nope" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This letter was not found');
  });
});

describe('helpers', () => {
  it('links', () => {
    expect(newCoverLetterHref('job 1', 'te_1')).toBe('/resume/letters?jobId=job+1&entry=te_1');
    expect(coverLetterHref('cl_1')).toBe('/resume/letters/cl_1');
  });

  it('letterErrorKind maps server answers', () => {
    expect(letterErrorKind(apiError('ai_unavailable', 503, { reason: 'content_safety_unavailable' }))).toBe('safety_unavailable');
    expect(letterErrorKind(apiError('phone_binding_required', 403))).toBe('phone_binding_required');
    expect(letterErrorKind(apiError('conflict', 409, { reason: 'posting_unavailable' }))).toBe('posting_unavailable');
    expect(letterErrorKind(apiError('conflict', 409, { reason: 'pdf_font_unavailable' }))).toBe('pdf_unavailable');
    expect(letterErrorKind(new Error('x'))).toBe('failed');
  });
});
