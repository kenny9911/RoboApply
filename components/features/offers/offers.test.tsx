// WP-64 UI: the offer section in the tracker drawer and the Offers view
// comparison. API calls are mocked at lib/api/offers. Both render nothing with
// the `offers` flag off; AI actions show only with `ai.text` and are labelled.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  listOffers: vi.fn(),
  compareOffers: vi.fn(),
  explainOffers: vi.fn(),
  putOffer: vi.fn(),
  deleteOffer: vi.fn(),
  getOfferBenchmark: vi.fn(),
  createNegotiationDraft: vi.fn(),
}));
vi.mock('../../../lib/api/offers', () => api);

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { RoboApiError } from '../../../lib/api/client';
import type { OfferBenchmark, OfferComparison as Comparison, OfferInput, OfferView } from '../../../lib/api/contracts/offers';
import { OfferComparison, OfferSection } from './index';
import { bodyFrom, defaultCurrency, formFrom } from './shared';

function totals(id: string, o: OfferInput, over: Partial<OfferView['totals']> = {}): OfferView['totals'] {
  const base = o.period === 'month' ? o.base * (o.cn?.salaryMonths ?? 12) : o.period === 'hour' ? o.base * 40 * 52 : o.base;
  const recurring = base + (o.bonusAmount ?? 0);
  return {
    trackerEntryId: id,
    currency: o.currency,
    baseAnnual: base,
    bonusAnnual: o.bonusAmount ?? null,
    housingFundAnnual: null,
    signingBonus: o.signingBonus ?? null,
    recurringAnnual: recurring,
    firstYear: recurring + (o.signingBonus ?? 0),
    excluded: [],
    ...over,
  };
}

function view(id: string, offer: OfferInput, over: Partial<OfferView> = {}): OfferView {
  return { trackerEntryId: id, jobId: null, title: 'Data Analyst', companyName: `Co ${id}`, status: 'offer', offer, totals: totals(id, offer), updatedAt: '2026-10-01T00:00:00.000Z', ...over };
}

const ON = { offers: true, 'ai.text': true } as const;

function apiError(status: number, code: string, details?: Record<string, unknown>) {
  return new RoboApiError('failed', { code, status, payload: { success: false, code, error: 'failed', details } });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listOffers.mockResolvedValue({ aiAvailable: true, items: [] });
});

describe('flag off', () => {
  it('both components render nothing and make no request', () => {
    const { container } = renderWithBrand(
      <>
        <OfferSection trackerEntryId="a" />
        <OfferComparison />
      </>,
      { flags: {} },
    );
    expect(container).toBeEmptyDOMElement();
    expect(api.listOffers).not.toHaveBeenCalled();
  });
});

