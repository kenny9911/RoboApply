'use client';

// Top-level client providers. Wraps the entire tree.
//
// Order matters:
//   1. React Query — needed by AuthProvider's hooks and lib/flags.ts.
//   2. BrandProvider — the request's product brand (resolved on the server
//      by app/layout.tsx from the proxy's x-ra-brand) and the shared state
//      behind useFlag()/useCapabilities().
//   3. NextIntlClientProvider — locale + translation messages (brand tokens
//      already substituted by loadMessages(locale, brandId)) and the time
//      zone every `format.dateTime` call inherits: the VIEWER's (see
//      useViewerTimeZone below), with the brand default for the server render.
//   4. AuthProvider — exposes session state to all (auth) descendants.
//
// We deliberately resolve the locale + load messages at the server layer
// (app/layout.tsx) and pass them down so we don't ship the entire
// dictionary on every public page request.

import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { useMemo, useSyncExternalStore, type ReactNode } from 'react';

import { AuthProvider } from '../lib/auth/AuthProvider';
import { BrandProvider, type SeedCapabilities } from '../lib/brand/BrandProvider';
import { clientBrandFor, type ClientBrand } from '../lib/brand/client';
import { ThemeProvider } from '../lib/theme';

interface ProvidersProps {
  children: ReactNode;
  locale: string;
  messages: Record<string, unknown>;
  /** The request's brand (publicBrand()). Defaults to RoboApply for callers that predate brands (preview harnesses). */
  brand?: ClientBrand;
  /** Optional seed for useCapabilities() (tests, previews). */
  initialCapabilities?: SeedCapabilities | null;
}

const DEFAULT_CLIENT_BRAND = clientBrandFor();

/**
 * Make a missing translation loud in development and harmless in production.
 *
 * next-intl does NOT throw on a missing key — `lib/i18n.ts` deep-merges each
 * locale over English, and with no `onError` the library falls back to
 * rendering the literal dotted path. So a renamed namespace with one stale
 * call site ships the string `jobs.headline` to production, in nine languages,
 * and neither `next build` nor `vitest` sees anything wrong (ruling C30).
 *
 * Two defences, and this is the second:
 *   • `scripts/check-copy.mjs` reads every `t('…')` literal and fails the build
 *     if it does not resolve in en.json. That catches the static cases.
 *   • This throws in development for everything static analysis cannot see —
 *     a key built from a template literal, or a namespace chosen at runtime.
 *
 * Production only logs. A user reading a rejection-adjacent screen should see
 * an imperfect string, never a crashed page, and the same event is already
 * failing the build for whoever is about to deploy.
 */
function onIntlError(error: unknown): void {
  if (process.env.NODE_ENV === 'development') throw error;
  console.error('[i18n]', error);
}

// ── The viewer's time zone ───────────────────────────────────────────────
//
// Times are shown in the zone of the person reading them. The provider used to
// pass `brand.defaultTimezone` (UTC on RoboApply), so in UTC+8 a daily credit
// refill read "More on Oct 11" when it already was Oct 11 and a check run at
// 02:08 read "Oct 10, 6:08 PM", while surfaces that call Intl directly showed
// local time. Credits themselves refill at the user's local midnight
// (PRODUCT_PLAN.md §6.2), so the brand zone was wrong for the copy as well.
//
// The server cannot know the browser's zone. So the server render and the
// hydration pass use the brand default (same markup on both sides, no
// mismatch), and React re-renders with the browser's zone straight after —
// that is exactly the contract of useSyncExternalStore's server snapshot.
// Signed-in screens load their data after hydration, so their times never
// paint in the brand zone at all.

let cachedViewerZone: string | null | undefined;

/** The browser's IANA time zone, or null when it reports none that Intl can format with. */
export function viewerTimeZone(): string | null {
  if (cachedViewerZone !== undefined) return cachedViewerZone;
  let zone: string | null = null;
  try {
    const reported = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (reported && reported !== 'Etc/Unknown') {
      // Throws RangeError for a name this engine cannot format with.
      new Intl.DateTimeFormat('en', { timeZone: reported });
      zone = reported;
    }
  } catch {
    zone = null;
  }
  cachedViewerZone = zone;
  return zone;
}

/** Test seam: forget the cached zone. */
export function resetViewerTimeZoneForTests(): void {
  cachedViewerZone = undefined;
}

// A device changes zone while the tab sleeps (travel, a laptop reopened
// elsewhere). There is no event for it, so look again when the tab is shown.
function subscribeToViewerTimeZone(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const recheck = () => {
    if (document.visibilityState !== 'visible') return;
    cachedViewerZone = undefined;
    onChange();
  };
  document.addEventListener('visibilitychange', recheck);
  return () => document.removeEventListener('visibilitychange', recheck);
}

/** The viewer's zone on the client; `fallback` on the server, during hydration, and when the browser reports none. */
export function useViewerTimeZone(fallback: string): string {
  return useSyncExternalStore(
    subscribeToViewerTimeZone,
    () => viewerTimeZone() ?? fallback,
    () => fallback,
  );
}

export function Providers({
  children,
  locale,
  messages,
  brand = DEFAULT_CLIENT_BRAND,
  initialCapabilities = null,
}: ProvidersProps) {
  // Memoize so React Query state survives across navigation. One client per
  // tab is the recommended pattern from the next.js docs.
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
    [],
  );

  // Defensive: deep-clone messages so any namespace-wrapped JSON import
  // upstream can't leak a Module Namespace Object into the React tree.
  // Required to avoid React error #31 in the static prerender pass for
  // /404 and /500.
  const safeMessages = useMemo<Record<string, unknown>>(() => {
    try {
      return JSON.parse(JSON.stringify(messages ?? {}));
    } catch {
      return {};
    }
  }, [messages]);

  // RoboApply's default is UTC, GoApply's Asia/Shanghai; both are only the
  // server-render value and the fallback.
  const timeZone = useViewerTimeZone(brand.defaultTimezone);

  return (
    <QueryClientProvider client={queryClient}>
      <BrandProvider brand={brand} initialCapabilities={initialCapabilities}>
        <NextIntlClientProvider
          locale={locale}
          messages={safeMessages as any}
          timeZone={timeZone}
          onError={onIntlError}
        >
          <AuthProvider>
            <ThemeProvider>{children}</ThemeProvider>
          </AuthProvider>
        </NextIntlClientProvider>
      </BrandProvider>
    </QueryClientProvider>
  );
}

// Exposed for advanced consumers who need to imperatively invalidate.
export function useRoboQueryClient() {
  return useQueryClient();
}
