// Billing history (ST-10 web; MARKET_STRATEGY §9.2): invoices and receipts a
// page at a time, the payment channel from the row, the refunded marker, and
// a chip per status. The API wrapper is mocked; nothing reaches the network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import type { BillingHistoryResponse, BillingInvoice } from '../../../../lib/api/account';

const account = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock('../../../../lib/api/account', async (orig) => {
  const real = await orig<{ accountApi: Record<string, unknown> }>();
  return { ...real, accountApi: { ...real.accountApi, ...account } };
});

import { BillingHistoryView, invoiceStatusKind } from '../billingHistory';

/** A card invoice exactly as the server has always sent one: eight keys, no `channel`, no `refunded`. */
const invoice = (over: Partial<BillingInvoice> = {}): BillingInvoice => ({
  id: 'in_1',
  kind: 'stripe',
  date: '2026-10-01T12:00:00.000Z',
  amountMinor: 2499,
  currency: 'USD',
  status: 'paid',
  description: 'Pro Monthly',
  downloadable: true,
  ...over,
});
/** A mainland receipt as the server has always sent one. */
const receipt = (over: Partial<BillingInvoice> = {}): BillingInvoice =>
  invoice({ id: 'order_1', kind: 'alipay', date: '2026-09-20T12:00:00.000Z', amountMinor: 3900, currency: 'CNY', description: 'Member 30-day pass', ...over });
const page = (invoices: BillingInvoice[], nextCursor: string | null = null): BillingHistoryResponse => ({ invoices, nextCursor });

const rows = () => screen.getAllByTestId('invoice-row');
const row = (id: string) => rows().find((r) => r.getAttribute('data-invoice') === id)!;
const more = () => screen.queryByRole('button', { name: 'Show more' });

