// WP-21b — /admin/credits console (lib/api mocked; admin role from the auth mock).
// Market wave M4 (MKT-4C over MKT-4B's admin API): the Refunds panel (quote
// facts, refund through Stripe with a confirm step, the list with disputes
// flagged, the manual record of a mainland order), the practice-cost panel
// and the Stripe panel.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { ATTEMPT_KEY_RE, renderUi } from './fixtures';
import { RoboApiError } from '../../../../lib/api/client';
import type { RefundQuoteResponse } from '../../../../lib/api/admin';
import type { AdminRefundRow, CnOrderRow, PracticeCost, StripeHealth } from '../../../../lib/api/adminBilling';
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
// The admin billing calls (lib/api/adminBilling.ts) and the existing refund quote (lib/api/admin.ts).
const billing = vi.hoisted(() => ({
  issueRefund: vi.fn(),
  listRefunds: vi.fn(),
  listCnOrders: vi.fn(),
  recordCnRefund: vi.fn(),
  practiceCost: vi.fn(),
  stripeHealth: vi.fn(),
}));
const adminApi = vi.hoisted(() => ({ getRefundQuote: vi.fn() }));
vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/api/adminBilling', async (orig) => ({ ...(await orig<Record<string, unknown>>()), adminBillingApi: billing }));
vi.mock('../../../../lib/api/admin', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...adminApi }));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

import { AdminCreditsConsole } from '../AdminCreditsConsole';
import { ADMIN_STRIPE_PANEL_ID, cnRefundErrorKey, refundErrorKey } from '../AdminBillingPanels';
import { ADMIN_REFUND_REREAD_DELAYS_MS } from '../../../../hooks/credits/useAdminCredits';

const cost = (over: Partial<PracticeCost> = {}): PracticeCost => ({
  sampleSize: 50,
  averageUsd: 0.8421,
  enough: true,
  maxSessions: 50,
  minSessions: 10,
  oldest: '2026-09-01T12:00:00.000Z',
  newest: '2026-10-10T12:00:00.000Z',
  ...over,
});
const health = (over: Partial<StripeHealth> = {}): StripeHealth => ({
  keyMode: 'test',
  usable: true,
  refusedReason: null,
  webhookSecrets: 1,
  railReady: true,
  endpoint: { checked: true, url: 'https://www.example.test/api/v1/roboapply/stripe/webhook', missingEvents: [], reason: null },
  pinnedPlans: [],
  ...over,
});
const NO_CHARGE: RefundQuoteResponse = { charge: null, facts: null, decision: null };

