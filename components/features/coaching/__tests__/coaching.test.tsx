// WP-72 — /coaching, the booking request form, the practice-report line and
// the /coaching/bookings 404 (lib/api/coaching mocked; flags seeded through
// the brand provider).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { mockAuthState, buildAuthValue, buildFakeUser } from '../../../../__tests__/utils/mockAuth';
import { RoboApiError } from '../../../../lib/api/client';
import type { CoachView } from '../../../../lib/api/contracts/coaching';

const api = vi.hoisted(() => ({
  listCoaches: vi.fn(),
  getCoach: vi.fn(),
  requestCoach: vi.fn(),
}));
vi.mock('../../../../lib/api/coaching', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

import CoachingRoute from '../../../../app/(auth)/coaching/page';
import { PracticeReportCoachLine } from '..';
import { currencyDigits, formatMoney, initials, splitList, toMinor } from '../format';

const DANA: CoachView = {
  id: 'c1',
  displayName: 'Dana Lee',
  headline: 'Former recruiter, tech hiring',
  bio: 'Ran hiring for two startups.',
  photoUrl: null,
  languages: ['en', 'zh-TW'],
  specialties: ['Interview practice'],
  sessionLengths: [30, 60],
  rates: { currency: 'USD', '30': 4000 },
  sessions: [
    { minutes: 30, amountMinor: 4000, currency: 'USD' },
    { minutes: 60, amountMinor: null, currency: null },
  ],
  bookingUrl: null,
  booking: 'request',
  introVideoUrl: null,
  rating: null,
};
const ANA: CoachView = {
  ...DANA,
  id: 'c2',
  displayName: 'Ana Ruiz',
  languages: ['es'],
  specialties: ['Career change'],
  sessionLengths: [],
  rates: null,
  sessions: [],
  bookingUrl: 'https://cal.example.test/ana',
  booking: 'link',
  introVideoUrl: 'https://video.example.test/ana',
};

const ON = { flags: { coaching: true } };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mockAuthState.value = buildAuthValue({ user: buildFakeUser({ email: 'jane@example.com', name: 'Jane Seeker' }) });
  api.listCoaches.mockResolvedValue({ items: [DANA, ANA] });
  api.requestCoach.mockResolvedValue({ received: true });
});

