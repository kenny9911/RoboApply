// WP-10 web acceptance (Testing Library + jsdom): login/signup render the
// brand's configured methods, the in-app browser guard, contextual titles,
// carried query params, the agreements (marketing unchecked, required age,
// PDPA for zh-TW/TW), the cross-brand notice, sign-in routing, password
// reset pages and the settings pieces.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: '' }));
const api = vi.hoisted(() => ({
  login: vi.fn(),
  signup: vi.fn(),
  getAuthMethods: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  listIdentities: vi.fn(),
  unlinkIdentity: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  getEmailStatus: vi.fn(),
  sendVerificationEmail: vi.fn(),
  getEntryJob: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/signup',
}));
vi.mock('../../../lib/auth/AuthProvider', async () => {
  const { mockAuthState } = await import('../../../__tests__/utils/mockAuth');
  return { AuthProvider: ({ children }: { children: unknown }) => children, useAuth: () => mockAuthState.value };
});
vi.mock('../../../lib/api/auth', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../lib/api/auth')>()), ...api }));

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { buildAuthValue, mockAuthState } from '../../../__tests__/utils/mockAuth';
import { RoboApiError } from '../../../lib/api/client';
import { AuthEntryView, filterAndOrder } from './AuthEntryView';
import { ForgotPasswordView, ResetPasswordView } from './PasswordResetViews';
import { SignedInSessions, SignInMethods } from './SecuritySettings';
import { AUTH_METHOD_REGISTRY } from '../../auth/methods/registry';
import { SecurityCard } from '../../v3/account/security';

const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  nav.search = '';
  api.getAuthMethods.mockResolvedValue({ methods: [], country: null, pdpaNoticeRequired: false });
  api.getEntryJob.mockResolvedValue(null);
  mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null, refresh: vi.fn(async () => null) as never });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign, href: 'http://localhost/signup', pathname: '/signup', search: '' },
  });
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Macintosh) Chrome/129.0' });
});

const ON = { 'auth.google': true, 'auth.line': true, 'auth.passwordReset': true };

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('signup', () => {
  it('shows configured methods only, with marketing unchecked and age required', async () => {
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: { 'auth.google': true } });
    expect(screen.getByRole('heading', { name: 'Create your free account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with LINE' })).toBeNull();
    expect(screen.getByLabelText('Send me product news and tips')).not.toBeChecked();
    expect(screen.getByLabelText("I'm 16 or older")).not.toBeChecked();
    expect(screen.queryByText(/personal data notice/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal/terms');
  });

  it('refuses to submit without the age box, then sends the agreements and routes to onboarding', async () => {
    api.signup.mockResolvedValue({ user: { id: 'u1' }, token: 'j', next: '/onboarding/situation' });
    nav.search = 'from=job&job=cm1&utm_source=news';
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: {} });
    fill(/^Email$/, 'new@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Confirm that you are 16 or older to continue.')).toBeInTheDocument();
    expect(api.signup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("I'm 16 or older"));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/situation'));
    expect(api.signup).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@example.test',
        marketingOptIn: false,
        consents: [{ type: 'age_16_plus', granted: true, proseVersion: expect.any(String) }],
        attribution: expect.objectContaining({ from: 'job', jobId: 'cm1', utmSource: 'news' }),
      }),
    );
  });

  it('checks the password rules inline', () => {
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: {} });
    fill(/^Password$/, 'abcdefgh');
    const rules = screen.getByRole('list', { name: 'Password rules' });
    expect(rules.querySelectorAll('[data-met="true"]')).toHaveLength(2);
  });

  it('shows the PDPA notice row for zh-TW / Taiwan and requires it', async () => {
    api.getAuthMethods.mockResolvedValue({ methods: [], country: 'TW', pdpaNoticeRequired: true });
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: {} });
    const pdpa = await screen.findByRole('checkbox', { name: /personal data notice/ });
    expect(pdpa).not.toBeChecked();
    fill(/^Email$/, 'tw@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByLabelText("I'm 16 or older"));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Read and accept the personal data notice to continue.')).toBeInTheDocument();
    expect(api.signup).not.toHaveBeenCalled();
  });

  it('an other-brand email gets the normal "check your email" screen', async () => {
    api.signup.mockResolvedValue({ status: 'check_email' });
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: {} });
    fill(/^Email$/, 'held@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByLabelText("I'm 16 or older"));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByTestId('check-email')).toHaveTextContent('held@example.test');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('Google waits for the age box, then starts OAuth carrying the agreements', () => {
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: { 'auth.google': true } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByText('Tick the required boxes below first.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("I'm 16 or older"));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(assign).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/v1\/roboapply\/auth\/oauth\/google\/start\?.*age=1.*marketing=0/));
  });

  it('uses a contextual title from the looked-up job and carries the query to /login', async () => {
    api.getEntryJob.mockResolvedValue({ title: 'Data Analyst', companyName: 'Acme' });
    nav.search = 'action=apply&job=cm1&next=%2Fjobs%2Fcm1';
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: {} });
    expect(await screen.findByRole('heading', { name: 'Create a free account to see how you fit Data Analyst' })).toBeInTheDocument();
    expect(api.getEntryJob).toHaveBeenCalledWith('cm1');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login?next=%2Fjobs%2Fcm1&job=cm1&action=apply');
  });

  it('never shows text from the URL: a jobTitle param or an unknown job keeps the default title', async () => {
    nav.search = 'action=apply&job=nope&jobTitle=Your%20account%20is%20locked';
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: {} });
    await waitFor(() => expect(api.getEntryJob).toHaveBeenCalledWith('nope'));
    expect(screen.getByRole('heading', { name: 'Create your free account' })).toBeInTheDocument();
    expect(screen.queryByText(/locked/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).not.toContain('jobTitle');
  });

  it('hides LINE from visitors outside zh-TW / Taiwan even when it is configured', async () => {
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: ON });
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with LINE' })).toBeNull();
  });

  it('replaces provider buttons inside in-app browsers; email still works', async () => {
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone) Instagram 300.0' });
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: ON });
    expect(await screen.findAllByText('Open in your browser to continue with Google')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });
});

