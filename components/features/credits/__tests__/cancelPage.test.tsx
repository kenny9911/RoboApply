// WP-21b — /cancel without signing in, the checkout return page, the footer link.
// Market wave M4 (MKT-4C; ST-9): with a link the page first asks what the link
// can do, and while a withdrawal is open it offers two labelled choices:
// cancel at the end of the period, or withdraw from the contract and get the
// quoted amount back.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { atPhoneWidth, creditsResponse, renderUi } from './fixtures';
import { RoboApiError } from '../../../../lib/api/client';
import type { PublicCancelPreview } from '../../../../lib/api/account';
import { mockAuthState, buildAuthValue } from '../../../../__tests__/utils/mockAuth';

const api = vi.hoisted(() => ({ getCredits: vi.fn(), requestPublicCancel: vi.fn(), confirmPublicCancel: vi.fn() }));
// The link's two calls (hand-typed in lib/api/account.ts; the documented wrapper of lib/api/credits.ts is not used by the page).
const account = vi.hoisted(() => ({ previewPublicCancel: vi.fn(), confirmPublicCancel: vi.fn() }));
vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/api/account', async (orig) => {
  const real = await orig<{ accountApi: Record<string, unknown> }>();
  return { ...real, accountApi: { ...real.accountApi, ...account } };
});
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

import { PublicCancelFlow, openLinkWithdrawal } from '../PublicCancelFlow';
import { PUBLIC_CANCEL_PREVIEW_TIMEOUT_MS } from '../../../../hooks/credits/usePublicCancel';
import { CheckoutReturn } from '../CheckoutReturn';
import { CancelFooterLink } from '../CancelFooterLink';

const TOKEN = 'tok_abcdefghijklmnop';
// "Now" for the page is noon on day 5; the withdrawal is open until noon on day 14.
const NOW = new Date('2026-10-10T12:00:00.000Z');
const DEADLINE = '2026-10-19T12:00:00.000Z';
const PERIOD_END = '2026-11-05T12:00:00.000Z';
const now = () => NOW;

/** What the link can do: cancel only, unless the test adds a withdrawal. */
const linkPreview = (over: Partial<PublicCancelPreview> = {}): PublicCancelPreview => ({ planKey: 'pro_monthly', accessUntil: PERIOD_END, withdrawal: null, ...over });
const withWithdrawal = (over: Partial<NonNullable<PublicCancelPreview['withdrawal']>> = {}): PublicCancelPreview =>
  linkPreview({ withdrawal: { refundMinor: 2083, currency: 'USD', rule: 'withdrawal_14d_prorata', deadline: DEADLINE, ...over } });
const linkError = (code: string, status: number) => new RoboApiError('bad', { status, code, payload: { success: false, code } });