beforeEach(() => {
  for (const fn of [...Object.values(api), ...Object.values(billing), ...Object.values(adminApi)]) fn.mockReset();
  mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
  billing.listRefunds.mockResolvedValue({ items: [], cursor: null });
  billing.listCnOrders.mockResolvedValue({ items: [] });
  billing.practiceCost.mockResolvedValue({ brands: { roboapply: cost(), goapply: cost({ sampleSize: 4, averageUsd: null, enough: false }) } });
  billing.stripeHealth.mockResolvedValue(health());
  adminApi.getRefundQuote.mockResolvedValue(NO_CHARGE);
  api.adminGetCreditCatalog.mockResolvedValue({ override: { version: 1, brands: { roboapply: { buckets: { tailor: { free: { cap: 3 } } } } } } });
  api.adminPutCreditCatalog.mockImplementation(async (b: unknown) => b);
  api.adminListOverrides.mockResolvedValue({ items: [] });
  api.adminGetFxReference.mockResolvedValue(null);
  // `warnAt` is whole NT$ (the contract's one unit), never the 0.7 ratio.
  api.adminGetTwRevenue.mockResolvedValue({ periodStart: '2026-01-01', revenueTwd: 450000, thresholdTwd: 600000, warnAt: 420000, warning: true, source: 'stripe', asOf: '2026-10-10T00:00:00Z' });
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

  it('TW revenue: the warning is the server\'s answer and the percentage comes from warnAt in NT$', async () => {
    // Below the level the server warns at: no banner, whatever the share reads.
    api.adminGetTwRevenue.mockResolvedValue({ periodStart: '2026-01-01', revenueTwd: 300000, thresholdTwd: 600000, warnAt: 420000, warning: false, source: 'stripe', asOf: '2026-10-10T00:00:00Z' });
    const { unmount } = renderUi(<AdminCreditsConsole />);
    const quiet = (await screen.findByText('Taiwan card revenue')).closest('section')!;
    await waitFor(() => expect(quiet).toHaveTextContent('50% of the level'));
    expect(within(quiet).queryByRole('alert')).toBeNull();
    unmount();
    // A different warning level is printed from the NT$ figure (480,000 of 600,000 = 80%).
    api.adminGetTwRevenue.mockResolvedValue({ periodStart: '2026-01-01', revenueTwd: 500000, thresholdTwd: 600000, warnAt: 480000, warning: true, source: 'stripe', asOf: '2026-10-10T00:00:00Z' });
    renderUi(<AdminCreditsConsole />);
    const loud = (await screen.findByText('Taiwan card revenue')).closest('section')!;
    await waitFor(() => expect(within(loud).getByRole('alert')).toHaveTextContent('above 80%'));
  });

  it('TW revenue without a fresh rate shows "—" and no warning', async () => {
    api.adminGetTwRevenue.mockResolvedValue({ periodStart: '2026-01-01', revenueTwd: null, thresholdTwd: 600000, warnAt: 420000, warning: false, source: 'stripe', asOf: '2026-10-10T00:00:00Z' });
    renderUi(<AdminCreditsConsole />);
    const section = (await screen.findByText('Taiwan card revenue')).closest('section')!;
    await waitFor(() => expect(section).toHaveTextContent('Revenue this year—'));
    expect(within(section).queryByRole('alert')).toBeNull();
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

// ── Market wave M4: refunds, practice cost, Stripe ────────────────────────────

const apiError = (code: string, status: number) => new RoboApiError('refused', { code, status, payload: { success: false, code } });

/** The refund check of a German subscriber on day 5 who ticked the waiver: 25 of 30 days go back. */
const QUOTE: RefundQuoteResponse = {
  charge: { source: 'stripe', id: 'in_1PabcDEF2345', chargedAt: '2026-10-06T12:00:00.000Z', amountMinor: 2499, currency: 'USD', planKey: 'pro_monthly', chargeKind: 'first_purchase' },
  facts: { billingCountry: 'DE', withdrawalWaiver: true, paidOnlyCreditsUsed: 3, packCreditsUsed: null },
  decision: {
    eligible: true,
    amountMinor: 2083,
    currency: 'USD',
    rule: 'withdrawal_14d_prorata',
    blocker: null,
    deadline: '2026-10-20T12:00:00.000Z',
    withdrawalRegion: 'eu',
    policyVersion: 'refund-v1-2026-10',
    prorata: { usedDays: 5, periodDays: 30 },
    endsAccess: true,
  },
};

async function showUser(userId = 'u_42') {
  renderUi(<AdminCreditsConsole />);
  const panel = await screen.findByTestId('admin-refunds-panel');
  fireEvent.change(within(panel).getByLabelText('User ID'), { target: { value: `  ${userId} ` } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Show' }));
  await screen.findByTestId('admin-refunds-user');
  return panel;
}

describe('AdminCreditsConsole: Refunds, keyed by a user id', () => {
  it('nothing about a user is asked until an id is given', async () => {
    renderUi(<AdminCreditsConsole />);
    const panel = await screen.findByTestId('admin-refunds-panel');
    expect(within(panel).getByText('Enter a user ID to start.')).toBeInTheDocument();
    expect(adminApi.getRefundQuote).not.toHaveBeenCalled();
    expect(billing.listRefunds).not.toHaveBeenCalled();
    expect(billing.listCnOrders).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Show' }));
    expect(screen.queryByTestId('admin-refunds-user')).toBeNull();
  });

  it('(a) the refund quote is shown as read-only facts', async () => {
    adminApi.getRefundQuote.mockResolvedValue(QUOTE);
    await showUser();
    expect(adminApi.getRefundQuote).toHaveBeenCalledWith('u_42', expect.anything());
    const facts = await screen.findByTestId('refund-facts');
    await waitFor(() => expect(facts).toHaveTextContent(/\$24\.99 on Oct 6, 2026.* for pro_monthly \(first purchase\)\./));
    expect(facts).toHaveTextContent('Paid throughCard');
    expect(facts).toHaveTextContent('Billing countryDE');
    expect(facts).toHaveTextContent('Start-now box ticked at checkoutYes');
    expect(facts).toHaveTextContent('Actions that need Pro, used since the charge3');
    expect(facts).toHaveTextContent('Days used of the paid period5 of 30');
    const decision = within(facts).getByTestId('refund-decision');
    expect(decision).toHaveTextContent('Can be refunded');
    expect(decision).toHaveTextContent('Rule: withdrawal_14d_prorata');
    expect(decision).toHaveTextContent(/Refund window ends Oct 20, 2026/);
    expect(facts).toHaveTextContent('Refund amount: $20.83');
    // Facts only: nothing to type or press in this block.
    expect(within(facts).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(facts).queryAllByRole('button')).toHaveLength(0);
  });

  it('(a) a user without a paid charge says so', async () => {
    const panel = await showUser();
    expect(await within(panel).findByText('No paid charge found.')).toBeInTheDocument();
    expect(within(panel).queryByTestId('refund-decision')).toBeNull();
  });

  it('another user id starts every form and answer from nothing', async () => {
    adminApi.getRefundQuote.mockResolvedValue(QUOTE);
    const panel = await showUser('u_first');
    fireEvent.change(await within(screen.getByTestId('stripe-refund')).findByLabelText('Reason'), { target: { value: 'Typed for the first user' } });
    fireEvent.change(within(panel).getByLabelText('User ID'), { target: { value: 'u_second' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(screen.getByTestId('admin-refunds-user')).toHaveAttribute('data-user', 'u_second'));
    expect(within(screen.getByTestId('stripe-refund')).getByLabelText('Reason')).toHaveValue('');
    expect(adminApi.getRefundQuote).toHaveBeenLastCalledWith('u_second', expect.anything());
    expect(billing.listRefunds).toHaveBeenLastCalledWith('u_second', null, expect.anything());
    expect(billing.listCnOrders).toHaveBeenLastCalledWith('u_second', expect.anything());
  });

  it.each([
    ['not_found', 404, 'No user with this ID.'],
    ['server_error', 500, "We couldn't load the refund check."],
  ])('(a) a refund check answered %s says so', async (code, status, message) => {
    adminApi.getRefundQuote.mockRejectedValue(apiError(code, status));
    await showUser();
    expect(await within(screen.getByTestId('refund-facts')).findByRole('alert')).toHaveTextContent(message);
  });
});

describe('AdminCreditsConsole: (b) refund through Stripe', () => {
  const form = () => screen.getByTestId('stripe-refund');
  const fill = (reason = 'Charged twice by mistake', amount?: string) => {
    if (amount !== undefined) fireEvent.change(within(form()).getByLabelText(/^Amount/), { target: { value: amount } });
    fireEvent.change(within(form()).getByLabelText('Reason'), { target: { value: reason } });
  };
  const review = () => fireEvent.click(within(form()).getByRole('button', { name: 'Review refund' }));

  beforeEach(() => {
    adminApi.getRefundQuote.mockResolvedValue(QUOTE);
    billing.issueRefund.mockResolvedValue({ refundId: 're_1', amountMinor: 2499, currency: 'USD', full: true });
  });

  it('the latest invoice of the quote is the target; a full refund needs the reason and the confirm step, which repeats amount and user', async () => {
    await showUser();
    await within(form()).findByRole('radio', { name: /The latest charge: \$24\.99 on Oct 6, 2026/ });
    expect(within(form()).getByRole('radio', { name: /The latest charge/ })).toBeChecked();
    // A reason is required: nothing is reviewed or sent without one.
    review();
    expect(within(form()).getByRole('alert')).toHaveTextContent('Check what to refund, the amount and the reason.');
    expect(screen.queryByTestId('stripe-refund-confirm')).toBeNull();
    fill();
    review();
    const confirm = await screen.findByTestId('stripe-refund-confirm');
    expect(confirm).toHaveTextContent('Useru_42');
    expect(confirm).toHaveTextContent('ChargeThe latest charge: $24.99 on Oct 6, 2026');
    expect(confirm).toHaveTextContent('AmountEverything that can still be refunded');
    expect(confirm).toHaveTextContent('ReasonCharged twice by mistake');
    // Nothing is sent before the confirm step is confirmed.
    expect(billing.issueRefund).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
    const done = await screen.findByTestId('stripe-refund-done');
    expect(billing.issueRefund).toHaveBeenCalledTimes(1);
    expect(billing.issueRefund).toHaveBeenCalledWith({ userId: 'u_42', target: { invoiceId: 'in_1PabcDEF2345' }, reason: 'Charged twice by mistake', attemptKey: expect.stringMatching(ATTEMPT_KEY_RE) });
    // The returned amount, and that access changes when Stripe's event arrives (never "access removed").
    expect(done).toHaveTextContent('Refunded $24.99. Access changes when Stripe confirms the refund.');
    expect(done).toHaveTextContent('Nothing is left to refund on this charge.');
    // The lists are read again.
    await waitFor(() => expect(billing.listRefunds.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('a partial amount goes out in whole minor units and the confirm step shows it in the charge\'s currency', async () => {
    billing.issueRefund.mockResolvedValue({ refundId: 're_2', amountMinor: 1000, currency: 'USD', full: false });
    await showUser();
    await within(form()).findByRole('radio', { name: /The latest charge/ });
    fill('Half back as agreed', '10.00');
    review();
    const confirm = await screen.findByTestId('stripe-refund-confirm');
    expect(confirm).toHaveTextContent('Amount$10');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
    const done = await screen.findByTestId('stripe-refund-done');
    expect(billing.issueRefund.mock.calls[0]![0]).toMatchObject({ amountMinor: 1000, target: { invoiceId: 'in_1PabcDEF2345' } });
    expect(done).toHaveTextContent('Refunded $10.');
    expect(done).toHaveTextContent('Part of this charge has not been refunded.');
  });

  it.each(['abc', '0', '-5', '10.999', '25.00'])('an amount of "%s" is refused before the confirm step (not a positive amount, or more than the charge)', async (amount) => {
    await showUser();
    await within(form()).findByRole('radio', { name: /The latest charge/ });
    fill('Reason', amount);
    review();
    expect(within(form()).getByRole('alert')).toHaveTextContent('Check what to refund, the amount and the reason.');
    expect(screen.queryByTestId('stripe-refund-confirm')).toBeNull();
    expect(billing.issueRefund).not.toHaveBeenCalled();
  });

  it('a typed invoice or checkout session id is the target; anything else is refused', async () => {
    adminApi.getRefundQuote.mockResolvedValue(NO_CHARGE);
    await showUser();
    // No card charge in the quote: only the typed target is offered.
    expect(within(form()).queryByRole('radio', { name: /The latest charge/ })).toBeNull();
    const id = within(form()).getByLabelText('Invoice or checkout session ID');
    fireEvent.change(id, { target: { value: 'pi_not_an_invoice' } });
    fill('Pack bought by mistake', '5');
    review();
    expect(within(form()).getByRole('alert')).toBeInTheDocument();
    fireEvent.change(id, { target: { value: ' cs_test_a1B2c3D4e5F6 ' } });
    review();
    const confirm = await screen.findByTestId('stripe-refund-confirm');
    expect(confirm).toHaveTextContent('Chargecs_test_a1B2c3D4e5F6');
    // The currency of a typed target is not known here: the amount is repeated as typed, never with a guessed symbol.
    expect(confirm).toHaveTextContent('Amount5 in the currency of the charge');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
    await screen.findByTestId('stripe-refund-done');
    expect(billing.issueRefund.mock.calls[0]![0]).toMatchObject({ userId: 'u_42', target: { checkoutSessionId: 'cs_test_a1B2c3D4e5F6' }, amountMinor: 500, reason: 'Pack bought by mistake' });
  });

  it('a mainland charge in the quote is never a Stripe target', async () => {
    adminApi.getRefundQuote.mockResolvedValue({ ...QUOTE, charge: { ...QUOTE.charge!, source: 'cn', id: 'ord_1', currency: 'CNY', amountMinor: 3900 } });
    await showUser();
    await waitFor(() => expect(screen.getByTestId('refund-facts')).toHaveTextContent('Paid throughAlipay or WeChat Pay'));
    expect(within(form()).queryByRole('radio', { name: /The latest charge/ })).toBeNull();
    expect(within(form()).getByLabelText('Invoice or checkout session ID')).toBeInTheDocument();
  });

  it('"Back" leaves the confirm step without sending; the form keeps what was typed', async () => {
    await showUser();
    await within(form()).findByRole('radio', { name: /The latest charge/ });
    fill('Typed reason', '3.50');
    review();
    fireEvent.click(within(await screen.findByTestId('stripe-refund-confirm')).getByRole('button', { name: 'Back' }));
    expect(screen.queryByTestId('stripe-refund-confirm')).toBeNull();
    expect(within(form()).getByLabelText('Reason')).toHaveValue('Typed reason');
    expect(within(form()).getByLabelText(/^Amount/)).toHaveValue('3.50');
    expect(billing.issueRefund).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404, 'No such user, invoice or checkout session.'],
    ['refund_not_available', 409, "This charge can't be refunded: it belongs to someone else, it was already refunded in full, or the amount is more than what is left."],
    ['rail_not_configured', 503, 'Card payments are not set up here, so no refund can be sent.'],
    ['payment_provider_error', 502, 'Stripe did not confirm the refund. Check the list below before you try again.'],
    ['server_error', 500, "The refund didn't go through. Check the list below before you try again."],
  ])('%s (%i) shows its own message in the confirm step, which stays open', async (code, status, message) => {
    billing.issueRefund.mockRejectedValue(apiError(code, status));
    await showUser();
    await within(form()).findByRole('radio', { name: /The latest charge/ });
    fill();
    review();
    const confirm = await screen.findByTestId('stripe-refund-confirm');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(message);
    expect(within(confirm).getByRole('button', { name: 'Refund now' })).toBeEnabled();
    expect(screen.queryByTestId('stripe-refund-done')).toBeNull();
    expect(refundErrorKey(apiError(code, status))).toBe(code === 'server_error' ? 'generic' : code);
  });

  it('one attempt key per refund decision: the same on a retry, a new one for the next refund of the same amount', async () => {
    billing.issueRefund.mockRejectedValueOnce(apiError('payment_provider_error', 502));
    billing.issueRefund.mockResolvedValue({ refundId: 're_3', amountMinor: 1000, currency: 'USD', full: false });
    await showUser();
    await within(form()).findByRole('radio', { name: /The latest charge/ });
    const refundTen = async () => {
      fill('Ten back', '10');
      review();
      fireEvent.click(within(await screen.findByTestId('stripe-refund-confirm')).getByRole('button', { name: 'Refund now' }));
    };
    await refundTen();
    const confirm = await screen.findByTestId('stripe-refund-confirm');
    await within(confirm).findByRole('alert');
    // The retry of the SAME decision carries the same key: the payment provider answers it once.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
    await screen.findByTestId('stripe-refund-done');
    const key = (call: number) => (billing.issueRefund.mock.calls[call]![0] as { attemptKey: string }).attemptKey;
    expect(key(0)).toMatch(ATTEMPT_KEY_RE);
    expect(key(1)).toBe(key(0));
    // A second refund of the same amount on the same charge, an hour later, is a new decision: a new key.
    await refundTen();
    await waitFor(() => expect(billing.issueRefund).toHaveBeenCalledTimes(3));
    expect(key(2)).toMatch(ATTEMPT_KEY_RE);
    expect(key(2)).not.toBe(key(0));
    const body = (call: number) => {
      const { attemptKey: _key, ...rest } = billing.issueRefund.mock.calls[call]![0] as Record<string, unknown>;
      return rest;
    };
    expect(body(2)).toEqual(body(0));
  });

  // The key names the movement of money (user, charge, amount), not its wording. An unclear failure can mean the
  // refund WAS made: a retry with the same key is answered with that refund, a retry with a new key is a second refund.
  it('rewording the reason before a retry keeps the attempt key: the same money, the same decision', async () => {
    billing.issueRefund.mockRejectedValueOnce(new Error('connection lost'));
    billing.issueRefund.mockResolvedValue({ refundId: 're_5', amountMinor: 500, currency: 'USD', full: false });
    await showUser();
    await within(form()).findByRole('radio', { name: /The latest charge/ });
    fill('Five back', '5.00');
    review();
    let confirm = await screen.findByTestId('stripe-refund-confirm');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent("The refund didn't go through. Check the list below before you try again.");
    // Staff go back, fix the wording of the reason (and type the same amount another way) and confirm again.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Back' }));
    fill('Five back, as agreed by email', '5');
    review();
    confirm = await screen.findByTestId('stripe-refund-confirm');
    expect(confirm).toHaveTextContent('ReasonFive back, as agreed by email');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
    await screen.findByTestId('stripe-refund-done');
    const sent = billing.issueRefund.mock.calls.map((c) => c[0] as { attemptKey: string; reason: string; amountMinor: number });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.attemptKey).toMatch(ATTEMPT_KEY_RE);
    expect(sent[1]!.attemptKey).toBe(sent[0]!.attemptKey);
    // The new wording still goes out: it is what the refund and the audit line keep.
    expect(sent.map((b) => b.reason)).toEqual(['Five back', 'Five back, as agreed by email']);
    expect(sent.map((b) => b.amountMinor)).toEqual([500, 500]);
  });

  it('another amount is another decision: a new key', async () => {
    billing.issueRefund.mockRejectedValueOnce(apiError('payment_provider_error', 502));
    await showUser();
    await within(form()).findByRole('radio', { name: /The latest charge/ });
    fill('Ten back', '10');
    review();
    let confirm = await screen.findByTestId('stripe-refund-confirm');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
    await within(confirm).findByRole('alert');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Back' }));
    fill('Ten back', '12');
    review();
    confirm = await screen.findByTestId('stripe-refund-confirm');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
    await screen.findByTestId('stripe-refund-done');
    const keys = billing.issueRefund.mock.calls.map((c) => (c[0] as { attemptKey: string }).attemptKey);
    expect(keys[1]).toMatch(ATTEMPT_KEY_RE);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a detour through another amount does not lose the first amount\'s key: only a completed refund ends a key', async () => {
    // 10.00 fails unclearly (it may have gone through), 12.00 fails, staff go back to 10.00.
    billing.issueRefund.mockRejectedValueOnce(new Error('connection lost'));
    billing.issueRefund.mockRejectedValueOnce(apiError('refund_not_available', 409));
    billing.issueRefund.mockResolvedValue({ refundId: 're_7', amountMinor: 1000, currency: 'USD', full: false });
    await showUser();
    await within(form()).findByRole('radio', { name: /The latest charge/ });
    const attemptWith = async (amount: string, thenBack: boolean) => {
      fill('Back as agreed', amount);
      review();
      const confirm = await screen.findByTestId('stripe-refund-confirm');
      const before = billing.issueRefund.mock.calls.length;
      fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
      await waitFor(() => expect(billing.issueRefund.mock.calls.length).toBe(before + 1));
      if (!thenBack) return;
      await within(confirm).findByRole('alert');
      fireEvent.click(within(confirm).getByRole('button', { name: 'Back' }));
    };
    await attemptWith('10', true);
    await attemptWith('12', true);
    await attemptWith('10.00', false);
    await screen.findByTestId('stripe-refund-done');
    const sent = billing.issueRefund.mock.calls.map((c) => c[0] as { attemptKey: string; amountMinor: number });
    expect(sent.map((b) => b.amountMinor)).toEqual([1000, 1200, 1000]);
    expect(sent[1]!.attemptKey).not.toBe(sent[0]!.attemptKey);
    expect(sent[2]!.attemptKey).toBe(sent[0]!.attemptKey);
    // That 10.00 is now completed: the next 10.00 on this charge is another refund. The 12.00 that never went
    // through still has its own key.
    await attemptWith('10', false);
    await waitFor(() => expect(billing.issueRefund).toHaveBeenCalledTimes(4));
    await attemptWith('12', false);
    await waitFor(() => expect(billing.issueRefund).toHaveBeenCalledTimes(5));
    const keys = billing.issueRefund.mock.calls.map((c) => (c[0] as { attemptKey: string }).attemptKey);
    expect(keys[3]).toMatch(ATTEMPT_KEY_RE);
    expect(keys[3]).not.toBe(keys[0]);
    expect(keys[4]).toBe(keys[1]);
  });

  it('a partial amount and "everything" on one charge are two decisions, and so is another charge', async () => {
    billing.issueRefund.mockRejectedValue(apiError('payment_provider_error', 502));
    await showUser();
    await within(form()).findByRole('radio', { name: /The latest charge/ });
    const tryOnce = async () => {
      review();
      const confirm = await screen.findByTestId('stripe-refund-confirm');
      const before = billing.issueRefund.mock.calls.length;
      fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
      await waitFor(() => expect(billing.issueRefund.mock.calls.length).toBe(before + 1));
      await within(confirm).findByRole('alert');
      fireEvent.click(within(confirm).getByRole('button', { name: 'Back' }));
    };
    fill('Same reason', '10');
    await tryOnce();
    // The amount cleared: everything that can still be refunded.
    fill('Same reason', '');
    await tryOnce();
    // Another charge, typed.
    fireEvent.click(within(form()).getByRole('radio', { name: 'Another invoice or checkout session' }));
    fireEvent.change(within(form()).getByLabelText('Invoice or checkout session ID'), { target: { value: 'in_1PotherCHARGE99' } });
    await tryOnce();
    const sent = billing.issueRefund.mock.calls.map((c) => c[0] as { attemptKey: string; amountMinor?: number; target: unknown });
    expect(sent.map((b) => b.amountMinor)).toEqual([1000, undefined, undefined]);
    expect(sent[2]!.target).toEqual({ invoiceId: 'in_1PotherCHARGE99' });
    expect(new Set(sent.map((b) => b.attemptKey)).size).toBe(3);
  });

  // The refund's row is written by Stripe's event, a moment after the call answers: the list has to be read again later.
  it('after a refund the list and the refund check are read again at once, after 3 s and after 10 s, and then no more', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await showUser();
      await within(form()).findByRole('radio', { name: /The latest charge/ });
      fill();
      review();
      const lists = () => billing.listRefunds.mock.calls.length;
      const quotes = () => adminApi.getRefundQuote.mock.calls.length;
      await waitFor(() => expect(lists()).toBe(1));
      // Stripe's event has not arrived when the call answers; it has by the later reads.
      billing.listRefunds.mockResolvedValueOnce({ items: [], cursor: null });
      billing.listRefunds.mockResolvedValue({ items: [{ id: 'r_new', userId: 'u_42', brand: 'roboapply', rail: 'stripe', kind: 'refund', amountMinor: 2499, currency: 'USD', full: true, entitlementReversed: true, reason: 'Charged twice by mistake', actor: 'admin_7', invoiceId: 'in_1PabcDEF2345', checkoutSessionId: null, alipayOrderId: null, createdAt: '2026-10-10T12:00:05.000Z' }], cursor: null });
      fireEvent.click(within(await screen.findByTestId('stripe-refund-confirm')).getByRole('button', { name: 'Refund now' }));
      await screen.findByTestId('stripe-refund-done');
      expect(ADMIN_REFUND_REREAD_DELAYS_MS).toEqual([3000, 10_000]);
      await waitFor(() => expect(lists()).toBe(2));
      await waitFor(() => expect(quotes()).toBe(2));
      expect(within(screen.getByTestId('refund-list')).getByText('Nothing on record for this person.')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await waitFor(() => expect(lists()).toBe(3));
      // The refund just made shows by itself.
      await waitFor(() => expect(within(screen.getByTestId('refund-list')).getAllByRole('row')).toHaveLength(2));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7000);
      });
      await waitFor(() => expect(lists()).toBe(4));
      await waitFor(() => expect(quotes()).toBe(4));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(lists()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('after a refund that failed unclearly the list is read again the same way, so "check the list" has an answer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      billing.issueRefund.mockRejectedValue(apiError('payment_provider_error', 502));
      await showUser();
      await within(form()).findByRole('radio', { name: /The latest charge/ });
      fill();
      review();
      const lists = () => billing.listRefunds.mock.calls.length;
      await waitFor(() => expect(lists()).toBe(1));
      const confirm = await screen.findByTestId('stripe-refund-confirm');
      fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
      await within(confirm).findByRole('alert');
      await waitFor(() => expect(lists()).toBe(2));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await waitFor(() => expect(lists()).toBe(4));
      // The confirm step is still there with what was typed: the retry is the same decision.
      expect(screen.getByTestId('stripe-refund-confirm')).toHaveTextContent('ReasonCharged twice by mistake');
    } finally {
      vi.useRealTimers();
    }
  });

  it('"Show" on the user already on screen reads the facts again and starts no form over (a retry keeps its key)', async () => {
    billing.issueRefund.mockRejectedValueOnce(apiError('payment_provider_error', 502));
    const panel = await showUser();
    await within(form()).findByRole('radio', { name: /The latest charge/ });
    fill('Ten back', '10');
    review();
    const confirm = await screen.findByTestId('stripe-refund-confirm');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Refund now' }));
    await within(confirm).findByRole('alert');
    const before = { lists: billing.listRefunds.mock.calls.length, quotes: adminApi.getRefundQuote.mock.calls.length, orders: billing.listCnOrders.mock.calls.length };
    fireEvent.click(within(panel).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(billing.listRefunds.mock.calls.length).toBe(before.lists + 1));
    await waitFor(() => expect(adminApi.getRefundQuote.mock.calls.length).toBe(before.quotes + 1));
    await waitFor(() => expect(billing.listCnOrders.mock.calls.length).toBe(before.orders + 1));
    // Nothing was started over: the confirm step, with what was typed, is still open.
    expect(screen.getByTestId('stripe-refund-confirm')).toHaveTextContent('ReasonTen back');
    fireEvent.click(within(screen.getByTestId('stripe-refund-confirm')).getByRole('button', { name: 'Refund now' }));
    await screen.findByTestId('stripe-refund-done');
    const keys = billing.issueRefund.mock.calls.map((c) => (c[0] as { attemptKey: string }).attemptKey);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe('AdminCreditsConsole: (c) refunds, withdrawals and disputes', () => {
  const row = (over: Partial<AdminRefundRow> = {}): AdminRefundRow => ({
    id: 'r1', userId: 'u_42', brand: 'roboapply', rail: 'stripe', kind: 'refund', amountMinor: 2499, currency: 'USD', full: true, entitlementReversed: true,
    reason: 'Charged twice', actor: 'admin_7', invoiceId: 'in_1PabcDEF2345', checkoutSessionId: null, alipayOrderId: null, createdAt: '2026-10-10T12:00:00.000Z', ...over,
  });

  it('lists every kind with its words; a dispute is flagged in its row and above the table', async () => {
    billing.listRefunds.mockResolvedValue({
      items: [
        row(),
        row({ id: 'r2', kind: 'withdrawal', amountMinor: 2083, full: false, actor: 'self', reason: 'withdrawal' }),
        row({ id: 'r3', kind: 'dispute', actor: 'stripe', reason: 'fraudulent' }),
        row({ id: 'r4', kind: 'manual_cn', rail: 'alipay', amountMinor: 3900, currency: 'CNY', invoiceId: null, alipayOrderId: 'ord_1', entitlementReversed: false }),
        row({ id: 'r5', kind: 'other', amountMinor: null, currency: null, reason: null, actor: null, invoiceId: null }),
      ],
      cursor: null,
    });
    await showUser();
    const list = screen.getByTestId('refund-list');
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(6));
    expect(billing.listRefunds).toHaveBeenCalledWith('u_42', null, expect.anything());
    const cells = (id: string) => within(list.querySelector(`tr[data-kind="${id}"]`) as HTMLElement).getAllByRole('cell').map((c) => c.textContent);
    expect(cells('refund').slice(1)).toEqual(['Refund', '$24.99 (full)', 'Taken back', 'Charged twice', 'admin_7', 'in_1PabcDEF2345']);
    expect(cells('withdrawal').slice(1, 4)).toEqual(['Withdrawal', '$20.83 (partial)', 'Taken back']);
    expect(cells('manual_cn').slice(1)).toEqual(['Recorded by hand', 'CN¥39 (full)', 'Unchanged', 'Charged twice', 'admin_7', 'ord_1']);
    expect(cells('other').slice(1)).toEqual(['Other', '—', 'Taken back', '—', '—', '—']);
    expect(cells('dispute')[1]).toBe('Dispute');
    // Flagged, in words: above the table and in the row.
    expect(within(list).getByTestId('dispute-flag')).toHaveTextContent('1 dispute on record: the bank took the money back. Check this account.');
  });

  it('no dispute, no flag', async () => {
    billing.listRefunds.mockResolvedValue({ items: [row(), row({ id: 'r2', kind: 'withdrawal' })], cursor: null });
    await showUser();
    const list = screen.getByTestId('refund-list');
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(3));
    expect(within(list).queryByTestId('dispute-flag')).toBeNull();
  });

  it('nothing on record says so; a failed read says so', async () => {
    const first = renderUi(<AdminCreditsConsole />);
    fireEvent.change(within(await screen.findByTestId('admin-refunds-panel')).getByLabelText('User ID'), { target: { value: 'u_42' } });
    fireEvent.click(within(screen.getByTestId('admin-refunds-panel')).getByRole('button', { name: 'Show' }));
    expect(await within(await screen.findByTestId('refund-list')).findByText('Nothing on record for this person.')).toBeInTheDocument();
    first.unmount();
    billing.listRefunds.mockRejectedValue(apiError('not_found', 404));
    await showUser();
    expect(await within(screen.getByTestId('refund-list')).findByRole('alert')).toHaveTextContent("We couldn't load the refunds.");
  });

  it('"Show more" asks for the next page with the cursor and goes away at the end', async () => {
    billing.listRefunds.mockImplementation(async (_user: string, cursor?: string | null) => (cursor === 'c2' ? { items: [row({ id: 'r9' })], cursor: null } : { items: [row()], cursor: 'c2' }));
    await showUser();
    const list = screen.getByTestId('refund-list');
    fireEvent.click(await within(list).findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(3));
    expect(billing.listRefunds).toHaveBeenLastCalledWith('u_42', 'c2', expect.anything());
    expect(within(list).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  const refresh = (list: HTMLElement) => within(list).getByRole('button', { name: 'Refresh the list of refunds, withdrawals and disputes' });

  it('"Refresh" reads the list again in place, without starting anything over', async () => {
    billing.listRefunds.mockResolvedValueOnce({ items: [], cursor: null });
    billing.listRefunds.mockResolvedValue({ items: [row()], cursor: null });
    adminApi.getRefundQuote.mockResolvedValue(QUOTE);
    await showUser();
    const list = screen.getByTestId('refund-list');
    await within(list).findByText('Nothing on record for this person.');
    fireEvent.change(await within(screen.getByTestId('stripe-refund')).findByLabelText('Reason'), { target: { value: 'Typed before the refresh' } });
    expect(refresh(list)).toHaveTextContent('Refresh');
    fireEvent.click(refresh(list));
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(2));
    expect(billing.listRefunds).toHaveBeenCalledTimes(2);
    expect(billing.listRefunds).toHaveBeenLastCalledWith('u_42', null, expect.anything());
    expect(within(screen.getByTestId('stripe-refund')).getByLabelText('Reason')).toHaveValue('Typed before the refresh');
  });

  it('a refresh that fails keeps the rows and says they may be out of date', async () => {
    billing.listRefunds.mockResolvedValueOnce({ items: [row()], cursor: null });
    billing.listRefunds.mockRejectedValue(apiError('not_found', 404));
    await showUser();
    const list = screen.getByTestId('refund-list');
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(2));
    expect(within(list).queryByTestId('refund-list-stale')).toBeNull();
    fireEvent.click(refresh(list));
    expect(await within(list).findByTestId('refund-list-stale')).toHaveTextContent("We couldn't refresh the list. What you see may be out of date.");
    expect(within(list).getAllByRole('row')).toHaveLength(2);
    // It can be asked again, and a read that works takes the line away.
    billing.listRefunds.mockResolvedValue({ items: [row(), row({ id: 'r2', kind: 'withdrawal' })], cursor: null });
    fireEvent.click(refresh(list));
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(3));
    expect(within(list).queryByTestId('refund-list-stale')).toBeNull();
  });

  it('a "Show more" that fails says so, keeps the rows and can be pressed again', async () => {
    let fail = true;
    billing.listRefunds.mockImplementation(async (_user: string, cursor?: string | null) => {
      if (cursor !== 'c2') return { items: [row()], cursor: 'c2' };
      if (fail) throw apiError('not_found', 404);
      return { items: [row({ id: 'r9' })], cursor: null };
    });
    await showUser();
    const list = screen.getByTestId('refund-list');
    fireEvent.click(await within(list).findByRole('button', { name: 'Show more' }));
    expect(await within(list).findByTestId('refund-list-more-error')).toHaveTextContent("We couldn't load more. Try again.");
    expect(within(list).getAllByRole('row')).toHaveLength(2);
    fail = false;
    fireEvent.click(within(list).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(3));
    expect(within(list).queryByTestId('refund-list-more-error')).toBeNull();
  });
});

describe('AdminCreditsConsole: (d) mainland orders and the manual refund record (AL-7)', () => {
  const order = (over: Partial<CnOrderRow> = {}): CnOrderRow => ({ id: 'ord_1', outTradeNo: 'RAORDER_1001', planKey: 'pro_monthly', channel: 'alipay', amountMinor: 3900, completedAt: '2026-10-01T12:00:00.000Z', refunded: null, reversalPending: false, ...over });
  /** The record of a mainland refund as the refunds list carries it. The default: all of order 1, with no access taken back. */
  const cnRecord = (over: Partial<AdminRefundRow> = {}): AdminRefundRow => ({
    id: 'rf_cn_1', userId: 'u_42', brand: 'goapply', rail: 'alipay', kind: 'manual_cn', amountMinor: 3900, currency: 'CNY', full: true, entitlementReversed: false,
    reason: 'Refunded in the Alipay console', actor: 'admin_7', invoiceId: null, checkoutSessionId: null, alipayOrderId: 'ord_1', createdAt: '2026-10-10T12:00:00.000Z', ...over,
  });
  const orderRow = (id = 'ord_1') => orders().querySelector(`tr[data-order="${id}"]`) as HTMLElement;
  const checkButton = (no = 'RAORDER_1001') => within(orders()).getByRole('button', { name: `Check the refund record for order ${no}` });
  const orders = () => screen.getByTestId('cn-orders');
  const recordButton = (no = 'RAORDER_1001') => within(orders()).getByRole('button', { name: `Record refund for order ${no}` });
  const openForm = async (no = 'RAORDER_1001') => {
    await waitFor(() => expect(within(orders()).getAllByRole('row').length).toBeGreaterThan(1));
    fireEvent.click(recordButton(no));
    return screen.findByTestId('cn-refund-form');
  };

  beforeEach(() => {
    billing.listCnOrders.mockResolvedValue({ items: [order(), order({ id: 'ord_2', outTradeNo: 'GAWX_2002', channel: 'wechatpay', planKey: 'practice_pack_5', amountMinor: 2900 })] });
    billing.recordCnRefund.mockResolvedValue({ status: 'recorded', orderId: 'ord_1', entitlement: 'pass_ended' });
  });

  it('lists the completed orders with channel, amount and date', async () => {
    await showUser();
    await waitFor(() => expect(within(orders()).getAllByRole('row')).toHaveLength(3));
    expect(billing.listCnOrders).toHaveBeenCalledWith('u_42', expect.anything());
    const cells = (id: string) => within(orders().querySelector(`tr[data-order="${id}"]`) as HTMLElement).getAllByRole('cell').map((c) => c.textContent);
    expect(cells('ord_1').slice(0, 3)).toEqual(['pro_monthly', 'Alipay', 'CN¥39']);
    expect(cells('ord_1')[3]).toMatch(/Oct 1, 2026/);
    expect(cells('ord_2').slice(0, 3)).toEqual(['practice_pack_5', 'WeChat Pay', 'CN¥29']);
    expect(within(orders()).getByRole('rowheader', { name: 'GAWX_2002' })).toBeInTheDocument();
  });

  it('the Record button is disabled until the box is ticked and a reason is given', async () => {
    await showUser();
    const form = await openForm();
    const save = within(form).getByRole('button', { name: 'Record refund' });
    const box = within(form).getByRole('checkbox', { name: 'The money was returned in the merchant console' });
    expect(box).not.toBeChecked();
    expect(save).toBeDisabled();
    fireEvent.click(box);
    expect(save).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: '   ' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Refunded in the Alipay console' } });
    expect(save).toBeEnabled();
    fireEvent.click(box);
    expect(save).toBeDisabled();
    expect(billing.recordCnRefund).not.toHaveBeenCalled();
  });

  it('recording sends the order id, the reason and the confirmation; the row then shows the marker and what happened to the access', async () => {
    await showUser();
    const form = await openForm();
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Refunded in the Alipay console' } });
    // After the record the server lists the order as refunded.
    billing.listCnOrders.mockResolvedValue({ items: [order({ refunded: 'full' })] });
    fireEvent.click(within(form).getByRole('button', { name: 'Record refund' }));
    const result = await screen.findByTestId('cn-refund-result');
    expect(billing.recordCnRefund).toHaveBeenCalledTimes(1);
    // The route takes the order's id (not its order number); a full refund sends no amount.
    expect(billing.recordCnRefund).toHaveBeenCalledWith('ord_1', { reason: 'Refunded in the Alipay console', confirmMoneyReturned: true });
    expect(result).toHaveTextContent('Refund recorded for order RAORDER_1001.');
    expect(result).toHaveTextContent('The pass was ended.');
    const rowEl = orders().querySelector('tr[data-order="ord_1"]') as HTMLElement;
    await waitFor(() => expect(within(rowEl).getByTestId('cn-refunded')).toHaveTextContent('Refund recorded'));
    expect(rowEl).toHaveTextContent('The pass was ended.');
    // Recorded once: no button on that row any more, and the form is closed.
    expect(within(rowEl).queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('cn-refund-form')).toBeNull();
  });

  it.each([
    ['pass_shortened', 'The pass was shortened by the days this order added.'],
    ['pack_zeroed', 'The practice interviews left from this pack were removed.'],
    ['none', 'No access was changed.'],
  ] as const)('what happened to the access is the server\'s answer: %s', async (entitlement, sentence) => {
    billing.recordCnRefund.mockResolvedValue({ status: 'recorded', orderId: 'ord_1', entitlement });
    await showUser();
    const form = await openForm();
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'r' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record refund' }));
    expect(await screen.findByTestId('cn-refund-result')).toHaveTextContent(sentence);
  });

  it('a second record answers "already recorded" without an error, never "Refund recorded", and says what the first record did', async () => {
    // The server answers with the entitlement of the first record.
    billing.recordCnRefund.mockResolvedValue({ status: 'already_recorded', orderId: 'ord_1', entitlement: 'pass_ended' });
    await showUser();
    const form = await openForm();
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Second click' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record refund' }));
    const result = await screen.findByTestId('cn-refund-result');
    expect(result).toHaveTextContent('A refund was already recorded for order RAORDER_1001. It is not recorded twice.');
    expect(result).toHaveTextContent('The pass was ended.');
    expect(result).not.toHaveTextContent('Refund recorded for order');
    expect(within(orders()).queryByRole('alert')).toBeNull();
    // The row shows the marker and no button.
    const rowEl = orders().querySelector('tr[data-order="ord_1"]') as HTMLElement;
    expect(within(rowEl).getByTestId('cn-refunded')).toBeInTheDocument();
    expect(within(rowEl).queryByRole('button')).toBeNull();
  });

  it('an order that is already recorded shows the marker and no button', async () => {
    billing.listCnOrders.mockResolvedValue({ items: [order({ refunded: 'full' }), order({ id: 'ord_2', outTradeNo: 'RAORDER_1002', refunded: 'partial' }), order({ id: 'ord_3', outTradeNo: 'RAORDER_1003' })] });
    await showUser();
    await waitFor(() => expect(within(orders()).getAllByRole('row')).toHaveLength(4));
    const marker = (id: string) => within(orders().querySelector(`tr[data-order="${id}"]`) as HTMLElement).queryByTestId('cn-refunded')?.textContent;
    expect(marker('ord_1')).toBe('Refund recorded');
    expect(marker('ord_2')).toBe('Partial refund recorded');
    expect(marker('ord_3')).toBeUndefined();
    expect(within(orders()).getAllByRole('button', { name: /^Record refund for order/ })).toHaveLength(1);
  });

  it('a partial amount is sent in fen and marked partial; more than the order is refused before anything is sent', async () => {
    billing.recordCnRefund.mockResolvedValue({ status: 'recorded', orderId: 'ord_1', entitlement: 'none' });
    await showUser();
    const form = await openForm();
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Half back' } });
    const amount = within(form).getByLabelText(/^Amount returned in yuan/);
    fireEvent.change(amount, { target: { value: '40' } });
    expect(within(form).getByText('Enter the amount in yuan, for example 12 or 12.50, and not more than the order.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Record refund' })).toBeDisabled();
    fireEvent.change(amount, { target: { value: '19.50' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record refund' }));
    await screen.findByTestId('cn-refund-result');
    expect(billing.recordCnRefund).toHaveBeenCalledWith('ord_1', { reason: 'Half back', confirmMoneyReturned: true, refundedAmountMinor: 1950 });
    const rowEl = orders().querySelector('tr[data-order="ord_1"]') as HTMLElement;
    expect(within(rowEl).getByTestId('cn-refunded')).toHaveTextContent('Partial refund recorded');
    expect(rowEl).toHaveTextContent('No access was changed.');
  });

  it('the whole order typed out is a full refund: no amount is sent', async () => {
    await showUser();
    const form = await openForm();
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'All back' } });
    fireEvent.change(within(form).getByLabelText(/^Amount returned in yuan/), { target: { value: '39.00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record refund' }));
    await screen.findByTestId('cn-refund-result');
    expect(billing.recordCnRefund).toHaveBeenCalledWith('ord_1', { reason: 'All back', confirmMoneyReturned: true });
  });

  it.each([
    ['not_found', 404, 'No such completed order.'],
    ['order_not_completed', 409, 'This order was never completed, so there is no payment to refund.'],
    ['invalid_request', 422, 'Check the reason and the amount.'],
    // A 500 can mean "recorded, the access not taken back yet": the message never says "nothing changed".
    ['server_error', 500, "We couldn't finish recording the refund. Try again. A refund is never recorded twice."],
  ])('%s (%i) shows its own message and keeps the form', async (code, status, message) => {
    billing.recordCnRefund.mockRejectedValue(apiError(code, status));
    await showUser();
    const form = await openForm();
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'r' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record refund' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByTestId('cn-refund-result')).toBeNull();
    expect(cnRefundErrorKey(apiError(code, status))).toBe(code === 'server_error' ? 'generic' : code);
    // The same button sends again (a record that stopped half way is finished by the next call).
    expect(within(form).getByRole('button', { name: 'Record refund' })).toBeEnabled();
  });

  it('a record that failed half way is finished by trying again: the answer is "already recorded" with what it did', async () => {
    billing.recordCnRefund.mockRejectedValueOnce(apiError('server_error', 500));
    billing.recordCnRefund.mockResolvedValue({ status: 'already_recorded', orderId: 'ord_1', entitlement: 'pass_shortened' });
    await showUser();
    const form = await openForm();
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Refunded in the console' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record refund' }));
    await within(form).findByRole('alert');
    fireEvent.click(within(form).getByRole('button', { name: 'Record refund' }));
    const result = await screen.findByTestId('cn-refund-result');
    expect(result).toHaveTextContent('A refund was already recorded for order RAORDER_1001.');
    expect(result).toHaveTextContent('The pass was shortened by the days this order added.');
    expect(billing.recordCnRefund).toHaveBeenCalledTimes(2);
    expect(billing.recordCnRefund.mock.calls[1]).toEqual(billing.recordCnRefund.mock.calls[0]);
  });

  it('no completed mainland order says so', async () => {
    billing.listCnOrders.mockResolvedValue({ items: [] });
    await showUser();
    expect(await within(orders()).findByText('No completed mainland orders for this person.')).toBeInTheDocument();
  });

  // A record can be written with the access not taken back (the server answers 500 and finishes on the next call).
  // That next call must stay within reach after the form is closed, the user is switched or the page is loaded again.
  describe('"Check the record": a full refund on record with no access taken back', () => {
    it('the row keeps an action that sends the same call with the reason on record, and shows what the record did', async () => {
      billing.listCnOrders.mockResolvedValue({ items: [order({ refunded: 'full' }), order({ id: 'ord_2', outTradeNo: 'GAWX_2002' })] });
      billing.listRefunds.mockResolvedValue({ items: [cnRecord()], cursor: null });
      billing.recordCnRefund.mockResolvedValue({ status: 'already_recorded', orderId: 'ord_1', entitlement: 'pass_ended' });
      await showUser();
      const check = await within(orders()).findByTestId('cn-refund-check');
      expect(orderRow()).toContainElement(check);
      expect(check).toHaveTextContent('No access was taken back for this refund. If the pass or pack is still there, check the record to finish it.');
      expect(within(orderRow()).getByTestId('cn-refunded')).toHaveTextContent('Refund recorded');
      // Nothing is sent by showing it, and no form opens for it.
      expect(billing.recordCnRefund).not.toHaveBeenCalled();
      // The server has taken the access back by the time the lists are read again.
      billing.listRefunds.mockResolvedValue({ items: [cnRecord({ entitlementReversed: true })], cursor: null });
      fireEvent.click(checkButton());
      const result = await screen.findByTestId('cn-refund-result');
      expect(billing.recordCnRefund).toHaveBeenCalledTimes(1);
      expect(billing.recordCnRefund).toHaveBeenCalledWith('ord_1', { reason: 'Refunded in the Alipay console', confirmMoneyReturned: true });
      expect(result).toHaveTextContent('A refund was already recorded for order RAORDER_1001. It is not recorded twice.');
      expect(result).toHaveTextContent('The pass was ended.');
      expect(screen.queryByTestId('cn-refund-form')).toBeNull();
      // Finished: the action goes, the marker and what the record did stay.
      await waitFor(() => expect(within(orders()).queryByTestId('cn-refund-check')).toBeNull());
      expect(within(orderRow()).getByTestId('cn-refunded')).toBeInTheDocument();
      expect(orderRow()).toHaveTextContent('The pass was ended.');
    });

    it.each([
      ['a partial record (it changes no access by design)', order({ refunded: 'partial' }), cnRecord({ full: false, amountMinor: 1950 })],
      ['a full record whose access was taken back', order({ refunded: 'full' }), cnRecord({ entitlementReversed: true })],
      ['an order with no record', order(), cnRecord({ alipayOrderId: 'ord_other' })],
      ['a refund of another kind on the same reference', order({ refunded: 'full' }), cnRecord({ kind: 'refund' })],
    ])('never for %s', async (_name, o, record) => {
      billing.listCnOrders.mockResolvedValue({ items: [o] });
      billing.listRefunds.mockResolvedValue({ items: [record], cursor: null });
      await showUser();
      await waitFor(() => expect(within(orders()).getAllByRole('row')).toHaveLength(2));
      await waitFor(() => expect(within(screen.getByTestId('refund-list')).getAllByRole('row')).toHaveLength(2));
      expect(within(orders()).queryByTestId('cn-refund-check')).toBeNull();
      expect(within(orders()).queryByRole('button', { name: /^Check the refund record/ })).toBeNull();
    });

    it('recorded but not reversed, and the form was closed: the row still finishes it', async () => {
      // The first call writes the record and fails before the access is taken back.
      billing.recordCnRefund.mockImplementationOnce(async () => {
        billing.listCnOrders.mockResolvedValue({ items: [order({ refunded: 'full' })] });
        billing.listRefunds.mockResolvedValue({ items: [cnRecord({ reason: 'Refunded in the console' })], cursor: null });
        throw apiError('server_error', 500);
      });
      billing.recordCnRefund.mockResolvedValue({ status: 'already_recorded', orderId: 'ord_1', entitlement: 'pass_shortened' });
      billing.listCnOrders.mockResolvedValue({ items: [order()] });
      await showUser();
      const form = await openForm();
      fireEvent.click(within(form).getByRole('checkbox'));
      fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Refunded in the console' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Record refund' }));
      await within(form).findByRole('alert');
      // Staff close the form. The order now carries the marker and no "Record refund" button.
      fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('cn-refund-form')).toBeNull();
      await waitFor(() => expect(within(orderRow()).getByTestId('cn-refunded')).toBeInTheDocument());
      expect(within(orders()).queryByRole('button', { name: /^Record refund for order/ })).toBeNull();
      // The second call is still within reach.
      fireEvent.click(await within(orders()).findByRole('button', { name: 'Check the refund record for order RAORDER_1001' }));
      const result = await screen.findByTestId('cn-refund-result');
      expect(result).toHaveTextContent('A refund was already recorded for order RAORDER_1001.');
      expect(result).toHaveTextContent('The pass was shortened by the days this order added.');
      expect(billing.recordCnRefund).toHaveBeenCalledTimes(2);
      expect(billing.recordCnRefund.mock.calls[1]).toEqual(['ord_1', { reason: 'Refunded in the console', confirmMoneyReturned: true }]);
    });

    it('a check that fails says so in the row and can be pressed again', async () => {
      billing.listCnOrders.mockResolvedValue({ items: [order({ refunded: 'full' })] });
      billing.listRefunds.mockResolvedValue({ items: [cnRecord()], cursor: null });
      billing.recordCnRefund.mockRejectedValueOnce(apiError('server_error', 500));
      billing.recordCnRefund.mockResolvedValue({ status: 'already_recorded', orderId: 'ord_1', entitlement: 'none' });
      await showUser();
      fireEvent.click(await within(orders()).findByRole('button', { name: 'Check the refund record for order RAORDER_1001' }));
      expect(await within(orderRow()).findByRole('alert')).toHaveTextContent("We couldn't finish recording the refund. Try again. A refund is never recorded twice.");
      expect(screen.queryByTestId('cn-refund-result')).toBeNull();
      await waitFor(() => expect(checkButton()).toBeEnabled());
      fireEvent.click(checkButton());
      const result = await screen.findByTestId('cn-refund-result');
      // Nothing was left to take back: said as it is, never as a fresh record.
      expect(result).toHaveTextContent('A refund was already recorded for order RAORDER_1001. It is not recorded twice.');
      expect(result).toHaveTextContent('No access was changed.');
      expect(within(orderRow()).queryByRole('alert')).toBeNull();
    });

    it('the order\'s own flag, when the server sends one, is enough; with no reason on the page a fixed one goes out', async () => {
      billing.listCnOrders.mockResolvedValue({ items: [order({ refunded: 'full', reversalPending: true })] });
      // The record itself is on a page of the refunds list that is not loaded.
      billing.listRefunds.mockResolvedValue({ items: [], cursor: null });
      billing.recordCnRefund.mockResolvedValue({ status: 'already_recorded', orderId: 'ord_1', entitlement: 'pack_zeroed' });
      await showUser();
      fireEvent.click(await within(orders()).findByRole('button', { name: 'Check the refund record for order RAORDER_1001' }));
      await screen.findByTestId('cn-refund-result');
      expect(billing.recordCnRefund).toHaveBeenCalledWith('ord_1', { reason: 'Check of an earlier refund record', confirmMoneyReturned: true });
    });
  });
});

