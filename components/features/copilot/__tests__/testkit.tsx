// components/features/copilot/__tests__/testkit.tsx — helpers for the
// Assistant tests (WP-51). Not imported by app code.
//
// A fetch double keyed by "METHOD /path", SSE response builders that split a
// stream into arbitrary chunks, a provider wrapper (QueryClient + next-intl
// with the staged English + a brand with resolved flags), a synchronous popup
// gate, and fictional fixtures. No network, no database.

import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';

import { BrandProvider, clientBrandFor, type BrandId } from '../../../../lib/brand';
import { IntlWrapper } from '../../../../__tests__/utils/mockTranslations';
import { capsFor } from '../../../../__tests__/shell/helpers';
import { __setPopupGate, createPopupGate } from '../../../../lib/ui/popupGate';
import type { ResolvedFlags } from '../../../../server/src/platform/flags';
import type { CopilotCard } from '../../../../lib/api/contracts/copilot';

export interface RecordedCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
  headers: Record<string, string>;
  signal?: AbortSignal | null;
}

export type Route = (call: RecordedCall) => Response | Promise<Response>;

export const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, data }), { status, headers: { 'Content-Type': 'application/json' } });

export const noContent = () => new Response(null, { status: 204 });

export const fail = (status: number, code: string, details?: unknown) =>
  new Response(JSON.stringify({ success: false, code, error: code, details }), { status, headers: { 'Content-Type': 'application/json' } });

/** One SSE event as text. */
export const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A streaming Response whose body yields exactly these chunks (strings or raw bytes). */
export function streamResponse(chunks: Array<string | Uint8Array>, opts: { signal?: AbortSignal | null; hold?: boolean } = {}): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      if (!opts.hold) controller.close();
      opts.signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        } catch {
          // already closed
        }
      });
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Split a string into pieces of `size` characters (to cut events anywhere). */
export function pieces(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

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
        headers: (init.headers as Record<string, string>) ?? {},
        signal: init.signal,
      };
      calls.push(call);
      if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const route = routes[`${call.method} ${call.path}`];
      return route ? route(call) : fail(404, 'not_found');
    }),
  );
  return {
    calls,
    to: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
  };
}

/** A popup gate that decides synchronously. */
export function installPopupGate() {
  const gate = createPopupGate({
    now: () => Date.now(),
    loadLocal: () => null,
    saveLocal: () => undefined,
    persist: () => undefined,
    schedule: (fn) => fn(),
  });
  gate.notePageView('/jobs');
  __setPopupGate(gate);
  return gate;
}

export function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
}

export function renderUi(
  ui: ReactElement,
  opts: { brand?: BrandId; flags?: Partial<ResolvedFlags>; client?: QueryClient } = {},
) {
  const client = opts.client ?? makeClient();
  const brand = opts.brand ?? 'roboapply';
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <IntlWrapper>
          <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={capsFor(brand, { copilot: true, ...(opts.flags ?? {}) })}>
            {children}
          </BrandProvider>
        </IntlWrapper>
      </QueryClientProvider>
    );
  }
  return { client, ...render(ui, { wrapper: Wrapper }) };
}

export const card = <T,>(type: string, data: T, over: Partial<CopilotCard> = {}): CopilotCard =>
  ({ type, id: `card_${type}`, data, ...over }) as CopilotCard;

export const UI_STATE = (values: Record<string, string> = {}, dismissals: Record<string, { count: number; at: string }> = {}) => ({
  state: { tours: {}, dismissals, popupLastShownAt: null, announcementsSeen: [], values },
  lastFeedVisitAt: null,
  updatedAt: null,
});

export const CREDITS = (remaining = 12) => ({
  summary: {
    plan: 'free',
    upgradable: true,
    buckets: {
      assistant: { window: 'day', cap: 30, used: 30 - remaining, remaining, grantRemaining: 0, resetsAt: '2026-10-11T00:00:00.000Z' },
      tailor: { window: 'day', cap: 3, used: 1, remaining: 2, grantRemaining: 0, resetsAt: '2026-10-11T00:00:00.000Z' },
      cover_letter: { window: 'day', cap: 3, used: 0, remaining: 3, grantRemaining: 0, resetsAt: '2026-10-11T00:00:00.000Z' },
    },
  },
  practice: null,
});

export const PROFILE = (over: Record<string, unknown> = {}) => ({
  id: 'sp_main',
  name: '',
  isDefault: true,
  isActive: true,
  version: 3,
  schemaVersion: 1,
  filters: { workModels: ['remote'] },
  alertInstantMax: 0,
  alertDigest: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

export const PROFILES = (profiles = [PROFILE()]) => ({ profiles, maxProfiles: 1, maxInstantAlerts: 1, proMaxProfiles: 10, upgradable: true });

export const MEMORY_CONSENT = (granted: boolean | null) => ({
  items: [
    {
      type: 'copilot_memory',
      required: false,
      stage: 'in_context',
      control: 'toggle',
      withdrawable: true,
      onWithdraw: 'none',
      defaultGranted: false,
      prose: 'Let the Assistant remember preferences I tell it, for later conversations. You can review and delete them anytime.',
      proseVersion: 'v1',
      proseHash: 'h1',
      proseLocale: 'en',
      granted,
      answeredAt: null,
    },
  ],
});

/** The consent catalog with GoApply's AI consent (`ai_resume_parsing`, what aiAllowed reads) and, optionally, memory. */
export const CONSENTS = (ai: boolean | null, memory?: boolean | null) => ({
  items: [
    {
      type: 'ai_resume_parsing',
      required: false,
      stage: 'signup',
      control: 'toggle',
      withdrawable: true,
      onWithdraw: 'none',
      defaultGranted: false,
      prose: 'Use AI to read my resume and prepare application materials.',
      proseVersion: 'v1',
      proseHash: 'h0',
      proseLocale: 'en',
      granted: ai,
      answeredAt: null,
    },
    ...(memory === undefined ? [] : MEMORY_CONSENT(memory).items),
  ],
});
