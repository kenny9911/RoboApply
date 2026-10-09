// WP-21b — /cancel without signing in, the checkout return page, the footer link.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import { atPhoneWidth, creditsResponse, renderUi } from './fixtures';
import { RoboApiError } from '../../../../lib/api/client';
import { mockAuthState, buildAuthValue } from '../../../../__tests__/utils/mockAuth';

const api = vi.hoisted(() => ({ getCredits: vi.fn(), requestPublicCancel: vi.fn(), confirmPublicCancel: vi.fn() }));
vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

import { PublicCancelFlow } from '../PublicCancelFlow';
import { CheckoutReturn } from '../CheckoutReturn';
import { CancelFooterLink } from '../CancelFooterLink';

beforeEach(() => {
  atPhoneWidth();
  for (const fn of Object.values(api)) fn.mockReset();
  mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
});

describe('/cancel (no sign-in)', () => {
  it('email → the same neutral answer, whoever asks', async () => {
    api.requestPublicCancel.mockResolvedValue(undefined);
    renderUi(<PublicCancelFlow />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: '  Jane@Example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send cancel link' }));
    expect(await screen.findByTestId('public-cancel-sent')).toHaveTextContent('If this email has a subscription');
    expect(api.requestPublicCancel).toHaveBeenCalledWith({ email: 'jane@example.com' });
    expect(screen.queryByText(/signed in/)).toBeNull();
  });

  it('rejects an invalid email without calling the API', () => {
    renderUi(<PublicCancelFlow />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send cancel link' }));
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(api.requestPublicCancel).not.toHaveBeenCalled();
  });

  it('token link: one button cancels; the token leaves the address bar', async () => {
    window.history.replaceState(null, '', '/cancel?token=tok_abcdefghijklmnop');
    api.confirmPublicCancel.mockResolvedValue({ status: 'cancelled', accessUntil: '2026-11-01T00:00:00Z', alternative: null });
    renderUi(<PublicCancelFlow token="tok_abcdefghijklmnop" />);
    await waitFor(() => expect(window.location.search).toBe(''));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel now' }));
    expect(await screen.findByTestId('public-cancel-done')).toHaveTextContent('Your subscription is cancelled');
    expect(api.confirmPublicCancel).toHaveBeenCalledWith({ token: 'tok_abcdefghijklmnop' });
  });

  it('expired or used token: says so and offers a new link', async () => {
    api.confirmPublicCancel.mockRejectedValue(new RoboApiError('bad', { status: 400, code: 'cancel_token_invalid', payload: { code: 'cancel_token_invalid' } }));
    renderUi(<PublicCancelFlow token="tok_abcdefghijklmnop" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel now' }));
    expect(await screen.findByText(/expired or was already used/)).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('signed-in visitors also get the settings link', () => {
    mockAuthState.value = buildAuthValue();
    renderUi(<PublicCancelFlow />);
    expect(screen.getByRole('link', { name: 'Open billing settings' })).toHaveAttribute('href', '/settings#billing');
  });
});

describe('CheckoutReturn', () => {
  it('cancelled checkout says nothing was charged', () => {
    api.getCredits.mockResolvedValue(creditsResponse());
    renderUi(<CheckoutReturn outcome="cancel" />);
    expect(screen.getByText('Nothing was charged. You can choose a plan again any time.')).toBeInTheDocument();
  });

  it('success waits for the server before saying Pro is on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getCredits.mockResolvedValueOnce(creditsResponse());
    api.getCredits.mockResolvedValue(creditsResponse({ planProfile: 'pro', planKey: 'pro_monthly' }));
    renderUi(<CheckoutReturn outcome="success" pollMs={10} />);
    expect(await screen.findByText(/Your plan updates within a minute/)).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(await screen.findByText('Pro is on.')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('a practice pack is done when the practice balance rises — not when the plan turns Pro', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // A Free user: the plan never turns Pro after buying a pack.
    api.getCredits.mockResolvedValueOnce(creditsResponse({}, { balance: 1 }));
    api.getCredits.mockResolvedValue(creditsResponse({}, { balance: 6 }));
    renderUi(<CheckoutReturn outcome="success" planKey="practice_pack_5" practiceBefore={1} pollMs={10} />);
    expect(await screen.findByText(/practice interviews are added within a minute/)).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(await screen.findByText('Your practice interviews are added. You have 6 now.')).toBeInTheDocument();
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();
    vi.useRealTimers();
  });

  it('a pack with no baseline gets the neutral line, never the "taking longer" warning', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({}, { balance: 1 }));
    renderUi(<CheckoutReturn outcome="success" planKey="practice_pack_5" practiceBefore={null} pollMs={10} />);
    await waitFor(() => expect(api.getCredits).toHaveBeenCalled());
    expect(screen.getByText(/added as soon as the payment clears/)).toBeInTheDocument();
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();
    expect(screen.getByTestId('checkout-return').querySelector('[aria-busy]')).toBeNull();
  });
});

describe('CancelFooterLink', () => {
  it('links to /cancel', () => {
    renderUi(<CancelFooterLink />);
    expect(screen.getByRole('link', { name: 'Cancel a subscription' })).toHaveAttribute('href', '/cancel');
  });
});
