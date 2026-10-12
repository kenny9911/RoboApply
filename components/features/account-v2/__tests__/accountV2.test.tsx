// WP-79 — two-step sign-in settings, student verification and the /login/2fa
// step (component tests at 375 px; lib/api mocked, no network).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { RoboApiError } from '../../../../lib/api/client';
import { isProtectedPath } from '../../../../lib/proxyPaths';
import { atPhoneWidth, renderUi } from '../../credits/__tests__/fixtures';

const api = vi.hoisted(() => ({
  getTwoFactorStatus: vi.fn(),
  enrolTwoFactor: vi.fn(),
  verifyTwoFactor: vi.fn(),
  disableTwoFactor: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  getStudentStatus: vi.fn(),
  sendStudentEmailCode: vi.fn(),
  confirmStudentEmail: vi.fn(),
  completeTwoFactorSignIn: vi.fn(),
}));
const nav = vi.hoisted(() => ({ replace: vi.fn(), params: new URLSearchParams() }));
const auth = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('../../../../lib/api/accountV2', () => ({ accountV2Api: api, completeTwoFactorSignIn: api.completeTwoFactorSignIn }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace }),
  useSearchParams: () => nav.params,
  usePathname: () => '/login/2fa',
}));
vi.mock('../../../../lib/auth/AuthProvider', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAuth: () => ({ refresh: auth.refresh }),
}));

import { StudentVerification, TwoFactorChallenge, TwoFactorSettings } from '..';

function apiError(code: string, status: number, details?: Record<string, unknown>) {
  return new RoboApiError('failed', { code, status, payload: { success: false, code, error: 'x', ...(details ? { details } : {}) } });
}

const OFF = { enabled: false, enrolledAt: null, recoveryCodesLeft: 0, pending: false, available: true };
const ON = { enabled: true, enrolledAt: '2026-10-01T00:00:00.000Z', recoveryCodesLeft: 10, pending: false, available: true };
const CODES = Array.from({ length: 10 }, (_, i) => `abcd-efgh-${String.fromCharCode(97 + i).repeat(4)}`);

beforeEach(() => {
  atPhoneWidth();
  for (const fn of Object.values(api)) fn.mockReset();
  nav.replace.mockReset();
  nav.params = new URLSearchParams();
  auth.refresh.mockReset();
});

