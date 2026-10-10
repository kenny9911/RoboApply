// WP-58 — /campus calendar UI (lib/api mocked; auth from the auth mock).
// Every entry shows its source, the official link and the last check;
// "待核实" after 14 days; unknown dates render "Not listed"; the reminder
// button sits inside SubscribeOnTap; nothing applies for the user (D1).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { buildAuthValue, mockAuthState } from '../../../../__tests__/utils/mockAuth';
import type { CampusEventView } from '../../../../lib/api/contracts/cn/campus';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn(), back: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/campus',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));
const subscribeOnTap = vi.hoisted(() => vi.fn());
vi.mock('../../notify-cn', () => ({
  SubscribeOnTap: ({ template, children }: { template: string; children: unknown }) => {
    subscribeOnTap(template);
    return <div data-testid="subscribe-on-tap">{children as never}</div>;
  },
}));
const api = vi.hoisted(() => ({
  listPublicCampusEvents: vi.fn(),
  listCampusSubscriptions: vi.fn(),
  subscribeCampus: vi.fn(),
  unsubscribeCampus: vi.fn(),
  getPublicCampusCompany: vi.fn(),
}));
vi.mock('../../../../lib/api/campus', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));

import { CampusCalendar, CampusCompany } from '..';
import { fromBeijingLocal, splitList, toBeijingLocal, windowState, yearOfClass } from '../format';

const EVENT: CampusEventView = {
  id: 'ev_1',
  companyName: '示例科技',
  companySlug: '示例科技',
  title: '2027届校园招聘',
  graduationClass: '2027届',
  kind: 'application',
  applyOpensAt: '2026-08-31T16:00:00.000Z',
  applyClosesAt: '2099-10-31T15:59:00.000Z',
  stages: [{ kind: 'bishi', startsAt: '2099-11-04T16:00:00.000Z' }],
  cities: ['北京', '上海'],
  roles: [],
  officialUrl: 'https://campus.example.cn/2027',
  sourceUrl: null,
  sourceName: '示例科技校园招聘官网',
  verifiedAt: '2026-10-08T00:00:00.000Z',
  needsReverify: false,
  subscribed: false,
};
const STALE: CampusEventView = { ...EVENT, id: 'ev_2', title: '2027届暑期实习', applyClosesAt: null, applyOpensAt: null, needsReverify: true, sourceName: null };
const LIST = { items: [EVENT, STALE], cursor: null, asOf: '2026-10-10T00:00:00.000Z' };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  router.replace.mockReset();
  subscribeOnTap.mockReset();
  mockAuthState.value = buildAuthValue();
  api.listPublicCampusEvents.mockResolvedValue(LIST);
  api.listCampusSubscriptions.mockResolvedValue({ items: [] });
  api.subscribeCampus.mockResolvedValue({ id: 'sub_1', kind: 'event', eventId: 'ev_1', companyName: null, graduationClass: null, channel: 'in_app', createdAt: '', event: null });
  api.unsubscribeCampus.mockResolvedValue({ id: 'sub_1' });
});