beforeEach(() => {
  atPhoneWidth();
  for (const fn of [...Object.values(api), ...Object.values(account)]) fn.mockReset();
  account.previewPublicCancel.mockResolvedValue(linkPreview());
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
    account.confirmPublicCancel.mockResolvedValue({ status: 'cancelled', accessUntil: '2026-11-01T00:00:00Z', withdrawal: null });
    renderUi(<PublicCancelFlow token={TOKEN} />);
    await waitFor(() => expect(window.location.search).toBe(''));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel now' }));
    expect(await screen.findByTestId('public-cancel-done')).toHaveTextContent('Your subscription is cancelled');
    // Exactly the body the link always sent: the token and nothing else.
    expect(account.confirmPublicCancel).toHaveBeenCalledTimes(1);
    expect(account.confirmPublicCancel).toHaveBeenCalledWith({ token: TOKEN });
    // The page never falls back to the other wrapper for the same link.
    expect(api.confirmPublicCancel).not.toHaveBeenCalled();
  });

  it('expired or used token: says so and offers a new link', async () => {
    account.confirmPublicCancel.mockRejectedValue(linkError('cancel_token_invalid', 410));
    renderUi(<PublicCancelFlow token={TOKEN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel now' }));
    expect(await screen.findByText(/expired or was already used/)).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('signed-in visitors also get the settings link', () => {
    mockAuthState.value = buildAuthValue();
    renderUi(<PublicCancelFlow />);
    expect(screen.getByRole('link', { name: 'Open billing settings' })).toHaveAttribute('href', '/settings#billing');
  });
});

// ST-9 (MARKET_STRATEGY §4.4 "Statutory withdrawal"): a link holder inside the
// 14 days can withdraw in two steps without signing in (open the link, press
// the button) and sees the refunded amount.
describe('/cancel with a link: what the link can do is asked first', () => {
  it('asks once with the token, without using the link up, and waits for the answer before it shows a button', async () => {
    let answer!: (p: PublicCancelPreview) => void;
    account.previewPublicCancel.mockReturnValue(new Promise<PublicCancelPreview>((resolve) => (answer = resolve)));
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    expect(await screen.findByTestId('public-cancel-checking')).toHaveTextContent('Checking your link');
    expect(screen.queryByRole('button')).toBeNull();
    expect(account.previewPublicCancel).toHaveBeenCalledTimes(1);
    // The token, and a signal the page can give up with.
    expect(account.previewPublicCancel).toHaveBeenCalledWith(TOKEN, { signal: expect.any(AbortSignal) });
    await act(async () => answer(linkPreview()));
    expect(await screen.findByRole('button', { name: 'Cancel now' })).toBeEnabled();
    expect(account.confirmPublicCancel).not.toHaveBeenCalled();
    expect(account.previewPublicCancel).toHaveBeenCalledTimes(1);
  });

  it('no token: nothing is asked', () => {
    renderUi(<PublicCancelFlow now={now} />);
    expect(account.previewPublicCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send cancel link' })).toBeInTheDocument();
  });

  it('without a withdrawal the page is the one it always was: one button, no choice, no amount', async () => {
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    expect(await screen.findByRole('button', { name: 'Cancel now' })).toBeInTheDocument();
    expect(screen.getByText('This stops the renewal now. You keep Pro until the end of the period you paid for.')).toBeInTheDocument();
    expect(screen.queryByTestId('public-cancel-choices')).toBeNull();
    expect(screen.queryByText(/Withdraw/)).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('an invalid link shows the existing expired message on the question already, and no cancel button', async () => {
    account.previewPublicCancel.mockRejectedValue(linkError('cancel_token_invalid', 410));
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    expect(await screen.findByText('This link has expired or was already used. Ask for a new one below.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel now' })).toBeNull();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(account.confirmPublicCancel).not.toHaveBeenCalled();
  });

  it.each([
    ['a server without the route (404)', linkError('not_found', 404)],
    ['a rate limit', linkError('rate_limited', 429)],
    ['a network failure', new Error('offline')],
  ])('when the question fails for another reason (%s) the link can still cancel', async (_name, err) => {
    account.previewPublicCancel.mockRejectedValue(err);
    account.confirmPublicCancel.mockResolvedValue({ status: 'cancelled', accessUntil: null, withdrawal: null });
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel now' }));
    expect(await screen.findByTestId('public-cancel-done')).toHaveTextContent('Your subscription is cancelled');
    expect(account.confirmPublicCancel).toHaveBeenCalledWith({ token: TOKEN });
    expect(screen.queryByText(/expired or was already used/)).toBeNull();
  });

  // The question needs the payment provider on the server. A question that hangs must not keep the visitor from
  // cancelling: after a few seconds the page is the ordinary one-button page (§312k BGB).
  describe('a question that does not answer', () => {
    const hang = () => {
      let answer!: (p: PublicCancelPreview) => void;
      let signal: AbortSignal | undefined;
      account.previewPublicCancel.mockImplementation((_token: string, opts?: { signal?: AbortSignal }) => {
        signal = opts?.signal;
        return new Promise<PublicCancelPreview>((resolve) => (answer = resolve));
      });
      return { answer: (p: PublicCancelPreview) => answer(p), signal: () => signal };
    };

    it('the wait is capped: after the limit the page offers the ordinary cancel, and the request is given up', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const question = hang();
        account.confirmPublicCancel.mockResolvedValue({ status: 'cancelled', accessUntil: PERIOD_END, withdrawal: null });
        renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
        await screen.findByTestId('public-cancel-checking');
        expect(PUBLIC_CANCEL_PREVIEW_TIMEOUT_MS).toBeGreaterThanOrEqual(3000);
        expect(PUBLIC_CANCEL_PREVIEW_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
        // Just before the limit the page still waits: the choices must not appear under a button already pressed.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PUBLIC_CANCEL_PREVIEW_TIMEOUT_MS - 100);
        });
        expect(screen.getByTestId('public-cancel-checking')).toBeInTheDocument();
        expect(screen.queryByRole('button')).toBeNull();
        expect(question.signal()?.aborted).toBe(false);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        const cancel = await screen.findByRole('button', { name: 'Cancel now' });
        expect(screen.queryByTestId('public-cancel-checking')).toBeNull();
        expect(question.signal()?.aborted).toBe(true);
        // Not a bad link, and nothing is asked a second time.
        expect(screen.queryByText(/expired or was already used/)).toBeNull();
        expect(account.previewPublicCancel).toHaveBeenCalledTimes(1);
        fireEvent.click(cancel);
        expect(await screen.findByTestId('public-cancel-done')).toHaveTextContent('Your subscription is cancelled');
        expect(account.confirmPublicCancel).toHaveBeenCalledWith({ token: TOKEN });
      } finally {
        vi.useRealTimers();
      }
    });

    it('an answer that arrives after the page gave up changes nothing: no second choice under the button', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const question = hang();
        renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
        await screen.findByTestId('public-cancel-checking');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PUBLIC_CANCEL_PREVIEW_TIMEOUT_MS + 50);
        });
        await screen.findByRole('button', { name: 'Cancel now' });
        // The late answer says a withdrawal is open.
        await act(async () => {
          question.answer(withWithdrawal());
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(screen.getByRole('button', { name: 'Cancel now' })).toBeEnabled();
        expect(screen.queryByTestId('public-cancel-choices')).toBeNull();
        expect(screen.queryByText(/Withdraw/)).toBeNull();
        expect(screen.getAllByRole('button')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('an answer inside the limit is used as ever, and the limit then does nothing', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const question = hang();
        renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
        await screen.findByTestId('public-cancel-checking');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
          question.answer(withWithdrawal());
        });
        await screen.findByTestId('public-cancel-choices');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PUBLIC_CANCEL_PREVIEW_TIMEOUT_MS * 2);
        });
        expect(screen.getByTestId('public-cancel-choices')).toBeInTheDocument();
        expect(question.signal()?.aborted).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('/cancel with a link: two labelled choices while a withdrawal is open', () => {
  const choices = () => screen.findByTestId('public-cancel-choices');
  const cancelButton = () => screen.getByRole('button', { name: 'Cancel at the end of the period' });
  const withdrawButton = (amount = '$20.83') => screen.getByRole('button', { name: `Withdraw from contract and refund ${amount}` });

  it('both are labelled, with the quoted amount, the last day and what each does; nothing is sent by showing them', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal());
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    const block = await choices();
    expect(within(block).getByRole('heading', { name: 'Cancel at the end of the period' })).toBeInTheDocument();
    expect(within(block).getByRole('heading', { name: 'Withdraw from contract' })).toBeInTheDocument();
    expect(block).toHaveTextContent('The renewal stops now. You keep Pro until Nov 5, 2026.');
    // The amount and the last day are the server's own.
    expect(block).toHaveTextContent(/The plan ends at once and we refund \$20\.83\. You can do this until Oct (18|19|20), 2026/);
    expect(block).toHaveTextContent('You asked us to start at once, so the refund covers the days you have not used.');
    expect(cancelButton()).toBeEnabled();
    expect(withdrawButton()).toBeEnabled();
    // The old single button is not a third choice.
    expect(screen.queryByRole('button', { name: 'Cancel now' })).toBeNull();
    expect(account.confirmPublicCancel).not.toHaveBeenCalled();
  });

  it('a full refund (no waiver) has no "days you have not used" sentence', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal({ rule: 'withdrawal_14d', refundMinor: 2499 }));
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    expect(withdrawButton('$24.99')).toBeInTheDocument();
    expect(screen.queryByText(/days you have not used/)).toBeNull();
  });

  it('"Cancel at the end of the period" sends the ordinary cancel, without withdraw', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal());
    account.confirmPublicCancel.mockResolvedValue({ status: 'cancelled', accessUntil: PERIOD_END, withdrawal: null });
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    fireEvent.click(cancelButton());
    const done = await screen.findByTestId('public-cancel-done');
    expect(done).toHaveTextContent('Your subscription is cancelled. You keep Pro until Nov 5, 2026.');
    expect(done).not.toHaveTextContent(/withdraw|refund/i);
    expect(account.confirmPublicCancel).toHaveBeenCalledTimes(1);
    expect(account.confirmPublicCancel).toHaveBeenCalledWith({ token: TOKEN });
    expect(screen.queryByTestId('public-cancel-choices')).toBeNull();
  });

  it('"Withdraw from contract and refund {amount}" sends withdraw: true and shows the refunded amount the server answered', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal());
    // The server's own figure, on purpose not the previewed one.
    account.confirmPublicCancel.mockResolvedValue({ status: 'cancelled', accessUntil: null, withdrawal: { status: 'withdrawn', refundMinor: 2000, currency: 'USD' } });
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    fireEvent.click(withdrawButton());
    const done = await screen.findByTestId('public-cancel-withdrawn');
    expect(done).toHaveTextContent('You have withdrawn from the contract. The plan has ended and we are refunding $20. A confirmation email is on its way.');
    expect(account.confirmPublicCancel).toHaveBeenCalledTimes(1);
    expect(account.confirmPublicCancel).toHaveBeenCalledWith({ token: TOKEN, withdraw: true });
    // Never the "you keep Pro until" line after a withdrawal.
    expect(screen.getByTestId('public-cancel-done')).not.toHaveTextContent(/keep Pro/);
    expect(screen.queryByTestId('public-cancel-choices')).toBeNull();
  });

  it('a withdrawal answered without an amount states none', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal());
    account.confirmPublicCancel.mockResolvedValue({ status: 'cancelled', accessUntil: null, withdrawal: { status: 'withdrawn', refundMinor: null, currency: null } });
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    fireEvent.click(withdrawButton());
    const done = await screen.findByTestId('public-cancel-withdrawn');
    expect(done).toHaveTextContent('You have withdrawn from the contract. The plan has ended. Your refund and a confirmation email are on their way.');
    expect(done.textContent).not.toMatch(/\d/);
  });

  it('not available any more: the page says the plan was cancelled at the end of the period instead', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal());
    account.confirmPublicCancel.mockResolvedValue({ status: 'cancelled', accessUntil: PERIOD_END, withdrawal: { status: 'not_available', refundMinor: null, currency: null } });
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    fireEvent.click(withdrawButton());
    const done = await screen.findByTestId('public-cancel-done');
    expect(within(done).getByTestId('public-cancel-withdraw-gone')).toHaveTextContent('This purchase can no longer be withdrawn.');
    expect(done).toHaveTextContent("We cancelled your subscription at the end of the period instead. You keep Pro until Nov 5, 2026. We've emailed you a confirmation.");
    expect(done).not.toHaveTextContent(/refunding/);
    expect(screen.queryByTestId('public-cancel-withdrawn')).toBeNull();
  });

  it('a server that cancelled without saying anything about the withdrawal is read the same way, never as a refund', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal());
    account.confirmPublicCancel.mockResolvedValue({ status: 'already_cancelled', accessUntil: PERIOD_END, withdrawal: null });
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    fireEvent.click(withdrawButton());
    const done = await screen.findByTestId('public-cancel-done');
    expect(done).toHaveTextContent('This purchase can no longer be withdrawn.');
    expect(done).toHaveTextContent('This subscription was already cancelled.');
    expect(done).not.toHaveTextContent(/refunding|instead/);
  });

  it('a provider failure leaves the link usable: a plain error and both choices again', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal());
    account.confirmPublicCancel.mockRejectedValueOnce(linkError('payment_provider_error', 502));
    account.confirmPublicCancel.mockResolvedValue({ status: 'cancelled', accessUntil: null, withdrawal: { status: 'withdrawn', refundMinor: 2083, currency: 'USD' } });
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    fireEvent.click(withdrawButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
    expect(cancelButton()).toBeEnabled();
    expect(withdrawButton()).toBeEnabled();
    expect(screen.queryByLabelText('Email')).toBeNull();
    fireEvent.click(withdrawButton());
    expect(await screen.findByTestId('public-cancel-withdrawn')).toHaveTextContent('$20.83');
    expect(account.confirmPublicCancel).toHaveBeenCalledTimes(2);
  });

  it('409 withdrawal_not_available on the button: "can no longer be withdrawn", the choice goes and the ordinary cancel is left', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal());
    // As the server sends it when the payment provider refuses the refund (details.reason: refund_refused).
    account.confirmPublicCancel.mockRejectedValueOnce(
      new RoboApiError('refused', { status: 409, code: 'withdrawal_not_available', payload: { success: false, code: 'withdrawal_not_available', details: { reason: 'refund_refused' } } }),
    );
    account.confirmPublicCancel.mockResolvedValue({ status: 'already_cancelled', accessUntil: null, withdrawal: null });
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    fireEvent.click(withdrawButton());
    expect(await screen.findByTestId('public-cancel-withdraw-refused')).toHaveTextContent('This purchase can no longer be withdrawn.');
    expect(screen.queryByTestId('public-cancel-choices')).toBeNull();
    expect(screen.queryByRole('button', { name: /Withdraw/ })).toBeNull();
    expect(screen.queryByText('Something went wrong. Try again.')).toBeNull();
    // The link's ordinary cancel still answers for the plan as it is now.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel now' }));
    expect(await screen.findByTestId('public-cancel-done')).toHaveTextContent('This subscription was already cancelled.');
    expect(account.confirmPublicCancel).toHaveBeenLastCalledWith({ token: TOKEN });
  });

  it('a refused withdrawal is not offered again: not while the ordinary cancel is sent, and not after that cancel fails', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal());
    const refusal = new RoboApiError('refused', { status: 409, code: 'withdrawal_not_available', payload: { success: false, code: 'withdrawal_not_available' } });
    let failCancel!: (err: unknown) => void;
    account.confirmPublicCancel.mockRejectedValueOnce(refusal);
    account.confirmPublicCancel.mockImplementationOnce(() => new Promise((_resolve, reject) => (failCancel = reject)));
    account.confirmPublicCancel.mockResolvedValue({ status: 'cancelled', accessUntil: PERIOD_END, withdrawal: null });
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    fireEvent.click(withdrawButton());
    await screen.findByTestId('public-cancel-withdraw-refused');
    const single = () => {
      expect(screen.queryByTestId('public-cancel-choices')).toBeNull();
      expect(screen.queryByRole('button', { name: /Withdraw/ })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Withdraw from contract' })).toBeNull();
      expect(screen.getAllByRole('button')).toHaveLength(1);
    };
    single();
    // The ordinary cancel is on its way: still one button, and the reason it is the only one stays on the page.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel now' }));
    expect(await screen.findByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    single();
    expect(screen.getByTestId('public-cancel-withdraw-refused')).toHaveTextContent('This purchase can no longer be withdrawn.');
    // That cancel fails (the payment provider, the network): a plain error, and still only the ordinary cancel.
    await act(async () => failCancel(linkError('payment_provider_error', 502)));
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
    single();
    expect(screen.getByRole('button', { name: 'Cancel now' })).toBeEnabled();
    expect(screen.getByTestId('public-cancel-withdraw-refused')).toBeInTheDocument();
    // The link is still good for the cancel.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel now' }));
    expect(await screen.findByTestId('public-cancel-done')).toHaveTextContent('Your subscription is cancelled. You keep Pro until Nov 5, 2026.');
    expect(account.confirmPublicCancel.mock.calls.map((c) => c[0])).toEqual([{ token: TOKEN, withdraw: true }, { token: TOKEN }, { token: TOKEN }]);
  });

  it('a link that turns out to be used when the button is pressed: the expired message and a new link', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal());
    account.confirmPublicCancel.mockRejectedValue(linkError('cancel_token_invalid', 410));
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    fireEvent.click(withdrawButton());
    expect(await screen.findByText(/expired or was already used/)).toBeInTheDocument();
    expect(screen.queryByTestId('public-cancel-choices')).toBeNull();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('while one choice is being sent neither can be pressed again', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal());
    account.confirmPublicCancel.mockReturnValue(new Promise(() => undefined));
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    fireEvent.click(withdrawButton());
    const pending = await screen.findByRole('button', { name: 'Withdrawing…' });
    expect(pending).toBeDisabled();
    expect(cancelButton()).toBeDisabled();
    fireEvent.click(cancelButton());
    expect(account.confirmPublicCancel).toHaveBeenCalledTimes(1);
  });

  it('outside the window the page offers only the ordinary cancel, even if a stale quote arrives', async () => {
    // The last day has passed on this device's clock: the quote is not offered.
    account.previewPublicCancel.mockResolvedValue(withWithdrawal({ deadline: '2026-10-10T11:59:59.000Z' }));
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    expect(await screen.findByRole('button', { name: 'Cancel now' })).toBeInTheDocument();
    expect(screen.queryByTestId('public-cancel-choices')).toBeNull();
    expect(screen.queryByText(/Withdraw/)).toBeNull();
    expect(openLinkWithdrawal(withWithdrawal(), NOW)).not.toBeNull();
    expect(openLinkWithdrawal(withWithdrawal({ deadline: NOW.toISOString() }), NOW)).toBeNull();
    expect(openLinkWithdrawal(linkPreview(), NOW)).toBeNull();
    expect(openLinkWithdrawal(null, NOW)).toBeNull();
  });

  it('a refund in another currency than the brand\'s names its currency', async () => {
    account.previewPublicCancel.mockResolvedValue(withWithdrawal({ refundMinor: 74900, currency: 'TWD', rule: 'withdrawal_14d' }));
    renderUi(<PublicCancelFlow token={TOKEN} now={now} />);
    await choices();
    expect(withdrawButton('NT$749')).toBeInTheDocument();
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