describe('TwoFactorSettings', () => {
  it('renders nothing when the capability is off (no request)', () => {
    const { container } = renderUi(<TwoFactorSettings />);
    expect(container.textContent).toBe('');
    expect(api.getTwoFactorStatus).not.toHaveBeenCalled();
  });

  it('renders nothing when it cannot be turned on yet and is off (no dead control)', async () => {
    api.getTwoFactorStatus.mockResolvedValue({ ...OFF, available: false });
    const { container } = renderUi(<TwoFactorSettings />, { flags: { totp: true } });
    await waitFor(() => expect(api.getTwoFactorStatus).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="two-factor-settings"]')).toBeNull();
  });

  it('turns on: QR + key, a wrong code is explained, the right one shows recovery codes once', async () => {
    api.getTwoFactorStatus.mockResolvedValue(OFF);
    api.enrolTwoFactor.mockResolvedValue({ otpauthUri: 'otpauth://totp/RoboApply:u?secret=ABCD', secret: 'ABCDEFGHIJKLMNOP', qrDataUrl: 'data:image/png;base64,QR' });
    api.verifyTwoFactor.mockRejectedValueOnce(apiError('invalid_request', 422, { reason: 'totp_invalid' })).mockResolvedValueOnce({ recoveryCodes: CODES });
    renderUi(<TwoFactorSettings />, { flags: { totp: true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('img', { name: /QR code/ })).toHaveAttribute('src', 'data:image/png;base64,QR');
    expect(screen.getByTestId('two-factor-secret').textContent).toBe('ABCD EFGH IJKL MNOP');
    expect(screen.getByRole('link', { name: 'Open in an authenticator app' })).toHaveAttribute('href', 'otpauth://totp/RoboApply:u?secret=ABCD');

    const input = screen.getByLabelText('6-digit code');
    fireEvent.change(input, { target: { value: '12a34 56' } });
    expect((input as HTMLInputElement).value).toBe('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText(/That code didn't work/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    const list = await screen.findByTestId('recovery-codes');
    expect(list.querySelectorAll('li')).toHaveLength(10);
    expect(api.verifyTwoFactor).toHaveBeenLastCalledWith({ code: '123456' });
    expect(screen.getByRole('link', { name: 'Download as a text file' }).getAttribute('href')).toContain(encodeURIComponent(CODES[0]!));

    api.getTwoFactorStatus.mockResolvedValue(ON);
    fireEvent.click(screen.getByRole('button', { name: 'I saved them' }));
    expect(await screen.findByText('10 recovery codes left')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-codes')).toBeNull();
  });

  it('turns off with a recovery code', async () => {
    api.getTwoFactorStatus.mockResolvedValue({ ...ON, recoveryCodesLeft: 2 });
    api.disableTwoFactor.mockResolvedValue(undefined);
    renderUi(<TwoFactorSettings />, { flags: { totp: true } });
    expect(await screen.findByText(/Make new recovery codes soon/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    const submit = screen.getAllByRole('button', { name: 'Turn off' }).at(-1)!;
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: ' ABCD-EFGH-JKMN ' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(api.disableTwoFactor).toHaveBeenCalledWith({ recoveryCode: 'abcd-efgh-jkmn' }));
  });
});

describe('StudentVerification', () => {
  const NOT = { verified: false, schoolDomain: null, verifiedAt: null, expiresAt: null, pendingDomain: null, available: true };

  it('renders nothing with the capability off or before the storage exists', async () => {
    const off = renderUi(<StudentVerification />);
    expect(off.container.textContent).toBe('');
    off.unmount();
    api.getStudentStatus.mockResolvedValue({ ...NOT, available: false });
    const { container } = renderUi(<StudentVerification />, { flags: { student: true } });
    await waitFor(() => expect(api.getStudentStatus).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });

  it('sends a code, explains a refused address, and confirms', async () => {
    api.getStudentStatus.mockResolvedValue(NOT);
    api.sendStudentEmailCode.mockRejectedValueOnce(apiError('invalid_request', 422, { reason: 'school_domain_not_eligible' })).mockResolvedValueOnce({ schoolDomain: 'stanford.edu', expiresAt: '2026-10-10T00:15:00Z' });
    api.confirmStudentEmail.mockResolvedValue({ ...NOT, verified: true, schoolDomain: 'stanford.edu', expiresAt: '2027-10-10T00:00:00Z' });
    renderUi(<StudentVerification />, { flags: { student: true } });
    const email = await screen.findByLabelText('School email');
    fireEvent.change(email, { target: { value: 's@gmail.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(/Use the email address your school gave you/)).toBeInTheDocument();
    fireEvent.change(email, { target: { value: 's@stanford.edu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(/We sent a code to your address at stanford.edu/)).toBeInTheDocument();
    api.getStudentStatus.mockResolvedValue({ ...NOT, verified: true, schoolDomain: 'stanford.edu', expiresAt: '2027-10-10T00:00:00Z' });
    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Confirmed with stanford.edu until/)).toBeInTheDocument();
    expect(api.confirmStudentEmail).toHaveBeenCalledWith({ code: '654321' });
  });
});

describe('TwoFactorChallenge (/login/2fa)', () => {
  it('is a public page (the proxy does not bounce it to /login)', () => {
    expect(isProtectedPath('/login/2fa')).toBe(false);
  });

  it('signs in with a code and routes like the email form', async () => {
    nav.params = new URLSearchParams('next=/resume');
    api.completeTwoFactorSignIn.mockResolvedValue({ user: { id: 'u1', email: 'u@example.test' }, twoFactor: { method: 'totp', recoveryCodesLeft: 10 } });
    auth.refresh.mockResolvedValue({ onboarding: { completed: true, nextRoute: null } });
    renderUi(<TwoFactorChallenge />);
    const submit = screen.getByRole('button', { name: 'Continue' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(submit);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/resume'));
    expect(api.completeTwoFactorSignIn).toHaveBeenCalledWith({ code: '123456' });
  });

  it('counts down wrong codes and sends an expired challenge back to sign in', async () => {
    api.completeTwoFactorSignIn
      .mockRejectedValueOnce(apiError('totp_invalid', 401, { reason: 'totp_invalid', attemptsLeft: 3 }))
      .mockRejectedValueOnce(apiError('two_factor_challenge_invalid', 401));
    renderUi(<TwoFactorChallenge />);
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText("That code didn't work. 3 tries left")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('This sign-in step has expired. Sign in again.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('accepts a recovery code instead', async () => {
    api.completeTwoFactorSignIn.mockResolvedValue({ user: null, twoFactor: { method: 'recovery', recoveryCodesLeft: 9 } });
    auth.refresh.mockResolvedValue({ onboarding: { completed: true, nextRoute: null } });
    renderUi(<TwoFactorChallenge />);
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'ABCD-EFGH-JKMN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.completeTwoFactorSignIn).toHaveBeenCalledWith({ recoveryCode: 'abcd-efgh-jkmn' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/jobs'));
  });
});
