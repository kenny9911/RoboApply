// WP-21b acceptance — out-of-credits sheet, CreditCostLine, PlanBadge,
// credits view, Taiwan price reference (375 px; lib/api mocked).

import { act, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { atPhoneWidth, checkoutOf, creditsResponse, plansView, railNotReadyPlansView, renderUi, unpricedPlansView } from './fixtures';

const api = vi.hoisted(() => ({ getCredits: vi.fn(), getPlans: vi.fn(), getCreditHistory: vi.fn() }));
const account = vi.hoisted(() => ({ plan: vi.fn() }));
const push = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/api/account', async (orig) => ({ ...(await orig<Record<string, unknown>>()), accountApi: account }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/jobs' }));

import { OutOfCreditsSheet } from '../OutOfCreditsSheet';
import { CreditCostLine } from '../CreditCostLine';
import { PlanBadge } from '../PlanBadge';
import { CreditsUsage } from '../CreditsUsage';
import { PriceReference, PriceReferenceCountry } from '../../market/PriceReference';
import { usePlans } from '../../../../hooks/credits/usePlans';
import { clearCreditsExhausted, reportCreditsExhausted, __outOfCreditsStore } from '../../../../hooks/shared/useCreditGate';

/** Appears once the shared plans query has data (positive control for "hidden" assertions). */
function PlansSettled() {
  const { data } = usePlans();
  return data ? <span data-testid="plans-settled" /> : null;
}

beforeEach(() => {
  atPhoneWidth();
  for (const fn of [...Object.values(api), ...Object.values(account)]) fn.mockReset();
  push.mockReset();
  account.plan.mockResolvedValue({
    region: { market: 'other', currency: 'USD', method: 'stripe', source: 'brand' },
    current: { tier: 'free', status: 'active', amountMinor: null, currency: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, hasStripeCustomer: true, manualRenewal: false },
    credits: { balance: 1, periodAllotment: null, tier: 'free' },
    plans: [],
    stripeConfigured: true,
    alipayConfigured: false,
  });
  api.getCredits.mockResolvedValue(creditsResponse());
  api.getPlans.mockResolvedValue(plansView());
  api.getCreditHistory.mockResolvedValue({ items: [] });
});
afterEach(() => {
  act(() => clearCreditsExhausted());
  vi.useRealTimers();
});

