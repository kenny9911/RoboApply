// The pay check page (/pay): what live job posts of the last 90 days state
// about pay for a title. Results (counts and window in words, the 25th–75th
// band and the median per currency, the source line, the honesty line, the
// currencies with too few posts), "not enough" (counts only, a broader check
// offered), the prefill from the active saved search, remote, the form, errors
// and the `jobs.feed` gate. The job page's entry link is tested with the job
// page (components/features/job/job.test.tsx).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({ getPayCheck: vi.fn(), listSearchProfiles: vi.fn() }));
const caps = vi.hoisted(() => ({ flags: { 'jobs.feed': true } as Record<string, unknown> | null, status: 'ready' as string }));
const nav = vi.hoisted(() => ({ replace: [] as string[] }));

vi.mock('../../../lib/api/feed', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/feed')>()),
  getPayCheck: api.getPayCheck,
}));
vi.mock('../../../lib/api/search', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/search')>()),
  listSearchProfiles: api.listSearchProfiles,
}));
vi.mock('../../../lib/flags', () => ({
  useCapabilities: () => ({ flags: caps.flags, brand: null, status: caps.status }),
  useFlag: (k: string) => caps.flags?.[k] === true,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/pay',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: (h: string) => nav.replace.push(h), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
}));

import { RoboApiError } from '../../../lib/api/client';
import type { PayCheckResponse } from '../../../lib/api/contracts/feed';
import { renderWithProviders } from '../../../__tests__/utils/renderWithProviders';
import { PayCheckPage, formatMoney, payCheckHref, payCheckHrefForJob, rangeBar, savedSearchTitle } from './index';

const AS_OF = '2026-11-13T12:00:00.000Z';
const sourced = (value: number, sampleSize: number) => ({ value, source: 'index', sampleSize, asOf: AS_OF, method: 'computed' });

function answer(over: Partial<PayCheckResponse> = {}): PayCheckResponse {
  return {
    status: 'ok',
    title: 'Data Analyst',
    titleMatch: { method: 'role', roleId: 'data_analyst', roleLabel: 'Data analyst', text: 'data analyst' },
    place: { input: 'Austin, TX', kind: 'city', name: 'Austin', country: 'US' },
    window: { days: 90, from: '2026-08-15T12:00:00.000Z', to: AS_OF },
    matchedCount: 412,
    withPayCount: 125,
    capped: false,
    rowCap: 2000,
    period: 'year',
    minSample: 20,
    currencies: [
      { currency: 'USD', sampleSize: 120, p25: sourced(95_000, 120), median: sourced(120_000, 120), p75: sourced(150_000, 120) },
      { currency: 'EUR', sampleSize: 5, p25: null, median: null, p75: null },
    ],
    asOf: AS_OF,
    ...over,
  };
}

const notEnough = (over: Partial<PayCheckResponse> = {}) =>
  answer({
    status: 'not_enough',
    title: 'Senior Data Analyst',
    matchedCount: 31,
    withPayCount: 7,
    currencies: [{ currency: 'USD', sampleSize: 7, p25: null, median: null, p75: null }],
    ...over,
  });

const profiles = (titles: string[] | undefined) => ({
  profiles: [
    {
      id: 'sp1',
      name: '',
      isDefault: true,
      isActive: true,
      version: 2,
      schemaVersion: 1,
      filters: titles ? { titles } : {},
      alertInstantMax: 1,
      alertDigest: null,
      createdAt: AS_OF,
      updatedAt: AS_OF,
    },
  ],
  maxProfiles: 1,
  maxInstantAlerts: 1,
  proMaxProfiles: null,
  upgradable: false,
});

beforeEach(() => {
  api.getPayCheck.mockReset();
  api.listSearchProfiles.mockReset();
  api.getPayCheck.mockResolvedValue(answer());
  api.listSearchProfiles.mockResolvedValue(profiles(undefined));
  caps.flags = { 'jobs.feed': true };
  caps.status = 'ready';
  nav.replace.length = 0;
});

