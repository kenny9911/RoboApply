// WP-38 UI: the /applications views, the detail drawer, follow-up facts, the
// weekly card and the add sheet. API calls are mocked at lib/api/tracker; the
// board read uses the stub V2 client (NODE_ENV=test).

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { RoboApiError } from '../../../lib/api/client';
import type { TrackerEntryView, WeeklyInsightResponse } from '../../../lib/api/contracts/tracker';
import ApplicationsPage from '../../../app/(auth)/applications/page';
import { AddJobSheet } from './AddJobSheet';
import { ByDateView, groupByWeek } from './ByDateView';
import { FollowUpBanner } from './FollowUpBanner';
import { ListView } from './ListView';
import { buildPatch, TrackerDrawer } from './TrackerDrawer';
import { nameCitations, WeeklyInsightCard } from './WeeklyInsightCard';

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
    renderWithBrand(<WeeklyInsightCard entries={[entry()]} />, { brand: 'goapply' });
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
  it('shows By stage by default, no Offers tab without the flag, and the CSV link', async () => {
    renderWithBrand(<ApplicationsPage />);
    expect(screen.getByRole('tab', { name: 'By stage' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Offers' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Download as CSV' })).toHaveAttribute('href', 'http://api.test/api/v1/roboapply/v2/tracker/export.csv');
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

  it('?entry=<id> that no longer exists says so', async () => {
    api.getTrackerEntry.mockRejectedValue(new RoboApiError('Not found', { status: 404, code: 'not_found' }));
    nav.params = new URLSearchParams('entry=gone_1');
    renderWithBrand(<ApplicationsPage />);
    expect(await screen.findByText('This application could not be found.')).toBeInTheDocument();
  });
});