describe('OutOfCreditsSheet', () => {
  it('renders nothing until an action reports exhausted credits', () => {
    renderUi(<OutOfCreditsSheet />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('out-of-credits-options')).toBeNull();
  });

  it('three equal options: Get Pro · Wait until {time} · Continue without it', async () => {
    renderUi(<OutOfCreditsSheet />);
    act(() => reportCreditsExhausted({ bucket: 'tailor', resetsAt: '2026-10-11T07:00:00.000Z', upgradable: true }));
    const options = await screen.findByTestId('out-of-credits-options');
    const items = Array.from(options.children);
    expect(items).toHaveLength(3);
    // Equal weight: same element class for every option, no primary button.
    expect(new Set(items.map((el) => el.className)).size).toBe(1);
    expect(items[0]).toHaveTextContent('Get Pro');
    expect(items[0]).toHaveAttribute('href', '/settings/billing#plans');
    expect(items[1]).toHaveTextContent(/^Wait until/);
    expect(items[2]).toHaveTextContent('Continue without it');
    expect(screen.getByText('Tailored resumes')).toBeInTheDocument();
  });

  it('never blocks: "Continue without it" and "Wait" just close it', async () => {
    renderUi(<OutOfCreditsSheet />);
    act(() => reportCreditsExhausted({ bucket: 'tailor', resetsAt: null, upgradable: true }));
    fireEvent.click(await screen.findByText('Continue without it'));
    expect(__outOfCreditsStore.get()).toBeNull();
    expect(screen.queryByTestId('out-of-credits-options')).toBeNull();
    act(() => reportCreditsExhausted({ bucket: 'tailor', resetsAt: null, upgradable: true }));
    fireEvent.click(await screen.findByText('Wait for the refill'));
    expect(__outOfCreditsStore.get()).toBeNull();
  });

  it('no Get Pro when the server says nothing sellable raises the cap', async () => {
    renderUi(<OutOfCreditsSheet />);
    act(() => reportCreditsExhausted({ bucket: 'cover_letter', resetsAt: null, upgradable: false }));
    const options = await screen.findByTestId('out-of-credits-options');
    expect(options.children).toHaveLength(2);
    expect(screen.queryByText('Get Pro')).toBeNull();
  });

  it('practice: no daily-refill claims; a pack on sale is offered; no "Wait" without a server refill time', async () => {
    renderUi(<OutOfCreditsSheet />);
    act(() => reportCreditsExhausted({ bucket: 'practice', resetsAt: null, upgradable: false }));
    const link = (await screen.findByText('Get practice credits')).closest('a')!;
    expect(link.getAttribute('href')).toBe('/settings/billing?plan=practice_pack_5#plans');
    expect(screen.getByText('You have no practice interviews left')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Today's|refill/i);
    expect(screen.getByTestId('out-of-credits-options').children).toHaveLength(2);
    expect(api.getCredits).not.toHaveBeenCalled();
  });

  it('practice on GoApply with Alipay able to charge: the pack link is offered, as on RoboApply', async () => {
    api.getPlans.mockResolvedValue(
      plansView('goapply', {}, { paymentsOpen: true, checkout: checkoutOf(['alipay']) }),
    );
    renderUi(<OutOfCreditsSheet />, { brand: 'goapply' });
    act(() => reportCreditsExhausted({ bucket: 'practice', resetsAt: null, upgradable: false }));
    const link = (await screen.findByText('Get practice credits')).closest('a')!;
    expect(link.getAttribute('href')).toBe('/settings/billing?plan=practice_pack_5#plans');
  });

  it('practice when payments are not open (no rail can charge, either brand): no pack link, just Continue', async () => {
    api.getPlans.mockResolvedValue(plansView('goapply'));
    renderUi(
      <>
        <OutOfCreditsSheet />
        <PlansSettled />
      </>,
      { brand: 'goapply' },
    );
    act(() => reportCreditsExhausted({ bucket: 'practice', resetsAt: null, upgradable: false }));
    const options = await screen.findByTestId('out-of-credits-options');
    await screen.findByTestId('plans-settled');
    expect(options.children).toHaveLength(1);
    expect(options).toHaveTextContent('Continue without it');
    expect(screen.queryByText('Get practice credits')).toBeNull();
  });

  // M-25: RoboApply's card rail needs its key and a webhook secret. Until both are set the
  // packs list with their amounts and none can be bought, so the sheet offers none.
  it('practice on RoboApply with its card rail not ready: no pack link and no talk of a missing price', async () => {
    api.getPlans.mockResolvedValue(railNotReadyPlansView());
    renderUi(
      <>
        <OutOfCreditsSheet />
        <PlansSettled />
      </>,
    );
    act(() => reportCreditsExhausted({ bucket: 'practice', resetsAt: null, upgradable: false }));
    const options = await screen.findByTestId('out-of-credits-options');
    await screen.findByTestId('plans-settled');
    expect(options.children).toHaveLength(1);
    expect(options).toHaveTextContent('Continue without it');
    expect(screen.queryByText('Get practice credits')).toBeNull();
    expect(document.body.textContent).not.toMatch(/price/i);
  });

  it('practice when the API lists packs with no amount: nothing to offer, nothing invented', async () => {
    api.getPlans.mockResolvedValue({ ...unpricedPlansView(), paymentsOpen: true });
    renderUi(
      <>
        <OutOfCreditsSheet />
        <PlansSettled />
      </>,
    );
    act(() => reportCreditsExhausted({ bucket: 'practice', resetsAt: null, upgradable: true }));
    const options = await screen.findByTestId('out-of-credits-options');
    await screen.findByTestId('plans-settled');
    expect(screen.queryByText('Get practice credits')).toBeNull();
    // The server's own "Pro helps" answer still decides the other option.
    expect(options).toHaveTextContent('Get Pro');
  });

  it('practice with a server refill time offers Wait', async () => {
    api.getPlans.mockResolvedValue(plansView('goapply'));
    renderUi(<OutOfCreditsSheet />, { brand: 'goapply' });
    act(() => reportCreditsExhausted({ bucket: 'practice', resetsAt: '2026-11-01T00:00:00.000Z', upgradable: false }));
    expect(await screen.findByText(/^Wait until/)).toBeInTheDocument();
  });

  it('an unknown window never claims "today"', async () => {
    api.getCredits.mockReturnValue(new Promise(() => {}));
    renderUi(<OutOfCreditsSheet />);
    act(() => reportCreditsExhausted({ bucket: 'tailor', resetsAt: null, upgradable: false }));
    expect(await screen.findByText('Your credits for this are used up')).toBeInTheDocument();
  });
});

describe('CreditCostLine', () => {
  it('reads /credits: "Uses 1 of your N left today"', async () => {
    renderUi(<CreditCostLine bucket="tailor" />);
    expect(await screen.findByText('Uses 1 of your 1 left today')).toBeInTheDocument();
    expect(api.getCredits).toHaveBeenCalledTimes(1);
  });

  it('unknown renders "—", never 0', () => {
    api.getCredits.mockReturnValue(new Promise(() => {}));
    renderUi(<CreditCostLine bucket="tailor" />);
    expect(screen.getByText('Credits left: —')).toBeInTheDocument();
  });

  it('none left: See Pro goes to the plans', async () => {
    const r = creditsResponse();
    r.summary.buckets.tailor = { ...r.summary.buckets.tailor, remaining: 0, used: 2 };
    api.getCredits.mockResolvedValue(r);
    renderUi(<CreditCostLine bucket="tailor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'See Pro' }));
    expect(push).toHaveBeenCalledWith('/settings/billing#plans');
  });
});

describe('PlanBadge', () => {
  it('renders nothing until the summary is known', () => {
    api.getCredits.mockReturnValue(new Promise(() => {}));
    const { container } = renderUi(<PlanBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('Free · See Pro (only when upgradable)', async () => {
    renderUi(<PlanBadge variant="sheet" />);
    const link = await screen.findByRole('link', { name: /Your plan: Free/ });
    expect(link).toHaveAttribute('href', '/settings#billing');
    expect(link).toHaveTextContent('See Pro');
  });

  it('Pro shows the renewal date; GoApply says Member', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', periodEnd: '2026-11-01T00:00:00Z', upgradable: false }));
    const { unmount } = renderUi(<PlanBadge />);
    const link = await screen.findByRole('link', { name: /Your plan: Pro/ });
    // "Renews" is printed because the summary says the plan is not cancelled.
    await waitFor(() => expect(link).toHaveTextContent(/Renews Nov 1/));
    expect(account.plan).not.toHaveBeenCalled();
    expect(link).not.toHaveTextContent('See Pro');
    unmount();
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'pass', periodEnd: '2026-11-01T00:00:00Z', upgradable: false }));
    renderUi(<PlanBadge />, { brand: 'goapply' });
    expect(await screen.findByRole('link', { name: /Your plan: Member/ })).toHaveTextContent(/Until Nov 1/);
  });

  it('after a cancel it says "Until {date}", never "Renews" (from the summary, with no extra request)', async () => {
    api.getCredits.mockResolvedValue(
      creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', periodEnd: '2026-11-01T00:00:00Z', upgradable: false, cancelAtPeriodEnd: true }),
    );
    renderUi(<PlanBadge />);
    const link = await screen.findByRole('link', { name: /Your plan: Pro/ });
    await waitFor(() => expect(link).toHaveTextContent(/Until Nov 1/));
    expect(link).not.toHaveTextContent('Renews');
    expect(account.plan).not.toHaveBeenCalled();
  });

  it('when the summary does not say (an older server), no date is claimed and nothing else is asked', async () => {
    const res = creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', periodEnd: '2026-11-01T00:00:00Z', upgradable: false });
    delete (res.summary as { cancelAtPeriodEnd?: boolean }).cancelAtPeriodEnd;
    api.getCredits.mockResolvedValue(res);
    renderUi(<PlanBadge />);
    const link = await screen.findByRole('link', { name: /Your plan: Pro/ });
    expect(link).not.toHaveTextContent(/Renews|Until/);
    expect(account.plan).not.toHaveBeenCalled();
  });

  it('Free and pass users cost no billing-plan request', async () => {
    renderUi(<PlanBadge />);
    await screen.findByRole('link', { name: /Your plan: Free/ });
    expect(account.plan).not.toHaveBeenCalled();
  });
});

describe('CreditsUsage', () => {
  it('Free caps read "N a day"; Pro caps "Up to N a day"; never unlimited', async () => {
    const { unmount } = renderUi(<CreditsUsage />);
    const tailor = await screen.findByText('Tailored resumes');
    const row = tailor.closest('li')!;
    expect(row).toHaveTextContent('1 of 2 left');
    expect(row).toHaveTextContent('2 a day');
    expect(document.querySelector('[data-bucket="ready_kits"]')).toHaveTextContent('3 a week');
    expect(document.querySelector('[data-bucket="contact_lookup"]')).toBeNull();
    unmount();
    api.getCredits.mockResolvedValue(creditsResponse({ planProfile: 'pro', planKey: 'pro_monthly' }));
    renderUi(<CreditsUsage />);
    await waitFor(() => expect(document.querySelector('[data-bucket="tailor"]')).toHaveTextContent('Up to 50 a day'));
    expect(document.body.textContent?.toLowerCase()).not.toContain('unlimited');
  });

  it('daily rows say which day the refill is: "tomorrow" with the time, in the account\'s time zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T02:00:00.000Z')); // Sunday 10:00 in Shanghai
    const base = creditsResponse({ timezone: 'Asia/Shanghai' });
    const midnight = '2026-10-11T16:00:00.000Z'; // Monday 00:00 in Shanghai
    for (const b of Object.values(base.summary.buckets)) b.resetsAt = midnight;
    base.summary.buckets.ready_kits.resetsAt = '2026-10-18T16:00:00.000Z'; // the Monday after
    api.getCredits.mockResolvedValue(base);
    renderUi(<CreditsUsage />);
    const tailor = (await screen.findByText('Tailored resumes')).closest('li')!;
    expect(tailor).toHaveTextContent('2 a day · Refills tomorrow 12:00 AM');
    // Never a bare weekday on a daily row (it read like a weekly reset).
    expect(tailor.textContent).not.toMatch(/Mon/);
    // A later refill carries its date.
    expect(document.querySelector('[data-bucket="ready_kits"]')).toHaveTextContent('3 a week · Refills Mon, Oct 19, 12:00 AM');
  });

  it('GoApply in Chinese: the day reads "明天", not a bare weekday', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T02:00:00.000Z'));
    const base = creditsResponse({ timezone: 'Asia/Shanghai' });
    for (const b of Object.values(base.summary.buckets)) b.resetsAt = '2026-10-11T16:00:00.000Z';
    api.getCredits.mockResolvedValue(base);
    renderUi(<CreditsUsage />, { brand: 'goapply', locale: 'zh' });
    await waitFor(() => expect(document.querySelector('[data-bucket="tailor"]')).not.toBeNull());
    const meta = document.querySelector('[data-bucket="tailor"]')!.textContent ?? '';
    // The test provider carries the English sentences; `{when}` is the locale's
    // own wording, which the zh bundle wraps as "{when} 重置".
    expect(meta).toMatch(/明天 0?0:00/);
    expect(meta).not.toContain('周一');
  });

  it('recent use lists what the server sends as use, with "N used"', async () => {
    api.getCreditHistory.mockResolvedValue({ items: [{ id: 'l1', bucket: 'tailor', amount: 1, sku: 'ra_tailor_v2', fromSource: 'window', at: '2026-10-10T09:00:00.000Z' }] });
    renderUi(<CreditsUsage />);
    const history = (await screen.findByText('Recent use')).closest('section')!;
    await waitFor(() => expect(history).toHaveTextContent('Tailored resumes'));
    expect(history).toHaveTextContent('1 used');
    expect(history).not.toHaveTextContent('Practice interviews');
  });

  it('recent use is timed in the account\'s time zone, like the refill times above it', async () => {
    // A New York account on a site whose default zone is another one: an
    // action at 11:12 PM on Oct 10 there (03:12 UTC on Oct 11).
    api.getCredits.mockResolvedValue(creditsResponse({ timezone: 'America/New_York' }));
    api.getCreditHistory.mockResolvedValue({ items: [{ id: 'l1', bucket: 'tailor', amount: 1, sku: 'ra_tailor_v2', fromSource: 'window', at: '2026-10-11T03:12:00.000Z' }] });
    renderUi(<CreditsUsage />);
    const history = (await screen.findByText('Recent use')).closest('section')!;
    await waitFor(() => expect(history).toHaveTextContent('Tailored resumes'));
    expect(history).toHaveTextContent('Oct 10, 2026, 11:12 PM');
    expect(history.textContent).not.toMatch(/Oct 11/);
  });

  it('a practice interview shows under recent use with the credits it took', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({}, { balance: 0.25 }));
    api.getCreditHistory.mockResolvedValue({ items: [{ id: 'm1', bucket: 'practice', amount: 0.75, sku: null, fromSource: 'mock_credit', at: '2026-10-10T09:00:00.000Z' }] });
    renderUi(<CreditsUsage />);
    const history = (await screen.findByText('Recent use')).closest('section')!;
    await waitFor(() => expect(history).toHaveTextContent('Practice interviews'));
    // Part of a credit, said as what it counts (not "0.75 used").
    expect(history).toHaveTextContent('0.75 practice credits used');
    expect(history).not.toHaveTextContent('Nothing used yet.');
  });

  it('practice unknown → "—"; history empty state', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({}, null));
    renderUi(<CreditsUsage />);
    await waitFor(() => expect(document.querySelector('[data-bucket="practice"]')).toHaveTextContent('—'));
    expect(await screen.findByText('Nothing used yet.')).toBeInTheDocument();
  });
});

