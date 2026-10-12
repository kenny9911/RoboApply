// WP-23 web: the analytics client (lib/analytics.ts), the consent banner and
// the getting-started checklist. lib/api/growth is mocked, and fetch is
// spied on to prove no request leaves the test (no third-party calls, no
// network at all).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('../../../lib/api/growth', () => ({
  sendEvents: vi.fn(async () => ({ accepted: 0, rejected: 0 })),
  sendEventsBeacon: vi.fn(() => true),
  getChecklist: vi.fn(),
  dismissChecklist: vi.fn(),
}));

import * as api from '../../../lib/api/growth';
import { RoboApiError } from '../../../lib/api/client';
import {
  ANALYTICS_CONSENT_COOKIE,
  ANON_ID_COOKIE,
  ATTRIBUTION_STORAGE_KEY,
  FLUSH_AT,
  MAX_BATCH,
  __resetAnalyticsForTests,
  captureAttribution,
  configureAnalytics,
  flush,
  getAnonId,
  getAttribution,
  isAnalyticsConsentRequired,
  pendingEventCount,
  requestAnalyticsConsentReview,
  safePath,
  setAnalyticsConsent,
  touchFromSearch,
  track,
  TOKEN_PATH_PREFIXES as WEB_TOKEN_PREFIXES,
} from '../../../lib/analytics';
import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnalyticsConsent, CONSENT_RESERVE_VAR } from './AnalyticsConsent';
import { GettingStartedChecklist } from './GettingStartedChecklist';
import type { ChecklistView } from '../../../lib/api/contracts/growth';
import {
  CONSENT_REQUIRED_COUNTRIES as SERVER_COUNTRIES,
  PRODUCT_EVENT_NAMES,
  TOKEN_PATH_PREFIXES as SERVER_TOKEN_PREFIXES,
  sanitizeEventPath,
} from '../../../server/src/features/growth/events';
import { CONSENT_REQUIRED_COUNTRIES as WEB_COUNTRIES } from '../../../lib/analytics';

const sendEvents = vi.mocked(api.sendEvents);
const sendEventsBeacon = vi.mocked(api.sendEventsBeacon);
const getChecklist = vi.mocked(api.getChecklist);
const dismissChecklist = vi.mocked(api.dismissChecklist);

function cookie(name: string): string | null {
  const row = document.cookie.split(/;\s*/).find((r) => r.startsWith(`${name}=`));
  return row ? decodeURIComponent(row.slice(name.length + 1)) : null;
}

function clearCookies() {
  for (const row of document.cookie.split(/;\s*/)) {
    const name = row.split('=')[0];
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetAnalyticsForTests();
  clearCookies();
  window.localStorage.clear();
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  vi.useRealTimers();
  __resetAnalyticsForTests();
});

// ── lib/analytics ────────────────────────────────────────────────────────

