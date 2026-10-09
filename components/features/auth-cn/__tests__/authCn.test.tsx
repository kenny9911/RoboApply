// WP-11 web: GoApply sign-in methods, bind/change phone, the WeChat return
// page, the in-WeChat guidance banner, the phone-binding notice and the
// admin invite console. API calls are mocked (lib/api/authCn); no network.

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
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
import { errorMessage, isValidCnPhone, maskPhoneInput, signupInputs } from '../shared';

const CN0_POLICY = {
  signupOpen: true,
  inviteRequired: false,
  requiredConsents: [
    { type: 'pipl_basic_processing', proseVersion: 'v1' },
    { type: 'age_16_plus', proseVersion: 'v1' },
    { type: 'pipl_cross_border', proseVersion: 'v1' },
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
    expect(errorMessage(apiError(502, 'sms_send_failed'), t)).toBe('errors.sms_send_failed');
    expect(errorMessage(new Error('boom'), t)).toBe('errors.generic');
    expect(isPhoneBindingRequired(apiError(403, 'phone_binding_required'))).toBe(true);
    expect(isPhoneBindingRequired(apiError(403, 'forbidden'))).toBe(false);
  });
});

describe('PhoneMethod (G0)', () => {
  async function renderPhone(policy = CN0_POLICY) {
    api.getSignupPolicy.mockResolvedValue(policy);
    renderWithBrand(<PhoneMethod mode="signup" next="/jobs/abc" />, { brand: 'goapply', flags: ON });
    await screen.findByText(/stored and processed outside mainland China/);
  }

  it('keeps both buttons disabled until the agreement (and, in CN-0, the cross-border box) are ticked', async () => {
    await renderPhone();
    const checks = screen.getAllByRole('checkbox');
    expect(checks).toHaveLength(2);
    for (const c of checks) expect(c).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '13812345678' } });
    const send = screen.getByRole('button', { name: 'Get code' });
    const submit = screen.getByRole('button', { name: 'Sign in or create account' });
    expect(send).toBeDisabled();
    expect(submit).toBeDisabled();
    fireEvent.click(checks[0]!);
    expect(send).toBeDisabled();
    fireEvent.click(checks[1]!);
    expect(send).toBeEnabled();
    expect(submit).toBeEnabled();
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
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(1));
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
      consents: [
        { type: 'pipl_basic_processing', granted: true, proseVersion: 'v1' },
        { type: 'age_16_plus', granted: true, proseVersion: 'v1' },
        { type: 'pipl_cross_border', granted: true, proseVersion: 'v1' },
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
      await screen.findByText(/stored and processed outside mainland China/);
      // One set of boxes on the page, hosted by the phone form.
      expect(screen.getAllByRole('checkbox')).toHaveLength(2);
      const button = screen.getByRole('button', { name: 'Continue with WeChat' });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(button);
      expect(api.startWechatSignIn).not.toHaveBeenCalled();
      for (const c of screen.getAllByRole('checkbox')) fireEvent.click(c);
      expect(button).toHaveAttribute('aria-disabled', 'false');
      await act(async () => {
        fireEvent.click(button);
      });
      expect(api.startWechatSignIn).toHaveBeenLastCalledWith({ flow: 'web', next: '/resume', consents: CN0_POLICY.requiredConsents.map((c) => ({ ...c, granted: true })) });
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
    await screen.findByText(/stored and processed outside mainland China/);
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
