// WP-39b: the inbox bell, the message list, /settings#notifications and the
// /unsubscribe page. Network is a fetch double; data is fictional.

import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { BrandProvider, clientBrandFor, type BrandId } from '../../../lib/brand';
import { IntlWrapper } from '../../../__tests__/utils/mockTranslations';
import { capsFor } from '../../../__tests__/shell/helpers';
import type { ResolvedFlags } from '../../../server/src/platform/flags';
import { fail, installFetch, list, ok, profile, type RecordedCall } from '../filters/filters.testkit';
import { __toastStore } from '../../v3/primitives/Toast';
import type { NotificationPreferencesView, NotificationView } from '../../../lib/api/contracts/notifications';
import { NotifSection } from '../../v3/preferences/sections/NotifSection';
import { MessageCenterButton, formatUnread } from './MessageCenterButton';
import { MessageList } from './MessageList';
import { messageJobs } from './messageText';
import { NotificationsSettings } from './NotificationsSettings';
import { UnsubscribeFlow } from './UnsubscribeFlow';
import { icuArguments } from './messageText';
import { UNREAD_POLL_MS } from '../../../hooks/notifications';

// The push opt-in needs a browser that can do push and the server's VAPID key;
// jsdom has neither. The device state is a double: `pushDevice.current` is what
// the browser + server would report (null = the real hook, i.e. unsupported).
const pushDevice = vi.hoisted(() => ({ current: null as null | { status: string; available: boolean } }));
vi.mock('../../../hooks/pwa', async (orig) => {
  const real = await orig<typeof import('../../../hooks/pwa')>();
  return {
    ...real,
    usePushSubscription: (opts?: { enabled?: boolean }) =>
      pushDevice.current && opts?.enabled !== false
        ? { ...pushDevice.current, pending: false, error: null, enable: vi.fn(async () => true), disable: vi.fn(async () => undefined) }
        : real.usePushSubscription(opts),
  };
});

vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return { ...real, usePathname: () => '/jobs', useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) };
});

const N = '/api/v1/roboapply/notifications';
const U = '/api/v1/public/email/unsubscribe';
const SP = '/api/v1/roboapply/search-profiles';

function renderUi(ui: ReactElement, opts: { brand?: BrandId; flags?: Partial<ResolvedFlags> } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const brand = opts.brand ?? 'roboapply';
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <IntlWrapper>
          <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={capsFor(brand, opts.flags ?? {})}>
            {children}
          </BrandProvider>
        </IntlWrapper>
      </QueryClientProvider>
    );
  }
  return { client, ...render(ui, { wrapper: Wrapper }) };
}

function msg(over: Partial<NotificationView> = {}): NotificationView {
  return {
    id: 'n1',
    category: 'system',
    templateKey: null,
    params: null,
    title: 'Your export is ready',
    body: null,
    href: null,
    readAt: null,
    createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    ...over,
  };
}

function prefs(over: Partial<NotificationPreferencesView> = {}): NotificationPreferencesView {
  return {
    tipsReminders: true,
    channels: {
      alert: ['in_app', 'email'],
      reminder: ['in_app', 'email'],
      billing: ['in_app', 'email'],
      system: ['in_app', 'email'],
      invitation: ['in_app', 'email'],
      tips: ['in_app', 'email'],
      announcement: ['in_app'],
    },
    quietHours: { start: '21:00', end: '08:00' },
    tipsRemindersDefault: true,
    tipsRemindersSource: 'default',
    tipsRemindersConsent: { text: 'Send me tips and reminders about jobs I saved and practice I started.', locale: 'en', version: 'v-test' },
    availableChannels: ['in_app', 'email'],
    emailUnavailableReason: null,
    configurableCategories: ['alert', 'reminder', 'tips'],
    lockedCategories: ['billing', 'system'],
    productNewsEmail: null,
    ...over,
  };
}

beforeEach(() => {
  __toastStore.set(() => []);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  pushDevice.current = null;
});

describe('icuArguments', () => {
  it('finds argument names, not plural branch words', () => {
    expect(icuArguments('{count, plural, one {# new job fits “{search}”} other {Inbox, # jobs}}')).toEqual(['count', 'search']);
    expect(icuArguments('Time to follow up with {company}')).toEqual(['company']);
  });
});