describe('results', () => {
  it('the counts and the window in words, how it matched, the honesty line, and per currency the band, the median and the source', async () => {
    renderWithProviders(<PayCheckPage initialTitle="Data Analyst" initialLocation="Austin, TX" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Pay check' })).toBeInTheDocument();
    const result = await screen.findByTestId('pay-result');
    expect(api.getPayCheck).toHaveBeenCalledWith({ title: 'Data Analyst', location: 'Austin, TX' }, expect.anything());

    expect(within(result).getByRole('heading', { level: 2 })).toHaveTextContent('Stated pay for “Data Analyst”');
    expect(screen.getByTestId('pay-counts')).toHaveTextContent('412 job posts from the last 90 days matched. 125 of them state pay.');
    expect(screen.getByTestId('pay-match')).toHaveTextContent('Matched as the role “Data analyst” and as titles that contain “data analyst”. Location: Austin, United States.');
    expect(screen.getByTestId('pay-honesty')).toHaveTextContent('This is what job posts state about pay, not a prediction of an offer.');

    const ranges = screen.getAllByTestId('pay-range');
    expect(ranges).toHaveLength(1);
    const usd = ranges[0]!;
    expect(within(usd).getByRole('heading', { level: 3 })).toHaveTextContent('USD, a year');
    expect(within(usd).getByText('120 posts state pay in USD')).toBeInTheDocument();
    expect(within(usd).getByTestId('pay-p25')).toHaveTextContent('$95,000');
    expect(within(usd).getByTestId('pay-median')).toHaveTextContent('$120,000');
    expect(within(usd).getByTestId('pay-p75')).toHaveTextContent('$150,000');
    expect(within(usd).getByText('25th percentile')).toBeInTheDocument();
    expect(within(usd).getByText('75th percentile')).toBeInTheDocument();
    expect(usd).toHaveTextContent('Half of these posts state pay between $95,000 and $150,000 a year. The median is $120,000.');
    expect(usd.querySelector('[data-source-note="sourced"]')).toHaveTextContent('Source: jobs listed with us · 120 posts');
    // The bar is a picture of the three figures (decorative; the figures are written out).
    const bar = usd.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(bar.getAttribute('style')).toContain('--band-start');
    expect(bar.getAttribute('style')).toContain('--median-at');

    // A currency with too few posts shows its count only, never a figure.
    expect(screen.getByTestId('pay-few')).toHaveTextContent('EUR: 5 posts state pay, too few to show a range (at least 20 needed).');
    expect(screen.queryByText(/€/)).toBeNull();
    expect(screen.getByText(/shown as a year's pay/)).toBeInTheDocument();
  });

  it('more posts than the cap: says the newest were read', async () => {
    api.getPayCheck.mockResolvedValue(answer({ capped: true, matchedCount: 2000, withPayCount: 900 }));
    renderWithProviders(<PayCheckPage initialTitle="Data Analyst" />);
    expect(await screen.findByTestId('pay-counts')).toHaveTextContent('More than 2,000 job posts from the last 90 days matched, so the newest 2,000 were read. 900 of them state pay.');
  });

  it('a title matched as text, and the other places in words', async () => {
    api.getPayCheck.mockResolvedValue(answer({ titleMatch: { method: 'text', roleId: null, roleLabel: null, text: 'xyzzy wrangler' }, place: null }));
    const view = renderWithProviders(<PayCheckPage initialTitle="Xyzzy Wrangler" />);
    expect(await screen.findByTestId('pay-match')).toHaveTextContent('Matched as titles that contain “xyzzy wrangler”. Any location.');
    view.unmount();
    api.getPayCheck.mockResolvedValue(answer({ place: { input: 'Bay Area', kind: 'text', name: null, country: null } }));
    renderWithProviders(<PayCheckPage initialTitle="Data Analyst" initialLocation="Bay Area" />);
    expect(await screen.findByTestId('pay-match')).toHaveTextContent('Jobs whose location mentions “Bay Area”.');
  });
});

describe('not enough', () => {
  it('counts only, no figure, and a broader check: the role the title names, or no location', async () => {
    api.getPayCheck.mockResolvedValueOnce(notEnough());
    renderWithProviders(<PayCheckPage initialTitle="Senior Data Analyst" initialLocation="Austin, TX" />);
    const block = await screen.findByTestId('pay-not-enough');
    expect(block).toHaveTextContent('Not enough posts state pay for this yet');
    expect(block).toHaveTextContent('A range shows once at least 20 posts in one currency state pay. Try a broader title, or leave the location empty.');
    expect(screen.getByTestId('pay-counts')).toHaveTextContent('31 job posts from the last 90 days matched. 7 of them state pay.');
    expect(screen.getByTestId('pay-few')).toHaveTextContent('USD: 7 posts state pay, too few to show a range (at least 20 needed).');
    expect(screen.queryByTestId('pay-range')).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
    // Still the honesty line.
    expect(screen.getByTestId('pay-honesty')).toBeInTheDocument();

    api.getPayCheck.mockResolvedValueOnce(answer());
    fireEvent.click(within(block).getByRole('button', { name: 'Check without the location' }));
    await waitFor(() => expect(api.getPayCheck).toHaveBeenLastCalledWith({ title: 'Senior Data Analyst' }, expect.anything()));
    expect(nav.replace.at(-1)).toBe('/pay?title=Senior+Data+Analyst');
    expect(await screen.findByTestId('pay-range')).toBeInTheDocument();
  });

  it('offers the role the title names when it is not what was typed', async () => {
    api.getPayCheck.mockResolvedValueOnce(notEnough({ place: null }));
    renderWithProviders(<PayCheckPage initialTitle="Senior Data Analyst" />);
    const block = await screen.findByTestId('pay-not-enough');
    expect(within(block).queryByRole('button', { name: 'Check without the location' })).toBeNull();
    fireEvent.click(within(block).getByRole('button', { name: 'Check “Data analyst”' }));
    await waitFor(() => expect(api.getPayCheck).toHaveBeenLastCalledWith({ title: 'Data analyst' }, expect.anything()));
    expect(screen.getByRole('textbox', { name: 'Job title' })).toHaveValue('Data analyst');
  });

  it('nothing matched: says so, and asks for nothing more', async () => {
    api.getPayCheck.mockResolvedValue(notEnough({ title: 'Xyzzy', matchedCount: 0, withPayCount: 0, currencies: [], titleMatch: { method: 'text', roleId: null, roleLabel: null, text: 'xyzzy' }, place: null }));
    renderWithProviders(<PayCheckPage initialTitle="Xyzzy" />);
    expect(await screen.findByTestId('pay-counts')).toHaveTextContent(/^No job posts from the last 90 days matched\.$/);
    const block = screen.getByTestId('pay-not-enough');
    expect(screen.queryByTestId('pay-few')).toBeNull();
    // No role to offer (the title matched as text) and no location to drop.
    expect(within(block).queryAllByRole('button')).toEqual([]);
  });
});

describe('the title: from the link, else the active saved search', () => {
  it('no link title: the saved search’s first title is filled in and checked at once', async () => {
    api.listSearchProfiles.mockResolvedValue(profiles(['  Product Manager ', 'Program Manager']));
    renderWithProviders(<PayCheckPage />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Job title' })).toHaveValue('Product Manager'));
    expect(screen.getByTestId('pay-prefilled')).toHaveTextContent('Filled in from your saved search.');
    await waitFor(() => expect(api.getPayCheck).toHaveBeenCalledWith({ title: 'Product Manager' }, expect.anything()));
  });

  it('a saved search with no title: nothing is filled in or asked', async () => {
    renderWithProviders(<PayCheckPage />);
    expect(await screen.findByText('Enter a job title to see what job posts state about pay.')).toBeInTheDocument();
    await waitFor(() => expect(api.listSearchProfiles).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: 'Job title' })).toHaveValue('');
    expect(screen.queryByTestId('pay-prefilled')).toBeNull();
    expect(api.getPayCheck).not.toHaveBeenCalled();
  });

  it('the link’s title wins and the saved search is not read', async () => {
    api.listSearchProfiles.mockResolvedValue(profiles(['Product Manager']));
    renderWithProviders(<PayCheckPage initialTitle="Data Analyst" />);
    await screen.findByTestId('pay-result');
    expect(screen.getByRole('textbox', { name: 'Job title' })).toHaveValue('Data Analyst');
    expect(api.listSearchProfiles).not.toHaveBeenCalled();
  });

  it('savedSearchTitle: the first non-blank title, trimmed', () => {
    expect(savedSearchTitle(null)).toBeNull();
    expect(savedSearchTitle({ filters: {} })).toBeNull();
    expect(savedSearchTitle({ filters: { titles: ['  ', ' Barista '] } })).toBe('Barista');
  });
});

describe('the form', () => {
  it('a typed title and place are checked and kept in the address', async () => {
    renderWithProviders(<PayCheckPage />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Job title' }), { target: { value: ' Backend Engineer ' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Location (optional)' }), { target: { value: 'Berlin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check pay' }));
    await waitFor(() => expect(api.getPayCheck).toHaveBeenCalledWith({ title: 'Backend Engineer', location: 'Berlin' }, expect.anything()));
    expect(nav.replace).toEqual(['/pay?title=Backend+Engineer&location=Berlin']);
    expect(await screen.findByTestId('pay-result')).toBeInTheDocument();
  });

  it('"Remote jobs only" asks for remote jobs and sets the location aside; ?location=remote ticks it', async () => {
    api.getPayCheck.mockResolvedValue(answer({ place: { input: 'remote', kind: 'remote', name: null, country: null } }));
    renderWithProviders(<PayCheckPage initialTitle="Data Analyst" initialLocation="remote" />);
    expect(screen.getByRole('checkbox', { name: 'Remote jobs only' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Location (optional)' })).toBeDisabled();
    await waitFor(() => expect(api.getPayCheck).toHaveBeenCalledWith({ title: 'Data Analyst', location: 'remote' }, expect.anything()));
    expect(await screen.findByTestId('pay-match')).toHaveTextContent('Remote jobs only.');
  });

  it('the submit button waits for a title (the one primary button)', () => {
    renderWithProviders(<PayCheckPage />);
    const submit = screen.getByRole('button', { name: 'Check pay' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveClass('primary');
    fireEvent.change(screen.getByRole('textbox', { name: 'Job title' }), { target: { value: 'Nurse' } });
    expect(submit).toBeEnabled();
    expect(document.querySelectorAll('.btn.primary')).toHaveLength(1);
  });
});

describe('errors and the jobs.feed gate', () => {
  it('a failed read says so and offers Try again', async () => {
    api.getPayCheck.mockRejectedValueOnce(new Error('network'));
    renderWithProviders(<PayCheckPage initialTitle="Data Analyst" />);
    expect(await screen.findByText('Pay could not be loaded right now.')).toBeInTheDocument();
    api.getPayCheck.mockResolvedValueOnce(answer());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('pay-result')).toBeInTheDocument();
  });

  it('too many checks: says to wait', async () => {
    api.getPayCheck.mockRejectedValueOnce(new RoboApiError('Too many', { status: 429, payload: { success: false, code: 'rate_limited' } }));
    renderWithProviders(<PayCheckPage initialTitle="Data Analyst" />);
    expect(await screen.findByText('Too many checks in a short time. Try again in a minute.')).toBeInTheDocument();
  });

  it('with the job feed off the page says it is not available and asks for nothing', async () => {
    caps.flags = { 'jobs.feed': false };
    api.listSearchProfiles.mockResolvedValue(profiles(['Product Manager']));
    renderWithProviders(<PayCheckPage initialTitle="Data Analyst" />);
    expect(screen.getByText('Pay check is not available here')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the dashboard' })).toHaveAttribute('href', '/dashboard');
    expect(screen.queryByTestId('pay-form')).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(api.getPayCheck).not.toHaveBeenCalled();
    expect(api.listSearchProfiles).not.toHaveBeenCalled();
  });

  it('while the capabilities load: a loading line, nothing asked', () => {
    caps.flags = null;
    caps.status = 'loading';
    renderWithProviders(<PayCheckPage initialTitle="Data Analyst" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(api.getPayCheck).not.toHaveBeenCalled();
  });
});

describe('pure helpers', () => {
  it('payCheckHref / payCheckHrefForJob', () => {
    expect(payCheckHref({ title: ' Data Analyst ', location: 'Austin, TX' })).toBe('/pay?title=Data+Analyst&location=Austin%2C+TX');
    expect(payCheckHref({ title: 'Data Analyst', location: '  ' })).toBe('/pay?title=Data+Analyst');
    expect(payCheckHref({ title: 'x'.repeat(200) })).toBe(`/pay?title=${'x'.repeat(120)}`);
    expect(payCheckHrefForJob({ title: 'Backend Engineer', location: 'New York, NY', workModel: 'remote' })).toBe('/pay?title=Backend+Engineer&location=remote');
    expect(payCheckHrefForJob({ title: 'Backend Engineer', location: 'New York, NY', workModel: 'hybrid' })).toBe('/pay?title=Backend+Engineer&location=New+York%2C+NY');
    expect(payCheckHrefForJob({ title: 'Backend Engineer', location: null, workModel: null })).toBe('/pay?title=Backend+Engineer');
  });

  it('formatMoney follows the locale and the currency (Intl.NumberFormat)', () => {
    expect(formatMoney(120000, 'USD', 'en')).toBe('$120,000');
    expect(formatMoney(120000, 'EUR', 'de')).toMatch(/^120\.000\s€$/);
    expect(formatMoney(5_000_000, 'JPY', 'ja')).toMatch(/5,000,000/);
    expect(formatMoney(300000, 'CNY', 'zh')).toMatch(/300,000/);
  });

  it('rangeBar: the band and the median inside the bar, with room on both sides', () => {
    const g = rangeBar(95_000, 120_000, 150_000);
    expect(g.start).toBeGreaterThan(0);
    expect(g.end).toBeLessThan(100);
    expect(g.start).toBeLessThan(g.median);
    expect(g.median).toBeLessThan(g.end);
    const flat = rangeBar(80_000, 80_000, 80_000);
    expect(flat.start).toBe(flat.end);
    expect(flat.median).toBe(50);
  });
});
