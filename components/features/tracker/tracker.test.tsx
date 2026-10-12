// WP-38 UI: the /applications views, the detail drawer, follow-up facts, the
// weekly card and the add sheet. API calls are mocked at lib/api/tracker; the
// board read uses the stub V2 client (NODE_ENV=test).
// WP-93: the drawer's mounts from other areas (Tailor resume, Write a
// follow-up, Practice for this job, the resume download that records the file,
// the cover letter rows), each hidden when its flag or AI is off; and
// `/applications?entry=<id>`.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => '/applications',
}));

const api = vi.hoisted(() => ({
  listFollowUps: vi.fn(),
  getTrackerEntry: vi.fn(),
  listTrackerEvents: vi.fn(),
  listTrackerArtifacts: vi.fn(),
  addTrackerNote: vi.fn(),
  patchTrackerEntry: vi.fn(),
  createTrackerEntry: vi.fn(),
  getWeeklyInsight: vi.fn(),
  refreshWeeklyInsight: vi.fn(),
  trackerExportCsvUrl: () => 'http://api.test/api/v1/roboapply/v2/tracker/export.csv',
}));
vi.mock('../../../lib/api/tracker', () => api);

// Other areas' entry points, as stand-ins that show what they were given. The
// tailoring button keeps its own rule (it renders nothing when AI tailoring is
// off for this user): `seams.tailorAvailable` plays that answer.
const seams = vi.hoisted(() => ({
  tailorAvailable: true,
  resumes: [] as Array<{ id: string; name: string; isPrimary?: boolean }>,
  resume: null as null | Record<string, unknown>,
  resumeError: false,
  consents: null as null | { items: Array<{ type: string; granted: boolean | null }> },
  getConsents: vi.fn(),
}));
vi.mock('../tailor', () => ({
  TailorButton: (p: { jobId: string; resumeId?: string | null; from?: string; jobTitle?: string | null }) =>
    seams.tailorAvailable ? (
      <button type="button" data-testid="tailor-button" data-job={p.jobId} data-from={p.from} data-resume={p.resumeId ?? ''} data-title={p.jobTitle ?? ''}>
        Tailor resume
      </button>
    ) : null,
}));
vi.mock('../network', () => ({
  FollowUpDraftButton: (p: { jobId: string; trackerEntryId: string; companyName: string }) => (
    <button type="button" data-testid="follow-up-draft" data-job={p.jobId} data-entry={p.trackerEntryId} data-company={p.companyName}>
      Write a follow-up
    </button>
  ),
}));
vi.mock('../../v3/resume-editor/DownloadModal', () => ({
  DownloadModal: (p: { resumeId: string; resumeName: string; resumeMarkdown: string; trackerEntryId?: string | null; unverifiedClaims?: number; aiAssisted?: boolean; onClose: () => void }) => (
    <div role="dialog" aria-label="Download" data-testid="download-modal" data-resume={p.resumeId} data-entry={p.trackerEntryId ?? ''} data-claims={String(p.unverifiedClaims ?? 0)} data-ai={String(p.aiAssisted === true)}>
      {p.resumeName}
      <button type="button" onClick={p.onClose}>
        Close download
      </button>
    </div>
  ),
}));
vi.mock('../../../hooks/useResumes', () => ({
  useResumeList: () => ({ data: { resumes: seams.resumes }, isLoading: false }),
  useResume: (id: string | null) => ({ data: id && seams.resume && !seams.resumeError ? { id, ...seams.resume } : undefined, isLoading: false, isError: Boolean(id) && seams.resumeError }),
}));
vi.mock('../../../lib/api/compliance', () => ({ getConsents: seams.getConsents }));

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { RoboApiError } from '../../../lib/api/client';
import type { TrackerEntryView, WeeklyInsightResponse } from '../../../lib/api/contracts/tracker';
import ApplicationsPage from '../../../app/(auth)/applications/page';
import { AddJobSheet } from './AddJobSheet';
import { ByDateView, groupByWeek, weekOf } from './ByDateView';
import { EntryRow } from './EntryRow';
import { dayKeyOf, fromDateInput, isDateOnly, toDateInput, withTimeZone } from './shared';
import { FollowUpBanner } from './FollowUpBanner';
import { ListView } from './ListView';
import { buildPatch, formFrom, isRealChange, letterHrefFor, TrackerDrawer } from './TrackerDrawer';
import { nameCitations, shownWeek, WeeklyInsightCard } from './WeeklyInsightCard';

function entry(over: Partial<TrackerEntryView> = {}): TrackerEntryView {
  return {
    id: 'e1',
    userId: 'u1',
    jobId: 'job1',
    status: 'applied',
    excitementStars: 0,
    maxSalary: null,
    maxSalaryCurrency: null,
    notesMarkdown: null,
    dateSaved: '2026-10-01T00:00:00.000Z',
    dateApplied: '2026-10-02T00:00:00.000Z',
    deadline: null,
    followUpAt: null,
    appliedVia: 'manual',
    linkedRunId: null,
    job: { title: 'Data Analyst', companyName: 'Acme', companyLogoUrl: null, location: null, workType: 'onsite', applyUrl: 'https://acme.example/1', closed: false },
    externalSnapshot: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    source: 'feed',
    stageDetail: null,
    outcome: null,
    interviewAt: null,
    offer: null,
    tailoredVariantId: null,
    coverLetterId: null,
    ...over,
  };
}