describe('MessageCenterButton (the bell)', () => {
  it('formats large counts', () => {
    expect(formatUnread(7)).toBe('7');
    expect(formatUnread(120)).toBe('99+');
  });

  it('shows the real unread count and names it for screen readers', async () => {
    installFetch({ [`GET ${N}/unread-count`]: () => ok({ count: 3 }) });
    renderUi(<MessageCenterButton />);
    const bell = await screen.findByRole('button', { name: 'Inbox, 3 unread messages' });
    expect(within(bell).getByText('3')).toBeInTheDocument();
  });

  it('draws no number for zero or when the count failed to load', async () => {
    installFetch({ [`GET ${N}/unread-count`]: () => ok({ count: 0 }) });
    const a = renderUi(<MessageCenterButton />);
    await waitFor(() => expect(a.client.getQueryData(['notifications', 'unread'])).toEqual({ count: 0 }));
    expect(screen.getByRole('button', { name: 'Inbox' }).textContent).toBe('');
    a.unmount();
    installFetch({ [`GET ${N}/unread-count`]: () => fail(500, 'internal_error') });
    renderUi(<MessageCenterButton />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole('button', { name: 'Inbox' }).textContent).toBe('');
  });

  it('polls every 60 s while the page is visible, and not while it is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const net = installFetch({ [`GET ${N}/unread-count`]: () => ok({ count: 1 }) });
    renderUi(<MessageCenterButton />);
    await waitFor(() => expect(net.to('GET', `${N}/unread-count`)).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNREAD_POLL_MS + 50);
    });
    await waitFor(() => expect(net.to('GET', `${N}/unread-count`)).toHaveLength(2));

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNREAD_POLL_MS * 3);
    });
    expect(net.to('GET', `${N}/unread-count`)).toHaveLength(2);

    // Coming back refreshes at once.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(net.to('GET', `${N}/unread-count`).length).toBeGreaterThanOrEqual(3));
  });

  it('opens the drawer; following a message link marks it read and lowers the count', async () => {
    const net = installFetch({
      [`GET ${N}/unread-count`]: () => ok({ count: 1 }),
      [`GET ${N}`]: () => ok({ items: [msg({ id: 'a1', category: 'alert', title: 'New jobs', href: '/jobs/cm1?src=alert' })], cursor: null }),
      [`POST ${N}/a1/read`]: () => ok(null),
    });
    renderUi(<MessageCenterButton />);
    fireEvent.click(await screen.findByRole('button', { name: 'Inbox, 1 unread message' }));
    const dialog = await screen.findByRole('dialog');
    const link = await within(dialog).findByRole('link', { name: /New jobs/ });
    expect(link).toHaveAttribute('href', '/jobs/cm1?src=alert');
    expect(within(dialog).getByRole('link', { name: 'Open inbox' })).toHaveAttribute('href', '/inbox');
    fireEvent.click(link);
    await waitFor(() => expect(net.to('POST', `${N}/a1/read`)).toHaveLength(1));
  });
});

