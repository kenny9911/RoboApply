// WP-72 — /admin/coaches (lib/api/coaching mocked; admin role from the auth mock).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { mockAuthState, buildAuthValue, buildFakeUser } from '../../../../__tests__/utils/mockAuth';
import { RoboApiError } from '../../../../lib/api/client';
import type { AdminCoachView } from '../../../../lib/api/contracts/coaching';

const api = vi.hoisted(() => ({
  listCoaches: vi.fn(),
  adminListCoaches: vi.fn(),
  adminCreateCoach: vi.fn(),
  adminUpdateCoach: vi.fn(),
  adminDeleteCoach: vi.fn(),
}));
vi.mock('../../../../lib/api/coaching', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

import AdminCoachesPage from '../../../../app/(auth)/admin/coaches/page';
import { buildRates, parseLengths } from '../AdminCoachesConsole';

const ROW: AdminCoachView = {
  id: 'c1',
  displayName: 'Dana Lee',
  headline: 'Former recruiter',
  bio: 'Ran hiring.',
  photoUrl: null,
  languages: ['en'],
  specialties: ['Interview practice'],
  sessionLengths: [30],
  rates: { currency: 'USD', '30': 4000 },
  sessions: [{ minutes: 30, amountMinor: 4000, currency: 'USD' }],
  bookingUrl: null,
  booking: 'request',
  introVideoUrl: null,
  rating: null,
  brand: 'roboapply',
  userId: null,
  requestEmail: 'dana@coach.example.test',
  active: false,
  status: 'approved',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
  api.adminListCoaches.mockResolvedValue({ items: [ROW] });
  api.adminCreateCoach.mockResolvedValue({ ...ROW, id: 'c2' });
  api.adminUpdateCoach.mockResolvedValue({ ...ROW, active: true });
  api.adminDeleteCoach.mockResolvedValue({ deleted: true });
});

describe('/admin/coaches', () => {
  it('non-admins see "not authorized" and nothing is fetched', () => {
    mockAuthState.value = buildAuthValue();
    renderWithBrand(<AdminCoachesPage />);
    expect(screen.getByText(/authorized/)).toBeInTheDocument();
    expect(api.adminListCoaches).not.toHaveBeenCalled();
  });

  it('lists roster rows with their state and booking path; filters by site', async () => {
    renderWithBrand(<AdminCoachesPage />);
    const row = await screen.findByTestId('admin-coach-row');
    expect(within(row).getByText('Dana Lee')).toBeInTheDocument();
    expect(within(row).getByText('Hidden')).toBeInTheDocument();
    expect(within(row).getByText(/Requests by email/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Site'), { target: { value: 'goapply' } });
    await waitFor(() => expect(api.adminListCoaches).toHaveBeenLastCalledWith({ brand: 'goapply' }, expect.anything()));
  });

  it('shows / hides a coach', async () => {
    renderWithBrand(<AdminCoachesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show on site' }));
    await waitFor(() => expect(api.adminUpdateCoach).toHaveBeenCalledWith('c1', { active: true }));
  });

  it('adding a coach needs the listing agreement; prices go in minor units', async () => {
    renderWithBrand(<AdminCoachesPage />);
    await screen.findByTestId('admin-coach-row');
    fireEvent.click(screen.getByRole('button', { name: 'Add a coach' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Lin Chen' } });
    fireEvent.change(within(dialog).getByLabelText('One-line description'), { target: { value: 'Engineering manager' } });
    fireEvent.change(within(dialog).getByLabelText('About the coach'), { target: { value: 'Hired 40 engineers.' } });
    fireEvent.change(within(dialog).getByLabelText('Session lengths (minutes)'), { target: { value: '60, 30' } });
    fireEvent.change(within(dialog).getByLabelText("Currency of the coach's prices"), { target: { value: 'usd' } });
    fireEvent.change(await within(dialog).findByLabelText('Price for 30 min'), { target: { value: '45' } });
    fireEvent.change(within(dialog).getByLabelText("Coach's booking page"), { target: { value: 'https://cal.example.test/lin' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('agreed to be listed');
    expect(api.adminCreateCoach).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByLabelText('This person agreed to be listed with these details.'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.adminCreateCoach).toHaveBeenCalled());
    expect(api.adminCreateCoach.mock.calls[0]![0]).toEqual({
      brand: 'roboapply',
      displayName: 'Lin Chen',
      headline: 'Engineering manager',
      bio: 'Hired 40 engineers.',
      languages: [],
      specialties: [],
      sessionLengths: [30, 60],
      active: false,
      bookingUrl: 'https://cal.example.test/lin',
      rates: { currency: 'USD', '30': 4500 },
      listingConsent: true,
    });
  });

  it('editing clears emptied fields with null and maps server reasons', async () => {
    api.adminUpdateCoach.mockRejectedValueOnce(
      new RoboApiError('x', { code: 'invalid_request', status: 422, payload: { success: false, code: 'invalid_request', details: { reason: 'no_booking_path' } } }),
    );
    renderWithBrand(<AdminCoachesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Price for 30 min')).toHaveValue('40');
    fireEvent.change(within(dialog).getByLabelText('Email for requests'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Price for 30 min'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.adminUpdateCoach).toHaveBeenCalled());
    const [id, body] = api.adminUpdateCoach.mock.calls[0]!;
    expect(id).toBe('c1');
    expect(body).toMatchObject({ requestEmail: null, bookingUrl: null, photoUrl: null, rates: null, active: false });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Add a booking page or an email for requests');
  });

  it('an unknown or other-site linked account gets a plain message', async () => {
    renderWithBrand(<AdminCoachesPage />);
    for (const [reason, text] of [
      ['coach_user_not_found', 'No account has that ID'],
      ['coach_user_wrong_brand', 'belongs to the other site'],
    ] as const) {
      api.adminUpdateCoach.mockRejectedValueOnce(
        new RoboApiError('x', { code: 'invalid_request', status: 422, payload: { success: false, code: 'invalid_request', details: { reason } } }),
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Linked account ID'), { target: { value: 'ghost' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  it('remove asks first', async () => {
    renderWithBrand(<AdminCoachesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Remove Dana Lee from the coach list/)).toBeInTheDocument();
    expect(api.adminDeleteCoach).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.adminDeleteCoach).toHaveBeenCalledWith('c1'));
  });

  it('form helpers validate lengths and prices', () => {
    expect(parseLengths('60, 30, 30')).toEqual([30, 60]);
    expect(parseLengths('')).toEqual([]);
    expect(parseLengths('10')).toBeNull();
    expect(parseLengths('thirty')).toBeNull();
    expect(buildRates([30], '', {})).toEqual({ rates: null });
    expect(buildRates([30], 'US', { '30': '40' })).toEqual({ rates: null, error: 'currency' });
    expect(buildRates([30], 'USD', { '30': 'abc' })).toEqual({ rates: null, error: 'price' });
    expect(buildRates([30, 60], 'jpy', { '30': '3000' })).toEqual({ rates: { currency: 'JPY', '30': 3000 } });
  });
});
