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
// GoApply's sign-up policy (invite mode, required consents) for the email form (INT-01).
const cnApi = vi.hoisted(() => ({ getSignupPolicy: vi.fn() }));
vi.mock('../../../lib/api/authCn', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../lib/api/authCn')>()), ...cnApi }));

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { buildAuthValue, mockAuthState } from '../../../__tests__/utils/mockAuth';
import { RoboApiError } from '../../../lib/api/client';
import { AuthEntryView, filterAndOrder } from './AuthEntryView';
import { ForgotPasswordView, ResetPasswordView } from './PasswordResetViews';
import { SignedInSessions, SignInMethods } from './SecuritySettings';
import { AUTH_METHOD_REGISTRY, SECONDARY_AUTH_METHODS, layoutAuthMethods } from '../../auth/methods/registry';
import { signupInputs } from '../auth-cn/shared';
import { SecurityCard } from '../../v3/account/security';

const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  nav.search = '';
  api.getAuthMethods.mockResolvedValue({ methods: [], country: null, pdpaNoticeRequired: false });
  api.getEntryJob.mockResolvedValue(null);
  cnApi.getSignupPolicy.mockResolvedValue(CN0_INVITE_POLICY);
  signupInputs.reset();
  mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null, refresh: vi.fn(async () => null) as never });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign, href: 'http://localhost/signup', pathname: '/signup', search: '' },
  });
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Macintosh) Chrome/129.0' });
});

const ON = { 'auth.google': true, 'auth.line': true, 'auth.passwordReset': true };

/** GoApply while invite-only and processed outside the mainland (the defaults). */
const CN0_INVITE_POLICY = {
  signupOpen: true,
  inviteRequired: true,
  // Each required consent with the text the form shows beside its box (the
  // compliance catalog prose), its version and its hash.
  requiredConsents: [
    { type: 'pipl_basic_processing', proseVersion: 'v1', prose: { text: 'I have read and agree to the User Agreement and the Privacy Policy.', locale: 'en', version: 'catalog.v1', hash: 'a'.repeat(64) } },
    { type: 'age_16_plus', proseVersion: 'v1', prose: { text: 'I am 16 or older.', locale: 'en', version: 'catalog.v1', hash: 'b'.repeat(64) } },
    {
      type: 'pipl_cross_border',
      proseVersion: 'v1',
      prose: { text: 'Your personal information is processed and stored outside mainland China. I agree to this processing.', locale: 'en', version: 'catalog.v1', hash: 'c'.repeat(64) },
    },
  ],
  methods: { phoneOtp: false, wechatWeb: false, wechatInApp: false },
  legal: { termsPath: '/legal/terms', privacyPath: '/legal/privacy' },
};

function wireError(status: number, code: string, details?: Record<string, unknown>) {
  return new RoboApiError('x', { status, code, payload: { success: false, code, error: 'x', ...(details ? { details } : {}) } });
}

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

  // Verification finding: "Enter a valid email address." showed under the field and again in the red box.
  it('a bad email is said once, under the field, and goes away when the address is fixed', async () => {
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: {} });
    fill(/^Email$/, 'bad');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getAllByText('Enter a valid email address.')).toHaveLength(1);
    expect(screen.getByLabelText(/^Email$/)).toHaveAttribute('aria-invalid', 'true');
    expect(api.signup).not.toHaveBeenCalled();
    fill(/^Email$/, 'good@example.test');
    expect(screen.queryByText('Enter a valid email address.')).toBeNull();
  });

  it('an empty email is said once too when Create account is pressed', () => {
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: {} });
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getAllByText('Enter a valid email address.')).toHaveLength(1);
    expect(api.signup).not.toHaveBeenCalled();
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

  it('GoApply keeps email behind "其他方式" (Other ways to sign in) when another method exists', () => {
    renderWithBrand(<AuthEntryView mode="login" />, { brand: 'goapply', flags: { 'auth.wechatWeb': true } });
    expect(screen.queryByLabelText(/^Email$/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Other ways to sign in' }));
    // The email form opens in place and takes focus.
    expect(screen.getByLabelText(/^Email$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email$/)).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Other ways to sign in' })).toBeNull();
  });

  it('GoApply with no other method available shows the email form at once (never an empty card)', () => {
    renderWithBrand(<AuthEntryView mode="login" />, { brand: 'goapply', flags: {} });
    expect(screen.getByLabelText(/^Email$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Other ways to sign in' })).toBeNull();
  });

  it('RoboApply never hides the email form', () => {
    renderWithBrand(<AuthEntryView mode="login" />, { flags: { 'auth.google': true } });
    expect(screen.getByLabelText(/^Email$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Other ways to sign in' })).toBeNull();
  });

  it('two-step sign-in: the password was right → the code page, carrying `next`; nothing else happens', async () => {
    const refresh = vi.fn(async () => null);
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null, refresh: refresh as never });
    api.login.mockRejectedValue(wireError(401, 'two_factor_required', { next: '/login/2fa', methods: ['totp', 'recovery'], expiresInSec: 300 }));
    nav.search = 'next=/jobs/cm1';
    renderWithBrand(<AuthEntryView mode="login" />, { flags: {} });
    fill(/^Email$/, 'ana@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login/2fa?next=%2Fjobs%2Fcm1'));
    // No session exists yet: the form does not ask for /auth/me and shows no error.
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a `next` to a free tool page is honoured after sign-in even while onboarding is unfinished', async () => {
    const me = { onboarding: { step: 'account', path: null, completed: false, nextRoute: '/onboarding/situation' } };
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null, refresh: vi.fn(async () => me) as never });
    api.login.mockResolvedValue({ user: { id: 'u1' }, token: 'j' });
    nav.search = 'from=resume-check&next=/tools/resume-check';
    renderWithBrand(<AuthEntryView mode="login" />, { flags: {} });
    fill(/^Email$/, 'ana@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/tools/resume-check'));
  });
});

