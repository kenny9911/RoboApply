// components/features/feed/feed.testkit.tsx — test helpers for the feed UI
// tests (WP-33). Not imported by app code.
//
// A fetch double keyed by "METHOD /path" (pathname only), a provider wrapper
// (QueryClient + next-intl with the staged English + a brand with resolved
// flags), a synchronous popup gate, and FeedItem / profile fixtures with
// fictional data.

import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';

import { BrandProvider, clientBrandFor, type BrandId } from '../../../lib/brand';
import { IntlWrapper } from '../../../__tests__/utils/mockTranslations';
import { capsFor } from '../../../__tests__/shell/helpers';
import { __setPopupGate, createPopupGate } from '../../../lib/ui/popupGate';
import type { FeedItem, FeedQueryResponse } from '../../../lib/api/contracts/feed';
import type { SearchProfileListWire, SearchProfileWire } from '../../../lib/api/contracts/search';
import type { ResolvedFlags } from '../../../server/src/platform/flags';

export interface RecordedCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

export type Route = (call: RecordedCall) => Response | Promise<Response>;

export const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, data }), { status, headers: { 'Content-Type': 'application/json' } });

export const fail = (status: number, code: string, details?: unknown) =>
  new Response(JSON.stringify({ success: false, code, error: code, details }), { status, headers: { 'Content-Type': 'application/json' } });

/** The server's real envelope for an area reason: generic platform `code`, the reason in `details.reason` (platform/http.ts mapError). */
export const failReason = (status: 409 | 429, reason: string, extra: Record<string, unknown> = {}) =>
  fail(status, status === 429 ? 'rate_limited' : 'conflict', { reason, ...extra });

/** Install a fetch double. Unknown routes answer 404. */
export function installFetch(routes: Record<string, Route>) {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(String(url), 'http://localhost');
      const call: RecordedCall = {
        method: (init.method ?? 'GET').toUpperCase(),
        path: u.pathname,
        search: u.search,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      return route ? route(call) : fail(404, 'not_found');
    }),
  );
  return {
    calls,
    to: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
  };
}

/** A fictional feed item. */
export function feedItem(n: number, over: Partial<FeedItem> = {}): FeedItem {
  return {
    jobId: `job_${n}`,
    title: `Backend engineer ${n}`,
    company: { id: `co_${n}`, name: `Example Co ${n}`, logoUrl: null },
    location: 'Berlin, Germany',
    workModel: 'hybrid',
    employmentType: 'full_time',
    seniority: 'mid',
    pay: { min: 70000, max: 90000, currency: 'EUR', period: 'year', text: null },
    postedAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-10-09T00:00:00.000Z',
    source: { name: 'Example Jobs API', kind: 'provider' },
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: false,
    badges: [],
    fit: { tier: 'good', score: 72, kind: 'pre', topGap: 'They ask for Kubernetes; your resume does not mention it.', topOverlap: 'Your Go work lines up with the post.' },
    tracker: null,
    ...over,
  };
}

export function page(items: FeedItem[], over: Partial<FeedQueryResponse> = {}): FeedQueryResponse {
  return { items, cursor: null, endOfFeed: true, hiddenByTier: 0, sessionId: 'fs_1', ...over };
}

export function searchProfile(over: Partial<SearchProfileWire> = {}): SearchProfileWire {
  return {
    id: 'sp_main',
    name: '',
    isDefault: true,
    isActive: true,
    version: 3,
    schemaVersion: 1,
    filters: {},
    alertInstantMax: 0,
    alertDigest: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

export function profileList(profiles: SearchProfileWire[]): SearchProfileListWire {
  return { profiles, maxProfiles: 1, maxInstantAlerts: 1, proMaxProfiles: 10, upgradable: true };
}

export const EMPTY_UI_STATE = {
  state: { tours: {}, dismissals: {}, popupLastShownAt: null, announcementsSeen: [], values: {} },
  lastFeedVisitAt: null,
  updatedAt: null,
};

/** A popup gate that decides synchronously. `deny` = the view's slot is already taken. */
export function installPopupGate({ deny = false }: { deny?: boolean } = {}) {
  const gate = createPopupGate({
    now: () => Date.now(),
    loadLocal: () => null,
    saveLocal: () => undefined,
    persist: () => undefined,
    schedule: (fn) => fn(),
  });
  gate.notePageView('/jobs');
  if (deny) void gate.request('other:prompt', 'offer', { essential: true });
  __setPopupGate(gate);
  return gate;
}

export function renderFeed(
  ui: ReactElement,
  opts: { brand?: BrandId; flags?: Partial<ResolvedFlags>; client?: QueryClient } = {},
) {
  const client = opts.client ?? new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const brand = opts.brand ?? 'roboapply';
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <IntlWrapper>
          <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={capsFor(brand, { 'jobs.feed': true, ...(opts.flags ?? {}) })}>
            {children}
          </BrandProvider>
        </IntlWrapper>
      </QueryClientProvider>
    );
  }
  return { client, ...render(ui, { wrapper: Wrapper }) };
}