describe('OfferSection', () => {
  it('adds an offer: validation, then PUT with only the filled fields', async () => {
    api.putOffer.mockResolvedValue(view('a', { base: 120000, currency: 'USD', period: 'year' }));
    renderWithBrand(<OfferSection trackerEntryId="a" />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Add offer details' }));
    const form = screen.getByRole('form', { name: 'Offer details' });
    fireEvent.click(within(form).getByRole('button', { name: 'Save offer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the base pay as a number above 0.');
    fireEvent.change(within(form).getByLabelText('Base pay'), { target: { value: '120,000' } });
    fireEvent.change(within(form).getByLabelText('Signing bonus'), { target: { value: '10000' } });
    fireEvent.change(within(form).getByLabelText('Equity, as the offer says it'), { target: { value: '0.1% over 4 years' } });
    expect(within(form).queryByLabelText('Months of pay a year')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Save offer' }));
    await waitFor(() =>
      expect(api.putOffer).toHaveBeenCalledWith('a', { base: 120000, currency: 'USD', period: 'year', signingBonus: 10000, equity: '0.1% over 4 years' }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('GoApply: monthly by default in CNY, with 薪数, 公积金 and 户口 fields sent under cn', async () => {
    api.putOffer.mockResolvedValue(view('a', { base: 20000, currency: 'CNY', period: 'month' }));
    renderWithBrand(<OfferSection trackerEntryId="a" />, { brand: 'goapply', flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Add offer details' }));
    const form = screen.getByRole('form', { name: 'Offer details' });
    expect((within(form).getByLabelText('Currency') as HTMLInputElement).value).toBe('CNY');
    expect((within(form).getByLabelText('Paid per') as HTMLSelectElement).value).toBe('month');
    fireEvent.change(within(form).getByLabelText('Base pay'), { target: { value: '20000' } });
    fireEvent.change(within(form).getByLabelText('Months of pay a year'), { target: { value: '30' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save offer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Months of pay is a whole number from 12 to 24.');
    fireEvent.change(within(form).getByLabelText('Months of pay a year'), { target: { value: '14' } });
    fireEvent.change(within(form).getByLabelText('Housing fund %'), { target: { value: '12' } });
    fireEvent.change(within(form).getByLabelText('Hukou (residence registration)'), { target: { value: 'yes' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save offer' }));
    await waitFor(() =>
      expect(api.putOffer).toHaveBeenCalledWith('a', { base: 20000, currency: 'CNY', period: 'month', cn: { salaryMonths: 14, housingFundPercent: 12, hukou: true } }),
    );
  });

  it('shows the saved offer with server totals, and posted pay with N on demand', async () => {
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [view('a', { base: 120000, currency: 'USD', period: 'year', signingBonus: 10000 })] });
    const bench: OfferBenchmark = {
      trackerEntryId: 'a',
      postedRange: {
        low: { value: 110000, source: 'index', sampleSize: 24, asOf: '2026-10-10T00:00:00.000Z', method: 'computed' },
        median: { value: 125000, source: 'index', sampleSize: 24, asOf: '2026-10-10T00:00:00.000Z', method: 'computed' },
        high: { value: 140000, source: 'index', sampleSize: 24, asOf: '2026-10-10T00:00:00.000Z', method: 'computed' },
        currency: 'USD',
        period: 'year',
        sampleSize: 24,
        source: 'index',
        asOf: '2026-10-10T00:00:00.000Z',
      },
      totalCount: 60,
      listedCount: 24,
      minSample: 20,
      scope: { title: 'Data Analyst', taxonomyId: null, country: 'US', city: null },
      position: 'within',
      offerBaseInRangePeriod: 120000,
      reason: null,
    };
    api.getOfferBenchmark.mockResolvedValue(bench);
    renderWithBrand(<OfferSection trackerEntryId="a" />, { flags: ON });
    expect(await screen.findByText('$120,000 a year')).toBeInTheDocument();
    expect(screen.getByText('$130,000')).toBeInTheDocument(); // first-year total
    expect(api.getOfferBenchmark).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show posted pay for this role' }));
    expect(await screen.findByText('The middle half of posted pay is $110,000 to $140,000 a year (median $125,000).')).toBeInTheDocument();
    expect(screen.getByText('Your base pay is within that range.')).toBeInTheDocument();
    expect(screen.getByText(/24 posts/)).toBeInTheDocument();
  });

  it('states the conversion when posted pay uses another period than the offer', async () => {
    const monthly = view('a', { base: 20000, currency: 'CNY', period: 'month', cn: { salaryMonths: 13 } });
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [monthly] });
    api.getOfferBenchmark.mockResolvedValue({
      trackerEntryId: 'a',
      postedRange: {
        low: { value: 200000, source: 'index', sampleSize: 30, asOf: '2026-10-10T00:00:00.000Z', method: 'computed' },
        median: { value: 240000, source: 'index', sampleSize: 30, asOf: '2026-10-10T00:00:00.000Z', method: 'computed' },
        high: { value: 300000, source: 'index', sampleSize: 30, asOf: '2026-10-10T00:00:00.000Z', method: 'computed' },
        currency: 'CNY',
        period: 'year',
        sampleSize: 30,
        source: 'index',
        asOf: '2026-10-10T00:00:00.000Z',
      },
      totalCount: 40,
      listedCount: 30,
      minSample: 20,
      scope: { title: 'Data Analyst', taxonomyId: null, country: 'CN', city: null },
      position: 'within',
      offerBaseInRangePeriod: 260000,
      reason: null,
    } satisfies OfferBenchmark);
    renderWithBrand(<OfferSection trackerEntryId="a" />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Show posted pay for this role' }));
    expect(await screen.findByText(/Posted pay is yearly, so your base pay is counted as CN¥260,000 a year/)).toBeInTheDocument();
  });

  it('no conversion note when the periods match', async () => {
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [view('a', { base: 120000, currency: 'USD', period: 'year' })] });
    api.getOfferBenchmark.mockResolvedValue({
      trackerEntryId: 'a',
      postedRange: {
        low: { value: 110000, source: 'index', sampleSize: 24, asOf: '2026-10-10T00:00:00.000Z', method: 'computed' },
        median: { value: 125000, source: 'index', sampleSize: 24, asOf: '2026-10-10T00:00:00.000Z', method: 'computed' },
        high: { value: 140000, source: 'index', sampleSize: 24, asOf: '2026-10-10T00:00:00.000Z', method: 'computed' },
        currency: 'USD',
        period: 'year',
        sampleSize: 24,
        source: 'index',
        asOf: '2026-10-10T00:00:00.000Z',
      },
      totalCount: 60,
      listedCount: 24,
      minSample: 20,
      scope: { title: 'Data Analyst', taxonomyId: null, country: 'US', city: null },
      position: 'within',
      offerBaseInRangePeriod: 120000,
      reason: null,
    } satisfies OfferBenchmark);
    renderWithBrand(<OfferSection trackerEntryId="a" />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Show posted pay for this role' }));
    await screen.findByText('Your base pay is within that range.');
    expect(screen.queryByText(/Posted pay is yearly/)).toBeNull();
  });

  it('says there is not enough posted pay instead of showing a figure', async () => {
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [view('a', { base: 120000, currency: 'USD', period: 'year' })] });
    api.getOfferBenchmark.mockResolvedValue({
      trackerEntryId: 'a',
      postedRange: null,
      totalCount: 8,
      listedCount: 3,
      minSample: 20,
      scope: { title: 'Data Analyst', taxonomyId: null, country: null, city: null },
      position: null,
      offerBaseInRangePeriod: null,
      reason: 'not_enough_data',
    } satisfies OfferBenchmark);
    renderWithBrand(<OfferSection trackerEntryId="a" />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Show posted pay for this role' }));
    expect(await screen.findByText('Not enough posted pay in USD for this role yet (3 of 20 posts needed), so nothing is shown.')).toBeInTheDocument();
  });

  it('removes the offer after a confirmation', async () => {
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [view('a', { base: 1, currency: 'USD', period: 'year' })] });
    api.deleteOffer.mockResolvedValue({ deleted: true });
    const onChange = vi.fn();
    renderWithBrand(<OfferSection trackerEntryId="a" onChange={onChange} />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove offer details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteOffer).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('negotiation draft: AI-labelled text with talking points; mentions other offers when asked', async () => {
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [view('a', { base: 120000, currency: 'USD', period: 'year' }), view('b', { base: 125000, currency: 'USD', period: 'year' })] });
    api.createNegotiationDraft.mockResolvedValue({ text: 'Thank you for the offer.', talkingPoints: ['Ask about base'], aiWritten: true, postedRange: null, position: null });
    renderWithBrand(<OfferSection trackerEntryId="a" />, { flags: ON });
    await screen.findByRole('button', { name: 'Draft a negotiation message' });
    fireEvent.change(screen.getByLabelText('What to ask about'), { target: { value: 'base' } });
    fireEvent.click(screen.getByLabelText('Mention my other offer'));
    fireEvent.click(screen.getByRole('button', { name: 'Draft a negotiation message' }));
    await waitFor(() => expect(api.createNegotiationDraft).toHaveBeenCalledWith('a', { focus: 'base', compareWith: ['b'] }));
    expect(await screen.findByText('Thank you for the offer.')).toBeInTheDocument();
    expect(screen.getByText('AI-written draft. Check every line, then send it yourself.')).toBeInTheDocument();
    expect(screen.getByText('Ask about base')).toBeInTheDocument();
    expect(screen.getByText('There is not enough posted pay for this role, so the draft uses only your own numbers.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
  });

  it('GoApply labels the draft with the AI-generated badge', async () => {
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [view('a', { base: 20000, currency: 'CNY', period: 'month' })] });
    api.createNegotiationDraft.mockResolvedValue({ text: '感谢您的 offer。', talkingPoints: [], aiWritten: true, postedRange: null, position: null });
    renderWithBrand(<OfferSection trackerEntryId="a" />, { brand: 'goapply', flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Draft a negotiation message' }));
    const panel = (await screen.findByText('感谢您的 offer。')).closest('[data-ai-output]') as HTMLElement;
    expect(within(panel).getByText('AI-generated')).toBeInTheDocument();
  });

  it('no AI buttons when the server says AI is off for this user (GoApply without AI consent)', async () => {
    api.listOffers.mockResolvedValue({ aiAvailable: false, items: [view('a', { base: 20000, currency: 'CNY', period: 'month' }), view('b', { base: 21000, currency: 'CNY', period: 'month' })] });
    api.compareOffers.mockResolvedValue({
      offers: [],
      totals: [],
      rows: [],
      annualized: [],
      assumptions: [],
      sameCurrency: true,
      highest: null,
    } satisfies Comparison);
    const first = renderWithBrand(<OfferSection trackerEntryId="a" />, { brand: 'goapply', flags: ON });
    await screen.findByRole('button', { name: 'Edit offer' });
    expect(screen.queryByRole('button', { name: 'Draft a negotiation message' })).toBeNull();
    first.unmount();
    renderWithBrand(<OfferComparison />, { brand: 'goapply', flags: ON });
    await waitFor(() => expect(api.compareOffers).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Explain the differences' })).toBeNull();
    expect(api.createNegotiationDraft).not.toHaveBeenCalled();
    expect(api.explainOffers).not.toHaveBeenCalled();
  });

  it('no AI button without ai.text; plain errors when the AI fails', async () => {
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [view('a', { base: 1, currency: 'USD', period: 'year' })] });
    const first = renderWithBrand(<OfferSection trackerEntryId="a" />, { flags: { offers: true } });
    await screen.findByRole('button', { name: 'Edit offer' });
    expect(screen.queryByRole('button', { name: 'Draft a negotiation message' })).toBeNull();
    first.unmount();

    api.createNegotiationDraft.mockRejectedValueOnce(apiError(429, 'rate_limited')).mockRejectedValueOnce(apiError(503, 'ai_unavailable', { reason: 'ai_unsupported_numbers' }));
    renderWithBrand(<OfferSection trackerEntryId="a" />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Draft a negotiation message' }));
    expect(await screen.findByText("You have reached today's limit for AI drafts. Try again tomorrow.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Draft a negotiation message' }));
    expect(await screen.findByText('We could not write a draft that uses only your own numbers. Try again.')).toBeInTheDocument();
  });
});

describe('OfferComparison', () => {
  const a = view('a', { base: 120000, currency: 'USD', period: 'year', signingBonus: 20000 });
  const b = view('b', { base: 130000, currency: 'USD', period: 'year' });
  const cmp: Comparison = {
    offers: [a, b],
    totals: [a.totals, b.totals],
    rows: [
      { key: 'base', values: [120000, 130000] },
      { key: 'signingBonus', values: [20000, null] },
    ],
    annualized: [
      { trackerEntryId: 'a', value: 120000, currency: 'USD' },
      { trackerEntryId: 'b', value: 130000, currency: 'USD' },
    ],
    assumptions: [{ code: 'pre_tax' }, { code: 'signing_first_year_only', trackerEntryIds: ['a'] }],
    sameCurrency: true,
    highest: { recurringAnnual: ['b'], firstYear: ['a'] },
  };

  it('asks for two offers when there are fewer', async () => {
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [a] });
    renderWithBrand(<OfferComparison />, { flags: ON });
    expect(await screen.findByText(/Add offer details to two or more applications/)).toBeInTheDocument();
    expect(api.compareOffers).not.toHaveBeenCalled();
  });

  it('compares every offer by default: table, totals, Highest, assumptions; explains with an AI label', async () => {
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [a, b] });
    api.compareOffers.mockResolvedValue(cmp);
    api.explainOffers.mockResolvedValue({ text: 'Offer b pays more each year.', aiWritten: true, trackerEntryIds: ['a', 'b'] });
    renderWithBrand(<OfferComparison />, { flags: ON });
    const table = await screen.findByRole('table');
    expect(api.compareOffers).toHaveBeenCalledWith({ trackerEntryIds: ['a', 'b'] });
    expect(within(table).getByText('$120,000 a year')).toBeInTheDocument();
    expect(within(table).getByText('—')).toBeInTheDocument();
    const yearly = within(table).getByRole('row', { name: /Yearly total/ });
    expect(within(yearly).getByText('Highest')).toBeInTheDocument();
    expect(within(within(table).getByRole('row', { name: /First-year total/ })).getByText('$140,000')).toBeInTheDocument();
    expect(screen.getByText('All amounts are before tax.')).toBeInTheDocument();
    expect(screen.getByText(/Signing bonuses count in the first year only\. \(Applies to: Co a\.\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explain the differences' }));
    expect(await screen.findByText('Offer b pays more each year.')).toBeInTheDocument();
    expect(screen.getByText('AI-written explanation, based only on the numbers above.')).toBeInTheDocument();
  });

  it('different currencies: no Highest, and says amounts are not converted', async () => {
    const c = view('c', { base: 3000000, currency: 'TWD', period: 'year' });
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [a, c] });
    api.compareOffers.mockResolvedValue({ ...cmp, offers: [a, c], totals: [a.totals, c.totals], sameCurrency: false, highest: null, rows: [{ key: 'base', values: [120000, 3000000] }] });
    renderWithBrand(<OfferComparison />, { flags: ON });
    await screen.findByRole('table');
    expect(screen.getByText('These offers use different currencies. Amounts are not converted, so totals are not ranked.')).toBeInTheDocument();
    expect(screen.queryByText('Highest')).toBeNull();
  });

  it('with more than two offers the user picks which to compare (at least two)', async () => {
    const c = view('c', { base: 1, currency: 'USD', period: 'year' });
    api.listOffers.mockResolvedValue({ aiAvailable: true, items: [a, b, c] });
    api.compareOffers.mockResolvedValue(cmp);
    renderWithBrand(<OfferComparison />, { flags: ON });
    await screen.findByRole('group', { name: 'Offers to compare (up to 5)' });
    await waitFor(() => expect(api.compareOffers).toHaveBeenCalledWith({ trackerEntryIds: ['a', 'b', 'c'] }));
    fireEvent.click(screen.getByLabelText('Co c'));
    await waitFor(() => expect(api.compareOffers).toHaveBeenCalledWith({ trackerEntryIds: ['a', 'b'] }));
    fireEvent.click(screen.getByLabelText('Co b'));
    expect(await screen.findByText('Pick at least two offers to compare.')).toBeInTheDocument();
  });
});

describe('form helpers', () => {
  it('defaults by market and locale', () => {
    expect(defaultCurrency('cn', 'zh')).toBe('CNY');
    expect(defaultCurrency('intl', 'zh-TW')).toBe('TWD');
    expect(defaultCurrency('intl', 'en')).toBe('USD');
    expect(formFrom(null, { market: 'cn', currency: 'CNY' })).toMatchObject({ period: 'month', currency: 'CNY', base: '', hukou: '' });
  });

  it('round-trips an offer and rejects bad numbers', () => {
    const offer: OfferInput = { base: 50, currency: 'USD', period: 'hour', hoursPerWeek: 30, bonus: '10%', bonusAmount: 2000, startDate: '2026-11-01' };
    const f = formFrom(offer, { market: 'intl', currency: 'USD' });
    expect(bodyFrom(f, 'intl')).toEqual({ body: offer });
    expect(bodyFrom({ ...f, currency: 'US' }, 'intl')).toEqual({ error: 'currency' });
    expect(bodyFrom({ ...f, bonusAmount: 'lots' }, 'intl')).toEqual({ error: 'number' });
    expect(bodyFrom({ ...f, hoursPerWeek: '100' }, 'intl')).toEqual({ error: 'hours' });
    expect(bodyFrom({ ...f, housingFundPercent: '20' }, 'intl')).toEqual({ body: offer }); // cn fields ignored on intl
    expect(bodyFrom({ ...f, period: 'month', housingFundPercent: '20' }, 'cn')).toEqual({ error: 'housing_fund_percent' });
  });
});