beforeEach(() => {
  account.history.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('BillingHistoryView: paging', () => {
  it('"Show more" loads the next page with the cursor the server sent and disappears at the end', async () => {
    account.history.mockImplementation(async (cursor?: string | null) =>
      cursor === 'cursor-2' ? page([invoice({ id: 'in_3' }), receipt({ id: 'order_4' })]) : page([invoice({ id: 'in_1' }), receipt({ id: 'order_2' })], 'cursor-2'),
    );
    renderWithProviders(<BillingHistoryView />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    // The first page is asked for with no cursor.
    expect(account.history).toHaveBeenCalledTimes(1);
    expect(account.history.mock.calls[0]![0] ?? null).toBeNull();
    fireEvent.click(more()!);
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(account.history).toHaveBeenCalledTimes(2);
    expect(account.history).toHaveBeenLastCalledWith('cursor-2');
    // Rows keep their order: the first page, then the second.
    expect(rows().map((r) => r.getAttribute('data-invoice'))).toEqual(['in_1', 'order_2', 'in_3', 'order_4']);
    expect(more()).toBeNull();
  });

  it('an older server sends no nextCursor: every row it sent and no button', async () => {
    account.history.mockResolvedValue({ invoices: [invoice(), receipt()] } as unknown as BillingHistoryResponse);
    renderWithProviders(<BillingHistoryView />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(more()).toBeNull();
  });

  it('a row that a page boundary repeats is listed once', async () => {
    account.history.mockImplementation(async (cursor?: string | null) => (cursor ? page([invoice({ id: 'in_2' }), invoice({ id: 'in_3' })]) : page([invoice({ id: 'in_1' }), invoice({ id: 'in_2' })], 'c2')));
    renderWithProviders(<BillingHistoryView />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(more()!);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map((r) => r.getAttribute('data-invoice'))).toEqual(['in_1', 'in_2', 'in_3']);
  });

  it('a next page that fails keeps the rows on screen, says so, and the same button asks again', async () => {
    account.history.mockResolvedValueOnce(page([invoice()], 'c2'));
    account.history.mockRejectedValueOnce(new Error('offline'));
    account.history.mockResolvedValue(page([invoice({ id: 'in_9' })]));
    renderWithProviders(<BillingHistoryView />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(more()!);
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load more. Try again.");
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText('Your billing history did not load. Try again.')).toBeNull();
    fireEvent.click(more()!);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(more()).toBeNull();
  });

  it('while the next page loads the button cannot be pressed twice', async () => {
    account.history.mockResolvedValueOnce(page([invoice()], 'c2'));
    account.history.mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<BillingHistoryView />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(more()!);
    const busy = await screen.findByRole('button', { name: 'Loading…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(account.history).toHaveBeenCalledTimes(2);
  });
});

describe('BillingHistoryView: what a row states', () => {
  it('the payment channel comes from the row: card, Alipay, WeChat Pay', async () => {
    account.history.mockResolvedValue(
      page([
        invoice({ id: 'in_card' }),
        receipt({ id: 'order_ali' }),
        // A WeChat Pay order: `kind` stays 'alipay' for old clients, `channel` says how it was paid.
        receipt({ id: 'order_wx', channel: 'wechatpay', description: 'Member week pass' }),
        // The server may also name a channel that the kind already implies.
        invoice({ id: 'in_card_named', channel: 'card' }),
        receipt({ id: 'order_ali_named', channel: 'alipay' }),
      ]),
    );
    renderWithProviders(<BillingHistoryView />);
    await waitFor(() => expect(rows()).toHaveLength(5));
    const channel = (id: string) => within(row(id)).getByTestId('invoice-channel').textContent;
    expect(channel('in_card')).toBe('Card');
    expect(channel('order_ali')).toBe('Alipay');
    expect(channel('order_wx')).toBe('WeChat Pay');
    expect(channel('in_card_named')).toBe('Card');
    expect(channel('order_ali_named')).toBe('Alipay');
  });

  it('each row keeps its own currency', async () => {
    account.history.mockResolvedValue(page([invoice({ id: 'in_usd' }), receipt({ id: 'order_cny' }), invoice({ id: 'in_usd_whole', amountMinor: 1500 })]));
    renderWithProviders(<BillingHistoryView />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(row('in_usd')).toHaveTextContent('$24.99');
    expect(row('order_cny')).toHaveTextContent('¥39');
    expect(row('in_usd_whole')).toHaveTextContent('$15');
  });

  it('a refunded invoice shows the marker; a partly refunded one says so; a row that is not refunded has none', async () => {
    account.history.mockResolvedValue(page([invoice({ id: 'in_full', refunded: 'full' }), invoice({ id: 'in_part', refunded: 'partial' }), invoice({ id: 'in_none' })]));
    renderWithProviders(<BillingHistoryView />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(within(row('in_full')).getByTestId('invoice-refunded')).toHaveTextContent('Refunded');
    expect(within(row('in_part')).getByTestId('invoice-refunded')).toHaveTextContent('Partly refunded');
    expect(within(row('in_none')).queryByTestId('invoice-refunded')).toBeNull();
    // The marker is beside the status, not instead of it: the charge was paid.
    expect(within(row('in_full')).getByTestId('invoice-status')).toHaveTextContent('Paid');
  });

  it('a mainland order recorded as refunded shows the marker and is still downloadable', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    account.history.mockResolvedValue(page([receipt({ id: 'order_refunded', refunded: 'full' })]));
    renderWithProviders(<BillingHistoryView />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    const r = row('order_refunded');
    expect(within(r).getByTestId('invoice-refunded')).toHaveTextContent('Refunded');
    fireEvent.click(within(r).getByRole('button', { name: 'Download' }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(String(opened.mock.calls[0]![0])).toMatch(/\/billing\/invoices\/order_refunded\/download$/);
  });

  it('status chips: paid, open and uncollectible each have words; an unknown status gets the neutral chip, never "Failed"', async () => {
    account.history.mockResolvedValue(
      page([
        invoice({ id: 'in_paid', status: 'paid' }),
        invoice({ id: 'in_open', status: 'open', downloadable: false }),
        invoice({ id: 'in_bad', status: 'uncollectible' }),
        invoice({ id: 'in_new', status: 'some_future_status' }),
        invoice({ id: 'in_blank', status: '' }),
      ]),
    );
    renderWithProviders(<BillingHistoryView />);
    await waitFor(() => expect(rows()).toHaveLength(5));
    const status = (id: string) => within(row(id)).getByTestId('invoice-status');
    expect(status('in_paid')).toHaveTextContent('Paid');
    expect(status('in_open')).toHaveTextContent('Pending');
    expect(status('in_bad')).toHaveTextContent('Not paid');
    expect(status('in_new')).toHaveTextContent('Status not known');
    expect(status('in_blank')).toHaveTextContent('Status not known');
    expect(screen.queryByText('Failed')).toBeNull();
    // The unknown chip is the neutral one; the others carry their own tone. Never colour alone: each has its words.
    expect(status('in_new').style.background).toBe('var(--surface-2)');
    expect(status('in_paid').style.background).toBe('var(--ok-subtle)');
    expect(status('in_open').style.background).toBe('var(--warn-subtle)');
    expect(status('in_bad').style.background).toBe('var(--danger-subtle)');
    // A row that cannot be downloaded has no button.
    expect(within(row('in_open')).queryByRole('button', { name: 'Download' })).toBeNull();
  });

  it('invoiceStatusKind reads the statuses the history lists and nothing else', () => {
    expect(invoiceStatusKind('paid')).toBe('paid');
    expect(invoiceStatusKind('PAID')).toBe('paid');
    expect(invoiceStatusKind('open')).toBe('open');
    expect(invoiceStatusKind('pending')).toBe('open');
    expect(invoiceStatusKind('uncollectible')).toBe('uncollectible');
    for (const s of ['draft', 'void', 'failed', '', null, undefined]) expect(invoiceStatusKind(s), String(s)).toBe('unknown');
  });
});

describe('BillingHistoryView: empty, loading and error', () => {
  it('no invoices says so', async () => {
    account.history.mockResolvedValue(page([]));
    renderWithProviders(<BillingHistoryView />);
    expect(await screen.findByText('No invoices yet.')).toBeInTheDocument();
    expect(more()).toBeNull();
  });

  it('loading, then the list', async () => {
    let answer!: (p: BillingHistoryResponse) => void;
    account.history.mockReturnValue(new Promise<BillingHistoryResponse>((resolve) => (answer = resolve)));
    renderWithProviders(<BillingHistoryView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    answer(page([invoice()]));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByText('Invoices')).toBeInTheDocument();
  });

  it('a first page that does not load says the history did not load', async () => {
    account.history.mockRejectedValue(new Error('offline'));
    renderWithProviders(<BillingHistoryView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your billing history did not load. Try again.');
    expect(screen.queryAllByTestId('invoice-row')).toHaveLength(0);
  });
});