describe('PriceReference (Taiwan, CN L-7)', () => {
  const fresh = () => ({ currency: 'TWD' as const, ratePerUsd: 32, source: 'Bank of Taiwan', asOf: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10), amounts: {} });

  it('renders for zh-TW with a fresh rate', async () => {
    api.getPlans.mockResolvedValue(plansView('roboapply', undefined, { fxReference: fresh() }));
    renderUi(<PriceReference amountMinor={2499} currency="USD" />, { locale: 'zh-TW' });
    const line = await screen.findByTestId('price-reference');
    expect(line).toHaveTextContent('800');
    expect(line).toHaveTextContent('Bank of Taiwan');
  });

  it('renders for a Taiwan visitor in English', async () => {
    api.getPlans.mockResolvedValue(plansView('roboapply', undefined, { fxReference: fresh(), visitor: { country: 'TW' } }));
    renderUi(<PriceReference amountMinor={2499} currency="USD" />);
    expect(await screen.findByTestId('price-reference')).toHaveTextContent(/About NT\$800/);
  });

  // Renders the reference next to a probe that appears once the plans query
  // has data, so "hidden" is asserted only after the data arrived.
  async function renderSettled(ui: ReactElement, opts: Parameters<typeof renderUi>[1] = {}) {
    const r = renderUi(
      <>
        <div data-testid="ref-slot">{ui}</div>
        <PlansSettled />
      </>,
      opts,
    );
    await screen.findByTestId('plans-settled');
    return r;
  }

  it('hidden when the rate is older than 45 days (after the data arrived)', async () => {
    api.getPlans.mockResolvedValue(plansView('roboapply', undefined, { fxReference: { ...fresh(), asOf: '2020-01-01' }, visitor: { country: 'TW' } }));
    await renderSettled(<PriceReference amountMinor={2499} currency="USD" />);
    expect(screen.getByTestId('ref-slot')).toBeEmptyDOMElement();
  });

  it('hidden for a visitor outside Taiwan on an English locale (after the data arrived)', async () => {
    api.getPlans.mockResolvedValue(plansView('roboapply', undefined, { fxReference: fresh(), visitor: { country: 'US' } }));
    await renderSettled(<PriceReference amountMinor={2499} currency="USD" />);
    expect(screen.getByTestId('ref-slot')).toBeEmptyDOMElement();
  });

  it('hidden when there is no rate (after the data arrived)', async () => {
    api.getPlans.mockResolvedValue(plansView('roboapply', undefined, { visitor: { country: 'TW' } }));
    await renderSettled(<PriceReference amountMinor={2499} currency="USD" />);
    expect(screen.getByTestId('ref-slot')).toBeEmptyDOMElement();
  });

  it('a caller-resolved country (edge header) wins over the plans response', async () => {
    api.getPlans.mockResolvedValue(plansView('roboapply', undefined, { fxReference: fresh() }));
    const a = await renderSettled(
      <PriceReferenceCountry country="TW">
        <PriceReference amountMinor={2499} currency="USD" />
      </PriceReferenceCountry>,
    );
    expect(await screen.findByTestId('price-reference')).toHaveTextContent(/About NT\$800/);
    a.unmount();
    api.getPlans.mockResolvedValue(plansView('roboapply', undefined, { fxReference: fresh(), visitor: { country: 'TW' } }));
    await renderSettled(
      <PriceReferenceCountry country="US">
        <PriceReference amountMinor={2499} currency="USD" />
      </PriceReferenceCountry>,
    );
    expect(screen.getByTestId('ref-slot')).toBeEmptyDOMElement();
  });

  it('never renders on GoApply', () => {
    const { container } = renderUi(<PriceReference amountMinor={2499} currency="USD" />, { brand: 'goapply', locale: 'zh-TW' });
    expect(container).toBeEmptyDOMElement();
    expect(api.getPlans).not.toHaveBeenCalled();
  });
});