describe('login', () => {
  it('routes an unfinished onboarding to its screen, a finished one to `next`', async () => {
    api.login.mockResolvedValue({ user: { id: 'u1' }, token: 'j' });
    nav.search = 'next=%2Fjobs%2Fcm1';
    const me = { user: { id: 'u1' }, profile: null, onboarding: { step: 'basics', path: null, completed: false, nextRoute: '/onboarding/basics' } };
    mockAuthState.value = buildAuthValue({ refresh: vi.fn(async () => me) as never });
    const first = renderWithBrand(<AuthEntryView mode="login" />, { flags: {} });
    fill(/^Email$/, 'a@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/basics'));
    first.unmount();

    nav.replace.mockClear();
    mockAuthState.value = buildAuthValue({
      refresh: vi.fn(async () => ({ ...me, onboarding: { step: 'done', path: null, completed: true, nextRoute: null } })) as never,
    });
    renderWithBrand(<AuthEntryView mode="login" />, { flags: {} });
    fill(/^Email$/, 'a@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/jobs/cm1'));
  });

  it('shows "continue there" for an account of the other brand', async () => {
    api.login.mockRejectedValue(
      new RoboApiError('other', {
        code: 'account_other_brand',
        status: 409,
        payload: { code: 'account_other_brand', details: { otherBrandUrl: 'https://www.goapply.top/login' } },
      }),
    );
    renderWithBrand(<AuthEntryView mode="login" />, { flags: {} });
    fill(/^Email$/, 'a@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const notice = await screen.findByTestId('other-brand-notice');
    expect(notice).toHaveTextContent('This account belongs to GoApply');
    expect(screen.getByRole('link', { name: 'Go to GoApply' })).toHaveAttribute('href', 'https://www.goapply.top/login');
  });

  it('links "Forgot password?" only when reset is available', () => {
    const { unmount } = renderWithBrand(<AuthEntryView mode="login" />, { flags: {} });
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).toBeNull();
    unmount();
    renderWithBrand(<AuthEntryView mode="login" />, { flags: { 'auth.passwordReset': true } });
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password');
  });

  it('GoApply keeps email behind "Use email instead" when another method exists', () => {
    renderWithBrand(<AuthEntryView mode="login" />, { brand: 'goapply', flags: { 'auth.wechatWeb': true } });
    expect(screen.queryByLabelText(/^Email$/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use email instead' }));
    expect(screen.getByLabelText(/^Email$/)).toBeInTheDocument();
  });
});