const FACTS = { weekStart: '2026-10-04', weekEnd: '2026-10-10', applied: 3, interviews: 1, offers: 0, ended: 2, noReply10d: 1 };
function weekly(over: Partial<WeeklyInsightResponse> = {}): WeeklyInsightResponse {
  return { insight: null, facts: FACTS, week: { startUtc: '2026-10-04', endUtc: '2026-10-10' }, aiAvailable: false, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.params = new URLSearchParams();
  api.listFollowUps.mockResolvedValue({ items: [] });
  api.listTrackerEvents.mockResolvedValue({ items: [] });
  api.listTrackerArtifacts.mockResolvedValue({ items: [] });
  api.getWeeklyInsight.mockResolvedValue(weekly());
  seams.tailorAvailable = true;
  seams.resumes = [];
  seams.resume = null;
  seams.resumeError = false;
  seams.getConsents.mockImplementation(async () => seams.consents ?? { items: [] });
  seams.consents = null;
});

describe('TrackerDrawer', () => {
  it('saves only the changed fields; an outcome records who ended it', async () => {
    const e = entry();
    api.patchTrackerEntry.mockResolvedValue({ entry: { ...e, status: 'withdrawn', outcome: 'i_withdrew', notesMarkdown: 'Recruiter: Sam' } });
    renderWithBrand(<TrackerDrawer entry={e} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: 'Open the job post' })).toHaveAttribute('href', 'https://acme.example/1');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'I withdrew' }));
    fireEvent.change(within(dialog).getByLabelText('Notes'), { target: { value: 'Recruiter: Sam' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.patchTrackerEntry).toHaveBeenCalledWith('e1', { outcome: 'i_withdrew', notesMarkdown: 'Recruiter: Sam' }));
    expect(await within(dialog).findByText('Saved.')).toBeInTheDocument();
  });

  it('lists files sent and describes the history; adds a note', async () => {
    api.listTrackerArtifacts.mockResolvedValue({
      items: [{ id: 'a1', kind: 'resume', fileName: 'Jane-Doe-Resume.pdf', format: 'pdf', sha256: 'x', via: 'download', variantId: 'v1', coverLetterId: null, createdAt: '2026-10-02T00:00:00.000Z' }],
    });
    api.listTrackerEvents.mockResolvedValue({
      items: [
        { id: 'v2', kind: 'status', fromValue: 'bookmarked', toValue: 'applied', payload: null, at: '2026-10-02T00:00:00.000Z' },
        { id: 'v1', kind: 'created', fromValue: null, toValue: 'bookmarked', payload: null, at: '2026-10-01T00:00:00.000Z' },
      ],
    });
    api.addTrackerNote.mockResolvedValue({ id: 'n1', kind: 'note', fromValue: null, toValue: null, payload: { text: 'Called' }, at: '2026-10-03T00:00:00.000Z' });
    renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />);
    expect(await screen.findByText('Jane-Doe-Resume.pdf')).toBeInTheDocument();
    expect(screen.getByText(/PDF · Downloaded/)).toBeInTheDocument();
    expect(await screen.findByText('Moved from Saved to Applied')).toBeInTheDocument();
    expect(screen.getByText('Added at Saved')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Add a note to the history'), { target: { value: 'Called' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(api.addTrackerNote).toHaveBeenCalledWith('e1', { note: 'Called' }));
  });

  it('“Practice for this job” opens practice for the job', async () => {
    renderWithBrand(<TrackerDrawer entry={entry({ tailoredVariantId: 'v9' })} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Practice for this job' }));
    expect(nav.push).toHaveBeenCalledWith('/practice?job=job1&resume=v9&from=applications');
  });

  it('says when no files were recorded', async () => {
    renderWithBrand(<TrackerDrawer entry={entry({ jobId: null })} onClose={() => {}} />);
    expect(await screen.findByText(/No files recorded for this application/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Practice for this job' })).toBeNull();
  });

  it('GoApply: the cn ladder and interview rounds', async () => {
    renderWithBrand(<TrackerDrawer entry={entry({ status: 'interviewing' })} onClose={() => {}} />, { brand: 'goapply' });
    const stage = (await screen.findByLabelText('Stage')) as HTMLSelectElement;
    const options = Array.from(stage.options).map((o) => o.value);
    expect(options).toEqual(['bookmarked', 'applied', 'assessment', 'written_test', 'ai_interview', 'interviewing', 'offer', 'signed']);
    expect(screen.getByLabelText('Interview round')).toBeInTheDocument();
    fireEvent.change(stage, { target: { value: 'written_test' } });
    expect(screen.queryByLabelText('Interview round')).toBeNull();
  });
});

describe('TrackerDrawer: next steps from other areas (WP-93)', () => {
  const AI = { 'ai.text': true } as const;
  const aiConsent = (granted: boolean | null) => ({ items: [{ type: 'ai_resume_parsing', granted }] });
  const steps = async () => within(await screen.findByTestId('tracker-next-steps'));

  it('Tailor resume: mounted for the job with from="tracker" and the tailored version; hidden when AI tailoring is off', async () => {
    const a = renderWithBrand(<TrackerDrawer entry={entry({ tailoredVariantId: 'v9' })} onClose={() => {}} />, { flags: AI });
    const button = (await steps()).getByTestId('tailor-button');
    expect(button).toHaveAttribute('data-job', 'job1');
    expect(button).toHaveAttribute('data-from', 'tracker');
    expect(button).toHaveAttribute('data-resume', 'v9');
    expect(button).toHaveAttribute('data-title', 'Data Analyst');
    a.unmount();

    // The tailoring area hides its own button when AI is off for this user or brand.
    seams.tailorAvailable = false;
    renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />, { flags: AI });
    expect((await steps()).queryByTestId('tailor-button')).toBeNull();
  });

  it('Write a follow-up: mounted with the job, this application and its company (RoboApply, AI on)', async () => {
    renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />, { flags: { ...AI, hiringContacts: 'off' } });
    const button = (await steps()).getByTestId('follow-up-draft');
    expect(button).toHaveAttribute('data-job', 'job1');
    expect(button).toHaveAttribute('data-entry', 'e1');
    expect(button).toHaveAttribute('data-company', 'Acme');
    // RoboApply needs no consent read for this.
    expect(seams.getConsents).not.toHaveBeenCalled();
  });

  it('Write a follow-up is hidden when the brand has no AI text model', async () => {
    renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />, { flags: { 'ai.text': false, hiringContacts: 'on' } });
    expect((await steps()).queryByTestId('follow-up-draft')).toBeNull();
  });

  it('GoApply offers the follow-up draft under the same rule as RoboApply: AI on and the consent given, whatever the contacts mode (D5)', async () => {
    seams.consents = aiConsent(true);
    for (const hiringContacts of ['off', 'deeplinks_only', 'on'] as const) {
      const view = renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />, { brand: 'goapply', flags: { ...AI, hiringContacts } });
      expect(await screen.findByTestId('follow-up-draft')).toHaveAttribute('data-entry', 'e1');
      view.unmount();
    }
    expect(seams.getConsents).toHaveBeenCalled();
  });

  it('GoApply hides the follow-up draft while the AI consent is unknown, and when it is off', async () => {
    let release: (v: unknown) => void = () => undefined;
    seams.getConsents.mockImplementation(() => new Promise((r) => (release = r)));
    const pending = renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />, { brand: 'goapply', flags: { ...AI, hiringContacts: 'on' } });
    expect((await steps()).queryByTestId('follow-up-draft')).toBeNull();
    release(aiConsent(false));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('follow-up-draft')).toBeNull();
    pending.unmount();

    seams.getConsents.mockImplementation(async () => aiConsent(true));
    renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />, { brand: 'goapply', flags: { ...AI, hiringContacts: 'on' } });
    expect(await screen.findByTestId('follow-up-draft')).toBeInTheDocument();
  });

  it('Practice for this job stays next to them; an application with no job has no next steps at all', async () => {
    const a = renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />, { flags: AI });
    fireEvent.click((await steps()).getByRole('button', { name: 'Practice for this job' }));
    expect(nav.push).toHaveBeenCalledWith('/practice?job=job1&from=applications');
    a.unmount();

    renderWithBrand(<TrackerDrawer entry={entry({ jobId: null, job: null, externalSnapshot: { title: 'Analyst', companyName: 'Initech', applyUrl: null } })} onClose={() => {}} />, { flags: AI });
    await screen.findByRole('dialog');
    expect(screen.queryByTestId('tracker-next-steps')).toBeNull();
    expect(screen.queryByTestId('tailor-button')).toBeNull();
    expect(screen.queryByTestId('follow-up-draft')).toBeNull();
    expect(screen.queryByTestId('download-resume')).toBeNull();
  });

  it('Download the resume passes this application to the download dialog, so the exact file is recorded; the files list is read again', async () => {
    seams.resumes = [{ id: 'r_other', name: 'Old' }, { id: 'r_main', name: 'Main resume', isPrimary: true }];
    seams.resume = { name: 'Main resume', resumeMarkdown: '# Jane Doe', unverifiedClaims: 2, aiAssisted: true };
    renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />);
    await waitFor(() => expect(api.listTrackerArtifacts).toHaveBeenCalledTimes(1));
    const button = (await steps()).getByTestId('download-resume');
    // No tailored version for this job: the main resume.
    expect(button).toHaveAttribute('data-resume', 'r_main');
    expect(screen.queryByTestId('download-modal')).toBeNull();
    fireEvent.click(button);
    const modal = await screen.findByTestId('download-modal');
    expect(modal).toHaveAttribute('data-resume', 'r_main');
    expect(modal).toHaveAttribute('data-entry', 'e1');
    // Details still to verify and the AI mark travel with it (the dialog blocks or labels the file).
    expect(modal).toHaveAttribute('data-claims', '2');
    expect(modal).toHaveAttribute('data-ai', 'true');
    fireEvent.click(within(modal).getByRole('button', { name: 'Close download' }));
    await waitFor(() => expect(screen.queryByTestId('download-modal')).toBeNull());
    await waitFor(() => expect(api.listTrackerArtifacts).toHaveBeenCalledTimes(2));
  });

  it('the version tailored for this job is the one downloaded; with no resume there is no download', async () => {
    seams.resumes = [{ id: 'r_main', name: 'Main resume', isPrimary: true }];
    seams.resume = { name: 'Tailored for Acme', resumeMarkdown: '# Jane Doe' };
    const a = renderWithBrand(<TrackerDrawer entry={entry({ tailoredVariantId: 'v9' })} onClose={() => {}} />);
    fireEvent.click((await steps()).getByTestId('download-resume'));
    expect(await screen.findByTestId('download-modal')).toHaveAttribute('data-resume', 'v9');
    a.unmount();

    seams.resumes = [];
    renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />);
    expect((await steps()).queryByTestId('download-resume')).toBeNull();
  });

  it('a resume that fails to load says so and opens no dialog', async () => {
    seams.resumes = [{ id: 'r_main', name: 'Main resume', isPrimary: true }];
    seams.resumeError = true;
    renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />);
    fireEvent.click((await steps()).getByTestId('download-resume'));
    expect(await screen.findByTestId('download-resume-error')).toHaveTextContent('This part did not load.');
    expect(screen.queryByTestId('download-modal')).toBeNull();
  });
});

