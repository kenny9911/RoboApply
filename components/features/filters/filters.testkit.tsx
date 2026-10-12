// components/features/filters/filters.testkit.tsx — test helpers for the
// filters and saved-search tests (WP-20). Not imported by app code.
//
// A fetch double keyed by "METHOD /path", a provider wrapper (QueryClient +
// next-intl with the staged English + a brand), and profile fixtures
// (fictional data).

import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import type { AbstractIntlMessages } from 'next-intl';

import enMessages from '../../../i18n/messages/en.json';

import { BrandProvider, clientBrandFor, type BrandId } from '../../../lib/brand';
import { IntlWrapper } from '../../../__tests__/utils/mockTranslations';
import type { SearchProfile, SearchProfileList } from '../../../hooks/search/useSearchProfiles';

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

/** Install a fetch double. `routes` keys are "METHOD /path" (pathname only). Unknown routes answer 404. */
export function installFetch(routes: Record<string, Route>) {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(url, 'http://localhost');
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
    writes: () => calls.filter((c) => c.method !== 'GET'),
    to: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
  };
}

export function profile(over: Partial<SearchProfile> = {}): SearchProfile {
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

export function list(profiles: SearchProfile[], over: Partial<SearchProfileList> = {}): SearchProfileList {
  return { profiles, maxProfiles: 1, maxInstantAlerts: 1, proMaxProfiles: 10, upgradable: true, ...over };
}

/** Taxonomy tree route body with a couple of real ids. */
export const TAXONOMY_TREE = {
  version: 1,
  asOf: '2026-10-01',
  locale: 'en',
  nodes: [
    { id: 'software_engineering', level: 1, parent: null, label: 'Software engineering' },
    { id: 'backend_engineer', level: 3, parent: 'swe_backend', label: 'Backend engineer' },
  ],
  suggestions: [],
  sources: [],
};

/** English messages with a few keys replaced (a locale's translated names), for tests of translated labels. */
function messagesWith(over: Record<string, unknown> | undefined): AbstractIntlMessages | undefined {
  if (!over) return undefined;
  const merge = (base: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(src)) {
      const prev = out[k];
      out[k] = v && typeof v === 'object' && prev && typeof prev === 'object' ? merge(prev as Record<string, unknown>, v as Record<string, unknown>) : v;
    }
    return out;
  };
  return merge(JSON.parse(JSON.stringify(enMessages)), over) as AbstractIntlMessages;
}

export function renderWith(ui: ReactElement, opts: { brand?: BrandId; client?: QueryClient; locale?: string; messages?: Record<string, unknown> } = {}) {
  const messages = messagesWith(opts.messages);
  const client = opts.client ?? new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <IntlWrapper locale={opts.locale} {...(messages ? { messages } : {})}>
          <BrandProvider brand={clientBrandFor(opts.brand ?? 'roboapply')}>{children}</BrandProvider>
        </IntlWrapper>
      </QueryClientProvider>
    );
  }
  return { client, ...render(ui, { wrapper: Wrapper }) };
}
