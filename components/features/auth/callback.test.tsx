// OAuth callback and email-link pages (WP-10): signed in → next; a new user
// ticks the agreements first; LINE without email asks for one; the other
// brand is explained; a link is never fired twice.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: '' }));
const api = vi.hoisted(() => ({ finishOAuth: vi.fn(), completeOAuth: vi.fn(), submitOAuthEmail: vi.fn(), getAuthMethods: vi.fn(), verifyEmail: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('../../../lib/auth/AuthProvider', async () => {
  const { mockAuthState } = await import('../../../__tests__/utils/mockAuth');
  return { AuthProvider: ({ children }: { children: unknown }) => children, useAuth: () => mockAuthState.value };
});
vi.mock('../../../lib/api/auth', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../lib/api/auth')>()), ...api }));

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { buildAuthValue, mockAuthState } from '../../../__tests__/utils/mockAuth';
import { RoboApiError } from '../../../lib/api/client';
import { OAuthCallbackView } from './OAuthCallbackView';
import { VerifyEmailView } from './VerifyEmailView';
import { RoboApplyAccessGate } from '../../RoboApplyAccessGate';

beforeEach(() => {
  vi.clearAllMocks();
  nav.search = 'code=c1&state=s1';
  api.getAuthMethods.mockResolvedValue({ methods: [], country: null, pdpaNoticeRequired: false });
  mockAuthState.value = buildAuthValue({ refresh: vi.fn(async () => null) as never });
});

describe('OAuth callback', () => {
  it('signed in → next, exchanging the code once', async () => {
    api.finishOAuth.mockResolvedValue({ status: 'signed_in', next: '/onboarding/situation', isNewUser: true });
    renderWithBrand(<OAuthCallbackView provider="google" />, { flags: {} });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/situation'));
    expect(api.finishOAuth).toHaveBeenCalledTimes(1);
    expect(api.finishOAuth).toHaveBeenCalledWith('google', { code: 'c1', state: 's1', error: null });
  });

  it('a new user ticks the agreements before the account exists', async () => {
    api.finishOAuth.mockResolvedValue({ status: 'consent_required', pendingToken: 'p'.repeat(20), next: '/jobs', name: null, email: 'n@example.test' });
    api.completeOAuth.mockResolvedValue({ status: 'signed_in', next: '/onboarding/situation', isNewUser: true });
    renderWithBrand(<OAuthCallbackView provider="google" />, { flags: {} });
    expect(await screen.findByRole('heading', { name: 'One more step' })).toBeInTheDocument();
    expect(screen.getByLabelText('Send me product news and tips')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Confirm that you are 16 or older to continue.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("I'm 16 or older"));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/situation'));
    expect(api.completeOAuth).toHaveBeenCalledWith('p'.repeat(20), expect.objectContaining({ marketingOptIn: false, consents: [expect.objectContaining({ type: 'age_16_plus', granted: true })] }));
  });

  it('LINE without email asks for one and says to check the inbox', async () => {
    api.finishOAuth.mockResolvedValue({ status: 'email_required', pendingToken: 'p'.repeat(20), next: '/jobs', name: 'Lin' });
    api.submitOAuthEmail.mockResolvedValue({ status: 'check_email' });
    renderWithBrand(<OAuthCallbackView provider="line" />, { flags: {} });
    expect(await screen.findByRole('heading', { name: 'Add your email' })).toBeInTheDocument();
    expect(screen.getByText(/LINE did not share a confirmed email address/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Email$/), { target: { value: 'lin@example.test' } });
    fireEvent.click(screen.getByLabelText("I'm 16 or older"));
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation link' }));
    expect(await screen.findByText(/We sent a message to lin@example.test/)).toBeInTheDocument();
  });

  it('a Google user without a confirmed email gets the same email step (LINE not required)', async () => {
    api.finishOAuth.mockResolvedValue({ status: 'email_required', pendingToken: 'p'.repeat(20), next: '/jobs', name: null });
    api.submitOAuthEmail.mockResolvedValue({ status: 'check_email' });
    renderWithBrand(<OAuthCallbackView provider="google" />, { flags: { 'auth.google': true } });
    expect(await screen.findByText(/Google did not share a confirmed email address/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Email$/), { target: { value: 'g@example.test' } });
    fireEvent.click(screen.getByLabelText("I'm 16 or older"));
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation link' }));
    expect(await screen.findByText(/We sent a message to g@example.test/)).toBeInTheDocument();
    expect(api.submitOAuthEmail).toHaveBeenCalledWith('p'.repeat(20), 'g@example.test', expect.anything());
  });

  it('explains a non-seeker account', async () => {
    api.finishOAuth.mockRejectedValue(new RoboApiError('x', { code: 'not_a_seeker_account', status: 403, payload: { code: 'not_a_seeker_account' } }));
    renderWithBrand(<OAuthCallbackView provider="google" />, { flags: {} });
    expect(await screen.findByText(/not a job-seeker account/)).toBeInTheDocument();
  });

  it('explains an account of the other brand', async () => {
    api.finishOAuth.mockRejectedValue(
      new RoboApiError('x', { code: 'account_other_brand', status: 409, payload: { code: 'account_other_brand', details: { otherBrandUrl: 'https://www.goapply.top/login' } } }),
    );
    renderWithBrand(<OAuthCallbackView provider="google" />, { flags: {} });
    expect(await screen.findByTestId('other-brand-notice')).toBeInTheDocument();
  });
});

describe('verify email page', () => {
  it('reports a confirmed email and fires the link once', async () => {
    api.verifyEmail.mockResolvedValue({ status: 'verified', next: '/settings#account' });
    renderWithBrand(<VerifyEmailView token="tok" />, { flags: {} });
    expect(await screen.findByRole('heading', { name: 'Email confirmed' })).toBeInTheDocument();
    expect(api.verifyEmail).toHaveBeenCalledTimes(1);
  });

  it('a LINE link for an address that already has an account says so and links nothing', async () => {
    api.verifyEmail.mockResolvedValue({ status: 'account_exists', next: '/login' });
    renderWithBrand(<VerifyEmailView token="tok" />, { flags: {} });
    expect(await screen.findByRole('heading', { name: 'You already have an account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('explains an expired link', async () => {
    api.verifyEmail.mockRejectedValue(new RoboApiError('x', { code: 'token_expired', status: 400, payload: { code: 'token_expired' } }));
    renderWithBrand(<VerifyEmailView token="tok" />, { flags: {} });
    expect(await screen.findByText(/has expired/)).toBeInTheDocument();
  });
});

describe('RoboApplyAccessGate (localized)', () => {
  it('lets a seeker through on either brand and explains a recruiter redirect', () => {
    const replace = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, replace } });
    mockAuthState.value = buildAuthValue();
    const { unmount } = renderWithBrand(
      <RoboApplyAccessGate>
        <p>app</p>
      </RoboApplyAccessGate>,
      { brand: 'goapply', flags: {} },
    );
    expect(screen.getByText('app')).toBeInTheDocument();
    unmount();
    mockAuthState.value = buildAuthValue({ user: { id: 'r', email: 'r@x.test', role: 'user', roles: ['user'] } });
    renderWithBrand(
      <RoboApplyAccessGate>
        <p>app</p>
      </RoboApplyAccessGate>,
      { flags: {} },
    );
    expect(screen.getByRole('status')).toHaveTextContent('This app is for job seekers. Redirecting you to RoboHire');
    expect(replace).toHaveBeenCalled();
  });
});