describe('TrackerDrawer: files and the application\'s cover letter (WP-93)', () => {
  const aiConsent = (granted: boolean | null) => ({ items: [{ type: 'ai_resume_parsing', granted }] });

  const file = (over: Record<string, unknown>) => ({ id: 'a1', kind: 'resume', fileName: 'Jane-Doe-Resume.pdf', format: 'pdf', sha256: 'x', via: 'download', variantId: 'v1', coverLetterId: null, createdAt: '2026-10-02T00:00:00.000Z', ...over });

  it('a cover letter file opens its letter with this application attached; a resume file is plain text', async () => {
    api.listTrackerArtifacts.mockResolvedValue({
      items: [file({ id: 'a2', kind: 'cover_letter', fileName: 'Jane-Doe-Cover-Letter.pdf', coverLetterId: 'cl_7', variantId: null }), file({})],
    });
    renderWithBrand(<TrackerDrawer entry={entry({ coverLetterId: 'cl_7' })} onClose={() => {}} />);
    const link = await screen.findByRole('link', { name: 'Jane-Doe-Cover-Letter.pdf' });
    expect(link).toHaveAttribute('href', '/resume/letters/cl_7?entry=e1');
    expect(link.closest('li')).toHaveAttribute('data-kind', 'cover_letter');
    expect(link.closest('li')!.textContent).toContain('Cover letter · PDF · Downloaded');
    expect(screen.getByText('Jane-Doe-Resume.pdf').closest('a')).toBeNull();
    expect(letterHrefFor({ kind: 'cover_letter', coverLetterId: 'a/b' }, 'e1')).toBe('/resume/letters/a%2Fb?entry=e1');
    expect(letterHrefFor({ kind: 'cover_letter', coverLetterId: null }, 'e1')).toBeNull();
    expect(letterHrefFor({ kind: 'resume', coverLetterId: 'cl_7' }, 'e1')).toBeNull();
  });

  it('an application holds one cover letter: the entry\'s letter is the one named, older letter files stay listed', async () => {
    api.listTrackerArtifacts.mockResolvedValue({
      items: [
        file({ id: 'a3', kind: 'cover_letter', fileName: 'Letter-v2.pdf', coverLetterId: 'cl_new', variantId: null }),
        file({ id: 'a2', kind: 'cover_letter', fileName: 'Letter-v1.pdf', coverLetterId: 'cl_old', variantId: null }),
      ],
    });
    renderWithBrand(<TrackerDrawer entry={entry({ coverLetterId: 'cl_new' })} onClose={() => {}} />);
    const attached = await screen.findByTestId('tracker-cover-letter');
    expect(attached).toHaveTextContent('Cover letter for this application');
    expect(screen.getAllByTestId('tracker-cover-letter')).toHaveLength(1);
    expect(within(attached).getByRole('link', { name: 'Open the letter' })).toHaveAttribute('href', '/resume/letters/cl_new?entry=e1');
    expect(await screen.findByRole('link', { name: 'Letter-v1.pdf' })).toHaveAttribute('href', '/resume/letters/cl_old?entry=e1');
    expect(screen.getByRole('link', { name: 'Letter-v2.pdf' })).toHaveAttribute('href', '/resume/letters/cl_new?entry=e1');
    expect(screen.queryByTestId('tracker-cover-letter-new')).toBeNull();
  });

  it('with no letter yet it offers to write one for this job and application; not when AI is off or the entry has no job', async () => {
    const a = renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />, { flags: { 'ai.text': true } });
    const offer = await screen.findByTestId('tracker-cover-letter-new');
    expect(within(offer).getByRole('link', { name: 'Write a cover letter' })).toHaveAttribute('href', '/resume/letters?jobId=job1&entry=e1');
    a.unmount();

    const b = renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />, { flags: { 'ai.text': false } });
    await screen.findByText(/No files recorded for this application/);
    expect(screen.queryByTestId('tracker-cover-letter-new')).toBeNull();
    b.unmount();

    renderWithBrand(<TrackerDrawer entry={entry({ jobId: null })} onClose={() => {}} />, { flags: { 'ai.text': true } });
    await screen.findByText(/No files recorded for this application/);
    expect(screen.queryByTestId('tracker-cover-letter-new')).toBeNull();
  });

  it('GoApply offers to write a cover letter only with the AI consent on: hidden while it is unknown and when it is off', async () => {
    let release: (v: unknown) => void = () => undefined;
    seams.getConsents.mockImplementation(() => new Promise((r) => (release = r)));
    const pending = renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />, { brand: 'goapply', flags: { 'ai.text': true } });
    // Unknown (the consent read has not answered): no AI entry point.
    await waitFor(() => expect(seams.getConsents).toHaveBeenCalled());
    expect(screen.queryByTestId('tracker-cover-letter-new')).toBeNull();
    // Off.
    release(aiConsent(false));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('tracker-cover-letter-new')).toBeNull();
    pending.unmount();

    // On: the link is offered. A letter already attached is always listed, consent or not.
    seams.getConsents.mockImplementation(async () => aiConsent(true));
    const on = renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />, { brand: 'goapply', flags: { 'ai.text': true } });
    expect(within(await screen.findByTestId('tracker-cover-letter-new')).getByRole('link')).toHaveAttribute('href', '/resume/letters?jobId=job1&entry=e1');
    on.unmount();

    seams.getConsents.mockImplementation(async () => aiConsent(false));
    renderWithBrand(<TrackerDrawer entry={entry({ coverLetterId: 'cl_7' })} onClose={() => {}} />, { brand: 'goapply', flags: { 'ai.text': true } });
    expect(within(await screen.findByTestId('tracker-cover-letter')).getByRole('link')).toHaveAttribute('href', '/resume/letters/cl_7?entry=e1');
  });
});

