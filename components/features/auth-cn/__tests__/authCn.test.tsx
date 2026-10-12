// WP-11 web: GoApply sign-in methods, bind/change phone, the WeChat return
// page, the in-WeChat guidance banner, the phone-binding notice and the
// admin invite console. API calls are mocked (lib/api/authCn); no network.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { buildAuthValue, buildFakeUser, mockAuthState } from '../../../../__tests__/utils/mockAuth';
import { RoboApiError } from '../../../../lib/api/client';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/signup',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const api = vi.hoisted(() => ({
  getSignupPolicy: vi.fn(),
  getPhoneStatus: vi.fn(),
  sendPhoneCode: vi.fn(),
  verifyPhoneCode: vi.fn(),
  bindPhone: vi.fn(),
  changePhone: vi.fn(),
  startWechatSignIn: vi.fn(),
  wechatQrUrl: vi.fn((q?: Record<string, string>) => `/api/v1/roboapply/auth/wechat/qr?${new URLSearchParams(q ?? {}).toString()}`),
  wechatMpStartUrl: vi.fn((q?: Record<string, string>) => `/api/v1/roboapply/auth/wechat/mp/start?${new URLSearchParams(q ?? {}).toString()}`),
  adminListInvites: vi.fn(),
  adminCreateInvites: vi.fn(),
}));
vi.mock('../../../../lib/api/authCn', () => api);

import {
  AdminInvites,
  BindPhoneForm,
  ChangePhoneSection,
  isPhoneBindingRequired,
  isWechatBrowser,
  PhoneBindingNotice,
  PhoneMethod,
  REVERIFY_STORAGE_KEY,
  WechatBrowserBanner,
  WechatMethod,
  WechatReturn,
} from '..';
import { agreementSatisfied, errorMessage, isConsentOutdated, isInviteInvalid, isValidCnPhone, maskPhoneInput, shownConsentsFromPolicy, signupInputs, signupLinkCodes } from '../shared';
import { linkDocuments } from '../SignupConsents';

// The consent texts as the sign-up policy serves them (compliance catalog
// prose, English), each with its version and hash.
const PROSE_VERSION = '2026-10-10.wp13.v1';
const AGREEMENT_TEXT = 'I have read and agree to the User Agreement and the Privacy Policy.';
const AGE_TEXT = 'I am 16 or older.';
const CROSS_BORDER_TEXT =
  'During this closed beta your personal information is processed and stored outside mainland China, in the United States. Processors outside mainland China: the database at Neon (US East), hosting at Vercel (United States), voice practice at LiveKit Cloud, speech recognition and synthesis at Deepgram / Cartesia, and email delivery at Resend. I agree to this processing. I understand that withdrawing this consent closes my account and deletes my data.';
const prose = (text: string, hash: string) => ({ text, locale: 'en' as const, version: PROSE_VERSION, hash });
const CN0_POLICY = {
  signupOpen: true,
  inviteRequired: false,
  requiredConsents: [
    { type: 'pipl_basic_processing', proseVersion: 'v1', prose: prose(AGREEMENT_TEXT, 'a'.repeat(64)) },
    { type: 'age_16_plus', proseVersion: 'v1', prose: prose(AGE_TEXT, 'b'.repeat(64)) },
    { type: 'pipl_cross_border', proseVersion: 'v1', prose: prose(CROSS_BORDER_TEXT, 'c'.repeat(64)) },
  ],
  methods: { phoneOtp: true, wechatWeb: true, wechatInApp: true },
  legal: { termsPath: '/legal/terms', privacyPath: '/legal/privacy' },
};

function apiError(status: number, code: string, details?: Record<string, unknown>) {
  return new RoboApiError('x', { status, code, payload: { success: false, code, error: 'x', ...(details ? { details } : {}) } });
}

const refresh = vi.fn(async () => ({}) as never);
const ON = { 'auth.phoneOtp': true, 'auth.wechatWeb': true, 'auth.wechatInApp': true } as const;
const originalUA = navigator.userAgent;

function setUA(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  signupInputs.reset();
  mockAuthState.value = buildAuthValue({ refresh });
  api.getSignupPolicy.mockResolvedValue(CN0_POLICY);
});

afterEach(() => {
  setUA(originalUA);
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
});

