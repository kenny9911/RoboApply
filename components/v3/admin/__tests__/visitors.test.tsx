// /admin/visitors (visitor conversion): the steps from first visit to account,
// what the report leaves out of them, the breakdowns, the visitor list and the
// state while the visitor table is not in the database. API wrappers are
// mocked; nothing reaches the network.

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { buildAuthValue, buildFakeUser, mockAuthState } from '../../../../__tests__/utils/mockAuth';

vi.mock('../../../../lib/auth/AuthProvider', () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children, useAuth: () => mockAuthState.value }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/visitors', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const api = vi.hoisted(() => ({ getVisitorsReport: vi.fn(), listVisitors: vi.fn() }));
vi.mock('../../../../lib/api/admin', async (orig) => {
  const real = await orig<typeof import('../../../../lib/api/admin')>();
  return { ...real, adminConsoleApi: { ...real.adminConsoleApi, ...api } };
});

import { VisitorsConsole, conversionRate, groupDays, stepRate } from '../VisitorsConsole';
import { ADMIN_AREAS, currentAdminArea } from '../AdminNav';
import type { VisitorView, VisitorsReportResponse } from '../../../../lib/api/admin';
import { VISITOR_CHANNEL_IDS, VISITOR_STATUSES } from '../../../../server/src/features/admin/contract';
import { SIGNUP_METHODS, VISITOR_DEVICES } from '../../../../server/src/features/growth/visitors';
import en from '../../../../i18n/messages/en.json';

const admin = () => buildAuthValue({ user: { ...buildFakeUser(), role: 'admin' } as never });

const report = (over: Partial<VisitorsReportResponse> = {}): VisitorsReportResponse => ({
  ready: true,
  from: '2026-10-12T00:00:00.000Z',
  to: '2026-11-11T00:00:00.000Z',
  tz: 'UTC',
  funnel: { visitors: 1200, signupViewed: 300, signupStarted: 150, signedUp: 90, onboarded: 45 },
  knownUsers: 80,
  pageViews: 5400,
  medianSecondsToSignup: 420,
  untrackedVisits: 210,
  newAccounts: 104,
  daily: [
    { day: '2026-11-08', visitors: 400, signupViewed: 100, signupStarted: 50, signedUp: 30, onboarded: 15 },
    { day: '2026-11-09', visitors: 0, signupViewed: 0, signupStarted: 0, signedUp: 0, onboarded: 0 },
    { day: '2026-11-10', visitors: 800, signupViewed: 200, signupStarted: 100, signedUp: 60, onboarded: 30 },
  ],
  channels: [{ key: 'search', visitors: 700, signedUp: 63 }, { key: 'direct', visitors: 500, signedUp: 27 }],
  sources: [{ key: 'google.com', visitors: 650, signedUp: 60 }, { key: null, visitors: 500, signedUp: 27 }],
  landingPages: [{ key: '/', visitors: 900, signedUp: 70 }, { key: '/pricing', visitors: 300, signedUp: 20 }],
  countries: [{ key: 'US', visitors: 800, signedUp: 60 }, { key: null, visitors: 400, signedUp: 30 }],
  devices: [{ key: 'desktop', visitors: 700, signedUp: 70 }, { key: 'mobile', visitors: 500, signedUp: 20 }],
  methods: [{ key: 'google', visitors: 100, signedUp: 70 }, { key: 'email', visitors: 50, signedUp: 20 }],
  ...over,
});

const visitor = (over: Partial<VisitorView> = {}): VisitorView => ({
  id: 'v1',
  brand: 'roboapply',
  status: 'signed_up',
  firstSeenAt: '2026-11-10T08:00:00.000Z',
  lastSeenAt: '2026-11-10T09:00:00.000Z',
  channel: 'search',
  source: 'google.com',
  campaign: null,
  landingPath: '/pricing',
  country: 'US',
  device: 'mobile',
  locale: 'en',
  pageViews: 6,
  visits: 2,
  signupFrom: 'pricing',
  signupMethod: 'google',
  signupViewedAt: '2026-11-10T08:10:00.000Z',
  signupStartedAt: '2026-11-10T08:11:00.000Z',
  signedUpAt: '2026-11-10T08:12:00.000Z',
  user: { id: 'u9', email: 'ada@example.com', name: 'Ada Lovelace' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthState.value = admin();
  api.getVisitorsReport.mockResolvedValue(report());
  api.listVisitors.mockResolvedValue({ ready: true, items: [visitor()], cursor: null });
});

describe('rates', () => {
  it('a rate needs something to divide by', () => {
    expect(conversionRate(90, 1200)).toBeCloseTo(7.5);
    expect(conversionRate(0, 1200)).toBe(0);
    expect(conversionRate(5, 0)).toBeNull();
    const f = report().funnel;
    expect(stepRate(f, 'visitors')).toBeNull();
    expect(stepRate(f, 'signupViewed')).toBeCloseTo(25);
    expect(stepRate(f, 'signedUp')).toBeCloseTo(60);
    expect(stepRate({ ...f, signedUp: 0 }, 'onboarded')).toBeNull();
  });

  it('long periods are drawn as runs of days that keep every visitor', () => {
    const daily = Array.from({ length: 200 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      visitors: 2,
      signupViewed: 0,
      signupStarted: 0,
      signedUp: 1,
      onboarded: 0,
    }));
    const columns = groupDays(daily, 62);
    expect(columns.length).toBeLessThanOrEqual(62);
    expect(columns.reduce((n, c) => n + c.visitors, 0)).toBe(400);
    expect(columns.reduce((n, c) => n + c.signedUp, 0)).toBe(200);
    expect(columns[0]).toMatchObject({ from: '2026-01-01', to: '2026-01-04', visitors: 8 });
    expect(groupDays(daily.slice(0, 30), 62)).toHaveLength(30);
    expect(groupDays([], 62)).toEqual([]);
  });
});

