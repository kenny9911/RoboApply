// Admin console additions (WP-74): admin gate, navigation to every admin
// area per brand, System (health, retry, costs CSV, Assistant feedback),
// Reports to review (close/restore, /admin/fraud hand-off, referral codes on
// GoApply, personal-data requests) and the per-user overrides panel.
// API wrappers are mocked; nothing reaches the network.

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { buildAuthValue, buildFakeUser, mockAuthState } from '../../../../__tests__/utils/mockAuth';

vi.mock('../../../../lib/auth/AuthProvider', () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children, useAuth: () => mockAuthState.value }));
const nav = vi.hoisted(() => ({ pathname: '/admin/system' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const api = vi.hoisted(() => ({
  getSystemStatus: vi.fn(),
  listWorkItems: vi.fn(),
  retryWorkItem: vi.fn(),
  getCosts: vi.fn(),
  costsCsvUrl: vi.fn((q?: Record<string, string>) => `/csv?${new URLSearchParams(q ?? {}).toString()}`),
  getSafety: vi.fn(),
  listReports: vi.fn(),
  resolveReport: vi.fn(),
  listOverrides: vi.fn(),
  createOverride: vi.fn(),
  deleteOverride: vi.fn(),
  listCopilotFeedback: vi.fn(),
  listReferralQueue: vi.fn(),
  moderateReferralCode: vi.fn(),
  getRefundQuote: vi.fn(),
}));
vi.mock('../../../../lib/api/admin', async (orig) => {
  const real = await orig<typeof import('../../../../lib/api/admin')>();
  return { ...real, adminConsoleApi: api, costsCsvUrl: api.costsCsvUrl };
});
const pi = vi.hoisted(() => ({ adminListPiRequests: vi.fn(), adminUpdatePiRequest: vi.fn() }));
vi.mock('../../../../lib/api/compliance', async (orig) => ({ ...(await orig<typeof import('../../../../lib/api/compliance')>()), ...pi }));

import { SystemConsole } from '../SystemConsole';
import { ReportsConsole } from '../ReportsConsole';
import { AdminNav, ADMIN_AREAS, adminAreasFor } from '../AdminNav';
import { UserOverridesPanel, parseOverrideValue } from '../UserAdminPanels';
import type { BrandHealth, SystemStatusResponse, ReportItem } from '../../../../lib/api/admin';

const admin = () => buildAuthValue({ user: { ...buildFakeUser(), role: 'admin' } as never });

const brand = (over: Partial<BrandHealth> = {}): BrandHealth => ({
  brand: 'roboapply',
  market: 'intl',
  ingest: { due: 3, overdue: 1, failing: 0, newJobsToday: 12, newJobs7dAvg: 40, openJobs: 200, enrichBacklog: 20, enrichedShare: 0.9, enrichBudget: { used: 10, limit: 8000 } },
  precompute: { used: 5, limit: 20000 },
  alerts: { sent: 4, failed: 1 },
  email: { sent: 50, failed: 2, failedByTemplate: [{ template: 'notify.welcome', count: 2 }] },
  copilot: { turns: 7, guardHits: 2, costUsd: 0.0123, budgetUsd: 50 },
  creditExhaustion: null,
  ...over,
});

const status: SystemStatusResponse = {
  asOf: '2026-10-10T12:00:00.000Z',
  dayKey: '2026-10-10',
  dayComplete: false,
  dayElapsedShare: 0.5,
  brands: [brand()],
  queue: { kinds: [{ kind: 'job.enrich', queued: 4, leased: 1, failed: 0, dead: 2, oldestQueuedAt: '2026-10-10T10:00:00.000Z' }], deadTotal: 2 },
  providers: [{ provider: 'jsearch', calls: 20, limit: 200, jobsReturned: 300, jobsNew: 40, errors: 1 }],
  alerts: [{ key: 'ingest_new_low', brand: 'roboapply', subject: null, value: 12, level: 20 }],
  brandsServed: ['roboapply'],
};

const report = (over: Partial<ReportItem> = {}): ReportItem => ({
  id: 'job1', title: 'Data analyst', companyName: 'Acme', market: 'intl', sourceName: 'Greenhouse', applyUrl: 'https://example.com/a',
  state: 'open', closeReason: null, closedAt: null, reasons: [{ reason: 'scam', count: 2 }], reportCount: 2,
  firstReportedAt: '2026-10-08T00:00:00.000Z', lastReportedAt: '2026-10-09T00:00:00.000Z', notes: ['They asked for a deposit'],
  scamSignals: [{ rule: 'intl_fee_required', evidence: 'Pay a $50 starter fee', at: '2026-10-08T00:00:00.000Z' }],
  reviewElsewhere: false, lastDecision: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = '/admin/system';
  window.history.replaceState(null, '', '/admin/system');
  mockAuthState.value = admin();
  api.getSystemStatus.mockResolvedValue(status);
  api.listWorkItems.mockResolvedValue({ items: [{ id: 'w1', kind: 'job.enrich', status: 'dead', brand: 'roboapply', attempts: 5, maxAttempts: 5, runAfter: status.asOf, lastError: 'timeout', createdAt: status.asOf, updatedAt: status.asOf }], cursor: null });
  api.retryWorkItem.mockResolvedValue({ id: 'w1', status: 'queued' });
  api.getCosts.mockResolvedValue({ from: '2026-09-11', to: '2026-10-10', rows: [{ day: '2026-10-09', sku: 'ra_job_enrich', brand: 'roboapply', costUsd: 1.5, units: 30, rows: 30, unpricedRows: 0, platform: true }], totals: { costUsd: 1.5, units: 30, rows: 30 } });
  api.listCopilotFeedback.mockResolvedValue({ items: [{ messageId: 'm1', threadId: 't1', userId: 'u1', value: 'down', note: 'Wrong salary', createdAt: status.asOf, excerpt: [{ role: 'user', text: 'What pays?' }, { role: 'assistant', text: 'Pay is not listed.' }], guardHits: 1 }], cursor: null });
  api.listReports.mockResolvedValue({ items: [report(), report({ id: 'cn1', title: '储备干部', market: 'cn', reviewElsewhere: true, scamSignals: [] })], cursor: null });
  api.resolveReport.mockResolvedValue({ id: 'job1', state: 'closed', decision: 'close' });
  api.listReferralQueue.mockResolvedValue({ items: [], cursor: null });
  api.listOverrides.mockResolvedValue({ items: [{ id: 'ov1', userId: 'u1', key: 'bucket:tailor', value: 5, reason: 'beta tester', adminId: 'a1', expiresAt: null, createdAt: status.asOf }], cursor: null });
  api.createOverride.mockResolvedValue({ id: 'ov2' });
  api.deleteOverride.mockResolvedValue(null);
  pi.adminListPiRequests.mockResolvedValue({ items: [{ id: 'p1', kind: 'deletion', status: 'open', dueAt: '2026-10-20T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', resolvedAt: null, download: null, brand: 'roboapply', userId: 'u1', overdue: false, userNote: null, handlingNotes: [] }], cursor: null });
  pi.adminUpdatePiRequest.mockResolvedValue({});
});

describe('admin gate', () => {
  it('a non-admin sees "not authorized" and no admin data is requested', () => {
    mockAuthState.value = buildAuthValue();
    renderWithBrand(<SystemConsole />);
    expect(screen.getByText(/authorized/i)).toBeInTheDocument();
    expect(api.getSystemStatus).not.toHaveBeenCalled();
    renderWithBrand(<ReportsConsole />);
    expect(api.listReports).not.toHaveBeenCalled();
  });
});

describe('admin navigation', () => {
  it('lists every admin sub-route other WPs built, per brand', () => {
    const hrefs = ADMIN_AREAS.map((a) => a.href);
    for (const p of ['credits', 'campus', 'fraud', 'sources', 'invites', 'questions', 'announcements', 'coaches', 'system', 'reports']) expect(hrefs).toContain(`/admin/${p}`);
    expect(adminAreasFor('goapply').map((a) => a.id)).toEqual(expect.arrayContaining(['campus', 'fraud', 'invites']));
    expect(adminAreasFor('goapply').map((a) => a.id)).not.toContain('sources');
    expect(adminAreasFor('roboapply').map((a) => a.id)).not.toContain('fraud');
  });

  it('marks the current page and shows only the brand’s areas', () => {
    nav.pathname = '/admin/fraud';
    renderWithBrand(<AdminNav />, { brand: 'goapply' });
    expect(screen.getByRole('link', { name: 'Suspicious jobs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Company job boards' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Coaches' })).toBeInTheDocument();
  });

  it('grid variant links each area with a description', () => {
    renderWithBrand(<AdminNav variant="grid" />);
    expect(screen.getByRole('link', { name: /Reports to review/ })).toHaveAttribute('href', '/admin/reports');
    expect(screen.getByRole('link', { name: /Announcements/ })).toHaveAttribute('href', '/admin/announcements');
    expect(screen.queryByRole('link', { name: /^Overview/ })).not.toBeInTheDocument();
  });
});

describe('/admin/system', () => {
  it('shows live brand health, alerts and the providers against their limits', async () => {
    renderWithBrand(<SystemConsole />);
    expect(await screen.findByText(/below half of what the 7-day average expects/)).toBeInTheDocument();
    expect(screen.getByText('New jobs today')).toBeInTheDocument();
    expect(screen.getByText('20 of 200')).toBeInTheDocument();
    expect(screen.getByText(/Not recorded yet/)).toBeInTheDocument();
    expect(screen.getByText('$0.0123 / $50.00')).toBeInTheDocument();
  });

  it('retries a dead item', async () => {
    renderWithBrand(<SystemConsole />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try the job.enrich item again' }));
    await waitFor(() => expect(api.retryWorkItem).toHaveBeenCalledWith('w1'));
    expect(await screen.findByText(/Put back in line/)).toBeInTheDocument();
  });

  it('costs view: platform rows marked and the CSV link carries the filters', async () => {
    renderWithBrand(<SystemConsole />);
    fireEvent.click(screen.getByRole('tab', { name: 'Costs' }));
    expect(await screen.findByText('ra_job_enrich')).toBeInTheDocument();
    expect(screen.getByText('Platform')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Site'), { target: { value: 'goapply' } });
    await waitFor(() => expect(api.getCosts).toHaveBeenLastCalledWith(expect.objectContaining({ brand: 'goapply' })));
    expect(screen.getByRole('link', { name: 'Download CSV' }).getAttribute('href')).toContain('brand=goapply');
    expect(window.location.search).toBe('?view=costs');
  });

  it('opens Assistant feedback from the URL and shows the excerpt and guard hits', async () => {
    window.history.replaceState(null, '', '/admin/system?view=feedback');
    renderWithBrand(<SystemConsole />);
    expect(await screen.findByText('Reason: Wrong salary')).toBeInTheDocument();
    expect(screen.getByText('1 sentence removed')).toBeInTheDocument();
    expect(screen.getByText('Pay is not listed.')).toBeInTheDocument();
    expect(api.listCopilotFeedback).toHaveBeenCalledWith({ value: 'down' });
    expect(screen.getByRole('link', { name: "Open this person's admin page" })).toHaveAttribute('href', '/admin/users/u1');
  });
});

describe('/admin/reports', () => {
  it('lists reports with the scam sentence; close sends the note', async () => {
    renderWithBrand(<ReportsConsole />);
    expect(await screen.findByText('Data analyst')).toBeInTheDocument();
    expect(screen.getByText('"Pay a $50 starter fee"')).toBeInTheDocument();
    const card = screen.getByText('Data analyst').closest('li')!;
    fireEvent.change(within(card).getByLabelText(/Note for the record/), { target: { value: 'Asked for money' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Close this job' }));
    await waitFor(() => expect(api.resolveReport).toHaveBeenCalledWith('job1', { decision: 'close', note: 'Asked for money' }));
  });

  it('a GoApply fraud report links to /admin/fraud instead of deciding here', async () => {
    renderWithBrand(<ReportsConsole />);
    const card = (await screen.findByText('储备干部')).closest('li')!;
    expect(within(card).getByRole('link', { name: 'Decide this one on Suspicious jobs' })).toHaveAttribute('href', '/admin/fraud');
    expect(within(card).queryByRole('button', { name: 'Close this job' })).not.toBeInTheDocument();
  });

  it('referral codes are a GoApply view only', async () => {
    nav.pathname = '/admin/reports';
    const { unmount } = renderWithBrand(<ReportsConsole />);
    expect(screen.queryByRole('tab', { name: 'Referral codes' })).not.toBeInTheDocument();
    unmount();
    renderWithBrand(<ReportsConsole />, { brand: 'goapply' });
    fireEvent.click(screen.getByRole('tab', { name: 'Referral codes' }));
    expect(await screen.findByText('No codes are waiting.')).toBeInTheDocument();
  });

  it('personal-data requests: due date shown, status changes go to the compliance API', async () => {
    renderWithBrand(<ReportsConsole />);
    fireEvent.click(screen.getByRole('tab', { name: 'Personal-data requests' }));
    expect(await screen.findByText('Delete their data')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark in progress' }));
    await waitFor(() => expect(pi.adminUpdatePiRequest).toHaveBeenCalledWith('p1', { status: 'in_progress' }));
  });
});

describe('per-user overrides', () => {
  it('parses values', () => {
    expect(parseOverrideValue('5')).toBe(5);
    expect(parseOverrideValue('true')).toBe(true);
    expect(parseOverrideValue('false')).toBe(false);
    expect(parseOverrideValue('deeplinks_only')).toBe('deeplinks_only');
    expect(parseOverrideValue('-1')).toBeNull();
    expect(parseOverrideValue('lots')).toBeNull();
  });

  it('adds and removes an override with a reason', async () => {
    renderWithBrand(<UserOverridesPanel userId="u1" />);
    expect(await screen.findByText('beta tester')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
    expect(await screen.findByText(/Fill in the name/)).toBeInTheDocument();
    expect(api.createOverride).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'tailor' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'support case' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
    await waitFor(() => expect(api.createOverride).toHaveBeenCalledWith({ key: 'bucket:tailor', value: 9, reason: 'support case', userId: 'u1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove bucket:tailor' }));
    await waitFor(() => expect(api.deleteOverride).toHaveBeenCalledWith('ov1', { userId: 'u1' }));
    expect(screen.getByRole('link', { name: 'Limits for every plan' })).toHaveAttribute('href', '/admin/credits');
  });
});