describe('shared helpers', () => {
  it('validates +86 mobile numbers like the server', () => {
    for (const ok of ['13812345678', '+8613812345678', '138 1234 5678', '19912345678']) expect(isValidCnPhone(ok), ok).toBe(true);
    for (const bad of ['12812345678', '1381234567', '+14155550100', '+85291234567', 'abc']) expect(isValidCnPhone(bad), bad).toBe(false);
    expect(maskPhoneInput('+8613812345678')).toBe('138****5678');
  });

  it('detects the WeChat browser', () => {
    expect(isWechatBrowser('Mozilla/5.0 (iPhone) MicroMessenger/8.0.50 NetType/WIFI')).toBe(true);
    expect(isWechatBrowser('Mozilla/5.0 (Macintosh) Chrome/130')).toBe(false);
  });

  it('maps error codes to messages, including tries left and lock minutes', () => {
    const t = ((key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ''}`) as never;
    expect(errorMessage(apiError(422, 'otp_invalid', { attemptsLeft: 3 }), t)).toBe('errors.otp_invalid_left{"count":3}');
    expect(errorMessage(apiError(429, 'otp_locked', { retryAfterSec: 1800 }), t)).toBe('errors.otp_locked{"minutes":30}');
    expect(errorMessage(apiError(422, 'invite_invalid', { missing: true }), t)).toBe('errors.invite_missing');
    // The consent text changed (or its hash was not sent): a different message from a missed box.
    expect(errorMessage(apiError(422, 'consent_required', { outdated: ['pipl_cross_border'], proseVersion: 'v2' }), t)).toBe('errors.consent_outdated');
    expect(errorMessage(apiError(422, 'consent_required', { missing: ['pipl_cross_border'] }), t)).toBe('errors.consent_required');
    expect(isConsentOutdated(apiError(422, 'consent_required', { outdated: [] }))).toBe(false);
    expect(isConsentOutdated(apiError(422, 'invite_invalid', { outdated: ['x'] }))).toBe(false);
    expect(errorMessage(apiError(502, 'sms_send_failed'), t)).toBe('errors.sms_send_failed');
    expect(errorMessage(new Error('boom'), t)).toBe('errors.generic');
    expect(isPhoneBindingRequired(apiError(403, 'phone_binding_required'))).toBe(true);
    expect(isPhoneBindingRequired(apiError(403, 'forbidden'))).toBe(false);
  });

  // INT-01 audit of `apiErrorCode(err) === '<reason>'` against the server:
  // the auth-cn routes and the `requirePhoneBound()` gate write the reason in
  // `code` (features/auth-cn/errors.ts `sendAuthCnError`); an area that wraps
  // it in a platform code puts it in `details.reason`. Both are read.
  it('reads phone_binding_required from the real wire shapes', () => {
    // { success: false, code: 'phone_binding_required', error, details: { bindRoute } } — what the gate sends.
    expect(isPhoneBindingRequired(apiError(403, 'phone_binding_required', { bindRoute: '/bind-phone' }))).toBe(true);
    // { code: 'forbidden', details: { reason: 'phone_binding_required' } } — a platform envelope around the same reason.
    expect(isPhoneBindingRequired(apiError(403, 'forbidden', { reason: 'phone_binding_required' }))).toBe(true);
    expect(isPhoneBindingRequired(apiError(403, 'forbidden', { reason: 'something_else' }))).toBe(false);
    expect(isPhoneBindingRequired(apiError(402, 'credits_exhausted', { bucket: 'tailor' }))).toBe(false);
    expect(isPhoneBindingRequired(new Error('boom'))).toBe(false);
  });

  it('reads invite_invalid from the real wire shapes', () => {
    // { code: 'invite_invalid' } (used, expired, unknown) and details { missing: true } (none sent).
    expect(isInviteInvalid(apiError(422, 'invite_invalid'))).toBe(true);
    expect(isInviteInvalid(apiError(422, 'invite_invalid', { missing: true }))).toBe(true);
    expect(isInviteInvalid(apiError(422, 'invalid_request', { reason: 'invite_invalid' }))).toBe(true);
    expect(isInviteInvalid(apiError(422, 'consent_required', { missing: ['pipl_cross_border'] }))).toBe(false);
  });

  it('tells the two codes a sign-up link can carry apart', () => {
    const q = (s: string) => new URLSearchParams(s);
    // /r/<code> → ?ref=<code>: the invite-friends code.
    expect(signupLinkCodes(q('ref=ABCD2345&from=invite'))).toEqual({ ref: 'ABCD2345', accessCode: null });
    // ?invite= in the invite-friends shape is the same thing.
    expect(signupLinkCodes(q('invite=abcd-2345'))).toEqual({ ref: 'abcd-2345', accessCode: null });
    // ?invite= in the closed-beta shape starts the invite field.
    expect(signupLinkCodes(q('invite=abcde-fghjk'))).toEqual({ ref: null, accessCode: 'ABCDE-FGHJK' });
    expect(signupLinkCodes(q('ref=ABCD2345&invite=ABCDE-FGHJK'))).toEqual({ ref: 'ABCD2345', accessCode: 'ABCDE-FGHJK' });
    expect(signupLinkCodes(q('invite=<script>'))).toEqual({ ref: null, accessCode: null });
    expect(signupLinkCodes(q(''))).toEqual({ ref: null, accessCode: null });
    expect(signupLinkCodes(null)).toEqual({ ref: null, accessCode: null });
  });
});

describe('INT-01: invite-friends ref, access-code prefill and two-step sign-in in the phone form', () => {
  const visit = (search: string) => window.history.replaceState({}, '', `/signup${search}`);
  afterEach(() => visit(''));

  async function signIn() {
    api.sendPhoneCode.mockResolvedValue({ resendInSec: 60 });
    for (const c of screen.getAllByRole('checkbox')) fireEvent.click(c);
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '13812345678' } });
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in or create account' }));
    });
  }

  it('sends the ref from the link with the code check; without one, no ref field at all', async () => {
    api.verifyPhoneCode.mockResolvedValue({ userId: 'u1', isNewUser: true, nextRoute: '/onboarding/consent' });
    visit('?ref=ABCD2345&from=invite');
    const first = renderWithBrand(<PhoneMethod mode="signup" />, { brand: 'goapply', flags: ON });
    await screen.findByText(/processed and stored outside mainland China/);
    await signIn();
    await waitFor(() => expect(api.verifyPhoneCode).toHaveBeenCalledWith(expect.objectContaining({ ref: 'ABCD2345', phone: '13812345678' })));
    first.unmount();

    api.verifyPhoneCode.mockClear();
    visit('');
    renderWithBrand(<PhoneMethod mode="signup" />, { brand: 'goapply', flags: ON });
    await screen.findByText(/processed and stored outside mainland China/);
    await signIn();
    await waitFor(() => expect(api.verifyPhoneCode).toHaveBeenCalled());
    expect(api.verifyPhoneCode.mock.calls[0]![0]).not.toHaveProperty('ref');
  });

  it('a closed-beta access code in the link starts the invite field (the visitor can change it)', async () => {
    api.getSignupPolicy.mockResolvedValue({ ...CN0_POLICY, inviteRequired: true });
    visit('?invite=abcde-fghjk');
    renderWithBrand(<PhoneMethod mode="signup" />, { brand: 'goapply', flags: ON });
    expect(await screen.findByLabelText('Invite code')).toHaveValue('ABCDE-FGHJK');
  });

  it('a wrong invite (real wire shape) opens the invite field on the sign-in page and explains', async () => {
    api.getSignupPolicy.mockResolvedValue({ ...CN0_POLICY, inviteRequired: true });
    api.verifyPhoneCode.mockRejectedValue(apiError(422, 'invite_invalid', { missing: true }));
    renderWithBrand(<PhoneMethod mode="login" />, { brand: 'goapply', flags: ON });
    await screen.findByText(/processed and stored outside mainland China/);
    expect(screen.queryByLabelText('Invite code')).toBeNull();
    await signIn();
    expect(await screen.findByLabelText('Invite code')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an invite code to create a new account.');
  });

  it('two-step sign-in: the code was right → the authenticator page, carrying `next`; no session is asked for', async () => {
    api.verifyPhoneCode.mockRejectedValue(apiError(401, 'two_factor_required', { next: '/login/2fa?next=%2Fjobs%2Fabc', methods: ['totp', 'recovery'], expiresInSec: 300 }));
    renderWithBrand(<PhoneMethod mode="login" next="/jobs/abc" />, { brand: 'goapply', flags: ON });
    await screen.findByText(/processed and stored outside mainland China/);
    await signIn();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login/2fa?next=%2Fjobs%2Fabc'));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('WeChat: the ref rides in the POST body with the consents, never in a URL', async () => {
    api.startWechatSignIn.mockResolvedValue({ url: 'https://open.weixin.qq.com/connect/qrconnect?state=s' });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign, search: '?ref=ABCD2345', pathname: '/signup' } });
    try {
      renderWithBrand(<WechatMethod mode="signup" />, { brand: 'goapply', flags: { 'auth.wechatWeb': true } });
      await screen.findByText(/processed and stored outside mainland China/);
      for (const c of screen.getAllByRole('checkbox')) fireEvent.click(c);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Continue with WeChat' }));
      });
      await waitFor(() => expect(api.startWechatSignIn).toHaveBeenCalledWith(expect.objectContaining({ flow: 'web', ref: 'ABCD2345', consents: expect.any(Array) })));
      expect(api.wechatQrUrl).not.toHaveBeenCalled();
      expect(assign).toHaveBeenCalledWith('https://open.weixin.qq.com/connect/qrconnect?state=s');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

describe('PhoneMethod (G0)', () => {
  async function renderPhone(policy = CN0_POLICY) {
    api.getSignupPolicy.mockResolvedValue(policy);
    renderWithBrand(<PhoneMethod mode="signup" next="/jobs/abc" />, { brand: 'goapply', flags: ON });
    await screen.findByText(/processed and stored outside mainland China/);
  }

  it('keeps both buttons disabled until every required box (the agreement, the age and, in CN-0, the cross-border consent) is ticked', async () => {
    await renderPhone();
    const checks = screen.getAllByRole('checkbox');
    expect(checks).toHaveLength(3);
    for (const c of checks) expect(c).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '13812345678' } });
    const send = screen.getByRole('button', { name: 'Get code' });
    const submit = screen.getByRole('button', { name: 'Sign in or create account' });
    expect(send).toBeDisabled();
    expect(submit).toBeDisabled();
    fireEvent.click(checks[0]!);
    fireEvent.click(checks[1]!);
    expect(send).toBeDisabled();
    fireEvent.click(checks[2]!);
    expect(send).toBeEnabled();
    expect(submit).toBeEnabled();
  });

  it('shows, beside each box, exactly the text the policy serves (the text whose hash is recorded), asked for in the page language', async () => {
    const { container } = renderWithBrand(<PhoneMethod mode="signup" />, { brand: 'goapply', flags: ON });
    await screen.findByText(/processed and stored outside mainland China/);
    expect(api.getSignupPolicy).toHaveBeenCalledWith('en');
    const shown = [...container.querySelectorAll('[data-consent-text]')].map((el) => [el.getAttribute('data-consent-text'), el.textContent, el.getAttribute('lang')]);
    // Character for character: linking the document names changes nothing in the string.
    expect(shown).toEqual([
      ['pipl_basic_processing', AGREEMENT_TEXT, 'en'],
      ['age_16_plus', AGE_TEXT, 'en'],
      ['pipl_cross_border', CROSS_BORDER_TEXT, 'en'],
    ]);
    expect(screen.getByRole('checkbox', { name: AGE_TEXT })).not.toBeChecked();
  });

  it('linkDocuments keeps the text intact in Chinese and English, and leaves a text without document names alone', () => {
    const paths = { terms: '/legal/terms', privacy: '/legal/privacy' };
    const zh = '我已阅读并同意《用户协议》和《隐私政策》。';
    const { container, unmount } = render(<p>{linkDocuments(zh, paths)}</p>);
    expect(container.textContent).toBe(zh);
    expect([...container.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['《用户协议》', '/legal/terms'],
      ['《隐私政策》', '/legal/privacy'],
    ]);
    unmount();
    const plain = render(<p>{linkDocuments(AGE_TEXT, paths)}</p>);
    expect(plain.container.textContent).toBe(AGE_TEXT);
    expect(plain.container.querySelector('a')).toBeNull();
  });

  it('a tick belongs to the text it was given for: when the served text changes, the box is unticked again', async () => {
    await renderPhone();
    for (const c of screen.getAllByRole('checkbox')) fireEvent.click(c);
    expect(agreementSatisfied(signupInputs.get(), CN0_POLICY)).toBe(true);
    const reworded = {
      ...CN0_POLICY,
      requiredConsents: CN0_POLICY.requiredConsents.map((c) => (c.type === 'pipl_cross_border' ? { ...c, prose: prose('New wording.', 'd'.repeat(64)) } : c)),
    };
    expect(agreementSatisfied(signupInputs.get(), reworded)).toBe(false);
    // Nothing counts as agreed before the policy and its texts have loaded.
    expect(agreementSatisfied(signupInputs.get(), undefined)).toBe(false);
    const noText = { ...CN0_POLICY, requiredConsents: CN0_POLICY.requiredConsents.map(({ prose: _prose, ...c }) => c) };
    expect(agreementSatisfied(signupInputs.get(), noText)).toBe(false);
    expect(shownConsentsFromPolicy(noText)).toEqual([]);
    // What every form sends (phone, WeChat, email): the version and hash of each shown text.
    expect(shownConsentsFromPolicy(CN0_POLICY)).toEqual([
      { type: 'pipl_basic_processing', granted: true, proseVersion: PROSE_VERSION, proseHash: 'a'.repeat(64) },
      { type: 'age_16_plus', granted: true, proseVersion: PROSE_VERSION, proseHash: 'b'.repeat(64) },
      { type: 'pipl_cross_border', granted: true, proseVersion: PROSE_VERSION, proseHash: 'c'.repeat(64) },
    ]);
  });

  it('links the user agreement and privacy policy', async () => {
    await renderPhone();
    expect(screen.getByRole('link', { name: 'User Agreement' })).toHaveAttribute('href', '/legal/terms');
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/legal/privacy');
  });

  it('shows no cross-border box outside CN-0', async () => {
    api.getSignupPolicy.mockResolvedValue({ ...CN0_POLICY, requiredConsents: CN0_POLICY.requiredConsents.slice(0, 2) });
    renderWithBrand(<PhoneMethod mode="signup" />, { brand: 'goapply', flags: ON });
    await waitFor(() => expect(api.getSignupPolicy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2));
    expect(screen.queryByText(/outside mainland China/)).toBeNull();
  });

  it('rejects a non-mainland number with the plain message', async () => {
    await renderPhone();
    const input = screen.getByLabelText('Phone number');
    fireEvent.change(input, { target: { value: '4155550100' } });
    fireEvent.blur(input);
    expect(screen.getByText('Enter a valid mainland China mobile number.')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('sends the code, counts down 60 s, and signs in with the consents', async () => {
    api.sendPhoneCode.mockResolvedValue({ resendInSec: 60 });
    api.verifyPhoneCode.mockResolvedValue({ userId: 'u1', isNewUser: true, nextRoute: '/onboarding/consent' });
    await renderPhone();
    for (const c of screen.getAllByRole('checkbox')) fireEvent.click(c);
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '138 1234 5678' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Get code' }));
    });
    expect(api.sendPhoneCode).toHaveBeenCalledWith({ phone: '13812345678', purpose: 'login' });
    expect(await screen.findByRole('button', { name: /Resend in \d+s/ })).toBeDisabled();
    expect(screen.getByText(/138\*\*\*\*5678/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '12a3456' } });
    expect(screen.getByLabelText('Verification code')).toHaveValue('123456');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in or create account' }));
    });
    expect(api.verifyPhoneCode).toHaveBeenCalledWith({
      phone: '13812345678',
      code: '123456',
      // Each consent carries the hash of the text shown beside its box, so the stored record names it.
      consents: [
        { type: 'pipl_basic_processing', granted: true, proseVersion: PROSE_VERSION, proseHash: 'a'.repeat(64) },
        { type: 'age_16_plus', granted: true, proseVersion: PROSE_VERSION, proseHash: 'b'.repeat(64) },
        { type: 'pipl_cross_border', granted: true, proseVersion: PROSE_VERSION, proseHash: 'c'.repeat(64) },
      ],
      next: '/jobs/abc',
    });
    expect(refresh).toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith('/onboarding/consent');
  });

  it('asks for an invite code in invite mode and sends it', async () => {
    api.verifyPhoneCode.mockResolvedValue({ userId: 'u1', isNewUser: true, nextRoute: '/onboarding/consent' });
    await renderPhone({ ...CN0_POLICY, inviteRequired: true });
    for (const c of screen.getAllByRole('checkbox')) fireEvent.click(c);
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '13812345678' } });
    fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: 'abcde-fghjk' } });
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in or create account' }));
    });
    expect(api.verifyPhoneCode.mock.calls[0]![0]).toMatchObject({ inviteCode: 'ABCDE-FGHJK' });
  });

  it('shows the server error (wrong code, tries left)', async () => {
    api.verifyPhoneCode.mockRejectedValue(apiError(422, 'otp_invalid', { attemptsLeft: 2 }));
    await renderPhone();
    for (const c of screen.getAllByRole('checkbox')) fireEvent.click(c);
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '13812345678' } });
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '000000' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in or create account' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('That code is not correct. 2 tries left.');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('reloads the consent text and unticks the boxes when the server says the text changed', async () => {
    api.verifyPhoneCode.mockRejectedValue(apiError(422, 'consent_required', { outdated: ['pipl_cross_border'], proseVersion: 'v2' }));
    await renderPhone();
    for (const c of screen.getAllByRole('checkbox')) fireEvent.click(c);
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '13812345678' } });
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } });
    const loads = api.getSignupPolicy.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in or create account' }));
    });
    await waitFor(() => expect(api.getSignupPolicy.mock.calls.length).toBeGreaterThan(loads));
    expect(signupInputs.get().granted).toEqual({});
    for (const c of screen.getAllByRole('checkbox')) expect(c).not.toBeChecked();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('says when sign-up is closed', async () => {
    await renderPhone({ ...CN0_POLICY, signupOpen: false });
    expect(screen.getByText('Sign-up is not open yet. Existing accounts can still sign in.')).toBeInTheDocument();
  });
});

describe('WechatMethod', () => {
  it('renders nothing when WeChat sign-in is off', () => {
    const { container } = renderWithBrand(<WechatMethod mode="login" />, { brand: 'goapply', flags: { 'auth.phoneOtp': true } });
    expect(container).toBeEmptyDOMElement();
  });

  it('uses the QR flow outside WeChat, only after the shared agreement is ticked, consents in the POST body', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
    api.startWechatSignIn.mockResolvedValue({ url: 'https://open.weixin.qq.com/connect/qrconnect?state=s' });
    try {
      renderWithBrand(
        <>
          <PhoneMethod mode="login" />
          <WechatMethod mode="login" next="/resume" />
        </>,
        { brand: 'goapply', flags: ON },
      );
      await screen.findByText(/processed and stored outside mainland China/);
      // One set of boxes on the page, hosted by the phone form.
      expect(screen.getAllByRole('checkbox')).toHaveLength(3);
      const button = screen.getByRole('button', { name: 'Continue with WeChat' });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(button);
      expect(api.startWechatSignIn).not.toHaveBeenCalled();
      for (const c of screen.getAllByRole('checkbox')) fireEvent.click(c);
      expect(button).toHaveAttribute('aria-disabled', 'false');
      await act(async () => {
        fireEvent.click(button);
      });
      expect(api.startWechatSignIn).toHaveBeenLastCalledWith({ flow: 'web', next: '/resume', consents: shownConsentsFromPolicy(CN0_POLICY) });
      expect(shownConsentsFromPolicy(CN0_POLICY).every((c) => /^[0-9a-f]{64}$/.test(c.proseHash))).toBe(true);
      // Nothing about consent ever goes into a URL.
      expect(api.wechatQrUrl).not.toHaveBeenCalled();
      expect(assign).toHaveBeenCalledWith('https://open.weixin.qq.com/connect/qrconnect?state=s');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('uses the 公众号 flow inside WeChat and hosts the boxes itself without a phone form', async () => {
    setUA('Mozilla/5.0 (iPhone) MicroMessenger/8.0.50');
    api.startWechatSignIn.mockRejectedValue(apiError(422, 'consent_required'));
    renderWithBrand(<WechatMethod mode="signup" />, { brand: 'goapply', flags: { 'auth.wechatInApp': true } });
    await screen.findByText(/processed and stored outside mainland China/);
    for (const c of screen.getAllByRole('checkbox')) fireEvent.click(c);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue with WeChat' }));
    });
    expect(api.startWechatSignIn).toHaveBeenLastCalledWith(expect.objectContaining({ flow: 'mp' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('BindPhoneForm', () => {
  it('binds and continues', async () => {
    api.sendPhoneCode.mockResolvedValue({ resendInSec: 60 });
    api.bindPhone.mockResolvedValue({ userId: 'u1', merged: false, nextRoute: '/onboarding/consent', phoneMasked: '138****5678' });
    renderWithBrand(<BindPhoneForm next="/onboarding/consent" />, { brand: 'goapply', flags: ON });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '13812345678' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Get code' }));
    });
    expect(api.sendPhoneCode).toHaveBeenCalledWith({ phone: '13812345678', purpose: 'bind' });
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add phone number' }));
    });
    expect(api.bindPhone).toHaveBeenCalledWith({ phone: '13812345678', code: '123456', next: '/onboarding/consent' });
    expect(router.replace).toHaveBeenCalledWith('/onboarding/consent');
  });

  it('explains a merge onto the existing account', async () => {
    api.bindPhone.mockResolvedValue({ userId: 'owner', merged: true, nextRoute: '/resume', phoneMasked: '138****5678' });
    renderWithBrand(<BindPhoneForm />, { brand: 'goapply', flags: ON });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '13812345678' } });
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add phone number' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('This number already had an account');
  });

  it('asks a signed-out visitor to sign in first', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    renderWithBrand(<BindPhoneForm next="/resume" />, { brand: 'goapply', flags: ON });
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', `/login?next=${encodeURIComponent('/bind-phone?next=%2Fresume')}`);
  });
});

describe('WechatReturn (/auth/callback/wechat)', () => {
  it('sends a new WeChat account to bind a phone first', async () => {
    renderWithBrand(<WechatReturn params={{ result: 'ok', next: '/onboarding/consent', bind: '1' }} />, { brand: 'goapply', flags: ON });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/bind-phone?next=%2Fonboarding%2Fconsent'));
    expect(refresh).toHaveBeenCalled();
  });

  it('never follows an off-site next', async () => {
    renderWithBrand(<WechatReturn params={{ result: 'ok', next: '//evil.example' }} />, { brand: 'goapply', flags: ON });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/resume'));
  });

  it('keeps the re-verification token out of the URL (sessionStorage)', async () => {
    renderWithBrand(<WechatReturn params={{ result: 'ok', reverify: 'tok123', next: '/settings#security' }} />, { brand: 'goapply', flags: ON });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/settings#security'));
    expect(sessionStorage.getItem(REVERIFY_STORAGE_KEY)).toBe('tok123');
  });

  it('shows why it failed', () => {
    renderWithBrand(<WechatReturn params={{ result: 'error', code: 'oauth_state_invalid' }} />, { brand: 'goapply', flags: ON });
    expect(screen.getByRole('alert')).toHaveTextContent('The WeChat sign-in link expired. Start again.');
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });
});

describe('ChangePhoneSection (#security)', () => {
  it('offers to add a number when there is none', async () => {
    api.getPhoneStatus.mockResolvedValue({ phoneMasked: null, hasPassword: false, hasWechat: true });
    renderWithBrand(<ChangePhoneSection />, { brand: 'goapply', flags: ON });
    expect(await screen.findByRole('link', { name: 'Add a phone number' })).toHaveAttribute('href', '/bind-phone?next=%2Fsettings%23security');
  });

  it('changes the number with both codes', async () => {
    api.getPhoneStatus.mockResolvedValue({ phoneMasked: '138****5678', hasPassword: true, hasWechat: false });
    api.sendPhoneCode.mockResolvedValue({ resendInSec: 60 });
    api.changePhone.mockResolvedValue({ phoneMasked: '139****5678', sessionsRevoked: 2 });
    renderWithBrand(<ChangePhoneSection />, { brand: 'goapply', flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Change number' }));
    const [oldPhone, newPhone] = screen.getAllByPlaceholderText(/138\*\*\*\*5678|11-digit mobile number/);
    fireEvent.change(oldPhone!, { target: { value: '13812345678' } });
    const [sendOld, sendNew] = screen.getAllByRole('button', { name: 'Get code' });
    await act(async () => {
      fireEvent.click(sendOld!);
    });
    expect(api.sendPhoneCode).toHaveBeenCalledWith({ phone: '13812345678', purpose: 'change_old' });
    fireEvent.change(newPhone!, { target: { value: '13912345678' } });
    await act(async () => {
      fireEvent.click(sendNew!);
    });
    expect(api.sendPhoneCode).toHaveBeenCalledWith({ phone: '13912345678', purpose: 'change_new' });
    const [oldCode, newCode] = screen.getAllByPlaceholderText('6-digit code');
    fireEvent.change(oldCode!, { target: { value: '111111' } });
    fireEvent.change(newCode!, { target: { value: '222222' } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Change number' }).at(-1)!);
    });
    expect(api.changePhone).toHaveBeenCalledWith({ oldCode: '111111', newPhone: '13912345678', newCode: '222222' });
    expect(await screen.findByText('Number changed to 139****5678. Other devices were signed out.')).toBeInTheDocument();
  });

  it('offers the password when the old number is lost', async () => {
    api.getPhoneStatus.mockResolvedValue({ phoneMasked: '138****5678', hasPassword: true, hasWechat: false });
    api.changePhone.mockResolvedValue({ phoneMasked: '139****5678', sessionsRevoked: 0 });
    renderWithBrand(<ChangePhoneSection />, { brand: 'goapply', flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Change number' }));
    fireEvent.click(screen.getByRole('button', { name: "I can't use my current number" }));
    fireEvent.change(screen.getByLabelText('Account password'), { target: { value: 'secret-pass' } });
    fireEvent.change(screen.getByLabelText('New phone number'), { target: { value: '13912345678' } });
    fireEvent.change(screen.getByPlaceholderText('6-digit code'), { target: { value: '222222' } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Change number' }).at(-1)!);
    });
    expect(api.changePhone).toHaveBeenCalledWith({
      identityProof: { method: 'password', value: 'secret-pass' },
      newPhone: '13912345678',
      newCode: '222222',
    });
  });

  it('renders nothing when phone sign-in is off', () => {
    const { container } = renderWithBrand(<ChangePhoneSection />, { brand: 'goapply', flags: {} });
    expect(container).toBeEmptyDOMElement();
    expect(api.getPhoneStatus).not.toHaveBeenCalled();
  });
});

describe('WechatBrowserBanner', () => {
  it('shows only inside WeChat', async () => {
    const { container, unmount } = renderWithBrand(<WechatBrowserBanner action="download" />, { brand: 'goapply' });
    expect(container).toBeEmptyDOMElement();
    unmount();
    setUA('Mozilla/5.0 (Linux; Android 14) MicroMessenger/8.0.49');
    renderWithBrand(<WechatBrowserBanner action="download" />, { brand: 'goapply' });
    expect(await screen.findByText('Open in your browser')).toBeInTheDocument();
    expect(screen.getByText(/Downloads don't work inside WeChat/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });
});

describe('PhoneBindingNotice', () => {
  it('appears only for phone_binding_required', () => {
    const { container, unmount } = renderWithBrand(<PhoneBindingNotice error={apiError(403, 'forbidden')} />, { brand: 'goapply' });
    expect(container).toBeEmptyDOMElement();
    unmount();
    renderWithBrand(<PhoneBindingNotice error={apiError(403, 'phone_binding_required')} next="/resume/1" />, { brand: 'goapply' });
    expect(screen.getByRole('link', { name: 'Add phone number' })).toHaveAttribute('href', '/bind-phone?next=%2Fresume%2F1');
  });
});

describe('AdminInvites', () => {
  it('is admin-only', () => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'seeker' }) });
    renderWithBrand(<AdminInvites />, { brand: 'goapply' });
    expect(screen.getByText('Only admins can see this page.')).toBeInTheDocument();
    expect(api.adminListInvites).not.toHaveBeenCalled();
  });

  it('creates codes, shows them once, and lists rows without codes', async () => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
    api.adminListInvites.mockResolvedValue({
      items: [
        { id: 'i1', code: null, maxUses: 1, usedCount: 1, status: 'used', expiresAt: null, note: 'Pilot', createdAt: '2026-10-01T00:00:00.000Z' },
      ],
      cursor: null,
    });
    api.adminCreateInvites.mockResolvedValue({
      items: [
        { id: 'n1', code: 'ABCDE-FGHJK', maxUses: 1, usedCount: 0, status: 'active', expiresAt: null, note: null, createdAt: '2026-10-10T00:00:00.000Z' },
        { id: 'n2', code: 'KMNPQ-RSTUV', maxUses: 1, usedCount: 0, status: 'active', expiresAt: null, note: null, createdAt: '2026-10-10T00:00:00.000Z' },
      ],
    });
    renderWithBrand(<AdminInvites />, { brand: 'goapply' });
    expect(await screen.findByText('1 of 1')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Used up' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('How many'), { target: { value: '2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create codes' }));
    });
    expect(api.adminCreateInvites).toHaveBeenCalledWith({ count: 2, maxUses: 1 });
    expect(await screen.findByText('ABCDE-FGHJK')).toBeInTheDocument();
    expect(screen.getByText('New codes. Copy them now; they are not shown again.')).toBeInTheDocument();
  });
});