describe('copy and navigation', () => {
  const copy = en.admin.console.visitors;

  it('is an admin area of both brands with its own nav entry', () => {
    const area = ADMIN_AREAS.find((a) => a.id === 'visitors');
    expect(area).toMatchObject({ href: '/admin/visitors' });
    expect(area?.brands).toBeUndefined();
    expect(currentAdminArea('/admin/visitors', ADMIN_AREAS)?.id).toBe('visitors');
    expect(en.admin.console.nav.visitors).toMatchObject({ title: expect.any(String), sub: expect.any(String) });
  });

  it('names every channel, device, sign-up method and stage the server can answer', () => {
    for (const id of VISITOR_CHANNEL_IDS) expect(copy.channel, id).toHaveProperty(id);
    for (const id of VISITOR_DEVICES) expect(copy.device, id).toHaveProperty(id);
    for (const id of SIGNUP_METHODS) expect(copy.method, id).toHaveProperty(id);
    for (const id of VISITOR_STATUSES) expect(copy.status, id).toHaveProperty(id);
  });
});

describe('VisitorsConsole', () => {
  it('is for admins only', () => {
    mockAuthState.value = buildAuthValue({ user: { ...buildFakeUser(), role: 'user' } as never });
    renderWithBrand(<VisitorsConsole />);
    expect(screen.queryByRole('heading', { name: 'Visitors and sign-ups' })).toBeNull();
    expect(api.getVisitorsReport).not.toHaveBeenCalled();
  });

  it('shows the steps from first visit to account with counts and rates', async () => {
    renderWithBrand(<VisitorsConsole />);
    const steps = await screen.findByRole('region', { name: 'From first visit to account' });
    const rows = within(steps).getAllByRole('listitem').slice(0, 5);
    expect(rows.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^Visited the site1,200100\.0% of visitors$/),
      expect.stringMatching(/^Opened sign-up or sign-in30025\.0% of visitors · 25\.0% of the step before$/),
      expect.stringMatching(/^Started signing up15012\.5% of visitors · 50\.0% of the step before$/),
      expect.stringMatching(/^Created an account907\.5% of visitors · 60\.0% of the step before$/),
      expect.stringMatching(/^Finished setup453\.8% of visitors · 50\.0% of the step before$/),
    ]);
    // The headline numbers.
    const kpis = screen.getByLabelText('Visitors and sign-ups', { selector: 'dl' });
    expect(kpis).toHaveTextContent('New visitors1,2005,400 pages viewed');
    expect(kpis).toHaveTextContent('Visitor to account7.5%90 of 1,200 visitors');
    expect(kpis).toHaveTextContent('Finished setup4550.0% of the new accounts');
  });

  it('says in words what the steps leave out: existing users, visits without a record, and all accounts created', async () => {
    renderWithBrand(<VisitorsConsole />);
    const steps = await screen.findByRole('region', { name: 'From first visit to account' });
    expect(steps).toHaveTextContent('Half of the people who signed up did so within 7 minutes of their first visit.');
    expect(steps).toHaveTextContent('104 accounts were created in this period in total, counting any that no visitor record matches.');
    expect(steps).toHaveTextContent('80 more visitors already had an account when first seen here and are not counted above.');
    expect(steps).toHaveTextContent('210 page loads were counted without a visitor record');
  });

  it('asks for the last 30 days in the viewer’s time zone, and for one site when it is chosen', async () => {
    renderWithBrand(<VisitorsConsole />);
    await screen.findByRole('region', { name: 'From first visit to account' });
    const first = api.getVisitorsReport.mock.calls[0]![0];
    expect(first).toMatchObject({ tz: expect.any(String), from: expect.any(String), to: expect.any(String) });
    expect(first).not.toHaveProperty('brand');
    const days = (Date.parse(first.to) - Date.parse(first.from)) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    fireEvent.change(screen.getByLabelText('Site'), { target: { value: 'goapply' } });
    await waitFor(() => expect(api.getVisitorsReport).toHaveBeenLastCalledWith(expect.objectContaining({ brand: 'goapply' })));
    await waitFor(() => expect(api.listVisitors).toHaveBeenLastCalledWith(expect.objectContaining({ brand: 'goapply' })));
  });

  it('breaks the visitors down by channel, source, first page, country, device and sign-up method', async () => {
    renderWithBrand(<VisitorsConsole />);
    const channels = await screen.findByRole('region', { name: 'How they arrived' });
    expect(within(channels).getByRole('row', { name: /Search/ })).toHaveTextContent('Search700639.0%');
    const sources = screen.getByRole('region', { name: 'Where they came from' });
    expect(within(sources).getByRole('row', { name: /google\.com/ })).toHaveTextContent('google.com650609.2%');
    expect(within(sources).getByRole('row', { name: /No referring site/ })).toHaveTextContent('500275.4%');
    expect(within(screen.getByRole('region', { name: 'First page' })).getByRole('row', { name: /\/pricing/ })).toHaveTextContent('300206.7%');
    const countries = screen.getByRole('region', { name: 'Countries' });
    expect(within(countries).getByRole('row', { name: /United States/ })).toBeInTheDocument();
    expect(within(countries).getByRole('row', { name: /Not recorded/ })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Devices' })).getByRole('row', { name: /Phone/ })).toHaveTextContent('500204.0%');
    expect(within(screen.getByRole('region', { name: 'Sign-up method' })).getByRole('row', { name: /Google/ })).toHaveTextContent('1007070.0%');
  });

  it('draws the days as a labelled picture with a text summary', async () => {
    renderWithBrand(<VisitorsConsole />);
    const chart = await screen.findByRole('img', { name: /1,200 new visitors, 90 created an account/ });
    expect(chart.children).toHaveLength(3);
    expect(chart.children[2]).toHaveAttribute('title', expect.stringContaining('New visitors: 800'));
  });

  it('lists the visitors with stage, source, first page and the linked account, and filters by stage and channel', async () => {
    api.listVisitors.mockResolvedValue({ ready: true, items: [visitor(), visitor({ id: 'v2', status: 'browsing', user: null, signedUpAt: null, signupMethod: null, signupFrom: null, source: null, channel: 'direct', country: null, device: null, visits: 1 })], cursor: 'o:25' });
    renderWithBrand(<VisitorsConsole />);
    const list = await screen.findByRole('region', { name: 'Visitors' });
    const rows = await within(list).findAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Created an account');
    expect(rows[1]).toHaveTextContent('Google');
    expect(rows[1]).toHaveTextContent('Search');
    expect(rows[1]).toHaveTextContent('google.com');
    expect(rows[1]).toHaveTextContent('/pricing');
    expect(rows[1]).toHaveTextContent('Sign-up opened from: pricing');
    expect(rows[1]).toHaveTextContent('United States · Phone');
    expect(rows[1]).toHaveTextContent('2 visits');
    expect(within(rows[1]!).getByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute('href', '/admin/users/u9');
    expect(rows[2]).toHaveTextContent('Browsing');
    expect(rows[2]).toHaveTextContent('1 visit');
    expect(within(rows[2]!).queryByRole('link')).toBeNull();

    fireEvent.change(within(list).getByLabelText('Stage'), { target: { value: 'signup_started' } });
    await waitFor(() => expect(api.listVisitors).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'signup_started' })));
    fireEvent.change(within(list).getByLabelText('Channel'), { target: { value: 'ai' } });
    await waitFor(() => expect(api.listVisitors).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'signup_started', channel: 'ai' })));
    fireEvent.click(await within(list).findByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(api.listVisitors).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'o:25' })));
    // Changing a filter starts from the first page again.
    fireEvent.change(within(list).getByLabelText('Stage'), { target: { value: '' } });
    await waitFor(() => expect(api.listVisitors.mock.calls.at(-1)![0]).not.toHaveProperty('cursor'));
  });

  it('while the visitor table is not in the database: says so, shows no invented numbers, and hides the list', async () => {
    api.getVisitorsReport.mockResolvedValue(
      report({ ready: false, funnel: { visitors: 0, signupViewed: 0, signupStarted: 0, signedUp: 0, onboarded: 0 }, knownUsers: 0, pageViews: 0, medianSecondsToSignup: null, untrackedVisits: 0, newAccounts: 12, daily: [], channels: [], sources: [], landingPages: [], countries: [], devices: [], methods: [] }),
    );
    renderWithBrand(<VisitorsConsole />);
    expect(await screen.findByText('Visitors are not being recorded yet')).toBeInTheDocument();
    const steps = screen.getByRole('region', { name: 'From first visit to account' });
    expect(steps).toHaveTextContent('No visitors were recorded in this period.');
    expect(steps).toHaveTextContent('12 accounts were created in this period in total');
    expect(screen.getByLabelText('Visitors and sign-ups', { selector: 'dl' })).toHaveTextContent('Visitor to account—');
    expect(screen.queryByRole('region', { name: 'Visitors' })).toBeNull();
    expect(api.listVisitors).not.toHaveBeenCalled();
  });

  it('a failed load offers a retry', async () => {
    api.getVisitorsReport.mockRejectedValueOnce(new Error('offline'));
    renderWithBrand(<VisitorsConsole />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'From first visit to account' })).toBeInTheDocument();
  });
});