describe('analytics client', () => {
  it('mirrors the server consent-region list and rule', () => {
    expect([...WEB_COUNTRIES].sort()).toEqual([...SERVER_COUNTRIES].sort());
    expect(isAnalyticsConsentRequired('intl', 'FR')).toBe(true);
    expect(isAnalyticsConsentRequired('intl', null)).toBe(true);
    expect(isAnalyticsConsentRequired('intl', 'US')).toBe(false);
    expect(isAnalyticsConsentRequired('cn', 'FR')).toBe(false);
    expect(PRODUCT_EVENT_NAMES).toContain('page_viewed');
  });

  it('buffers until configured, then sends batches of at most 50', async () => {
    for (let i = 0; i < 60; i += 1) track('job_opened', { jobId: `j${i}` });
    expect(sendEvents).not.toHaveBeenCalled();
    expect(pendingEventCount()).toBe(60);
    configureAnalytics({ consentRequired: false });
    await flush();
    expect(sendEvents).toHaveBeenCalledTimes(2);
    const [first, second] = sendEvents.mock.calls.map((c) => c[0]);
    expect(first!.events).toHaveLength(MAX_BATCH);
    expect(second!.events).toHaveLength(10);
    expect(first!.events[0]).toMatchObject({ name: 'job_opened', props: { jobId: 'j0' }, at: expect.any(String) });
    expect(pendingEventCount()).toBe(0);
  });

  it(`flushes on its own at ${FLUSH_AT} events and after a short delay`, async () => {
    vi.useFakeTimers();
    configureAnalytics({ consentRequired: false });
    track('page_viewed');
    expect(sendEvents).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendEvents).toHaveBeenCalledTimes(1);
    for (let i = 0; i < FLUSH_AT; i += 1) track('job_saved', { jobId: `j${i}` });
    await vi.advanceTimersByTimeAsync(0);
    expect(sendEvents).toHaveBeenCalledTimes(2);
  });

  it('flushes with a keepalive beacon when the page is hidden', () => {
    configureAnalytics({ consentRequired: false });
    track('apply_clicked', { jobId: 'j1', from: 'feed' });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    expect(sendEventsBeacon).toHaveBeenCalledTimes(1);
    expect(sendEventsBeacon.mock.calls[0]![0].events[0]).toMatchObject({ name: 'apply_clicked' });
    expect(sendEvents).not.toHaveBeenCalled();
  });

  it('EEA before consent: no anonId cookie, nothing stored, events carry only the in-memory session id', async () => {
    configureAnalytics({ consentRequired: true });
    captureAttribution({ search: '?utm_source=newsletter', pathname: '/' });
    track('page_viewed');
    await flush();
    expect(cookie(ANON_ID_COOKIE)).toBeNull();
    expect(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull();
    const body = sendEvents.mock.calls[0]![0];
    expect(body.anonId).toBeUndefined();
    expect(body.sessionId).toMatch(/^[A-Za-z0-9]{8,}$/);
    expect(getAnonId()).toBeNull();
  });

  it('EEA after "Allow": the anonId cookie is set, sent, and the visit attribution is kept', async () => {
    configureAnalytics({ consentRequired: true });
    captureAttribution({ search: '?from=alert&job=cm1&utm_source=mail', pathname: '/jobs' });
    setAnalyticsConsent('granted');
    expect(cookie(ANALYTICS_CONSENT_COOKIE)).toBe('granted');
    const anon = cookie(ANON_ID_COOKIE);
    expect(anon).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    track('page_viewed');
    await flush();
    expect(sendEvents.mock.calls[0]![0].anonId).toBe(anon);
    expect(JSON.parse(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)!)).toMatchObject({ firstTouch: { from: 'alert', jobId: 'cm1', utmSource: 'mail', landingPath: '/jobs' } });
  });

  it('"Don\'t allow" removes the id and stored attribution', () => {
    configureAnalytics({ consentRequired: true });
    setAnalyticsConsent('granted');
    captureAttribution({ search: '?ref=ABCD2345', pathname: '/r/ABCD2345' });
    setAnalyticsConsent('denied');
    expect(cookie(ANON_ID_COOKIE)).toBeNull();
    expect(cookie(ANALYTICS_CONSENT_COOKIE)).toBe('denied');
    expect(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull();
    expect(getAnonId()).toBeNull();
  });

  it('"Don\'t allow": signup gets only the referral and job, never the marketing touch', () => {
    configureAnalytics({ consentRequired: true });
    captureAttribution({ search: '?utm_source=newsletter&from=alert&alert=a1&invite=INV1&job=cm1&action=apply', pathname: '/jobs/cm1' });
    setAnalyticsConsent('denied');
    const a = getAttribution();
    expect(a).toEqual({ firstTouch: { inviteCode: 'INV1', jobId: 'cm1', action: 'apply', at: expect.any(String) }, lastTouch: null });
    expect(JSON.stringify(a)).not.toMatch(/newsletter|utmSource|"from"|alert|landingPath/);
    // A marketing-only visit leaves nothing to send.
    __resetAnalyticsForTests();
    configureAnalytics({ consentRequired: true });
    captureAttribution({ search: '?utm_source=newsletter', pathname: '/' });
    setAnalyticsConsent('denied');
    expect(getAttribution()).toBeNull();
  });

  it('before a choice in the EEA, getAttribution() is functional-only; after "Allow" it is complete', () => {
    configureAnalytics({ consentRequired: true });
    captureAttribution({ search: '?utm_source=newsletter&ref=ABCD2345', pathname: '/' });
    expect(getAttribution()).toEqual({ firstTouch: { ref: 'ABCD2345', at: expect.any(String) }, lastTouch: null });
    setAnalyticsConsent('granted');
    expect(getAttribution()).toMatchObject({ firstTouch: { utmSource: 'newsletter', ref: 'ABCD2345', landingPath: '/' } });
  });

  it('never lets a token route leave the browser (mirrors the server redaction)', async () => {
    expect([...WEB_TOKEN_PREFIXES]).toEqual([...SERVER_TOKEN_PREFIXES]);
    for (const p of ['/reset-password/abc123', '/verify-email/t1?x=1', '/unsubscribe/u1/now', '/alerts/confirm/c1', '/de/reset-password/abc', '/jobs/cm1', '/alerts']) {
      expect(safePath(p)).toBe(sanitizeEventPath(p));
    }
    configureAnalytics({ consentRequired: false });
    track('page_viewed', {}, { path: '/reset-password/abc123' });
    await flush();
    expect(sendEvents.mock.calls[0]![0].events[0]!.path).toBe('/reset-password/:token');
    expect(touchFromSearch('?from=mail', '/verify-email/tok_1')).toMatchObject({ landingPath: '/verify-email/:token' });
  });

  it('outside the consent region the anonId is set at once; first touch is kept, later visits move lastTouch', () => {
    configureAnalytics({ consentRequired: false });
    expect(cookie(ANON_ID_COOKIE)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    captureAttribution({ search: '?utm_source=a', pathname: '/' });
    captureAttribution({ search: '', pathname: '/jobs' });
    captureAttribution({ search: '?from=alert&alert=tok', pathname: '/jobs/cm1' });
    expect(getAttribution()).toMatchObject({ firstTouch: { utmSource: 'a' }, lastTouch: { from: 'alert', alert: 'tok' } });
    expect(touchFromSearch('?nothing=1')).toBeNull();
  });

  it('track never throws', () => {
    expect(() => track('page_viewed', { locale: 'en' }, { path: '/x'.repeat(400) })).not.toThrow();
  });
});

// ── AnalyticsConsent ─────────────────────────────────────────────────────

describe('AnalyticsConsent', () => {
  it('EEA visitor on RoboApply: banner with equal-weight choices; no anonId until Allow', async () => {
    renderWithBrand(<AnalyticsConsent country="DE" />);
    const region = await screen.findByRole('region', { name: 'Usage statistics choice' });
    expect(region).toHaveTextContent("RoboApply's own database");
    expect(cookie(ANON_ID_COOKIE)).toBeNull();
    const allow = screen.getByRole('button', { name: 'Allow' });
    const reject = screen.getByRole('button', { name: "Don't allow" });
    expect(allow.className).toBe(reject.className);
    fireEvent.click(allow);
    expect(cookie(ANALYTICS_CONSENT_COOKIE)).toBe('granted');
    expect(cookie(ANON_ID_COOKIE)).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Usage statistics choice' })).toBeNull();
  });

  // Wave FIX carry-over: the banner covered "Already have an account? Sign in" on /signup at 1280×900.
  it('while open it publishes the room it takes at the bottom of the window, and clears it once a choice is made', async () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const banner = this.hasAttribute('data-analytics-consent');
      // A 96px banner docked 16px above the bottom edge of the window.
      const top = banner ? window.innerHeight - 112 : 0;
      return { top, bottom: top + (banner ? 96 : 0), left: 0, right: 0, width: 0, height: banner ? 96 : 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    try {
      const root = document.documentElement;
      expect(root.style.getPropertyValue(CONSENT_RESERVE_VAR)).toBe('');
      renderWithBrand(<AnalyticsConsent country="DE" />);
      await screen.findByRole('region', { name: 'Usage statistics choice' });
      // Height + distance from the bottom edge + a 12px gap.
      await waitFor(() => expect(root.style.getPropertyValue(CONSENT_RESERVE_VAR)).toBe('124px'));
      fireEvent.click(screen.getByRole('button', { name: "Don't allow" }));
      expect(root.style.getPropertyValue(CONSENT_RESERVE_VAR)).toBe('');
    } finally {
      rect.mockRestore();
    }
  });

  it('the sign-in layout keeps that room under the card, and on two columns the banner docks under the brand panel', () => {
    const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
    // One column: a reserve element under the card, as tall as the banner says (0 without a banner).
    expect(read('app/(public)/layout.tsx')).toMatch(/\{children\}\s*<div className=\{styles\.consentReserve\}/);
    const auth = read('components/features/auth/auth.module.css');
    expect(auth).toMatch(/\.consentReserve \{[^}]*height: var\(--analytics-consent-h, 0px\)/);
    expect(CONSENT_RESERVE_VAR).toBe('--analytics-consent-h');
    // Two columns: the banner leaves the form's half of the window.
    const growth = read('components/features/growth/growth.module.css');
    const desktop = /@media \(min-width: 1024px\) \{\s*:global\(body:has\(\.auth-split\)\) \.consent \{([^}]*)\}/.exec(growth)?.[1] ?? '';
    expect(desktop).toContain('right: auto');
    expect(desktop).toMatch(/width: calc\(50vw/);
    // The split layout switches to two columns at the same width.
    expect(read('styles/auth.css')).toMatch(/@media \(min-width: 1024px\) \{\s*\.auth-split \{\s*grid-template-columns: 1fr 1fr;/);
  });

  it('Reject keeps the visitor unlinked and the banner can be reopened', async () => {
    renderWithBrand(<AnalyticsConsent country="IE" />);
    fireEvent.click(await screen.findByRole('button', { name: "Don't allow" }));
    expect(cookie(ANALYTICS_CONSENT_COOKIE)).toBe('denied');
    expect(cookie(ANON_ID_COOKIE)).toBeNull();
    act(() => requestAnalyticsConsentReview());
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
  });

  it('does not ask again once a choice is stored', async () => {
    document.cookie = `${ANALYTICS_CONSENT_COOKIE}=denied; Path=/`;
    renderWithBrand(<AnalyticsConsent country="FR" />);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('US visitor: no banner, anonId set at once', async () => {
    renderWithBrand(<AnalyticsConsent country="US" />);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('region')).toBeNull();
    expect(cookie(ANON_ID_COOKIE)).not.toBeNull();
  });

  it('GoApply never shows the banner', async () => {
    renderWithBrand(<AnalyticsConsent country="DE" />, { brand: 'goapply' });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('region')).toBeNull();
  });
});

// ── GettingStartedChecklist ──────────────────────────────────────────────

function view(over: Partial<ChecklistView> = {}): ChecklistView {
  return {
    steps: { tailor: false, practice: false, save_job: false },
    rewarded: false,
    dismissed: false,
    reward: { bucket: 'practice', credits: 1 },
    ...over,
  };
}

describe('GettingStartedChecklist', () => {
  it('shows server progress, the reward size from the server, and links to each open step', async () => {
    getChecklist.mockResolvedValue(view({ steps: { tailor: false, practice: false, save_job: true } }));
    renderWithBrand(<GettingStartedChecklist />);
    expect(await screen.findByRole('heading', { name: 'Get started' })).toBeInTheDocument();
    expect(screen.getByText('Finish all three to get 1 practice interview credit.')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pick a job' })).toHaveAttribute('href', '/jobs');
    expect(screen.getByRole('link', { name: 'Practice' })).toHaveAttribute('href', '/practice');
    expect(screen.queryByRole('link', { name: 'Browse jobs' })).toBeNull();
    expect(screen.getByText(/Save a job for later/)).toHaveTextContent('Done');
    // Nothing here completes a step: the only buttons are links and Close.
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Hide the getting-started list']);
  });

  it('closing hides it and is stored on the server', async () => {
    getChecklist.mockResolvedValue(view());
    dismissChecklist.mockResolvedValue(view({ dismissed: true }));
    renderWithBrand(<GettingStartedChecklist variant="compact" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide the getting-started list' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull());
    expect(dismissChecklist).toHaveBeenCalledTimes(1);
  });

  it('says the reward was added only when the server granted it', async () => {
    getChecklist.mockResolvedValue(view({ steps: { tailor: true, practice: true, save_job: true }, rewarded: true }));
    const { unmount } = renderWithBrand(<GettingStartedChecklist />);
    expect(await screen.findByRole('status')).toHaveTextContent('1 practice interview credit was added to your account.');
    unmount();
    getChecklist.mockResolvedValue(view({ steps: { tailor: true, practice: true, save_job: true }, rewarded: false }));
    renderWithBrand(<GettingStartedChecklist />);
    expect(await screen.findByRole('status')).toHaveTextContent('has not been added yet');
  });

  it('renders nothing when dismissed, signed out or not available', async () => {
    getChecklist.mockResolvedValue(view({ dismissed: true }));
    const a = renderWithBrand(<GettingStartedChecklist />);
    await waitFor(() => expect(getChecklist).toHaveBeenCalled());
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    getChecklist.mockRejectedValue(new RoboApiError('off', { code: 'feature_disabled', status: 404, payload: { code: 'feature_disabled' } }));
    const b = renderWithBrand(<GettingStartedChecklist />);
    await waitFor(() => expect(getChecklist).toHaveBeenCalledTimes(2));
    expect(b.container).toBeEmptyDOMElement();
  });
});