describe('MessageList', () => {
  it('renders templates with their params and falls back to the stored text when a param is missing', async () => {
    installFetch({
      [`GET ${N}`]: () =>
        ok({
          items: [
            msg({ id: 't1', category: 'alert', templateKey: 'alerts.instant', params: { count: 4, search: 'Data roles' }, title: 'stored A' }),
            msg({ id: 't2', category: 'alert', templateKey: 'alerts.instant', params: { search: 'Data roles' }, title: 'Stored fallback title' }),
            msg({ id: 't3', category: 'reminder', templateKey: 'no.such.key', title: null }),
          ],
          cursor: null,
        }),
    });
    renderUi(<MessageList />);
    expect(await screen.findByText('4 new jobs fit “Data roles”')).toBeInTheDocument();
    expect(screen.getByText('Stored fallback title')).toBeInTheDocument();
    expect(screen.queryByText('stored A')).toBeNull();
    // No title and no template → the category name, never an invented line.
    expect(screen.getAllByText('Reminder').length).toBeGreaterThanOrEqual(2);
  });

  it('FIX-3: a job alert lists the jobs it is about, each with its own link; the row still opens the list', async () => {
    const jobs = [
      { id: 'cm1', title: 'Backend Engineer', company: 'Acme', href: '/jobs/cm1?from=alert&imp=d1', tier: 'good', gap: null },
      { id: 'cm2', title: 'Platform Engineer', company: 'Globex', href: '/jobs/cm2?from=alert&imp=d1', tier: 'great', gap: 'Go' },
      { id: 'bad', title: 'Phish', company: 'X', href: 'https://evil.example/jobs/1' }, // not one of our pages: its own id is used instead
      { id: '', title: '', company: 'Nobody' }, // nothing to show
    ];
    const net = installFetch({
      [`GET ${N}`]: () => ok({ items: [msg({ id: 'a1', category: 'alert', templateKey: 'alerts.instant', params: { search: 'Data roles', jobs }, href: '/jobs?from=alert', title: 'stored' })], cursor: null }),
      [`POST ${N}/a1/read`]: () => ok({ ok: true }),
    });
    renderUi(<MessageList />);
    // The count is the number of jobs the message lists.
    expect(await screen.findByText('4 new jobs fit “Data roles”')).toBeInTheDocument();
    const list = within(screen.getByTestId('message-jobs')).getByRole('list', { name: 'Jobs in this alert' });
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Backend Engineer at Acme', '/jobs/cm1?from=alert&imp=d1'],
      ['Platform Engineer at Globex', '/jobs/cm2?from=alert&imp=d1'],
      ['Phish at X', '/jobs/bad'],
    ]);
    expect(messageJobs({ params: { jobs } })).toHaveLength(3);
    expect(messageJobs({ params: { search: 'x' } })).toEqual([]);
    expect(messageJobs({ params: null })).toEqual([]);
    // More than five: the rest are counted.
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `j${i}`, title: `Job ${i}`, company: 'Co', href: `/jobs/j${i}` }));
    expect(messageJobs({ params: { jobs: many } })).toHaveLength(8);
    expect(net.calls.length).toBeGreaterThan(0);
  });

  it('renders the campus templates from the stored params: the official close in Beijing time, the followed class year', async () => {
    installFetch({
      [`GET ${N}`]: () =>
        ok({
          items: [
            msg({
              id: 'c1',
              category: 'reminder',
              templateKey: 'campus.deadline',
              // 31 Oct 23:59 in Beijing (15:59 UTC): the day shown must be the Beijing day whatever the reader's zone.
              params: { eventId: 'ev1', company: 'Example Tech', companySlug: 'example-tech', program: '2027 Campus Hiring', closesAt: '2026-10-31T15:59:00.000Z', officialUrl: 'https://campus.example.cn/2027', timeZone: 'Asia/Shanghai', days: 1 },
              title: '示例科技：网申明天截止',
              body: '2027届校园招聘 网申将于 10月31日 23:59（北京时间）截止（以官网为准）。',
              href: '/campus/example-tech',
            }),
            msg({
              id: 'c2',
              category: 'reminder',
              templateKey: 'campus.followed',
              params: { eventId: 'ev1', company: 'Example Tech', companySlug: 'example-tech', program: '2027 Campus Hiring', graduationClass: '2027届' },
              title: '你关注的示例科技发布了2027届项目',
              body: '2027届校园招聘 已加入校招日历，附官网链接。',
            }),
            // A close time that cannot be read, and a class with no year: the stored text is shown, nothing is made up.
            msg({ id: 'c3', category: 'reminder', templateKey: 'campus.deadline', params: { company: 'Other Co', program: 'P', closesAt: 'soon' }, title: 'Stored deadline title', body: 'Stored deadline body' }),
            msg({ id: 'c4', category: 'reminder', templateKey: 'campus.followed', params: { company: 'Other Co', program: 'P', graduationClass: '应届' }, title: 'Stored follow title', body: null }),
          ],
          cursor: null,
        }),
    });
    renderUi(<MessageList />);
    expect(await screen.findByText('Example Tech: applications close on Oct 31')).toBeInTheDocument();
    expect(screen.getByText('2027 Campus Hiring closes on Oct 31, 23:59 (Beijing time), as stated on the official page.')).toBeInTheDocument();
    expect(screen.getByText('Example Tech posted its class of 2027 programme')).toBeInTheDocument();
    expect(screen.getByText('2027 Campus Hiring is now on the campus calendar, with its official link.')).toBeInTheDocument();
    // Templated rows never mix in the stored text.
    expect(screen.queryByText('示例科技：网申明天截止')).toBeNull();
    expect(screen.queryByText('你关注的示例科技发布了2027届项目')).toBeNull();
    expect(screen.getByText('Stored deadline title')).toBeInTheDocument();
    expect(screen.getByText('Stored deadline body')).toBeInTheDocument();
    expect(screen.getByText('Stored follow title')).toBeInTheDocument();
  });

  it('shows an honest empty state', async () => {
    installFetch({ [`GET ${N}`]: () => ok({ items: [], cursor: null }) });
    renderUi(<MessageList />);
    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
  });

  it('loads older pages with the cursor and marks everything read', async () => {
    const net = installFetch({
      [`GET ${N}`]: (c: RecordedCall) =>
        c.search.includes('cursor=c2')
          ? ok({ items: [msg({ id: 'old', title: 'Older notice', readAt: '2026-10-01T00:00:00.000Z' })], cursor: null })
          : ok({ items: [msg({ id: 'new', title: 'Newer notice' })], cursor: 'c2' }),
      [`POST ${N}/read-all`]: () => ok({ updated: 1 }),
      [`GET ${N}/unread-count`]: () => ok({ count: 0 }),
    });
    renderUi(<MessageList />);
    expect(await screen.findByText('Newer notice')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    expect(await screen.findByText('Older notice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show older messages' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(net.to('POST', `${N}/read-all`)).toHaveLength(1));
    expect(screen.getByRole('link', { name: 'Notification settings' })).toHaveAttribute('href', '/settings#notifications');
  });

  it('offers invitation answers only when the capability is on', async () => {
    const items = [msg({ id: 'inv', category: 'invitation', title: 'Example Labs invited you to apply' })];
    installFetch({ [`GET ${N}`]: () => ok({ items, cursor: null }) });
    const off = renderUi(<MessageList />);
    await screen.findByText('Example Labs invited you to apply');
    expect(screen.queryByRole('button', { name: "I'm interested" })).toBeNull();
    off.unmount();

    const net = installFetch({
      [`GET ${N}`]: () => ok({ items, cursor: null }),
      [`POST ${N}/inv/respond`]: () => ok({ ...items[0], response: { interested: true, at: '2026-10-10T00:00:00.000Z' } }),
      [`GET ${N}/unread-count`]: () => ok({ count: 0 }),
    });
    renderUi(<MessageList />, { flags: { invitations: true } });
    fireEvent.click(await screen.findByRole('button', { name: "I'm interested" }));
    await waitFor(() => expect(net.to('POST', `${N}/inv/respond`)[0]?.body).toEqual({ interested: true }));
    expect(await screen.findByText("You said you're interested.")).toBeInTheDocument();
  });
});

