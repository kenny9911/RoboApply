// WP-78 visitor UI:
//   VisitorFeed      ≤ 20 public cards, never a score, the signup gate after the
//                    list, empty/error states, nothing when `jobs.feed` is off,
//                    the alerts link (jobs.alerts + notify.email), the assistant
//                    launcher only for signed-out visitors on RoboApply with the flag
//   VisitorAssistant one SSE turn with the page context, streamed text replaced by
//                    the guarded final text, AI label, job cards open public pages,
//                    rate limit → signup prompt, seeker cards dropped
//   JobAlertsForm    off → "not available", validation (email, consent), the filters
//                    sent, the same "check your inbox" answer, rate limit message
//   AlertConfirm     read without change → Confirm → on; invalid link; left list

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getPublicFeed: vi.fn(),
  sendVisitorTurn: vi.fn(),
  createAnonAlert: vi.fn(),
  confirmAnonAlert: vi.fn(),
  submitAnonAlertConfirm: vi.fn(),
  unsubscribeAnonAlert: vi.fn(),
}));
const auth = vi.hoisted(() => ({ status: 'unauthenticated' as 'loading' | 'authenticated' | 'unauthenticated' }));

vi.mock('../../../../lib/api/visitor', () => api);
vi.mock('../../../../lib/auth/useAuth', () => ({ useAuth: () => ({ status: auth.status, user: auth.status === 'authenticated' ? { id: 'u1' } : null }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/browse/data-analyst/taipei',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import { RoboApiError } from '../../../../lib/api/client';
import type { CopilotSseEvent } from '../../../../lib/api/contracts/copilot';
import type { VisitorFeedItem } from '../../../../lib/api/contracts/visitor';
import { AlertConfirm, JobAlertsForm, VisitorAssistant, VisitorFeed } from '..';
import { alertFilters, alertsHref, filtersLabel, looksLikeEmail, signupHref, visitorJobHref } from '../model';
import { intlErrors, renderVisitor } from './render';

function item(i: number, extra: Partial<VisitorFeedItem> = {}): VisitorFeedItem {
  return {
    jobId: `j${i}`,
    title: `Data Analyst ${i}`,
    company: { id: null, name: `Acme ${i}`, logoUrl: null },
    location: 'Taipei',
    workModel: 'hybrid',
    employmentType: null,
    seniority: null,
    pay: null,
    postedAt: '2026-10-08T00:00:00.000Z',
    lastSeenAt: '2026-10-10T00:00:00.000Z',
    source: { name: 'Acme', kind: 'ats_public' },
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: false,
    badges: [],
    campus: null,
    position: null,
    path: `/job/j${i}-data-analyst`,
    ...extra,
  };
}

const FEED_ON = { 'jobs.feed': true } as const;

beforeEach(() => {
  intlErrors.length = 0;
  auth.status = 'unauthenticated';
  for (const f of Object.values(api)) f.mockReset();
});

afterEach(() => {
  cleanup();
  expect(intlErrors).toEqual([]);
});

// ── VisitorFeed ──────────────────────────────────────────────────────────

describe('VisitorFeed', () => {
  it('lists at most 20 public jobs with facts only, then the signup gate', async () => {
    api.getPublicFeed.mockResolvedValue({
      items: Array.from({ length: 25 }, (_, i) => item(i, i === 0 ? { pay: { min: 120000, max: 150000, currency: 'USD', period: 'year', text: null } } : {})),
      asOf: '2026-10-10T08:00:00.000Z',
    });
    renderVisitor(<VisitorFeed from="browse" query={{ role: ' Data analyst ', city: 'Taipei', country: 'TW' }} />, { flags: FEED_ON });
    const list = await screen.findByRole('list', { name: 'Recent public jobs' });
    expect(api.getPublicFeed).toHaveBeenCalledWith({ role: 'Data analyst', city: 'Taipei', country: 'TW' });
    expect(within(list).getAllByRole('article')).toHaveLength(20);
    expect(within(list).getByRole('link', { name: 'Data Analyst 0' })).toHaveAttribute('href', '/job/j0-data-analyst');
    expect(within(list).getAllByText('Pay not listed')).toHaveLength(19);
    expect(within(list).getByText(/\$120K.*\$150K a year/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d+ ?\/ ?100|Great fit|Good fit|%/);
    const gate = document.querySelector('[data-gate="signup"]')!;
    expect(within(gate as HTMLElement).getByRole('link', { name: 'Create a free account' })).toHaveAttribute('href', '/signup?from=browse');
    expect(within(gate as HTMLElement).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=%2Fbrowse%2Fdata-analyst%2Ftaipei');
    // The gate comes after the list.
    expect(list.compareDocumentPosition(gate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders nothing when jobs.feed is off (and asks for nothing)', () => {
    const { container } = renderVisitor(<VisitorFeed from="browse" />, { flags: {} });
    expect(container).toBeEmptyDOMElement();
    expect(api.getPublicFeed).not.toHaveBeenCalled();
  });

  it('empty and error states; retry asks again', async () => {
    api.getPublicFeed.mockResolvedValueOnce({ items: [], asOf: '2026-10-10T08:00:00.000Z' });
    renderVisitor(<VisitorFeed from="browse" />, { flags: FEED_ON });
    expect(await screen.findByText('No public jobs for this page right now.')).toBeInTheDocument();
    cleanup();
    api.getPublicFeed.mockRejectedValueOnce(new Error('down'));
    api.getPublicFeed.mockRejectedValueOnce(new Error('down'));
    api.getPublicFeed.mockResolvedValueOnce({ items: [item(1)], asOf: '2026-10-10T08:00:00.000Z' });
    renderVisitor(<VisitorFeed from="browse" />, { flags: FEED_ON });
    // One automatic retry first (1 s), then the error with a Try again button.
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }, { timeout: 4000 }));
    expect(await screen.findByRole('link', { name: 'Data Analyst 1' })).toBeInTheDocument();
  });

  it('GoApply items without a public page link to signup that then opens the job', async () => {
    api.getPublicFeed.mockResolvedValue({ items: [item(3, { path: null })], asOf: '' });
    renderVisitor(<VisitorFeed from="campus" />, { brand: 'goapply', flags: FEED_ON });
    expect(await screen.findByRole('link', { name: 'Data Analyst 3' })).toHaveAttribute('href', '/signup?from=campus&next=%2Fjobs%2Fj3');
  });

  it('alerts link only with jobs.alerts and notify.email; carries the search', async () => {
    api.getPublicFeed.mockResolvedValue({ items: [item(1)], asOf: '' });
    renderVisitor(<VisitorFeed from="browse" query={{ role: 'Nurse', city: 'Taichung', country: 'TW' }} />, { flags: { ...FEED_ON, 'jobs.alerts': true } });
    await screen.findByRole('link', { name: 'Data Analyst 1' });
    expect(screen.queryByText('Get new jobs like these by email')).toBeNull();
    cleanup();
    renderVisitor(<VisitorFeed from="browse" query={{ role: 'Nurse', city: 'Taichung', country: 'TW' }} />, { flags: { ...FEED_ON, 'jobs.alerts': true, 'notify.email': true } });
    expect(await screen.findByRole('link', { name: 'Get new jobs like these by email' })).toHaveAttribute('href', '/tools/job-alerts?role=Nurse&city=Taichung&country=TW');
  });

  it('assistant launcher: flag on + signed out + RoboApply only', async () => {
    api.getPublicFeed.mockResolvedValue({ items: [item(1)], asOf: '' });
    renderVisitor(<VisitorFeed from="browse" />, { flags: { ...FEED_ON, visitorAssistant: true } });
    expect(await screen.findByRole('button', { name: 'Ask about these jobs' })).toBeInTheDocument();
    cleanup();
    renderVisitor(<VisitorFeed from="browse" />, { flags: FEED_ON });
    await screen.findByRole('link', { name: 'Data Analyst 1' });
    expect(screen.queryByRole('button', { name: 'Ask about these jobs' })).toBeNull();
    cleanup();
    renderVisitor(<VisitorFeed from="browse" />, { brand: 'goapply', flags: { ...FEED_ON, visitorAssistant: true } });
    await screen.findByRole('link', { name: 'Data Analyst 1' });
    expect(screen.queryByRole('button', { name: 'Ask about these jobs' })).toBeNull();
    cleanup();
    auth.status = 'authenticated';
    renderVisitor(<VisitorFeed from="browse" />, { flags: { ...FEED_ON, visitorAssistant: true } });
    await screen.findByRole('link', { name: 'Data Analyst 1' });
    expect(screen.queryByRole('button', { name: 'Ask about these jobs' })).toBeNull();
    // Signed in: no signup gate, a way back to the app.
    expect(screen.getByRole('link', { name: 'Open your jobs' })).toHaveAttribute('href', '/jobs');
    expect(screen.queryByRole('link', { name: 'Create a free account' })).toBeNull();
  });

  it('badges only from real fields and quotes', async () => {
    api.getPublicFeed.mockResolvedValue({
      items: [
        item(1, {
          fromRecruiterBank: true,
          employerVerified: true,
          source: { name: 'RoboHire', kind: 'bank' },
          badges: [
            { kind: 'sponsorship', label: 'sponsorship', quote: 'We sponsor H-1B visas.' },
            { kind: 'clearance_required', label: 'clearance' },
          ],
        }),
      ],
      asOf: '',
    });
    renderVisitor(<VisitorFeed from="browse" />, { flags: FEED_ON });
    expect(await screen.findByText('Direct from employer')).toBeInTheDocument();
    expect(screen.getByText('Visa sponsorship mentioned')).toHaveAttribute('title', 'We sponsor H-1B visas.');
    expect(screen.queryByText('Security clearance required')).toBeNull();
    expect(screen.queryByText(/by a recruiter/)).toBeNull();
  });
});

// ── VisitorAssistant ─────────────────────────────────────────────────────

describe('VisitorAssistant', () => {
  const ctx = { path: '/browse/data-analyst', role: 'Data analyst' };

  function stream(events: CopilotSseEvent[]) {
    api.sendVisitorTurn.mockImplementation(async (_body: unknown, opts: { onEvent: (e: CopilotSseEvent) => void }) => {
      for (const e of events) opts.onEvent(e);
    });
  }

  it('asks with the page context, shows the guarded answer with an AI label and public job links', async () => {
    stream([
      { event: 'meta', data: { threadId: 'visitor', messageId: 'm1' } },
      { event: 'tool', data: { id: 't1', name: 'search_jobs', phase: 'start' } },
      { event: 'tool', data: { id: 't1', name: 'search_jobs', phase: 'end', ok: true } },
      { event: 'card', data: { type: 'job_list', id: 'c1', data: { items: [item(7, { path: undefined as never })], visitor: true } } },
      { event: 'card', data: { type: 'fit_analysis', id: 'c2', data: { score: 90 } } },
      { event: 'delta', data: { text: 'Two remote jobs. You fit 90%.' } },
      { event: 'done', data: { messageId: 'm1', usage: { inputTokens: 1, outputTokens: 1 }, creditsRemaining: null, content: 'Two remote jobs.', guarded: true } },
    ]);
    renderVisitor(<VisitorAssistant pageContext={ctx} from="browse" />, { flags: { visitorAssistant: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask about these jobs' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Answers are written by AI and can be wrong. Nothing you type here is saved.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Which of these jobs can be done remotely?' }));
    expect(await within(dialog).findByText('Two remote jobs.')).toBeInTheDocument();
    expect(api.sendVisitorTurn).toHaveBeenCalledWith({ text: 'Which of these jobs can be done remotely?', pageContext: ctx }, expect.objectContaining({ onEvent: expect.any(Function) }));
    expect(within(dialog).queryByText(/90%/)).toBeNull();
    expect(within(dialog).getByText('AI answer')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Data Analyst 7' })).toHaveAttribute('href', '/job/j7');
  });

  it('typing and Enter sends; rate limit shows the signup prompt', async () => {
    api.sendVisitorTurn.mockRejectedValue(new RoboApiError('limit', { code: 'rate_limited', status: 429, payload: { code: 'rate_limited' } }));
    renderVisitor(<VisitorAssistant pageContext={ctx} from="browse" />, { flags: { visitorAssistant: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask about these jobs' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Your question');
    fireEvent.change(input, { target: { value: 'What do analysts earn?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await within(dialog).findByText("That's the limit for questions without an account. Create a free account to keep asking.")).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Create a free account' })).toHaveAttribute('href', '/signup?from=browse-assistant');
  });

  it('unavailable and stream errors read plainly', async () => {
    api.sendVisitorTurn.mockRejectedValueOnce(new RoboApiError('x', { code: 'ai_unavailable', status: 503, payload: { code: 'ai_unavailable' } }));
    renderVisitor(<VisitorAssistant pageContext={ctx} from="browse" />, { flags: { visitorAssistant: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask about these jobs' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'How does RoboApply work?' }));
    expect(await within(dialog).findByText('The assistant is not available right now.')).toBeInTheDocument();
    stream([{ event: 'error', data: { code: 'internal_error', message: 'x', retryable: true } }]);
    fireEvent.change(within(dialog).getByLabelText('Your question'), { target: { value: 'Hello?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await within(dialog).findByText('Something went wrong. Try again.')).toBeInTheDocument();
  });
});

// ── JobAlertsForm ────────────────────────────────────────────────────────

describe('JobAlertsForm', () => {
  const ON = { 'jobs.alerts': true, 'notify.email': true } as const;

  it('says it is not available when alerts or email are off', () => {
    renderVisitor(<JobAlertsForm />, { flags: { 'jobs.alerts': true } });
    expect(screen.getByText('Job alerts by email are not available here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send confirmation email' })).toBeNull();
  });

  it('checks the address and the (unticked) consent, then sends the search and shows the same answer', async () => {
    api.createAnonAlert.mockResolvedValue({ status: 'pending_confirmation' });
    renderVisitor(<JobAlertsForm initial={{ role: 'Nurse', city: 'Taichung', country: 'TW' }} />, { flags: ON });
    expect(screen.getByLabelText('Job title or keywords')).toHaveValue('Nurse');
    expect(screen.getByLabelText('Country or region')).toHaveValue('TW');
    const consent = screen.getByLabelText(/Email me new jobs for this search/);
    expect(consent).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation email' }));
    expect(await screen.findByText(/Enter a valid email address/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation email' }));
    expect(await screen.findByText('Tick the box to agree to these emails.')).toBeInTheDocument();
    expect(api.createAnonAlert).not.toHaveBeenCalled();
    fireEvent.click(consent);
    fireEvent.click(screen.getByLabelText('Once a day'));
    fireEvent.click(screen.getByLabelText('Remote jobs only'));
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation email' }));
    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
    expect(api.createAnonAlert).toHaveBeenCalledWith({
      email: 'me@example.com',
      filters: { q: 'Nurse', locations: [{ label: 'Taichung', city: 'Taichung', country: 'TW' }], workModels: ['remote'] },
      frequency: 'daily',
      locale: 'en',
      consent: true,
    });
    expect(screen.getByText(/If me@example.com can get alerts/)).toBeInTheDocument();
  });

  it('rate limit reads plainly and keeps the form', async () => {
    api.createAnonAlert.mockRejectedValue(new RoboApiError('x', { code: 'rate_limited', status: 429, payload: { code: 'rate_limited' } }));
    renderVisitor(<JobAlertsForm />, { flags: ON });
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByLabelText(/Email me new jobs for this search/));
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many sign-ups from this network today. Try again tomorrow.');
    expect(screen.getByRole('button', { name: 'Send confirmation email' })).toBeEnabled();
  });

  it('GoApply offers only mainland China as a region', () => {
    renderVisitor(<JobAlertsForm />, { brand: 'goapply', flags: ON });
    const options = within(screen.getByLabelText('Country or region')).getAllByRole('option');
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'CN']);
  });
});

// ── AlertConfirm ─────────────────────────────────────────────────────────

describe('AlertConfirm', () => {
  const TOKEN = 'tok-abcdefghijklmnopqrstuvwxyz';
  const view = (state: 'pending' | 'confirmed' | 'unsubscribed') => ({ state, cadence: 'weekly', filters: { q: 'Nurse', country: 'TW' }, emailMasked: 'm•••@example.com' });

  it('reads the link without changing it, then confirms on a press', async () => {
    api.confirmAnonAlert.mockResolvedValue(view('pending'));
    api.submitAnonAlertConfirm.mockResolvedValue(view('confirmed'));
    renderVisitor(<AlertConfirm token={TOKEN} />);
    expect(await screen.findByText('Confirm your job alerts')).toBeInTheDocument();
    expect(screen.getByText('m•••@example.com will get new jobs for “Nurse · Taiwan” once a week.')).toBeInTheDocument();
    expect(api.confirmAnonAlert).toHaveBeenCalledWith({ token: TOKEN });
    expect(api.submitAnonAlertConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm job alerts' }));
    expect(await screen.findByText('Your job alerts are on')).toBeInTheDocument();
    expect(api.submitAnonAlertConfirm).toHaveBeenCalledWith({ token: TOKEN });
  });

  it('invalid or expired link; short token never asks the server', async () => {
    api.confirmAnonAlert.mockRejectedValue(new RoboApiError('x', { code: 'not_found', status: 404, payload: { code: 'not_found', details: { reason: 'alert_token_invalid' } } }));
    renderVisitor(<AlertConfirm token={TOKEN} />);
    expect(await screen.findByText("This link doesn't work any more")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign up again' })).toHaveAttribute('href', '/tools/job-alerts');
    cleanup();
    api.confirmAnonAlert.mockClear();
    renderVisitor(<AlertConfirm token="short" />);
    expect(screen.getByText("This link doesn't work any more")).toBeInTheDocument();
    expect(api.confirmAnonAlert).not.toHaveBeenCalled();
  });

  it('an address that left the list stays off', async () => {
    api.confirmAnonAlert.mockResolvedValue(view('unsubscribed'));
    renderVisitor(<AlertConfirm token={TOKEN} />);
    expect(await screen.findByText('These alerts are off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm job alerts' })).toBeNull();
  });
});

// ── model ────────────────────────────────────────────────────────────────

describe('model', () => {
  it('links, filters and labels', () => {
    expect(signupHref('browse')).toBe('/signup?from=browse');
    expect(visitorJobHref({ jobId: 'a', path: '/job/a-x' }, 'intl', 'b')).toBe('/job/a-x');
    expect(visitorJobHref({ jobId: 'a' }, 'intl', 'b')).toBe('/job/a');
    expect(visitorJobHref({ jobId: 'a', path: null }, 'cn', 'b')).toBe('/signup?from=b&next=%2Fjobs%2Fa');
    expect(alertsHref({})).toBe('/tools/job-alerts');
    expect(alertsHref({ country: 'tw' })).toBe('/tools/job-alerts');
    expect(alertFilters({ role: ' ', city: '', country: 'US', remoteOnly: false })).toEqual({ country: 'US' });
    expect(alertFilters({ role: 'x', city: 'Paris', country: '', remoteOnly: false })).toEqual({ q: 'x', locations: [{ label: 'Paris', city: 'Paris' }] });
    expect(filtersLabel({})).toBe('');
    expect(filtersLabel({ q: 'Nurse', locations: [{ label: 'Taipei' }] })).toBe('Nurse · Taipei');
    expect(looksLikeEmail('a@b.co')).toBe(true);
    expect(looksLikeEmail('a b@c.co')).toBe(false);
  });
});