describe('signup: `next` and the contextual title for the free tools', () => {
  it('returns to the tool page instead of the first onboarding screen; any other next goes to onboarding', async () => {
    api.signup.mockResolvedValue({ user: { id: 'u1' }, token: 'j', next: '/onboarding/situation' });
    nav.search = 'from=resume-job-match&next=/tools/resume-job-match';
    const tool = renderWithBrand(<AuthEntryView mode="signup" />, { flags: {} });
    expect(screen.getByRole('heading', { name: 'Create a free account to keep your resume and job match' })).toBeInTheDocument();
    fill(/^Email$/, 'new@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByLabelText("I'm 16 or older"));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/tools/resume-job-match'));
    tool.unmount();

    nav.replace.mockClear();
    nav.search = 'next=/jobs/cm1';
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: {} });
    fill(/^Email$/, 'two@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByLabelText("I'm 16 or older"));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/situation'));
  });
});

describe('GoApply email sign-up (invite mode, CN-0 consents)', () => {
  const openEmail = () => fireEvent.click(screen.getByRole('button', { name: 'Other ways to sign in' }));

  it('with no other method on the page the email form shows GoApply’s own boxes and the invite field, all unticked', async () => {
    renderWithBrand(<AuthEntryView mode="signup" />, { brand: 'goapply', flags: {} });
    // Once the sign-up policy has loaded: the invite field and one box per
    // required consent (the agreement, the age confirmation and the separate
    // cross-border consent), each with the text the policy serves.
    expect(await screen.findByLabelText('Invite code')).toHaveValue('');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    for (const box of boxes) expect(box).not.toBeChecked();
    for (const c of CN0_INVITE_POLICY.requiredConsents) expect(screen.getByRole('checkbox', { name: c.prose.text })).toBeInTheDocument();
    expect(cnApi.getSignupPolicy).toHaveBeenCalledWith('en');
    // Not RoboApply's boxes.
    expect(screen.queryByLabelText("I'm 16 or older")).toBeNull();
    expect(screen.queryByLabelText('Send me product news and tips')).toBeNull();
  });

  it('refuses to submit until the boxes are ticked, then sends each consent with the hash of the text shown, and the invite code', async () => {
    api.signup.mockResolvedValue({ user: { id: 'u1' }, token: 'j', next: '/onboarding/consent' });
    renderWithBrand(<AuthEntryView mode="signup" />, { brand: 'goapply', flags: {} });
    await screen.findByLabelText('Invite code');
    fill(/^Email$/, 'xin@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Tick every box above to continue.')).toBeInTheDocument();
    expect(api.signup).not.toHaveBeenCalled();

    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    fill(/^Invite code$/, 'abcde-fghjk');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/consent'));
    expect(api.signup).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'xin@example.test',
        inviteCode: 'ABCDE-FGHJK',
        marketingOptIn: false,
        // The version and hash of the text beside each box, as the policy served it.
        consents: [
          { type: 'pipl_basic_processing', granted: true, proseVersion: 'catalog.v1', proseHash: 'a'.repeat(64) },
          { type: 'age_16_plus', granted: true, proseVersion: 'catalog.v1', proseHash: 'b'.repeat(64) },
          { type: 'pipl_cross_border', granted: true, proseVersion: 'catalog.v1', proseHash: 'c'.repeat(64) },
        ],
      }),
    );
  });

  it('one unticked box is enough to refuse: the cross-border consent is its own box', async () => {
    renderWithBrand(<AuthEntryView mode="signup" />, { brand: 'goapply', flags: {} });
    await screen.findByLabelText('Invite code');
    fill(/^Email$/, 'xin@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have read and agree to the User Agreement and the Privacy Policy.' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'I am 16 or older.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Tick every box above to continue.')).toBeInTheDocument();
    expect(api.signup).not.toHaveBeenCalled();
  });

  it('the consent text changed while the form was open: the new text is loaded, the boxes are asked again, and the next try sends the new hash', async () => {
    renderWithBrand(<AuthEntryView mode="signup" />, { brand: 'goapply', flags: {} });
    await screen.findByLabelText('Invite code');
    fill(/^Email$/, 'xin@example.test');
    fill(/^Password$/, 'abcdefg1');
    fill(/^Invite code$/, 'ABCDE-FGHJK');
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);

    const reworded = {
      ...CN0_INVITE_POLICY,
      requiredConsents: CN0_INVITE_POLICY.requiredConsents.map((c) =>
        c.type === 'pipl_cross_border' ? { ...c, prose: { ...c.prose, text: 'New wording of the cross-border consent.', version: 'catalog.v2', hash: 'd'.repeat(64) } } : c,
      ),
    };
    cnApi.getSignupPolicy.mockResolvedValue(reworded);
    api.signup.mockRejectedValueOnce(wireError(422, 'consent_required', { outdated: ['pipl_cross_border'], proseVersion: 'catalog.v2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('The agreement text was updated. Read it again and tick the boxes to continue.')).toBeInTheDocument();
    const fresh = await screen.findByRole('checkbox', { name: 'New wording of the cross-border consent.' });
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
    expect(nav.replace).not.toHaveBeenCalled();

    api.signup.mockResolvedValue({ user: { id: 'u1' }, token: 'j', next: '/onboarding/consent' });
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    expect(fresh).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/consent'));
    const sent = (api.signup.mock.calls.at(-1)![0] as { consents: Array<{ type: string; proseHash: string; proseVersion: string }> }).consents;
    expect(sent.find((c) => c.type === 'pipl_cross_border')).toMatchObject({ proseHash: 'd'.repeat(64), proseVersion: 'catalog.v2' });
  });

  it('shows the server’s answers in the real wire shape: a bad invite, a missing invite, a missing consent', async () => {
    renderWithBrand(<AuthEntryView mode="signup" />, { brand: 'goapply', flags: {} });
    await screen.findByLabelText('Invite code');
    fill(/^Email$/, 'xin@example.test');
    fill(/^Password$/, 'abcdefg1');
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    api.signup.mockRejectedValueOnce(wireError(422, 'invite_invalid'));
    submit();
    expect(await screen.findByText('That invite code is not valid or has been used.')).toBeInTheDocument();
    api.signup.mockRejectedValueOnce(wireError(422, 'invite_invalid', { missing: true }));
    submit();
    expect(await screen.findByText('Enter an invite code to create a new account.')).toBeInTheDocument();
    api.signup.mockRejectedValueOnce(wireError(422, 'consent_required', { missing: ['pipl_cross_border'] }));
    submit();
    expect(await screen.findByText('Accept the required agreements to create an account.')).toBeInTheDocument();
    // "Sign-up is not open" appears only when the server says so.
    expect(screen.queryByText('Sign-up with email is not open yet. Existing accounts can still sign in.')).toBeNull();
    api.signup.mockRejectedValueOnce(wireError(403, 'signup_closed'));
    submit();
    expect(await screen.findByText('Sign-up with email is not open yet. Existing accounts can still sign in.')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('next to the phone form it shares that form’s boxes instead of showing a second set', async () => {
    cnApi.getSignupPolicy.mockResolvedValue({ ...CN0_INVITE_POLICY, methods: { phoneOtp: true, wechatWeb: false, wechatInApp: false } });
    api.signup.mockResolvedValue({ user: { id: 'u1' }, token: 'j', next: '/onboarding/consent' });
    renderWithBrand(<AuthEntryView mode="signup" />, { brand: 'goapply', flags: { 'auth.phoneOtp': true } });
    await screen.findByLabelText('Invite code');
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    openEmail();
    // Still one set of boxes and one invite field.
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getAllByLabelText('Invite code')).toHaveLength(1);
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    fill(/^Invite code$/, 'ABCDE-FGHJK');
    fill(/^Email$/, 'xin@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(api.signup).toHaveBeenCalledWith(expect.objectContaining({ inviteCode: 'ABCDE-FGHJK', consents: expect.any(Array) })));
    // The shared boxes carry the same texts, so the email form still sends their hashes.
    const sent = (api.signup.mock.calls.at(-1)![0] as { consents: Array<{ proseHash?: string }> }).consents;
    expect(sent.map((c) => c.proseHash)).toEqual(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
  });

  it('RoboApply sign-up sends no invite code and RoboApply’s agreements only', async () => {
    api.signup.mockResolvedValue({ user: { id: 'u1' }, token: 'j', next: '/onboarding/situation' });
    renderWithBrand(<AuthEntryView mode="signup" />, { flags: {} });
    fill(/^Email$/, 'new@example.test');
    fill(/^Password$/, 'abcdefg1');
    fireEvent.click(screen.getByLabelText("I'm 16 or older"));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(api.signup).toHaveBeenCalled());
    const sent = api.signup.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('inviteCode');
    expect(sent.consents).toEqual([{ type: 'age_16_plus', granted: true, proseVersion: expect.any(String) }]);
    expect(cnApi.getSignupPolicy).not.toHaveBeenCalled();
  });
});

describe('which methods sit behind "Other ways to sign in"', () => {
  const R = AUTH_METHOD_REGISTRY;
  const ids = (list: Array<{ id: string }>) => list.map((m) => m.id);

  it('GoApply: email is secondary while phone or WeChat is available; RoboApply has none', () => {
    expect(SECONDARY_AUTH_METHODS).toEqual({ roboapply: [], goapply: ['email_password'] });
    const go = layoutAuthMethods('goapply', [R.phone_otp, R.wechat, R.email_password]);
    expect([ids(go.primary), ids(go.secondary)]).toEqual([['phone_otp', 'wechat'], ['email_password']]);
    const wechatOnly = layoutAuthMethods('goapply', [R.wechat, R.email_password]);
    expect([ids(wechatOnly.primary), ids(wechatOnly.secondary)]).toEqual([['wechat'], ['email_password']]);
    const robo = layoutAuthMethods('roboapply', [R.email_password, R.google]);
    expect([ids(robo.primary), ids(robo.secondary)]).toEqual([['email_password', 'google'], []]);
  });

  it('a secondary method moves up when nothing else is available', () => {
    const alone = layoutAuthMethods('goapply', [R.email_password]);
    expect([ids(alone.primary), ids(alone.secondary)]).toEqual([['email_password'], []]);
    expect(layoutAuthMethods('goapply', [])).toEqual({ primary: [], secondary: [] });
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

  // Verification finding: /reset-password/bogus-token-123 answered a valid new
  // password with "Use at least 8 characters…" (422 invalid_request on the token's length).
  it('reset: a cut-off or mistyped link is "not valid" with a way to ask for a new one, never a password error', async () => {
    api.resetPassword.mockRejectedValue(
      wireError(422, 'invalid_request', { where: 'body', issues: [{ path: ['token'], code: 'too_small', message: 'Too small' }] }),
    );
    renderWithBrand(<ResetPasswordView token="bogus-token-123" />, { flags: {} });
    fill(/^New password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('This reset link is not valid or was already used.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute('href', '/forgot-password');
    expect(screen.queryByText(/at least one letter and one number/)).toBeNull();
  });

  it('reset: a 422 that names the password is still a password message', async () => {
    api.resetPassword.mockRejectedValue(wireError(422, 'invalid_request', { where: 'body', issues: [{ path: ['password'], code: 'too_big', message: 'Too big' }] }));
    renderWithBrand(<ResetPasswordView token="a-real-looking-token-0001" />, { flags: {} });
    fill(/^New password$/, 'abcdefg1');
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText(/at least one letter and one number/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ask for a new link' })).toBeNull();
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

  it('reset on an account with two-step sign-in: the password is saved, then the code page (no session yet)', async () => {
    const refresh = vi.fn(async () => null);
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null, refresh: refresh as never });
    api.resetPassword.mockRejectedValue(wireError(401, 'two_factor_required', { next: '/login/2fa?next=%2Fjobs', methods: ['totp', 'recovery'], expiresInSec: 300 }));
    renderWithBrand(<ResetPasswordView token="tok" />, { flags: {} });
    fill(/^New password$/, 'abcdefg1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login/2fa?next=%2Fjobs'));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
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
