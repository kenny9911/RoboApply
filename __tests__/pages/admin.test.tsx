import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import AdminPage from '../../app/(auth)/admin/page';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState } from '../utils/mockAuth';
import { operationsApi } from '../../lib/api/adminOperations';

vi.mock('../../lib/auth/AuthProvider', () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children, useAuth: () => mockAuthState.value }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../lib/api/adminOperations', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api/adminOperations')>();
  return { ...actual, operationsApi: { overview: vi.fn(), payments: vi.fn(), users: vi.fn(), activity: vi.fn() } };
});
const coverage = { stripe: 'complete' as const, refundsIncluded: false as const };
const currencies = [{ currency: 'CNY', paidMinor: 12900, paidCount: 1 }, { currency: 'USD', paidMinor: 1900, paidCount: 1 }];
const payment = { id: 'payment-1', userId: 'user-1', email: 'chen@example.test', name: 'Chen', provider: 'alipay' as const, type: 'plan_purchase', status: 'paid', region: 'cn', amountMinor: 12900, currency: 'CNY', reference: 'ORDER-1', tier: 'premium', createdAt: '2026-10-09T08:00:00Z', paidAt: '2026-10-09T08:00:00Z' };
const adminAuth = { user: { id: 'admin-1', email: 'admin@example.test', role: 'admin', roles: ['admin'] } };
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/admin');
  vi.mocked(operationsApi.overview).mockResolvedValue({ range: { from: '2026-09-10', to: '2026-10-10', tz: 'UTC' }, users: { total: 3, new: 1, active: 2, loginUsers: 2, loginEvents: 4, featureEvents: 12, payingUsers: 2 }, payments: { currencies, total: 2, paid: 2, pending: 0, failed: 0, coverage }, costUsd: 0.13, activitySeries: [], featureUsage: [], regions: [], trackingSince: null });
  vi.mocked(operationsApi.payments).mockResolvedValue({ rows: [payment], total: 30, page: 1, pageSize: 25, currencies, coverage });
  vi.mocked(operationsApi.users).mockResolvedValue({ rows: [{ userId: 'user-1', email: 'chen@example.test', name: 'Chen', role: 'candidate', isActive: true, region: 'cn', tier: 'premium', status: 'active', createdAt: payment.createdAt, subscription: { currency: 'CNY', amountMinor: 12900 }, loginEvents: 3, featureEvents: 8, usageUnits: 1, periodCostUsd: 0.13, lastLoginAt: payment.createdAt, lastActiveAt: payment.createdAt }], total: 1, page: 1, pageSize: 25 });
  vi.mocked(operationsApi.activity).mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 });
});

describe('admin operations console', () => {
  it('blocks candidate accounts before requesting administrative data', async () => {
    renderWithProviders(<AdminPage />);
    expect(operationsApi.overview).not.toHaveBeenCalled();
    expect(operationsApi.payments).not.toHaveBeenCalled();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
  it('shows native collections separately from dollar service costs and refreshes API queries', async () => {
    renderWithProviders(<AdminPage />, { authValue: adminAuth });
    expect((await screen.findAllByText(/CNY\s*129\.00/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/USD\s*19\.00/)).toBeInTheDocument();
    expect(screen.getByText('$0.13')).toBeInTheDocument();
    expect(screen.queryByText(/99\.3%/)).not.toBeInTheDocument();
    const calls = vi.mocked(operationsApi.overview).mock.calls.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(operationsApi.overview).toHaveBeenCalledTimes(calls + 1));
  });
  it('sends exact payment filters to the API and resets pagination when filters or dates change', async () => {
    renderWithProviders(<AdminPage />, { authValue: adminAuth });
    fireEvent.click(screen.getByRole('tab', { name: 'Payments' }));
    const panel = screen.getByRole('tabpanel');
    await within(panel).findByText('Chen');
    fireEvent.click(within(panel).getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(operationsApi.payments).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
    fireEvent.change(within(panel).getByLabelText('Billing region'), { target: { value: 'cn' } });
    fireEvent.change(within(panel).getByLabelText('Type'), { target: { value: 'plan_purchase' } });
    await waitFor(() => expect(operationsApi.payments).toHaveBeenLastCalledWith(expect.objectContaining({ region: 'cn', type: 'plan_purchase', page: 1 })));
    const href = within(panel).getByRole('link', { name: 'Export CSV' }).getAttribute('href');
    expect(href).toContain('region=cn');
    expect(href).toContain('type=plan_purchase');
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => {
      const params = vi.mocked(operationsApi.payments).mock.calls.at(-1)![0];
      expect(params.page).toBe(1);
      expect(new Date(params.to!).getTime()).toBeGreaterThan(new Date(params.from!).getTime());
    });
  });
  it('opens a selected user payment history without showing other users', async () => {
    renderWithProviders(<AdminPage />, { authValue: adminAuth });
    fireEvent.click(screen.getByRole('tab', { name: 'Users' }));
    const panel = screen.getByRole('tabpanel');
    await within(panel).findByText('Chen');
    fireEvent.click(within(panel).getByRole('button', { name: 'Payments' }));
    await waitFor(() => expect(operationsApi.payments).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'user-1' })));
    expect(screen.getByText('User: user-1')).toBeInTheDocument();
  });
});

describe('admin home navigation', () => {
  it('links every admin area of the site, including held invite rewards', async () => {
    renderWithProviders(<AdminPage />, { authValue: adminAuth });
    const nav = await screen.findByRole('navigation', { name: 'Admin areas' });
    const hrefs = within(nav).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/admin/system', '/admin/reports', '/admin/reports/invites', '/admin/credits']));
    const invites = within(nav).getByRole('link', { name: /Held invite rewards/ });
    expect(invites).toHaveAttribute('href', '/admin/reports/invites');
    expect(invites).toHaveTextContent('Invites whose rewards wait for a person to approve or reject.');
  });
});