describe('FIX-3: tracker dates follow the reader\'s own calendar (UTC+8, 02:25 on Sunday Oct 11)', () => {
  const realTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Asia/Taipei';
  });
  afterAll(() => {
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  // "Mark applied" at 02:25 local on Sunday Oct 11 = 18:25 UTC on Saturday Oct 10.
  const CLICK = '2026-10-10T18:25:07.412Z';

  it('a moment is that reader\'s day; a picked calendar day stays that day', () => {
    expect(new Date(CLICK).getDate()).toBe(11); // the test really runs in UTC+8
    expect(dayKeyOf(CLICK)).toBe('2026-10-11');
    expect(toDateInput(CLICK)).toBe('2026-10-11'); // the drawer said 2026-10-10
    // A day picked in the drawer (or sent as a day) is not shifted by the zone.
    expect(isDateOnly('2026-10-02T00:00:00.000Z')).toBe(true);
    expect(isDateOnly('2026-10-02')).toBe(true);
    expect(isDateOnly(CLICK)).toBe(false);
    expect(toDateInput('2026-10-02T00:00:00.000Z')).toBe('2026-10-02');
    expect(toDateInput(fromDateInput('2026-10-02'))).toBe('2026-10-02');
    expect(toDateInput(null)).toBe('');
  });

  it('the row says "Applied Oct 11, 2026", the day History shows for the same click', () => {
    renderWithBrand(<EntryRow entry={entry({ dateApplied: CLICK })} onOpen={() => {}} />);
    expect(screen.getByText('Applied Oct 11, 2026')).toBeInTheDocument();
    expect(screen.queryByText(/Oct 10/)).toBeNull();
  });

  it('a picked day is shown as that day west of UTC too', () => {
    process.env.TZ = 'America/Los_Angeles';
    try {
      renderWithBrand(<EntryRow entry={entry({ dateApplied: '2026-10-02T00:00:00.000Z' })} onOpen={() => {}} />);
      expect(screen.getByText('Applied Oct 2, 2026')).toBeInTheDocument();
      expect(toDateInput('2026-10-02T00:00:00.000Z')).toBe('2026-10-02');
      // 18:25 UTC on Oct 10 is still Oct 10 in Los Angeles.
      expect(dayKeyOf(CLICK)).toBe('2026-10-10');
    } finally {
      process.env.TZ = 'Asia/Taipei';
    }
  });

  it('weeks are the reader\'s weeks: that Sunday click starts the week of Oct 11', () => {
    expect(weekOf(CLICK)).toBe('2026-10-11');
    expect(weekOf('2026-10-10T10:00:00.000Z')).toBe('2026-10-04'); // Saturday evening local
    expect(weekOf('2026-10-06T00:00:00.000Z')).toBe('2026-10-04'); // a picked day
    const groups = groupByWeek([entry({ id: 'sun', dateApplied: CLICK }), entry({ id: 'sat', dateApplied: '2026-10-10T10:00:00.000Z' })]);
    expect(groups.map((g) => [g.week, g.entries.map((e) => e.id)])).toEqual([
      ['2026-10-11', ['sun']],
      ['2026-10-04', ['sat']],
    ]);
  });

  it('"This week" asks for the reader\'s week and offers no summary while the server\'s week is a different one', async () => {
    const now = new Date('2026-10-10T18:25:00.000Z');
    expect(shownWeek(now)).toEqual({ week: '2026-10-11', sameAsServerWeek: false });
    expect(shownWeek(new Date('2026-10-07T12:00:00.000Z'))).toEqual({ week: '2026-10-04', sameAsServerWeek: true });
    api.getWeeklyInsight.mockResolvedValue(weekly({ aiAvailable: true, week: { startUtc: '2026-10-11', endUtc: '2026-10-17' } }));
    renderWithBrand(<WeeklyInsightCard entries={[]} now={now} />);
    expect(await screen.findByText('Oct 11, 2026 to Oct 17, 2026')).toBeInTheDocument();
    expect(api.getWeeklyInsight).toHaveBeenCalledWith('2026-10-11');
    expect(screen.queryByRole('button', { name: 'Write a summary' })).toBeNull();
  });
});