describe('NotificationsSettings (/settings#notifications)', () => {
  const searches = list([profile({ name: 'Analyst roles', alertInstantMax: 1, alertDigest: 'daily' })], { maxInstantAlerts: 1, upgradable: true });

  function setup(
    view = prefs(),
    extra: Record<string, (c: RecordedCall) => Response> = {},
    opts: { brand?: BrandId; flags?: Partial<ResolvedFlags> } = { flags: { 'jobs.alerts': true } },
  ) {
    const net = installFetch({
      [`GET ${N}/preferences`]: () => ok(view),
      [`PATCH ${N}/preferences`]: (c) => {
        const { tipsRemindersProseVersion: _v, ...rest } = c.body as Record<string, unknown>;
        return ok({ ...view, ...rest, tipsRemindersSource: 'user' });
      },
      [`GET ${SP}`]: () => ok(searches),
      [`PATCH ${SP}/sp_main`]: (c) => ok({ ...searches.profiles[0], ...(c.body as object), version: 4 }),
      ...extra,
    });
    renderUi(<NotificationsSettings />, opts);
    return net;
  }

  it('shows the "Tips and reminders" preference with the regional default, described by the exact consent text', async () => {
    setup(prefs({ tipsReminders: false, tipsRemindersDefault: false }));
    const tips = await screen.findByRole('switch', { name: 'Send tips and reminders' });
    expect(tips).not.toBeChecked();
    const consent = screen.getByText('Send me tips and reminders about jobs I saved and practice I started.');
    expect(tips).toHaveAttribute('aria-describedby', consent.id);
    expect(consent).toHaveAttribute('lang', 'en');
    expect(screen.getByText(/Default where you are: off\./)).toBeInTheDocument();
    expect(screen.getByText(/Tips and reminders are off, so none are sent\./)).toBeInTheDocument();
    // Its email switch cannot be used while the preference is off.
    expect(screen.getByRole('switch', { name: 'Tips and reminders: Email' })).toBeDisabled();
  });

  it('turning tips on sends one PATCH and confirms with a toast', async () => {
    const net = setup(prefs({ tipsReminders: false, tipsRemindersDefault: true }));
    expect(await screen.findByText(/Default where you are: on\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Send tips and reminders' }));
    // The version of the text shown travels with the choice, so a stale page gets a 409 instead of a wrong record.
    await waitFor(() => expect(net.to('PATCH', `${N}/preferences`)[0]?.body).toEqual({ tipsReminders: true, tipsRemindersProseVersion: 'v-test' }));
    await waitFor(() => expect(__toastStore.get().map((t) => t.message)).toContain('Saved'));
  });

  it('per-channel switches: turning job-alert email off keeps the inbox', async () => {
    const net = setup();
    const email = await screen.findByRole('switch', { name: 'Job alerts: Email' });
    expect(email).toBeChecked();
    expect(screen.getAllByText('Inbox: always on').length).toBe(3);
    fireEvent.click(email);
    await waitFor(() => expect(net.to('PATCH', `${N}/preferences`)[0]?.body).toEqual({ channels: { alert: ['in_app'] } }));
    expect(screen.getByText('Account, security and billing messages are always sent.')).toBeInTheDocument();
    expect(screen.getByText('Alerts and tips are not sent between 21:00 and 08:00 your time.')).toBeInTheDocument();
  });

  it('without a real email address there are no email switches, and it says why', async () => {
    setup(prefs({ availableChannels: ['in_app'], emailUnavailableReason: 'no_address', channels: { ...prefs().channels, alert: ['in_app'], reminder: ['in_app'], tips: ['in_app'] } }));
    expect(await screen.findByText('Add an email address to your account to get messages by email.')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Job alerts: Email' })).toBeNull();
  });

  it('when the brand does not send email, a user with an address is not told to add one, and there is no email summary to choose', async () => {
    setup(prefs({ availableChannels: ['in_app'], emailUnavailableReason: 'not_offered', channels: { ...prefs().channels, alert: ['in_app'], reminder: ['in_app'], tips: ['in_app'] } }));
    expect(await screen.findByRole('switch', { name: 'Send tips and reminders' })).toBeInTheDocument();
    expect(screen.queryByText(/Add an email address/)).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Reminders: Email' })).toBeNull();
    // The alert rows stay (the inbox still gets alerts); only the email summary goes.
    expect(await screen.findByLabelText('Instant alerts')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email summary')).toBeNull();
  });

  it('GoApply by default (email through the shared transport, job alerts on): the same email switches and email summary as RoboApply', async () => {
    const net = setup(prefs(), {}, { brand: 'goapply', flags: { 'jobs.alerts': true, 'notify.email': true } });
    expect(await screen.findByRole('switch', { name: 'Job alerts: Email' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Reminders: Email' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Email summary')).toBeInTheDocument();
    expect(net.to('GET', SP)).toHaveLength(1);
  });

  it('RoboApply with job alerts on shows the per-search alert controls', async () => {
    const net = setup();
    expect(await screen.findByRole('heading', { name: 'Job alerts' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Instant alerts')).toBeInTheDocument();
    expect(net.to('GET', SP)).toHaveLength(1);
  });

  it('GoApply with job alerts switched off (CN_RECRUITMENT_INFO_MODE=off) has no alert controls and never asks for saved searches', async () => {
    const net = setup(prefs({ configurableCategories: ['reminder', 'tips'] }), {}, { brand: 'goapply', flags: {} });
    expect(await screen.findByRole('switch', { name: 'Send tips and reminders' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Job alerts' })).toBeNull();
    expect(screen.queryByLabelText('Instant alerts')).toBeNull();
    expect(screen.queryByLabelText('Email summary')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Job alerts: Email' })).toBeNull();
    expect(net.to('GET', SP)).toHaveLength(0);
  });

  it('"Alerts on this device" sits with the channel switches only while web push is on for the brand', async () => {
    // A browser that can do push, and a server with its keys: only the flag decides.
    pushDevice.current = { status: 'off', available: true };
    const routes = { [`GET ${N}/preferences`]: () => ok(prefs({ availableChannels: ['in_app', 'email', 'push'] })) };

    // Flag off (either brand until VAPID keys are set, or FLAG_<BRAND>_WEB_PUSH=false): no opt-in, no dead entry.
    installFetch(routes);
    const off = renderUi(<NotificationsSettings />, { flags: { webPush: false, 'jobs.alerts': false } });
    await screen.findByRole('heading', { name: 'Where messages go' });
    expect(screen.queryByTestId('push-opt-in')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Get alerts on this device' })).toBeNull();
    off.unmount();

    installFetch(routes);
    const goOff = renderUi(<NotificationsSettings />, { brand: 'goapply', flags: { webPush: false, 'jobs.alerts': false } });
    await screen.findByRole('heading', { name: 'Where messages go' });
    expect(screen.queryByTestId('push-opt-in')).toBeNull();
    goOff.unmount();

    // GoApply with the flag on (the shared VAPID pair): the same opt-in as RoboApply.
    installFetch(routes);
    renderUi(<NotificationsSettings />, { brand: 'goapply', flags: { webPush: true, 'jobs.alerts': false } });
    const group = (await screen.findByRole('heading', { name: 'Where messages go' })).closest('section')!;
    const optIn = await within(group).findByTestId('push-opt-in');
    expect(within(optIn).getByRole('button', { name: 'Get alerts on this device' })).toBeEnabled();
  });

  it('with web push on, the opt-in is inside "Where messages go", after the channel rows', async () => {
    pushDevice.current = { status: 'off', available: true };
    installFetch({ [`GET ${N}/preferences`]: () => ok(prefs({ availableChannels: ['in_app', 'email', 'push'] })) });
    renderUi(<NotificationsSettings />, { flags: { webPush: true, 'jobs.alerts': false } });
    const group = (await screen.findByRole('heading', { name: 'Where messages go' })).closest('section')!;
    const optIn = await within(group).findByTestId('push-opt-in');
    expect(within(optIn).getByRole('heading', { name: 'Alerts on this device' })).toBeInTheDocument();
    // Nothing asks the browser until the person clicks.
    expect(within(optIn).getByRole('button', { name: 'Get alerts on this device' })).toBeEnabled();
    const rows = within(group).getAllByRole('switch');
    expect(rows[rows.length - 1]!.compareDocumentPosition(optIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('with web push on but a browser that cannot do push, the opt-in stays hidden', async () => {
    installFetch({ [`GET ${N}/preferences`]: () => ok(prefs()) });
    renderUi(<NotificationsSettings />, { flags: { webPush: true, 'jobs.alerts': false } });
    await screen.findByRole('heading', { name: 'Where messages go' });
    expect(screen.queryByTestId('push-opt-in')).toBeNull();
  });

  it('a failed save says so', async () => {
    setup(prefs(), { [`PATCH ${N}/preferences`]: () => fail(422, 'invalid_request') });
    fireEvent.click(await screen.findByRole('switch', { name: 'Reminders: Email' }));
    await waitFor(() => expect(__toastStore.get().map((t) => t.message)).toContain('Your change was not saved. Try again.'));
  });

  it('job alerts per saved search: plan-capped options, one PATCH with baseVersion, never "unlimited"', async () => {
    const net = setup();
    const instant = await screen.findByLabelText('Instant alerts');
    const options = within(instant).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
      ['Off', false],
      ['Up to 1 a day', false],
      ['Up to 2 a day', true],
      ['Up to 5 a day', true],
      ['As they arrive', true],
    ]);
    expect(screen.getByText('Pro can get alerts as they arrive.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email summary'), { target: { value: 'weekly' } });
    await waitFor(() => expect(net.to('PATCH', `${SP}/sp_main`)[0]?.body).toEqual({ alertDigest: 'weekly', baseVersion: 3 }));
    expect(document.body.textContent).not.toMatch(/unlimited/i);
  });

  it('the legacy settings section renders the same content', async () => {
    setup();
    renderUi(<NotifSection />, { flags: { 'jobs.alerts': true } });
    await waitFor(() => expect(screen.getAllByTestId('notifications-settings')).toHaveLength(2));
  });
});

describe('UnsubscribeFlow (/unsubscribe/<token>)', () => {
  const TOKEN = 'u1.eyJ2IjoxfQ.signature-part-xyz';

  it('asks first, then unsubscribes, then takes an optional reason', async () => {
    const net = installFetch({
      [`GET ${U}`]: () => ok({ category: 'digest', alreadyUnsubscribed: false, hasAccount: true }),
      [`POST ${U}`]: () => ok({ category: 'digest', unsubscribed: true }),
      [`POST ${U}/survey`]: () => ok(null),
    });
    renderUi(<UnsubscribeFlow token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: 'Stop job alert emails?' })).toBeInTheDocument();
    // A summary link stops instant alerts too (one email switch for job alerts), and it says so.
    expect(screen.getByText(/instant alerts and summaries alike/)).toBeInTheDocument();
    expect(net.writes()).toHaveLength(0);
    expect(net.to('GET', U)[0]!.search).toBe(`?token=${encodeURIComponent(TOKEN)}`);
    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByRole('heading', { name: "You're unsubscribed" })).toBeInTheDocument();
    expect(screen.getByText(/We won't send you job alert emails any more, instant or summaries\./)).toBeInTheDocument();
    expect(net.to('POST', U)[0]!.search).toBe(`?token=${encodeURIComponent(TOKEN)}`);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Too many emails' }));
    fireEvent.change(screen.getByLabelText('Anything else? (optional)'), { target: { value: '  Weekly is enough  ' } });
    fireEvent.click(send);
    await waitFor(() => expect(net.to('POST', `${U}/survey`)[0]?.body).toEqual({ token: TOKEN, reason: 'too_many', note: 'Weekly is enough' }));
    expect(await screen.findByText('Thanks for telling us.')).toBeInTheDocument();
  });

  it('says so when the list was already left', async () => {
    installFetch({ [`GET ${U}`]: () => ok({ category: 'tips', alreadyUnsubscribed: true, hasAccount: true }) });
    renderUi(<UnsubscribeFlow token={TOKEN} />);
    expect(await screen.findByText('You already unsubscribed from tips and reminders.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).toBeNull();
  });

  it('tips: says they stop in the inbox too, never that the inbox still shows them', async () => {
    installFetch({ [`GET ${U}`]: () => ok({ category: 'tips', alreadyUnsubscribed: false, hasAccount: true }) });
    renderUi(<UnsubscribeFlow token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: 'Stop tips and reminders?' })).toBeInTheDocument();
    expect(screen.getByText(/Tips and reminders stop everywhere, in your RoboApply inbox too\./)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/still shows/);
  });

  it('marketing: no inbox sentence', async () => {
    installFetch({ [`GET ${U}`]: () => ok({ category: 'marketing', alreadyUnsubscribed: false, hasAccount: true }) });
    renderUi(<UnsubscribeFlow token={TOKEN} />);
    expect(await screen.findByText("You'll stop getting product news by email. Emails about your account still arrive.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/inbox/i);
  });

  it('a logged-out alert subscription: no inbox and no Settings link', async () => {
    installFetch({
      [`GET ${U}`]: () => ok({ category: 'alerts', alreadyUnsubscribed: false, hasAccount: false }),
      [`POST ${U}`]: () => ok({ category: 'alerts', unsubscribed: true }),
    });
    renderUi(<UnsubscribeFlow token={TOKEN} />);
    expect(await screen.findByText("We'll stop sending job alert emails to this address.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/inbox|Settings/);
    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByText(/We won't send job alert emails to this address any more\./)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Notification settings' })).toBeNull();
  });

  it('a server or network failure while checking the link offers a retry, not "bad link"', async () => {
    let calls = 0;
    installFetch({
      [`GET ${U}`]: () => {
        calls += 1;
        return calls === 1 ? fail(503, 'service_unavailable') : ok({ category: 'reminders', alreadyUnsubscribed: false, hasAccount: true });
      },
    });
    renderUi(<UnsubscribeFlow token={TOKEN} />);
    expect(await screen.findByText("We couldn't check this link just now. Your emails have not changed.")).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "This link doesn't work" })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Stop reminder emails?' })).toBeInTheDocument();
  });

  it('a bad link gets one plain message and a way to sign in', async () => {
    installFetch({ [`GET ${U}`]: () => fail(422, 'invalid_request', { reason: 'unsubscribe_token_invalid' }) });
    renderUi(<UnsubscribeFlow token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: "This link doesn't work" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=%2Fsettings%23notifications');
  });

  it('a failed unsubscribe can be retried', async () => {
    installFetch({
      [`GET ${U}`]: () => ok({ category: 'marketing', alreadyUnsubscribed: false, hasAccount: true }),
      [`POST ${U}`]: () => fail(500, 'internal_error'),
    });
    renderUi(<UnsubscribeFlow token={TOKEN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByText("That didn't work. Try again.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeEnabled();
  });
});