describe('/campus calendar', () => {
  it('server-rendered entries show source, official link and last check; no fetch needed', () => {
    renderWithBrand(<CampusCalendar initial={LIST} />, { brand: 'goapply' });
    expect(screen.getByRole('heading', { name: 'Campus recruitment calendar' })).toBeInTheDocument();
    const card = screen.getByRole('article', { name: '2027届校园招聘' });
    expect(within(card).getByText('Source: 示例科技校园招聘官网')).toBeInTheDocument();
    const official = within(card).getByRole('link', { name: /Official page of 示例科技/ });
    expect(official).toHaveAttribute('href', 'https://campus.example.cn/2027');
    expect(official).toHaveAttribute('target', '_blank');
    expect(within(card).getByText(/^Last checked /)).toBeInTheDocument();
    expect(within(card).getByText(/Beijing time/)).toBeInTheDocument();
    expect(within(card).getByText('Written test', { exact: false })).toBeInTheDocument();
    expect(api.listPublicCampusEvents).not.toHaveBeenCalled();
  });

  it('unknown facts render "Not listed"; a stale entry says it needs a re-check and names its host', () => {
    renderWithBrand(<CampusCalendar initial={LIST} />, { brand: 'goapply' });
    const card = screen.getByRole('article', { name: '2027届暑期实习' });
    expect(within(card).getByText('Close date not listed')).toBeInTheDocument();
    expect(within(card).getAllByText('Not listed').length).toBeGreaterThan(0);
    expect(within(card).getByText('Needs re-check')).toBeInTheDocument();
    expect(within(card).getByText('Source: campus.example.cn')).toBeInTheDocument();
    // No close date → no reminder to offer.
    expect(within(card).getByText('No close date to remind you about')).toBeInTheDocument();
  });

  it('details read from another page: the source name links to that page, the official link stays', () => {
    const CITED: CampusEventView = { ...EVENT, sourceUrl: 'https://www.example.edu.cn/career/2027-campus', sourceName: '某大学就业网' };
    renderWithBrand(<CampusCalendar initial={{ ...LIST, items: [CITED] }} />, { brand: 'goapply' });
    const card = screen.getByRole('article', { name: '2027届校园招聘' });
    const cited = within(card).getByRole('link', { name: /Source page: 某大学就业网/ });
    expect(cited).toHaveAttribute('href', 'https://www.example.edu.cn/career/2027-campus');
    expect(cited).toHaveAttribute('target', '_blank');
    expect(cited).toHaveTextContent('某大学就业网');
    expect(within(card).getByRole('link', { name: /Official page of 示例科技/ })).toHaveAttribute('href', 'https://campus.example.cn/2027');
    // Without a sourceUrl the name is plain text (the first test).
    expect(within(card).queryByText('Source: 示例科技校园招聘官网')).toBeNull();
  });

  it('D1: the only apply action opens the official page; no copy says we apply', () => {
    const { container } = renderWithBrand(<CampusCalendar initial={LIST} />, { brand: 'goapply' });
    const apply = screen.getAllByRole('link', { name: /Apply on 示例科技's site/ })[0]!;
    expect(apply).toHaveAttribute('href', 'https://campus.example.cn/2027');
    expect(container.textContent).not.toMatch(/apply for you|auto-?apply|submit/i);
  });

  it('signed out: the reminder asks to sign in and comes back to /campus', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    renderWithBrand(<CampusCalendar initial={LIST} />, { brand: 'goapply' });
    const link = screen.getByRole('link', { name: 'Sign in for deadline reminders' });
    expect(link).toHaveAttribute('href', '/login?from=campus&next=%2Fcampus');
    expect(api.listCampusSubscriptions).not.toHaveBeenCalled();
  });

  it('signed in: 截止提醒 is wrapped in SubscribeOnTap and saves a reminder', async () => {
    renderWithBrand(<CampusCalendar initial={LIST} />, { brand: 'goapply' });
    const card = screen.getByRole('article', { name: '2027届校园招聘' });
    const btn = await within(card).findByRole('button', { name: 'Deadline reminder' });
    expect(btn.closest('[data-testid="subscribe-on-tap"]')).not.toBeNull();
    expect(subscribeOnTap).toHaveBeenCalledWith('deadline_reminder');
    expect(within(card).getByText('Reminders go out 3 days and 1 day before applications close.')).toBeInTheDocument();
    api.listCampusSubscriptions.mockResolvedValue({ items: [{ id: 'sub_1', kind: 'event', eventId: 'ev_1', companyName: null, graduationClass: null, channel: 'in_app', createdAt: '', event: null }] });
    fireEvent.click(btn);
    await waitFor(() => expect(api.subscribeCampus).toHaveBeenCalledWith({ kind: 'event', eventId: 'ev_1', channel: 'in_app' }));
    const on = await within(card).findByRole('button', { name: 'Reminder on' });
    expect(on).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(on);
    await waitFor(() => expect(api.unsubscribeCampus).toHaveBeenCalledWith('sub_1'));
  });

  it('filters go into the URL and the list query', async () => {
    renderWithBrand(<CampusCalendar initial={LIST} />, { brand: 'goapply' });
    fireEvent.change(screen.getByLabelText('Graduating class'), { target: { value: '2027' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: '上海' } });
    fireEvent.click(screen.getByLabelText('Taking applications now'));
    fireEvent.click(screen.getByRole('button', { name: 'Show programmes' }));
    expect(router.replace).toHaveBeenCalledWith(`/campus?class=2027&city=${encodeURIComponent('上海')}&openNow=true`, { scroll: false });
    await waitFor(() => expect(api.listPublicCampusEvents).toHaveBeenCalledWith({ class: 2027, city: '上海', openNow: 'true' }, expect.anything()));
  });

  it('empty and error states', async () => {
    api.listPublicCampusEvents.mockResolvedValueOnce({ items: [], cursor: null, asOf: '' });
    renderWithBrand(<CampusCalendar />, { brand: 'goapply' });
    expect(await screen.findByText('No programmes match these filters.')).toBeInTheDocument();
  });
});

describe('/campus/[company]', () => {
  it('lists the company programmes and follows it for a class', async () => {
    api.subscribeCampus.mockResolvedValue({ id: 'sub_9', kind: 'company', eventId: null, companyName: '示例科技', graduationClass: '2027届', channel: 'in_app', createdAt: '', event: null });
    renderWithBrand(<CampusCompany slug="示例科技" initial={{ ...LIST, companyName: '示例科技', companySlug: '示例科技' }} />, { brand: 'goapply' });
    expect(screen.getByRole('heading', { name: '示例科技 campus programmes' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All programmes/ })).toHaveAttribute('href', '/campus');
    fireEvent.change(screen.getByLabelText('Your graduating class'), { target: { value: '2028' } });
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    await waitFor(() => expect(api.subscribeCampus).toHaveBeenCalledWith({ kind: 'company', companyName: '示例科技', graduationClass: '2028届', channel: 'in_app' }));
  });
});

describe('format helpers', () => {
  it('window state, class year, Beijing local time, list split', () => {
    const now = new Date('2026-10-10T00:00:00.000Z');
    expect(windowState({ applyOpensAt: null, applyClosesAt: '2026-10-11T00:00:00.000Z' }, now)).toBe('open');
    expect(windowState({ applyOpensAt: '2026-10-20T00:00:00.000Z', applyClosesAt: '2026-10-30T00:00:00.000Z' }, now)).toBe('not_yet');
    expect(windowState({ applyOpensAt: null, applyClosesAt: '2026-10-01T00:00:00.000Z' }, now)).toBe('closed');
    expect(windowState({ applyOpensAt: null, applyClosesAt: null }, now)).toBe('unknown');
    expect(yearOfClass('2027届')).toBe(2027);
    expect(toBeijingLocal('2026-10-31T15:59:00.000Z')).toBe('2026-10-31T23:59');
    expect(fromBeijingLocal('2026-10-31T23:59')).toBe('2026-10-31T15:59:00.000Z');
    expect(fromBeijingLocal('')).toBeUndefined();
    expect(splitList('北京、上海, 深圳，北京')).toEqual(['北京', '上海', '深圳']);
  });
});