describe('AdminCreditsConsole: practice cost (PC-5)', () => {
  const panel = () => screen.findByTestId('practice-cost');
  const cells = (el: HTMLElement, brand: string) => within(el.querySelector(`tr[data-brand="${brand}"]`) as HTMLElement).getAllByRole('cell').map((c) => c.textContent);

  it('shows the average in US dollars with the sample size and the date range, per brand', async () => {
    billing.practiceCost.mockResolvedValue({ brands: { roboapply: cost(), goapply: cost({ sampleSize: 12, averageUsd: 0.41 }) } });
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    await waitFor(() => expect(el.querySelector('tr[data-brand="roboapply"]')).not.toBeNull());
    expect(within(el).getByRole('columnheader', { name: 'Average cost per session (USD)' })).toBeInTheDocument();
    expect(cells(el, 'roboapply')).toEqual(['$0.8421', '50 (the latest 50 at most)', 'Sep 1, 2026 to Oct 10, 2026']);
    expect(cells(el, 'goapply').slice(0, 2)).toEqual(['$0.41', '12 (the latest 50 at most)']);
    expect(within(el).getByRole('rowheader', { name: 'RoboApply' })).toBeInTheDocument();
    expect(within(el).getByRole('rowheader', { name: 'GoApply' })).toBeInTheDocument();
  });

  it('under the minimum it says "not enough sessions" with the count, never an average', async () => {
    billing.practiceCost.mockResolvedValue({ brands: { roboapply: cost({ sampleSize: 9, averageUsd: null, enough: false }), goapply: cost({ sampleSize: 0, averageUsd: null, enough: false, oldest: null, newest: null }) } });
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    await waitFor(() => expect(el.querySelector('tr[data-brand="roboapply"]')).not.toBeNull());
    expect(cells(el, 'roboapply')[0]).toBe('Not enough sessions yet (9 of 10)');
    expect(cells(el, 'goapply')).toEqual(['Not enough sessions yet (0 of 10)', '0 (the latest 50 at most)', '—']);
    expect(el.querySelector('tbody')!.textContent).not.toMatch(/\$/);
  });

  it('the two sizes are the server\'s; a brand it did not answer for is a dash', async () => {
    billing.practiceCost.mockResolvedValue({ brands: { roboapply: cost({ sampleSize: 15, averageUsd: null, enough: false, minSessions: 20, maxSessions: 80 }), goapply: null } });
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    await waitFor(() => expect(el.querySelector('tr[data-brand="roboapply"]')).not.toBeNull());
    expect(cells(el, 'roboapply').slice(0, 2)).toEqual(['Not enough sessions yet (15 of 20)', '15 (the latest 80 at most)']);
    expect(cells(el, 'goapply')).toEqual(['—', '—', '—']);
  });

  it('prints the owner\'s rule for each brand as plain text, with nothing converted', async () => {
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    const rules = within(el).getByTestId('practice-cost-rules');
    expect(rules).toHaveTextContent('RoboApplyAbove $1.00 a session, reprice the 15-pack to $27.99.');
    expect(rules).toHaveTextContent('GoApplyAbove about ¥3.5 a session, move the packs to ¥39 and ¥99.');
    expect(el).toHaveTextContent('The averages above are in US dollars and are not converted.');
    // The rule is there whatever the read says.
    expect(rules.querySelectorAll('li')).toHaveLength(2);
  });

  it('a failed read says so and still shows the rule', async () => {
    billing.practiceCost.mockRejectedValue(apiError('not_found', 404));
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    expect(await within(el).findByRole('alert')).toHaveTextContent("We couldn't load the cost.");
    expect(within(el).getByTestId('practice-cost-rules')).toBeInTheDocument();
  });
});

