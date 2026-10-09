// WP-21b — /admin/credits console (lib/api mocked; admin role from the auth mock).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderUi } from './fixtures';
import { mockAuthState, buildAuthValue, buildFakeUser } from '../../../../__tests__/utils/mockAuth';

const api = vi.hoisted(() => ({
  adminGetCreditCatalog: vi.fn(),
  adminPutCreditCatalog: vi.fn(),
  adminListOverrides: vi.fn(),
  adminCreateOverride: vi.fn(),
  adminDeleteOverride: vi.fn(),
  adminGetFxReference: vi.fn(),
  adminPutFxReference: vi.fn(),
  adminGetTwRevenue: vi.fn(),
}));
vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

import { AdminCreditsConsole } from '../AdminCreditsConsole';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
  api.adminGetCreditCatalog.mockResolvedValue({ override: { version: 1, brands: { roboapply: { buckets: { tailor: { free: { cap: 3 } } } } } } });
  api.adminPutCreditCatalog.mockImplementation(async (b: unknown) => b);
  api.adminListOverrides.mockResolvedValue({ items: [] });
  api.adminGetFxReference.mockResolvedValue(null);
  api.adminGetTwRevenue.mockResolvedValue({ periodStart: '2026-01-01', revenueTwd: 450000, thresholdTwd: 600000, warnAt: 0.7, source: 'stripe', asOf: '2026-10-10T00:00:00Z' });
});

describe('AdminCreditsConsole', () => {
  it('non-admins see "not authorized" and nothing is fetched', () => {
    mockAuthState.value = buildAuthValue();
    renderUi(<AdminCreditsConsole />);
    expect(screen.getByText(/authorized/)).toBeInTheDocument();
    expect(api.adminGetCreditCatalog).not.toHaveBeenCalled();
  });

  it('caps editor saves only the changed caps over the stored override', async () => {
    renderUi(<AdminCreditsConsole />);
    const input = await screen.findByLabelText('Tailored resumes · Free');
    await waitFor(() => expect(input).toHaveValue('3'));
    fireEvent.change(screen.getByLabelText('Tailored resumes · Pro'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(api.adminPutCreditCatalog).toHaveBeenCalled());
    expect(api.adminPutCreditCatalog.mock.calls[0][0]).toEqual({
      override: { version: 1, brands: { roboapply: { buckets: { tailor: { free: { cap: 3 }, pro: { cap: 60 } } } } } },
    });
  });

  it('invalid caps block saving', async () => {
    renderUi(<AdminCreditsConsole />);
    const input = await screen.findByLabelText('Cover letters · Free');
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: '-2' } });
    expect(screen.getByText(/whole numbers from 0 to 10,000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled();
  });

  it('FX: no rate → the line is hidden; saving sends source and date', async () => {
    api.adminPutFxReference.mockImplementation(async (b: unknown) => b);
    renderUi(<AdminCreditsConsole />);
    expect(await screen.findByText(/No rate yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New Taiwan dollars per US dollar'), { target: { value: '32.15' } });
    fireEvent.change(screen.getByLabelText('Rate date'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText(/^Source/), { target: { value: 'Bank of Taiwan board rate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    await waitFor(() =>
      expect(api.adminPutFxReference).toHaveBeenCalledWith({ currency: 'TWD', ratePerUsd: 32.15, source: 'Bank of Taiwan board rate', asOf: '2026-10-01' }),
    );
  });

  it('TW revenue warns above 70 % of the VAT level', async () => {
    renderUi(<AdminCreditsConsole />);
    const section = (await screen.findByText('Taiwan card revenue')).closest('section')!;
    await waitFor(() => expect(within(section).getByRole('alert')).toHaveTextContent('above 70%'));
    expect(section).toHaveTextContent('75% of the level');
  });

  it('per-user change: validates, then creates with a reason', async () => {
    api.adminCreateOverride.mockResolvedValue({ id: 'o1' });
    renderUi(<AdminCreditsConsole />);
    await screen.findByText('No per-user changes.');
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    expect(screen.getByText(/Check the user ID/)).toBeInTheDocument();
    fireEvent.change(screen.getAllByLabelText('User ID')[1], { target: { value: 'u1' } });
    fireEvent.change(screen.getByLabelText('What to change'), { target: { value: 'bucket:tailor' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Beta tester' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    await waitFor(() => expect(api.adminCreateOverride).toHaveBeenCalledWith({ userId: 'u1', key: 'bucket:tailor', value: 20, reason: 'Beta tester' }));
  });
});