describe('FIX-3: the drawer', () => {
  it('GoApply: the salary currency starts from the brand (CNY), never a stored "USD" with no amount, and is saved with the first amount', async () => {
    // A row created before the fix: no amount, the database default currency.
    const e = entry({ maxSalary: null, maxSalaryCurrency: 'USD' });
    renderWithBrand(<TrackerDrawer entry={e} onClose={() => {}} />, { brand: 'goapply' });
    const dialog = await screen.findByRole('dialog');
    const currency = within(dialog).getByLabelText('Currency') as HTMLInputElement;
    expect(currency.value).toBe('CNY');
    expect(buildPatch(e, { ...formFrom(e, 'CNY') }, 'CNY')).toEqual({});
    expect(buildPatch(e, { ...formFrom(e, 'CNY'), maxSalary: '25000' }, 'CNY')).toEqual({ maxSalary: 25000, maxSalaryCurrency: 'CNY' });
    // An amount that already has a currency keeps it.
    const hkd = entry({ maxSalary: 30000, maxSalaryCurrency: 'HKD' });
    expect(buildPatch(hkd, { ...formFrom(hkd, 'CNY'), maxSalary: '32000' }, 'CNY')).toEqual({ maxSalary: 32000 });
  });

  it('RoboApply keeps USD as the starting currency', async () => {
    renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Currency') as HTMLInputElement).value).toBe('USD');
  });

  it('history: the first stage is "Added at Saved" (not "Moved from Saved to Saved") and a move to the same stage is not listed', async () => {
    api.listTrackerEvents.mockResolvedValue({
      items: [
        { id: 'ev3', kind: 'status', fromValue: 'bookmarked', toValue: 'applied', payload: { via: 'apply_click' }, at: '2026-10-10T18:25:07.412Z' },
        { id: 'ev2', kind: 'status', fromValue: 'bookmarked', toValue: 'bookmarked', payload: {}, at: '2026-10-09T10:00:00.000Z' },
        { id: 'ev1', kind: 'status', fromValue: null, toValue: 'bookmarked', payload: { via: 'save' }, at: '2026-10-08T10:00:00.000Z' },
      ],
    });
    renderWithBrand(<TrackerDrawer entry={entry()} onClose={() => {}} />);
    expect(await screen.findByText('Added at Saved')).toBeInTheDocument();
    expect(screen.getByText('Moved from Saved to Applied')).toBeInTheDocument();
    expect(screen.queryByText('Moved from Saved to Saved')).toBeNull();
    expect(isRealChange({ kind: 'status', fromValue: 'applied', toValue: 'applied', payload: {} })).toBe(false);
    expect(isRealChange({ kind: 'status', fromValue: 'applied', toValue: null, payload: { undo: true, removed: true } })).toBe(true);
    expect(isRealChange({ kind: 'note', fromValue: null, toValue: null, payload: { text: 'x' } })).toBe(true);
  });
});