describe('AdminCreditsConsole: Stripe (ST-3)', () => {
  const panel = () => screen.findByTestId('stripe-health');

  it('a test key that is ready: key mode, usable, the number of webhook secrets, rail ready, no missing events', async () => {
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    await waitFor(() => expect(within(el).getByTestId('stripe-rail')).toHaveTextContent('Ready'));
    expect(el).toHaveAttribute('id', ADMIN_STRIPE_PANEL_ID);
    expect(ADMIN_STRIPE_PANEL_ID).toBe('admin-stripe');
    expect(el).toHaveTextContent('KeyTest key');
    expect(el).toHaveTextContent('Key can be used hereYes');
    expect(el).toHaveTextContent('Webhook signing secrets1');
    expect(el).toHaveTextContent('Webhook endpointhttps://www.example.test/api/v1/roboapply/stripe/webhook');
    expect(within(el).getByTestId('stripe-events-none')).toHaveTextContent('None. The endpoint sends every event the site acts on.');
    expect(el).toHaveTextContent('Plans with a pinned priceNone');
    expect(within(el).queryByTestId('stripe-refused')).toBeNull();
  });

  it('lists the missing events by name', async () => {
    billing.stripeHealth.mockResolvedValue(health({ endpoint: { checked: true, url: 'https://www.example.test/hook', missingEvents: ['charge.refunded', 'charge.dispute.created'], reason: null }, pinnedPlans: ['pro_monthly', 'pro_weekly'] }));
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    const missing = await within(el).findByTestId('stripe-events-missing');
    expect(missing).toHaveTextContent('2 events are missing. Add them to the endpoint in Stripe.');
    expect(within(missing).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['charge.refunded', 'charge.dispute.created']);
    expect(el).toHaveTextContent('Plans with a pinned pricepro_monthly, pro_weekly');
  });

  it('says plainly when a live key is refused outside production', async () => {
    billing.stripeHealth.mockResolvedValue(health({ keyMode: 'live', usable: false, refusedReason: 'live_key_outside_production', webhookSecrets: 0, railReady: false, endpoint: { checked: false, url: null, missingEvents: [], reason: null } }));
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    expect(await within(el).findByTestId('stripe-refused')).toHaveTextContent('A live key is refused outside production, so no card payment or refund can be made here.');
    expect(el).toHaveTextContent('KeyLive key');
    expect(el).toHaveTextContent('Key can be used hereNo');
    expect(within(el).getByTestId('stripe-rail')).toHaveTextContent('Not ready');
    expect(within(el).getByTestId('stripe-events-unchecked')).toHaveTextContent('Could not be checked. There is no key that can be used here.');
  });

  it('no key at all', async () => {
    billing.stripeHealth.mockResolvedValue(health({ keyMode: 'none', usable: false, refusedReason: 'missing', webhookSecrets: 0, railReady: false, endpoint: { checked: false, url: null, missingEvents: [], reason: null } }));
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    expect(await within(el).findByTestId('stripe-refused')).toHaveTextContent('No key is set.');
    expect(el).toHaveTextContent('KeyNo key');
  });

  it.each([
    ['restricted_key', 'Could not be checked. This key is not allowed to read webhook endpoints.'],
    ['error', 'Could not be checked. Stripe did not answer.'],
  ] as const)('renders "could not be checked" with the reason for %s, and never "none missing"', async (reason, text) => {
    billing.stripeHealth.mockResolvedValue(health({ endpoint: { checked: false, url: null, missingEvents: [], reason } }));
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    expect(await within(el).findByTestId('stripe-events-unchecked')).toHaveTextContent(text);
    expect(within(el).queryByTestId('stripe-events-none')).toBeNull();
    // The rail itself can still be ready: a restricted key takes payments, it just cannot read the endpoint.
    expect(within(el).getByTestId('stripe-rail')).toHaveTextContent('Ready');
  });

  it('a usable key whose endpoint was not checked, with no reason given, is never described as "no key"', async () => {
    billing.stripeHealth.mockResolvedValue(health({ endpoint: { checked: false, url: null, missingEvents: [], reason: null } }));
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    const line = await within(el).findByTestId('stripe-events-unchecked');
    expect(line.textContent?.trim()).toBe('Could not be checked.');
    expect(el).toHaveTextContent('Key can be used hereYes');
    expect(el).not.toHaveTextContent('There is no key that can be used here.');
  });

  // The server's own answer when no endpoint in Stripe points at the site (stripeHealth.ts): the check WAS made,
  // every event the site acts on is listed as missing, and the reason says why.
  const NO_ENDPOINT: StripeHealth['endpoint'] = {
    checked: true,
    url: null,
    missingEvents: [
      'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired',
      'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.pending_update_applied',
      'customer.subscription.pending_update_expired', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'charge.refunded', 'charge.dispute.created',
    ],
    reason: 'not_found',
  };

  it('no webhook endpoint at all says so, with the events a new one needs; never "add them to the endpoint"', async () => {
    billing.stripeHealth.mockResolvedValue(health({ endpoint: NO_ENDPOINT }));
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    const none = await within(el).findByTestId('stripe-endpoint-none');
    expect(none).toHaveTextContent('No webhook endpoint in Stripe points at this site. Add one in Stripe.');
    expect(none).toHaveTextContent('The endpoint needs these 14 events:');
    expect(within(none).getAllByRole('listitem')).toHaveLength(14);
    expect(within(none).getAllByRole('listitem')[12]).toHaveTextContent('charge.refunded');
    expect(el).toHaveTextContent('Webhook endpoint—');
    expect(el).not.toHaveTextContent(/events are missing|to the endpoint in Stripe/);
    expect(within(el).queryByTestId('stripe-events-missing')).toBeNull();
    expect(within(el).queryByTestId('stripe-events-unchecked')).toBeNull();
    expect(within(el).queryByTestId('stripe-events-none')).toBeNull();
    // The rail is what the readout says: a key and a secret are set, only the endpoint is not.
    expect(within(el).getByTestId('stripe-rail')).toHaveTextContent('Ready');
  });

  it('"no endpoint" is the same answer if a server ever sends it as an unchecked one', async () => {
    billing.stripeHealth.mockResolvedValue(health({ endpoint: { checked: false, url: null, missingEvents: [], reason: 'not_found' } }));
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    const none = await within(el).findByTestId('stripe-endpoint-none');
    expect(none).toHaveTextContent('No webhook endpoint in Stripe points at this site. Add one in Stripe.');
    // No list was sent, so none is printed.
    expect(within(none).queryAllByRole('listitem')).toHaveLength(0);
    expect(within(el).queryByTestId('stripe-events-unchecked')).toBeNull();
  });

  it('a failed read says so; nothing is claimed about the rail', async () => {
    billing.stripeHealth.mockRejectedValue(apiError('not_found', 404));
    renderUi(<AdminCreditsConsole />);
    const el = await panel();
    expect(await within(el).findByRole('alert')).toHaveTextContent("We couldn't load the Stripe state.");
    expect(within(el).queryByTestId('stripe-rail')).toBeNull();
  });
});

