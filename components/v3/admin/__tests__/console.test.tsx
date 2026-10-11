// Admin console additions (WP-74): admin gate, navigation to every admin
// area per brand, System (health, retry, costs CSV, Assistant feedback),
// Reports to review (close/keep and what Keep promises, /admin/fraud hand-off,
// referral codes on GoApply, personal-data requests), the per-user overrides
// panel, the admin actions view (INT-08) and held invite rewards (INT-08:
// list, approve, reject, the 409 on approve). API wrappers are mocked; nothing
// reaches the network.

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
  listAdminAudit: vi.fn(),
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
const growth = vi.hoisted(() => ({ listHeldReferrals: vi.fn(), reviewReferral: vi.fn() }));
vi.mock('../../../../lib/api/growth', async (orig) => ({ ...(await orig<typeof import('../../../../lib/api/growth')>()), ...growth }));
const pi = vi.hoisted(() => ({ adminListPiRequests: vi.fn(), adminUpdatePiRequest: vi.fn() }));
vi.mock('../../../../lib/api/compliance', async (orig) => ({ ...(await orig<typeof import('../../../../lib/api/compliance')>()), ...pi }));

import { SystemConsole } from '../SystemConsole';
import { ReportsConsole } from '../ReportsConsole';
import { AdminNav, ADMIN_AREAS, adminAreasFor, currentAdminArea } from '../AdminNav';
import { HOLD_REASONS, InviteRewardsConsole, reviewOutcome } from '../InviteRewardsConsole';
import { RoboApiError } from '../../../../lib/api/client';
import type { HeldReferralView } from '../../../../lib/api/contracts/growth';
import adminCopy from '../../../../i18n/messages/en.json';
import { ADMIN_AUDIT_EVENTS } from '../../../../server/src/features/admin/contract';
import { RISK_WEIGHTS } from '../../../../server/src/features/growth/referralRisk';
import { AUDIT_ACTIONS, PROVIDER_STATE_TONE } from '../SystemConsole';
import { PROVIDER_STATES } from '../../../../server/src/features/admin/contract';
import { UserOverridesPanel, parseOverrideValue } from '../UserAdminPanels';
import type { BrandHealth, ProviderUsageRow, SystemStatusResponse, ReportItem } from '../../../../lib/api/admin';

const admin = () => buildAuthValue({ user: { ...buildFakeUser(), role: 'admin' } as never });

const brand = (over: Partial<BrandHealth> = {}): BrandHealth => ({
  brand: 'roboapply',
  market: 'intl',
  sources: [],
  ingest: { due: 3, overdue: 1, failing: 0, newJobsToday: 12, newJobs7dAvg: 40, openJobs: 200, enrichBacklog: 20, enrichedShare: 0.9, enrichBudget: { used: 10, limit: 8000 } },
  precompute: { used: 5, limit: 20000 },
  alerts: { sent: 4, failed: 1 },
  email: { sent: 50, failed: 2, failedByTemplate: [{ template: 'notify.welcome', count: 2 }] },
  copilot: { turns: 7, guardHits: 2, costUsd: 0.0123, budgetUsd: 50 },
  creditExhaustion: null,
  ...over,
});

/** A provider row with nothing stated by the provider; a test names what it cares about. */
const provider = (over: Partial<ProviderUsageRow> & { provider: string }): ProviderUsageRow => ({
  market: 'intl', calls: 0, limit: null, jobsReturned: 0, jobsNew: 0, errors: 0,
  plan: null, requestsLimit: null, requestsRemaining: null, jobsLimit: null, jobsRemaining: null, resetAt: null, daysToReset: null, observedAt: null,
  costModel: 'free', state: 'ok',
  ...over,
});