describe('buildPatch', () => {
  it('maps form values to the PATCH body', () => {
    const e = entry({ status: 'rejected', outcome: 'they_said_no' });
    const base = {
      status: 'rejected',
      outcome: '',
      stageDetail: '',
      dateApplied: '2026-10-02',
      interviewAt: '',
      followUpAt: '2026-10-20',
      deadline: '',
      maxSalary: '95000',
      maxSalaryCurrency: 'usd',
      notesMarkdown: '',
    };
    expect(buildPatch(e, base)).toEqual({
      outcome: null,
      status: 'applied',
      followUpAt: '2026-10-20T00:00:00.000Z',
      maxSalary: 95000,
      maxSalaryCurrency: 'USD',
    });
  });
});

describe('FollowUpBanner (ruling C11)', () => {
  it('states the facts and opens the application', async () => {
    api.listFollowUps.mockResolvedValue({
      items: [
        { entryId: 'e2', reason: 'interview_tomorrow', at: '2026-10-11T15:00:00.000Z', days: null, companyName: 'Globex', title: 'PM' },
        { entryId: 'e1', reason: 'no_reply_10d', at: '2026-09-28T00:00:00.000Z', days: 12, companyName: 'Acme', title: 'Analyst' },
        { entryId: 'e3', reason: 'deadline_soon', at: '2026-10-11', days: 1, companyName: null, title: 'Engineer' },
      ],
    });
    const onOpen = vi.fn();
    renderWithBrand(<FollowUpBanner onOpen={onOpen} />);
    expect(await screen.findByText("1 company hasn't replied in 10 days.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Globex: interview within 24 hours' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Engineer: applications close tomorrow' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Acme: no reply for 12 days' }));
    expect(onOpen).toHaveBeenCalledWith('e1');
  });

  it('renders nothing without facts', async () => {
    const { container } = renderWithBrand(<FollowUpBanner onOpen={() => {}} />);
    await waitFor(() => expect(api.listFollowUps).toHaveBeenCalled());
    expect(container.querySelector('section')).toBeNull();
  });
});

describe('WeeklyInsightCard (ruling C40)', () => {
  it('shows real counts and no AI button without AI', async () => {
    renderWithBrand(<WeeklyInsightCard entries={[]} />);
    expect(await screen.findByText('Counted from your applications.')).toBeInTheDocument();
    expect(screen.getByText('No reply in 10+ days')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /summary/ })).toBeNull();
  });

  it('labels the AI summary, names cited applications and maps refresh errors', async () => {
    api.getWeeklyInsight.mockResolvedValue(
      weekly({
        aiAvailable: true,
        insight: { id: 'i1', weekStartUtc: '2026-10-04', summaryMarkdown: 'You applied to e1 this week.', citedTrackerIds: ['e1'], aiGenerated: true, modelUsed: 'm', generatedAt: '2026-10-10T00:00:00.000Z' },
      }),
    );
    api.refreshWeeklyInsight.mockRejectedValue(new RoboApiError('x', { status: 503, payload: { code: 'ai_unavailable' } }));
    renderWithBrand(<WeeklyInsightCard entries={[entry()]} now={new Date('2026-10-07T12:00:00.000Z')} />, { brand: 'goapply' });
    expect(await screen.findByText('You applied to Acme, Data Analyst this week.')).toBeInTheDocument();
    expect(screen.getByText(/Written by AI from your applications/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("A summary can't be written for this account right now.");
  });

  it('nameCitations drops ids it cannot name', () => {
    expect(nameCitations('See x1 and e1.', ['x1', 'e1'], [entry()])).toBe('See  and Acme, Data Analyst.');
  });
});

describe('ListView and ByDateView', () => {
  const rows = [
    entry({ id: 'a', status: 'bookmarked', dateApplied: null, updatedAt: '2026-10-05T00:00:00.000Z' }),
    entry({
      id: 'b',
      status: 'bookmarked',
      dateApplied: null,
      updatedAt: '2026-10-04T00:00:00.000Z',
      job: { title: 'PM', companyName: 'Globex', companyLogoUrl: null, location: null, workType: 'remote', applyUrl: 'https://g.example', closed: true },
    }),
    entry({ id: 'c', status: 'first_call', notesMarkdown: 'met Sam at the meetup', updatedAt: '2026-10-06T00:00:00.000Z' }),
  ];

  it('searches, filters by stage and splits saved jobs by whether the posting is open', async () => {
    const onOpen = vi.fn();
    renderWithBrand(<ListView entries={rows} onOpen={onOpen} initialStage="bookmarked" />);
    expect(screen.getByText('Showing 2 of 3')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Still open' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No longer open' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Search your applications'), { target: { value: 'meetup' } });
    expect(screen.getByText('Showing 1 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open details for Acme/ }));
    expect(onOpen).toHaveBeenCalledWith('c');
  });

  it('takes stage counts and the total from the server, and says when not all are loaded', () => {
    renderWithBrand(<ListView entries={rows} statusCounts={{ bookmarked: 120, applied: 80, applying: 5, first_call: 40 }} total={245} onOpen={() => {}} />);
    const select = screen.getByLabelText('Stage') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain('All stages (245)');
    expect(labels).toContain('Saved (120)');
    expect(labels).toContain('Applied (85)');
    expect(labels).toContain('First call (40)');
    expect(screen.getByText('Showing 3 of 245')).toBeInTheDocument();
    expect(screen.getByText('Search and filters cover your 3 most recently changed applications, out of 245.')).toBeInTheDocument();
  });

  it('groups by the week applied (or saved)', () => {
    const groups = groupByWeek([entry({ id: 'x', dateApplied: '2026-10-06T00:00:00.000Z' }), entry({ id: 'y', dateApplied: '2026-09-30T00:00:00.000Z' })]);
    expect(groups.map((g) => [g.week, g.entries.map((e) => e.id)])).toEqual([
      ['2026-10-04', ['x']],
      ['2026-09-27', ['y']],
    ]);
  });

  it('renders the weekly card above the weeks', async () => {
    renderWithBrand(<ByDateView entries={rows} onOpen={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'This week' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
  });
});

describe('AddJobSheet', () => {
  it('requires a title and company, then adds the job privately', async () => {
    api.createTrackerEntry.mockResolvedValue({ entry: entry({ id: 'new' }) });
    const onAdded = vi.fn();
    renderWithBrand(<AddJobSheet open onClose={() => {}} onAdded={onAdded} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add it' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Add a job title first.');
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Analyst' } });
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Initech' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add it' }));
    await waitFor(() =>
      expect(api.createTrackerEntry).toHaveBeenCalledWith({
        externalSnapshot: { title: 'Analyst', companyName: 'Initech', location: null, applyUrl: null },
        status: 'applied',
        source: 'manual',
      }),
    );
    expect(onAdded).toHaveBeenCalledWith('new');
  });
});

describe('/applications page', () => {
  it('withTimeZone adds the zone as one query value and leaves the link alone without one', () => {
    const url = 'http://api.test/api/v1/roboapply/v2/tracker/export.csv';
    expect(withTimeZone(url, 'Asia/Taipei')).toBe(`${url}?tz=Asia%2FTaipei`);
    expect(withTimeZone(`${url}?a=1`, 'America/Los_Angeles')).toBe(`${url}?a=1&tz=America%2FLos_Angeles`);
    expect(withTimeZone(url, null)).toBe(url);
  });

  it('shows By stage by default, no Offers tab without the flag, and the CSV link', async () => {
    renderWithBrand(<ApplicationsPage />);
    expect(screen.getByRole('tab', { name: 'By stage' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Offers' })).toBeNull();
    // The CSV link carries the reader's time zone, so the file's dates are the ones the page shows.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByRole('link', { name: 'Download as CSV' })).toHaveAttribute('href', `http://api.test/api/v1/roboapply/v2/tracker/export.csv?tz=${encodeURIComponent(zone)}`);
    for (const name of ['Saved', 'Applied', 'First call', 'Interviewing', 'Final round', 'Offer', 'Rejected']) {
      expect(await screen.findByRole('heading', { name, level: 2 })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('tab', { name: /^List/ }));
    expect(nav.replace).toHaveBeenCalledWith('/applications?view=list', { scroll: false });
  });

  it('?status=saved opens the List on Saved; Offers shows with the flag', async () => {
    nav.params = new URLSearchParams('status=saved');
    renderWithBrand(<ApplicationsPage />, { flags: { offers: true } });
    expect(screen.getByRole('tab', { name: /^List/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Offers' })).toBeInTheDocument();
    expect(((await screen.findByLabelText('Stage')) as HTMLSelectElement).value).toBe('bookmarked');
  });

  it('GoApply shows its ladder', async () => {
    renderWithBrand(<ApplicationsPage />, { brand: 'goapply' });
    for (const name of ['Assessment', 'Written test', 'AI interview', 'Signed']) {
      expect(await screen.findByRole('heading', { name, level: 2 })).toBeInTheDocument();
    }
    expect(screen.queryByRole('heading', { name: 'First call', level: 2 })).toBeNull();
  });

  it('?entry=<id> opens that application’s details', async () => {
    nav.params = new URLSearchParams('entry=cm_tr_001');
    renderWithBrand(<ApplicationsPage />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('?entry=<id> beyond the loaded entries fetches that one entry', async () => {
    api.getTrackerEntry.mockResolvedValue({ entry: entry({ id: 'old_1', job: { title: 'Ops Lead', companyName: 'Umbrella', companyLogoUrl: null, location: null, workType: 'onsite', applyUrl: 'https://u.example', closed: false } }) });
    nav.params = new URLSearchParams('entry=old_1');
    renderWithBrand(<ApplicationsPage />);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(api.getTrackerEntry).toHaveBeenCalledWith('old_1'));
    expect(await within(dialog).findByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.getAllByText(/Umbrella/).length).toBeGreaterThan(0);
  });

  it('?entry=<id> opens the drawer for the entry the link names (the Assistant\'s follow-up and reminder links)', async () => {
    api.getTrackerEntry.mockResolvedValue({ entry: entry({ id: 'te_1', job: { title: 'Data Analyst', companyName: 'Acme', companyLogoUrl: null, location: null, workType: 'onsite', applyUrl: 'https://acme.example/1', closed: false } }) });
    nav.params = new URLSearchParams('entry=te_1&view=list');
    renderWithBrand(<ApplicationsPage />);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('link', { name: 'Open the job post' })).toHaveAttribute('href', 'https://acme.example/1');
    expect(screen.getAllByText(/Acme · Data Analyst/).length).toBeGreaterThan(0);
    // Closing drops only the entry from the URL; the view stays.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/applications?view=list', { scroll: false }));
  });

  it('?entry=<id> that is not one of the user\'s applications is ignored: no details open, one plain line, the id leaves the URL', async () => {
    api.getTrackerEntry.mockRejectedValue(new RoboApiError('Not found', { status: 404, code: 'not_found' }));
    nav.params = new URLSearchParams('entry=gone_1');
    renderWithBrand(<ApplicationsPage />);
    expect(await screen.findByTestId('applications-entry-missing')).toHaveTextContent('This application could not be found.');
    expect(screen.queryByRole('dialog')).toBeNull();
    // The page itself is intact.
    expect(screen.getByRole('tab', { name: 'By stage' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'Applied', level: 2 })).toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith('/applications', { scroll: false });
    expect(api.getTrackerEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a server error', () => new RoboApiError('Server error', { status: 500, code: 'server_error' })],
    ['a timeout', () => new RoboApiError('The request timed out', { code: 'timeout' })],
    ['being offline', () => new TypeError('Failed to fetch')],
  ])('?entry=<id> that did not load because of %s is not treated as unknown: the id stays in the URL and Try again loads it', async (_name, failure) => {
    api.getTrackerEntry.mockRejectedValueOnce(failure());
    nav.params = new URLSearchParams('entry=te_9&view=list');
    renderWithBrand(<ApplicationsPage />);
    const note = await screen.findByTestId('applications-entry-load-error');
    expect(note).toHaveTextContent('This application did not load.');
    expect(screen.queryByTestId('applications-entry-missing')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // The link is kept: a refresh, or Try again, can still open the application.
    expect(nav.replace).not.toHaveBeenCalled();

    api.getTrackerEntry.mockResolvedValue({ entry: entry({ id: 'te_9' }) });
    fireEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('applications-entry-load-error')).toBeNull());
    expect(api.getTrackerEntry).toHaveBeenCalledTimes(2);
  });

  it('no ?entry= opens nothing', async () => {
    renderWithBrand(<ApplicationsPage />);
    expect(await screen.findByRole('heading', { name: 'Applied', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('applications-entry-missing')).toBeNull();
    expect(api.getTrackerEntry).not.toHaveBeenCalled();
  });
});