describe('AdminCreditsConsole on the mainland brand', () => {
  it('has no Stripe panel and no card refund form, asks Stripe nothing, and still records mainland refunds', async () => {
    billing.listCnOrders.mockResolvedValue({ items: [{ id: 'ord_1', outTradeNo: 'RAORDER_1001', planKey: 'pro_monthly', channel: 'alipay', amountMinor: 3900, completedAt: '2026-10-01T12:00:00.000Z', refunded: null }] });
    renderUi(<AdminCreditsConsole />, { brand: 'goapply' });
    const panel = await screen.findByTestId('admin-refunds-panel');
    fireEvent.change(within(panel).getByLabelText('User ID'), { target: { value: 'u_cn' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Show' }));
    const cn = await screen.findByTestId('cn-orders');
    // In the mainland brand's own currency the amount reads as its prices do.
    await waitFor(() => expect(cn).toHaveTextContent('¥39'));
    expect(cn).not.toHaveTextContent('CN¥');
    expect(within(cn).getByRole('button', { name: 'Record refund for order RAORDER_1001' })).toBeEnabled();
    expect(screen.queryByTestId('stripe-refund')).toBeNull();
    expect(screen.queryByTestId('stripe-health')).toBeNull();
    expect(billing.stripeHealth).not.toHaveBeenCalled();
    expect(billing.issueRefund).not.toHaveBeenCalled();
    // The quote, the list and the practice cost are the same on both brands.
    expect(screen.getByTestId('refund-facts')).toBeInTheDocument();
    expect(screen.getByTestId('refund-list')).toBeInTheDocument();
    expect(screen.getByTestId('practice-cost')).toBeInTheDocument();
  });
});