describe('method order', () => {
  it('offers LINE only to zh-TW or Taiwan, and then first', () => {
    const list = [AUTH_METHOD_REGISTRY.email_password, AUTH_METHOD_REGISTRY.google, AUTH_METHOD_REGISTRY.line];
    expect(filterAndOrder(list, { locale: 'en', country: null }).map((m) => m.id)).toEqual(['email_password', 'google']);
    expect(filterAndOrder(list, { locale: 'en', country: 'US' }).map((m) => m.id)).toEqual(['email_password', 'google']);
    expect(filterAndOrder(list, { locale: 'zh-TW', country: null }).map((m) => m.id)).toEqual(['line', 'email_password', 'google']);
    expect(filterAndOrder(list, { locale: 'en', country: 'TW' })[0]!.id).toBe('line');
  });
});

describe('password reset pages', () => {
  it('forgot: the same answer whether or not the email has an account', async () => {
    api.requestPasswordReset.mockResolvedValue(null);
    renderWithBrand(<ForgotPasswordView />, { flags: { 'auth.passwordReset': true } });
    fill(/^Email$/, 'a@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByTestId('reset-sent')).toHaveTextContent('If a@example.test has an account');
  });

  it('forgot: says reset is unavailable when no email transport is configured', () => {
    renderWithBrand(<ForgotPasswordView />, { flags: {} });
    expect(screen.getByText(/not available right now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send reset link' })).toBeNull();
  });

  it('reset: enforces the rules and explains an expired link', async () => {
    api.resetPassword.mockRejectedValue(new RoboApiError('x', { code: 'token_expired', status: 400, payload: { code: 'token_expired' } }));
    renderWithBrand(<ResetPasswordView token="tok" />, { flags: {} });
    fill(/^New password$/, 'short');
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText(/at least one letter and one number/)).toBeInTheDocument();
    expect(api.resetPassword).not.toHaveBeenCalled();
    fill(/^New password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('This reset link has expired.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute('href', '/forgot-password');
  });

  it('reset: success signs in and moves on', async () => {
    api.resetPassword.mockResolvedValue({ next: '/jobs' });
    renderWithBrand(<ResetPasswordView token="tok" />, { flags: {} });
    fill(/^New password$/, 'abcdefg1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/jobs'));
    expect(api.resetPassword).toHaveBeenCalledWith('tok', 'abcdefg1');
  });
});

describe('settings: sign-in methods and sessions', () => {
  it('lists methods; the last one has no Remove', async () => {
    api.listIdentities.mockResolvedValue({
      identities: [{ id: 'email', provider: 'email', display: 'a•••@example.test', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null, removable: false }],
    });
    renderWithBrand(<SignInMethods />, { flags: {} });
    expect(await screen.findByText(/Email and password · a•••@example.test/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByText(/last one cannot be removed/)).toBeInTheDocument();
  });

  it('removes a linked provider', async () => {
    const two = {
      identities: [
        { id: 'email', provider: 'email', display: 'a•••@x.test', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null, removable: true },
        { id: 'i1', provider: 'google', display: 'a•••@x.test', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: '2026-10-09T00:00:00Z', removable: true },
      ],
    };
    api.listIdentities.mockResolvedValue(two);
    api.unlinkIdentity.mockResolvedValue({ identities: [two.identities[0]] });
    renderWithBrand(<SignInMethods />, { flags: {} });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Google' }));
    await waitFor(() => expect(api.unlinkIdentity).toHaveBeenCalledWith('i1'));
  });

  it('marks this device and signs out another session', async () => {
    api.listSessions.mockResolvedValue({
      sessions: [
        { id: 's1', createdAt: '2026-10-09T00:00:00Z', expiresAt: '2026-11-09T00:00:00Z', current: true },
        { id: 's2', createdAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', current: false },
      ],
    });
    api.revokeSession.mockResolvedValue({ revoked: 1 });
    renderWithBrand(<SignedInSessions />, { flags: {} });
    expect(await screen.findByText('This device')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Sign out' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(api.revokeSession).toHaveBeenCalledWith('s2'));
  });
});

describe('settings: change password', () => {
  it('states the same letter-and-number rule as signup', () => {
    renderWithBrand(
      <SecurityCard
        hasPassword
        provider="email"
        changing={false}
        signingOut={false}
        passwordError={null}
        passwordSuccess={false}
        onChangePassword={vi.fn()}
        onSignOutEverywhere={vi.fn()}
        resetKey={0}
      />,
      { flags: {} },
    );
    fill(/^New password$/, 'abcdefgh');
    expect(screen.getByText('Use at least 8 characters with at least one letter and one number.')).toBeInTheDocument();
  });
});