const status: SystemStatusResponse = {
  asOf: '2026-10-10T12:00:00.000Z',
  dayKey: '2026-10-10',
  dayComplete: false,
  dayElapsedShare: 0.5,
  brands: [brand()],
  queue: { kinds: [{ kind: 'job.enrich', queued: 4, leased: 1, failed: 0, dead: 2, oldestQueuedAt: '2026-10-10T10:00:00.000Z' }], deadTotal: 2 },
  providers: [provider({ provider: 'jsearch', calls: 20, limit: 200, jobsReturned: 300, jobsNew: 40, errors: 1, costModel: 'per_request', requestsLimit: 10_000, requestsRemaining: 9_773, observedAt: '2026-10-10T11:00:00.000Z' })],
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

const held = (over: Partial<HeldReferralView> = {}): HeldReferralView => ({
  id: 'ref1', brand: 'roboapply', inviterUserId: 'u_inviter', inviteeUserId: 'u_friend', riskScore: 110, riskReasons: ['same_device', 'signals_missing'],
  signedUpAt: '2026-10-01T09:00:00.000Z', qualifiedAt: '2026-10-03T09:00:00.000Z', ...over,
});
const conflict = (details?: Record<string, unknown>) =>
  new RoboApiError('conflict', { code: 'conflict', status: 409, payload: { success: false, code: 'conflict', ...(details ? { details } : {}) } });

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
  api.listReports.mockResolvedValue({ items: [report(), report({ id: 'cn1', title: '储备干部', market: 'cn', reviewElsewhere: true, scamSignals: [] })], cursor: null, keepHolds: false });
  api.listAdminAudit.mockResolvedValue({
    items: [
      { id: 'al2', adminId: 'admin1', subjectUserId: 'u1', eventType: 'admin_override_created', details: 'key: bucket:tailor · value: 5 · reason: beta tester', createdAt: '2026-10-10T11:00:00.000Z' },
      { id: 'al1', adminId: 'admin1', subjectUserId: null, eventType: 'credits_refund_issued', details: '', createdAt: '2026-10-10T10:00:00.000Z' },
    ],
    cursor: '2026-10-10T10:00:00.000Z|al1',
  });
  growth.listHeldReferrals.mockResolvedValue({ items: [held(), held({ id: 'ref2', inviterUserId: 'u_inviter2', inviteeUserId: 'u_friend2', riskScore: 50, riskReasons: ['signals_unavailable'], signedUpAt: '2026-10-05T09:00:00.000Z', qualifiedAt: null })] });
  growth.reviewReferral.mockResolvedValue({ id: 'ref1', status: 'rewarded' });
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
    for (const p of ['credits', 'campus', 'fraud', 'sources', 'invites', 'questions', 'announcements', 'coaches', 'system', 'reports', 'reports/invites']) expect(hrefs).toContain(`/admin/${p}`);
    // Held invite rewards are reviewed on both sites.
    for (const b of ['roboapply', 'goapply'] as const) expect(adminAreasFor(b).map((a) => a.id)).toContain('inviteRewards');
    // Every area has a title and a description in the bundle.
    const navCopy = adminCopy.admin.console.nav as Record<string, unknown>;
    for (const a of ADMIN_AREAS) expect(navCopy[a.id], a.id).toMatchObject({ title: expect.any(String), sub: expect.any(String) });
    expect(adminAreasFor('goapply').map((a) => a.id)).toEqual(expect.arrayContaining(['campus', 'fraud', 'invites']));
    // Job sources are shown on both sites: each brand's admin sees its own (D5).
    for (const b of ['roboapply', 'goapply'] as const) expect(adminAreasFor(b).map((a) => a.id)).toContain('sources');
    expect(adminAreasFor('roboapply').map((a) => a.id)).not.toContain('fraud');
  });

  it('marks the current page and shows only the brand’s areas', () => {
    nav.pathname = '/admin/fraud';
    renderWithBrand(<AdminNav />, { brand: 'goapply' });
    expect(screen.getByRole('link', { name: 'Suspicious jobs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Company job boards' })).toHaveAttribute('href', '/admin/sources');
    expect(screen.getByRole('link', { name: 'Coaches' })).toBeInTheDocument();
  });

  it('marks only the deepest matching area: /admin/reports/invites is "Held invite rewards", not "Reports to review" too', () => {
    nav.pathname = '/admin/reports/invites';
    renderWithBrand(<AdminNav />);
    expect(screen.getByRole('link', { name: 'Held invite rewards' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Held invite rewards' })).toHaveAttribute('href', '/admin/reports/invites');
    expect(screen.getByRole('link', { name: 'Reports to review' })).not.toHaveAttribute('aria-current');
    expect(currentAdminArea('/admin/reports', ADMIN_AREAS)?.id).toBe('reports');
    expect(currentAdminArea('/admin/users/u1', ADMIN_AREAS)).toBeNull();
    expect(currentAdminArea('/admin', ADMIN_AREAS)?.id).toBe('overview');
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

  // ── Job providers: plan, quota left, days to reset (MKT-3F, JI-1) ──────────
  const providerCells = (id: string) => {
    const row = screen.getByRole('rowheader', { name: id }).closest('tr')!;
    return within(row).getAllByRole('cell').map((c) => c.textContent);
  };
  const withProviders = (providers: ProviderUsageRow[], alerts: SystemStatusResponse['alerts'] = []) => api.getSystemStatus.mockResolvedValue({ ...status, providers, alerts });

  it('providers: one row says the provider is exhausted, on which plan, what is left and when it resets; the banner names it', async () => {
    withProviders([
      provider({ provider: 'activejobs', costModel: 'per_job', state: 'exhausted', limit: 300, plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, resetAt: '2026-10-27T12:00:00.000Z', daysToReset: 17, observedAt: '2026-10-10T11:00:00.000Z' }),
      provider({ provider: 'jsearch', costModel: 'per_request', state: 'ok', calls: 20, limit: 200, jobsReturned: 300, jobsNew: 40, errors: 1, requestsLimit: 10_000, requestsRemaining: 9_773 }),
    ]);
    renderWithBrand(<SystemConsole />);
    const table = (await screen.findByRole('rowheader', { name: 'activejobs' })).closest('table')!;
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Provider', 'Market', 'State', 'Plan', 'Requests left / limit', 'Jobs left / limit', 'Resets in', 'Calls today / daily limit', 'Returned', 'New', 'Errors',
    ]);
    // activejobs · Exhausted · BASIC · 0 / 25 · Resets in 17 days, in one row; it made no call today.
    expect(providerCells('activejobs')).toEqual(['International', 'Exhausted', 'BASIC', '0 / 25', '—', '17 days', '0 of 300', '0', '0', '0']);
    expect(providerCells('jsearch')).toEqual(['International', 'On', '—', '9,773 / 10,000', '—', '—', '20 of 200', '300', '40', '1']);
    const banner = screen.getByTestId('providers-banner');
    expect(banner).toHaveTextContent('Not available right now: activejobs. The job feed is running without it.');
    expect(banner).toHaveAttribute('role', 'status');
    // No promise about how much of the market the feed covers (D3).
    expect(banner.textContent).not.toMatch(/all|every|full|complete|cover/i);
  });

  it('providers: every state has its words and its tone; an unmetered source that is off is not in the banner', async () => {
    const labels: Record<string, string> = { ok: 'On', low: 'Running low', exhausted: 'Exhausted', not_subscribed: 'Not subscribed', unauthorized: 'Key rejected', gated: 'Needs a larger plan', disabled: 'Off', unknown: 'Not known yet' };
    expect(Object.keys(labels).sort()).toEqual([...PROVIDER_STATES].sort());
    expect(Object.keys(PROVIDER_STATE_TONE).sort()).toEqual([...PROVIDER_STATES].sort());
    expect(PROVIDER_STATE_TONE).toEqual({ ok: 'neutral', low: 'warn', exhausted: 'danger', not_subscribed: 'danger', unauthorized: 'danger', gated: 'muted', disabled: 'muted', unknown: 'muted' });
    withProviders([
      ...PROVIDER_STATES.map((state) => provider({ provider: `p_${state}`, costModel: 'per_request', state })),
      provider({ provider: 'bank_gohire:cn', market: 'cn', costModel: 'free', state: 'disabled' }),
    ]);
    renderWithBrand(<SystemConsole />);
    await screen.findByRole('rowheader', { name: 'p_ok' });
    for (const state of PROVIDER_STATES) {
      const cells = providerCells(`p_${state}`);
      expect(cells[1], state).toBe(labels[state]);
      const badge = screen.getByRole('rowheader', { name: `p_${state}` }).closest('tr')!.querySelector('[data-state]')!;
      expect(badge).toHaveAttribute('data-state', state);
      expect(badge).toHaveTextContent(labels[state]!);
    }
    expect(providerCells('bank_gohire:cn').slice(0, 2)).toEqual(['Mainland China', 'Off']);
    // The three dead states of metered providers, in table order; the bank that is off is not one of them.
    expect(screen.getByTestId('providers-banner')).toHaveTextContent('Not available right now: p_exhausted, p_not_subscribed, p_unauthorized. The job feed is running without them.');
  });

  it('providers: a value the provider did not state is a dash, never 0; no banner while nothing is dead', async () => {
    withProviders([
      provider({ provider: 'jsearch', costModel: 'per_request', state: 'unknown', limit: 200 }),
      provider({ provider: 'activejobs', costModel: 'per_job', state: 'low', limit: 300, plan: 'BASIC', requestsLimit: 25, requestsRemaining: null, jobsLimit: 250, jobsRemaining: 12, daysToReset: 1 }),
      provider({ provider: 'bank_robohire', calls: 144, jobsReturned: 60, jobsNew: 2 }),
    ]);
    renderWithBrand(<SystemConsole />);
    await screen.findByRole('rowheader', { name: 'jsearch' });
    expect(providerCells('jsearch')).toEqual(['International', 'Not known yet', '—', '—', '—', '—', '0 of 200', '0', '0', '0']);
    // Half-stated: the side the provider gave is shown, the other is a dash. One day is singular.
    expect(providerCells('activejobs')).toEqual(['International', 'Running low', 'BASIC', '— / 25', '12 / 250', '1 day', '0 of 300', '0', '0', '0']);
    // An unmetered source shows calls and yields only.
    expect(providerCells('bank_robohire')).toEqual(['International', 'On', '—', '—', '—', '—', '144 (no daily limit)', '60', '2', '0']);
    expect(screen.queryByTestId('providers-banner')).not.toBeInTheDocument();
  });

  it('providers: the alert list says what is wrong with a provider in plain words', async () => {
    const hit = (state: 'exhausted' | 'not_subscribed' | 'unauthorized' | 'low', subject: string, over: Record<string, unknown> = {}) => ({ key: 'provider_quota' as const, brand: null, subject, value: 0, level: 0, state, daysToReset: null, ...over });
    withProviders(
      [provider({ provider: 'activejobs', costModel: 'per_job', state: 'exhausted', daysToReset: 17 })],
      [hit('exhausted', 'activejobs', { daysToReset: 17 }), hit('exhausted', 'feed'), hit('not_subscribed', 'linkedin'), hit('unauthorized', 'activejobs:cn'), hit('low', 'jsearch', { value: 412, level: 1000, daysToReset: 3 })],
    );
    renderWithBrand(<SystemConsole />);
    expect(await screen.findByText('activejobs: the monthly quota is used up. It resets in 17 days.')).toBeInTheDocument();
    expect(screen.getByText('feed: the monthly quota is used up. The provider did not say when it resets.')).toBeInTheDocument();
    expect(screen.getByText('linkedin: the key has no plan for this provider.')).toBeInTheDocument();
    expect(screen.getByText('activejobs:cn: the provider rejected the key.')).toBeInTheDocument();
    expect(screen.getByText('jsearch: 412 left of the monthly quota (alert level 1,000).')).toBeInTheDocument();
    expect(screen.getByText('5 numbers need a look')).toBeInTheDocument();
  });

  it('providers: a state this build does not know reads as not known yet, never as a raw code; an empty list says so', async () => {
    withProviders([provider({ provider: 'jsearch', costModel: 'per_request', state: 'paused_by_vendor' as never })]);
    const first = renderWithBrand(<SystemConsole />);
    await screen.findByRole('rowheader', { name: 'jsearch' });
    expect(providerCells('jsearch')[1]).toBe('Not known yet');
    expect(screen.queryByText(/paused_by_vendor/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('providers-banner')).not.toBeInTheDocument();
    first.unmount();
    withProviders([]);
    renderWithBrand(<SystemConsole />);
    expect(await screen.findByText('No job providers are set up.')).toBeInTheDocument();
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

describe('/admin/system — admin actions', () => {
  it('lists the audit rows newest first with who, about whom and the details; unknown actions show their code', async () => {
    window.history.replaceState(null, '', '/admin/system?view=audit');
    renderWithBrand(<SystemConsole />);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('Added a limit or feature for one person')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('key: bucket:tailor · value: 5 · reason: beta tester')).toBeInTheDocument();
    const links = within(rows[1]!).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/admin/users/admin1', '/admin/users/u1']);
    // An action another area wrote, with no subject and no details: the code and dashes, nothing invented.
    expect(within(rows[2]!).getByText('credits_refund_issued')).toBeInTheDocument();
    expect(within(rows[2]!).getAllByText('—')).toHaveLength(2);
    expect(api.listAdminAudit).toHaveBeenCalledWith({});
  });

  it('filters by action and pages with the cursor', async () => {
    renderWithBrand(<SystemConsole />);
    fireEvent.click(screen.getByRole('tab', { name: 'Admin actions' }));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(api.listAdminAudit).toHaveBeenLastCalledWith({ cursor: '2026-10-10T10:00:00.000Z|al1' }));
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'admin_report_resolved' } });
    await waitFor(() => expect(api.listAdminAudit).toHaveBeenLastCalledWith({ eventType: 'admin_report_resolved' }));
    expect(window.location.search).toBe('?view=audit');
  });

  it('the action filter lists exactly the events this area writes, each with words', () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual(Object.values(ADMIN_AUDIT_EVENTS).sort());
    const copy = adminCopy.admin.console.audit.action as Record<string, string>;
    for (const a of AUDIT_ACTIONS) expect(copy[a], a).toEqual(expect.any(String));
  });

  it('says so when nothing is recorded', async () => {
    api.listAdminAudit.mockResolvedValue({ items: [], cursor: null });
    window.history.replaceState(null, '', '/admin/system?view=audit');
    renderWithBrand(<SystemConsole />);
    expect(await screen.findByText('No admin actions recorded yet.')).toBeInTheDocument();
  });
});