describe('/coaching', () => {
  it('capability off: says it is not available and asks for nothing', () => {
    renderWithBrand(<CoachingRoute />);
    expect(screen.getByText('Coaching is not available here')).toBeInTheDocument();
    expect(api.listCoaches).not.toHaveBeenCalled();
  });

  it('empty roster: a plain empty state, no coach upsell', async () => {
    api.listCoaches.mockResolvedValue({ items: [] });
    renderWithBrand(<CoachingRoute />, ON);
    expect(await screen.findByText('No coaches are listed yet')).toBeInTheDocument();
    expect(screen.queryByTestId('coach-card')).toBeNull();
    expect(screen.getByRole('link', { name: 'Practice an interview' })).toHaveAttribute('href', '/practice');
  });

  it('lists real roster data only: prices as the coach set them, "Price not listed", no rating', async () => {
    renderWithBrand(<CoachingRoute />, ON);
    const cards = await screen.findAllByTestId('coach-card');
    expect(cards).toHaveLength(2);
    const dana = within(cards[0]!);
    expect(dana.getByRole('heading', { name: 'Dana Lee' })).toBeInTheDocument();
    expect(dana.getByText('30 min · $40')).toBeInTheDocument();
    expect(dana.getByText('60 min · Price not listed')).toBeInTheDocument();
    expect(dana.getByText(/Prices are set by Dana Lee/)).toBeInTheDocument();
    expect(dana.queryByText(/Rated/)).toBeNull();
    // A coach with no sessions or prices says "Not listed", never 0, and still says who sets the price.
    const ana = within(cards[1]!);
    expect(ana.getAllByText('Not listed').length).toBeGreaterThan(0);
    expect(ana.queryByText(/\$0/)).toBeNull();
    expect(ana.getByText('Ana Ruiz has not listed prices. You agree on a price with Ana Ruiz and pay them directly.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Coaching policy' })).toHaveAttribute('href', '/legal/coaching');
    expect(screen.getByText(/You pay the coach directly/)).toBeInTheDocument();
  });

  it('a coach with session lengths but no prices says "Price not listed" on every length', async () => {
    const LIN: CoachView = {
      ...DANA,
      id: 'c3',
      displayName: 'Lin Chen',
      rates: null,
      sessions: [
        { minutes: 30, amountMinor: null, currency: null },
        { minutes: 60, amountMinor: null, currency: null },
      ],
    };
    api.listCoaches.mockResolvedValue({ items: [LIN] });
    renderWithBrand(<CoachingRoute />, ON);
    const card = within(await screen.findByTestId('coach-card'));
    expect(card.getByText('30 min · Price not listed')).toBeInTheDocument();
    expect(card.getByText('60 min · Price not listed')).toBeInTheDocument();
    expect(card.queryByText('30 min')).toBeNull();
    expect(card.getByText(/Lin Chen has not listed prices\. .* pay them directly\./)).toBeInTheDocument();
  });

  it('links the coaching policy only where the site publishes it (GoApply has no mapping yet)', async () => {
    api.listCoaches.mockResolvedValue({ items: [DANA] });
    renderWithBrand(<CoachingRoute />, { brand: 'goapply', flags: { coaching: true } });
    await screen.findByTestId('coach-card');
    expect(screen.queryByRole('link', { name: 'Coaching policy' })).toBeNull();
  });

  it('GoApply: the request needs a separate consent to share with the coach', async () => {
    api.listCoaches.mockResolvedValue({ items: [DANA] });
    renderWithBrand(<CoachingRoute />, { brand: 'goapply', flags: { coaching: true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Request a session' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('What would you like help with?'), { target: { value: 'Mock interview' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Tick the box');
    expect(api.requestCoach).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId('coach-share-consent'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(api.requestCoach).toHaveBeenCalled());
    expect(api.requestCoach.mock.calls[0]![1]).toMatchObject({ topic: 'Mock interview', shareConsent: true });
  });

  it('RoboApply shows no share-consent box and sends none', async () => {
    renderWithBrand(<CoachingRoute />, ON);
    fireEvent.click(await screen.findByRole('button', { name: 'Request a session' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('coach-share-consent')).toBeNull();
  });

  it('a coach with a booking page links there in a new tab', async () => {
    renderWithBrand(<CoachingRoute />, ON);
    const link = await screen.findByRole('link', { name: "Book on Ana Ruiz's page" });
    expect(link).toHaveAttribute('href', 'https://cal.example.test/ana');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('link', { name: "Watch Ana Ruiz's intro" })).toHaveAttribute('href', 'https://video.example.test/ana');
  });

  it('filters the loaded coaches by language', async () => {
    renderWithBrand(<CoachingRoute />, ON);
    await screen.findAllByTestId('coach-card');
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'es' } });
    expect(screen.getAllByTestId('coach-card')).toHaveLength(1);
    expect(screen.getByText('1 coach listed')).toBeInTheDocument();
  });

  it('sends a request with only what the user typed and confirms it', async () => {
    renderWithBrand(<CoachingRoute />, ON);
    fireEvent.click(await screen.findByRole('button', { name: 'Request a session' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Email for the coach\'s reply')).toHaveValue('jane@example.com');
    fireEvent.change(within(dialog).getByLabelText('What would you like help with?'), { target: { value: 'Mock interview' } });
    fireEvent.change(within(dialog).getByLabelText('Session length'), { target: { value: '30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(api.requestCoach).toHaveBeenCalled());
    expect(api.requestCoach.mock.calls[0]![0]).toBe('c1');
    expect(api.requestCoach.mock.calls[0]![1]).toEqual({ name: 'Jane Seeker', topic: 'Mock interview', contactEmail: 'jane@example.com', durationMin: 30 });
    expect(await screen.findByText('Request sent to Dana Lee. Watch jane@example.com for their reply.')).toBeInTheDocument();
  });

  it('does not offer a placeholder address and validates before sending', async () => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ email: 'u1@users.goapply.invalid' }) });
    renderWithBrand(<CoachingRoute />, ON);
    fireEvent.click(await screen.findByRole('button', { name: 'Request a session' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Email for the coach\'s reply')).toHaveValue('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('a topic and a valid email are needed');
    expect(api.requestCoach).not.toHaveBeenCalled();
  });

  it('explains the daily limit and missing email setup plainly', async () => {
    api.requestCoach.mockRejectedValueOnce(new RoboApiError('Too many', { code: 'rate_limited', status: 429, payload: { success: false, code: 'rate_limited' } }));
    renderWithBrand(<CoachingRoute />, ON);
    fireEvent.click(await screen.findByRole('button', { name: 'Request a session' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('What would you like help with?'), { target: { value: 'Help' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('most requests allowed for today');

    api.requestCoach.mockRejectedValueOnce(new RoboApiError('No email', { code: 'provider_not_configured', status: 501, payload: { success: false, code: 'provider_not_configured' } }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('Email is not set up on this site'));
  });
});

describe('PracticeReportCoachLine', () => {
  it('hidden with the capability off (no roster request)', () => {
    const { container } = renderWithBrand(<PracticeReportCoachLine sessionId="s1" jobId="j1" />);
    expect(container).toBeEmptyDOMElement();
    expect(api.listCoaches).not.toHaveBeenCalled();
  });

  it('hidden while the roster is empty', async () => {
    api.listCoaches.mockResolvedValue({ items: [] });
    const { container } = renderWithBrand(<PracticeReportCoachLine sessionId="s1" />, ON);
    await waitFor(() => expect(api.listCoaches).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('hidden when the roster request fails (fail closed)', async () => {
    api.listCoaches.mockRejectedValue(new RoboApiError('x', { code: 'internal_error', status: 500, payload: { success: false, code: 'internal_error' } }));
    const { container } = renderWithBrand(<PracticeReportCoachLine sessionId="s1" />, ON);
    await waitFor(() => expect(api.listCoaches).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('"Prefer a person? See coaches" when at least one coach is listed', async () => {
    renderWithBrand(<PracticeReportCoachLine sessionId="s1" jobId="j1" />, ON);
    const link = await screen.findByRole('link', { name: 'See coaches' });
    expect(link.getAttribute('href')).toMatch(/^\/coaching/);
    expect(screen.getByText('Prefer a person?')).toBeInTheDocument();
  });
});

describe('/coaching/bookings', () => {
  /** Every page route under app/, as segment patterns (route groups dropped). */
  function pageRoutes(dir: string, segs: string[] = []): string[][] {
    const out: string[][] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name.startsWith('_') || name.startsWith('@')) continue;
        const next = /^\(.*\)$/.test(name) ? segs : [...segs, name];
        out.push(...pageRoutes(full, next));
      } else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(name) || /^route\.(ts|js)$/.test(name)) {
        out.push(segs);
      }
    }
    return out;
  }

  function matches(pattern: string[], url: string[]): boolean {
    if (pattern.length === 0) return url.length === 0;
    const [head, ...rest] = pattern;
    if (/^\[\[\.\.\..+\]\]$/.test(head!)) return true;
    if (/^\[\.\.\..+\]$/.test(head!)) return url.length > 0;
    if (url.length === 0) return false;
    if (/^\[.+\]$/.test(head!) || head === url[0]) return matches(rest, url.slice(1));
    return false;
  }

  it('no app route serves it (V2 has no bookings data), so Next answers 404', () => {
    const appDir = path.resolve(__dirname, '../../../../app');
    const routes = pageRoutes(appDir);
    expect(routes.some((r) => r.join('/') === 'coaching')).toBe(true);
    const hits = routes.filter((r) => matches(r, ['coaching', 'bookings']));
    expect(hits).toEqual([]);
  });
});

describe('format helpers', () => {
  it('money in minor units, never inventing a value', () => {
    expect(currencyDigits('USD')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(formatMoney(4000, 'USD', 'en')).toBe('$40');
    expect(formatMoney(4050, 'USD', 'en')).toBe('$40.50');
    expect(toMinor('40.5', 'USD')).toBe(4050);
    expect(toMinor('', 'USD')).toBeNull();
    expect(toMinor('-1', 'USD')).toBeNull();
    expect(toMinor('3000', 'JPY')).toBe(3000);
  });

  it('initials and comma lists', () => {
    expect(initials('Dana Lee')).toBe('DL');
    expect(initials('王老师')).toBe('王');
    expect(splitList('en, zh-TW,, en')).toEqual(['en', 'zh-TW']);
    expect(splitList('面试，简历')).toEqual(['面试', '简历']);
  });
});