describe('/admin/reports/invites — held invite rewards', () => {
  beforeEach(() => {
    nav.pathname = '/admin/reports/invites';
  });

  it('a non-admin sees "not authorized" and nothing is requested', () => {
    mockAuthState.value = buildAuthValue();
    renderWithBrand(<InviteRewardsConsole />);
    expect(screen.getByText(/authorized/i)).toBeInTheDocument();
    expect(growth.listHeldReferrals).not.toHaveBeenCalled();
  });

  it('lists held invites with their hold reasons, dates and account links, and no names or emails', async () => {
    renderWithBrand(<InviteRewardsConsole />);
    const first = (await screen.findByText('Friend signed up Oct 1, 2026')).closest('li')!;
    expect(within(first).getByText('Risk points: 110')).toBeInTheDocument();
    expect(within(first).getByText('Same device as the inviter')).toBeInTheDocument();
    expect(within(first).getByText('No device or network record for one of the two accounts')).toBeInTheDocument();
    expect(within(first).getByText('Met the conditions for the reward on Oct 3, 2026')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: "Open the inviter's admin page" })).toHaveAttribute('href', '/admin/users/u_inviter');
    expect(within(first).getByRole('link', { name: "Open the friend's admin page" })).toHaveAttribute('href', '/admin/users/u_friend');
    const second = screen.getAllByRole('listitem').find((li) => within(li).queryByText('The device and network check could not run'))!;
    expect(within(second).getByText('Has not met the conditions for the reward yet')).toBeInTheDocument();
    // Ids are link targets only: the page prints no account id, name or email.
    expect(document.body.textContent).not.toMatch(/u_inviter|u_friend|@/);
  });

  it('every hold reason the server can send has words (incl. signals_missing, invitee_no_profile, signals_unavailable); an unknown one shows its code', async () => {
    const copy = adminCopy.admin.console.inviteRewards.reason as Record<string, string>;
    for (const r of HOLD_REASONS) expect(copy[r], r).toEqual(expect.any(String));
    for (const r of ['signals_missing', 'invitee_no_profile', 'signals_unavailable']) expect(HOLD_REASONS).toContain(r);
    // Every risk sign the server scores is covered (features/growth referralRisk.ts).
    for (const r of Object.keys(RISK_WEIGHTS)) expect(HOLD_REASONS, r).toContain(r);
    growth.listHeldReferrals.mockResolvedValue({ items: [held({ riskReasons: ['invitee_no_profile', 'new_rule_x'] })] });
    renderWithBrand(<InviteRewardsConsole />);
    expect(await screen.findByText("The friend's account has no profile")).toBeInTheDocument();
    expect(screen.getByText('new_rule_x')).toBeInTheDocument();
  });

  it('approve sends the decision, reads the list again and confirms', async () => {
    renderWithBrand(<InviteRewardsConsole />);
    const card = (await screen.findByText('Friend signed up Oct 1, 2026')).closest('li')!;
    growth.listHeldReferrals.mockResolvedValue({ items: [held({ id: 'ref2', riskReasons: ['signals_unavailable'] })] });
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(growth.reviewReferral).toHaveBeenCalledWith('ref1', { decision: 'approve' }));
    expect(await screen.findByText('Approved. Both people got their practice credits.')).toBeInTheDocument();
    await waitFor(() => expect(growth.listHeldReferrals).toHaveBeenCalledTimes(2));
  });

  it('reject sends the decision and confirms', async () => {
    growth.reviewReferral.mockResolvedValue({ id: 'ref1', status: 'rejected' });
    renderWithBrand(<InviteRewardsConsole />);
    const card = (await screen.findByText('Friend signed up Oct 1, 2026')).closest('li')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(growth.reviewReferral).toHaveBeenCalledWith('ref1', { decision: 'reject' }));
    expect(await screen.findByText('Rejected. This invite does not count.')).toBeInTheDocument();
  });

  it('a 409 on approve reads as approved with the credits retried automatically, not as a failure', async () => {
    growth.reviewReferral.mockRejectedValue(conflict());
    renderWithBrand(<InviteRewardsConsole />);
    const card = (await screen.findByText('Friend signed up Oct 1, 2026')).closest('li')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    const note = await screen.findByText('Approved. The credits could not be added yet; they are retried automatically.');
    expect(note).toHaveAttribute('role', 'status');
    expect(screen.queryByText("That didn't save. Try again.")).not.toBeInTheDocument();
    await waitFor(() => expect(growth.listHeldReferrals).toHaveBeenCalledTimes(2));
  });

  it('a successful approve is worded from the status the server stored, never assumed', () => {
    // rewarded = both credited.
    expect(reviewOutcome('approve', null, 'rewarded')).toBe('approved');
    // qualified = only the friend (the inviter is at the yearly limit or has no profile).
    expect(reviewOutcome('approve', null, 'qualified')).toBe('approved_friend_only');
    // rejected = nobody (the friend's profile is gone, or a reject landed first).
    expect(reviewOutcome('approve', null, 'rejected')).toBe('not_counted');
    // pending = approved, another call is still adding the credits.
    expect(reviewOutcome('approve', null, 'pending')).toBe('approved_pending');
    // Still held, or no status at all: the approval did not take.
    expect(reviewOutcome('approve', null, 'held')).toBe('failed');
    expect(reviewOutcome('approve', null)).toBe('failed');
    expect(reviewOutcome('approve', null, null)).toBe('failed');
    // Every outcome has words.
    const copy = adminCopy.admin.console.inviteRewards.outcome as Record<string, string>;
    for (const o of ['approved', 'approved_friend_only', 'approved_pending', 'not_counted', 'rejected', 'already_reviewed', 'failed']) expect(copy[o], o).toEqual(expect.any(String));
  });

  it.each([
    ['qualified', "Approved. The friend got their practice credit. The inviter got none: they have reached this year's limit for invite rewards, or their account has no profile."],
    ['rejected', "This invite does not count and no credits were given: the friend's account has no profile, or someone rejected the invite first."],
    ['pending', 'Approved. The credits could not be added yet; they are retried automatically.'],
  ] as const)('approve answered with status %s does not claim both people were credited', async (status, words) => {
    growth.reviewReferral.mockResolvedValue({ id: 'ref1', status });
    renderWithBrand(<InviteRewardsConsole />);
    const card = (await screen.findByText('Friend signed up Oct 1, 2026')).closest('li')!;
    growth.listHeldReferrals.mockResolvedValue({ items: [held({ id: 'ref2', riskReasons: ['signals_unavailable'] })] });
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(words)).toHaveAttribute('role', 'status');
    expect(screen.queryByText('Approved. Both people got their practice credits.')).not.toBeInTheDocument();
  });

  it('the help line promises only the credits that are due', async () => {
    renderWithBrand(<InviteRewardsConsole />);
    const help = await screen.findByText(/Approve gives the practice credits that are due/);
    expect(help.textContent).toMatch(/unless they have reached this year's limit/);
    expect(help.textContent).not.toMatch(/both people/i);
  });

  it('tells apart the other answers: already reviewed, and a real failure', async () => {
    expect(reviewOutcome('approve', null, 'rewarded')).toBe('approved');
    expect(reviewOutcome('reject', null, 'rejected')).toBe('rejected');
    expect(reviewOutcome('reject', null)).toBe('rejected');
    expect(reviewOutcome('approve', conflict())).toBe('approved_pending');
    expect(reviewOutcome('approve', conflict({ status: 'rejected' }))).toBe('already_reviewed');
    expect(reviewOutcome('reject', conflict())).toBe('already_reviewed');
    expect(reviewOutcome('approve', new Error('network'))).toBe('failed');
    growth.reviewReferral.mockRejectedValue(new Error('network'));
    renderWithBrand(<InviteRewardsConsole />);
    const card = (await screen.findByText('Friend signed up Oct 1, 2026')).closest('li')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent("That didn't save. Try again.");
  });

  it('an empty list says nothing is waiting', async () => {
    growth.listHeldReferrals.mockResolvedValue({ items: [] });
    renderWithBrand(<InviteRewardsConsole />, { brand: 'goapply' });
    expect(await screen.findByText('No invite rewards are waiting.')).toBeInTheDocument();
  });
});

describe('/admin/reports', () => {
  it('Keep is worded by what the server says: no promise while one new report can still close a kept job', async () => {
    const { unmount } = renderWithBrand(<ReportsConsole />);
    const card = (await screen.findByText('Data analyst')).closest('li')!;
    expect(within(card).getByText(/For now, one new report can close a kept job again/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Keep this job' }));
    await waitFor(() => expect(api.resolveReport).toHaveBeenCalledWith('job1', { decision: 'restore', note: undefined }));
    unmount();
    api.listReports.mockResolvedValue({ items: [report()], cursor: null, keepHolds: true });
    renderWithBrand(<ReportsConsole />);
    const held2 = (await screen.findByText('Data analyst')).closest('li')!;
    expect(within(held2).getByText(/only reports made after your decision count toward closing it again/)).toBeInTheDocument();
    expect(within(held2).queryByText(/For now, one new report/)).not.toBeInTheDocument();
  });

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
