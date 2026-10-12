// The 404 page and the two error boundaries (verify finding FIX-1 #4).
//
// They were hard-coded English ("That page does not exist … Go to Jobs" under
// <html lang="zh">), and the 404's only action sent a signed-out visitor to
// /login?next=/jobs. The `errors` namespace was already translated in all nine
// bundles; nothing read it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';
const auth: { status: AuthStatus | 'no-provider' } = { status: 'unauthenticated' };
vi.mock('../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => {
    if (auth.status === 'no-provider') throw new Error('useAuth must be used inside <AuthProvider>');
    return { status: auth.status, user: null };
  },
}));

import { loadMessages } from '../lib/i18n';
import { LOCALES } from '../lib/localeConfig';
import RouteError from './error';
import { ERROR_COPY_EN, ERROR_COPY_PATH, type ErrorCopyKey } from '../components/v3/shell/errorCopy';
import { GLOBAL_ERROR_COPY } from '../components/v3/shell/globalErrorCopy';
import GlobalError from './global-error';
import NotFound from './not-found';

type Tree = Record<string, Record<string, string>>;
const bundle = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), 'i18n/messages', `${locale}.json`), 'utf8')) as Tree;
/** `at(bundle('zh'), 'seo.job.notFound.home')` — the string at a dotted path, or undefined. */
const at = (tree: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), tree);
const COPY_KEYS = Object.keys(ERROR_COPY_EN) as ErrorCopyKey[];
/** The visitor's home link, as translated in a bundle. */
const homeLabel = (locale: string) => at(bundle(locale), ERROR_COPY_PATH.go_site_home) as string;

function inLocale(locale: string, ui: ReactNode, onError: (e: unknown) => void = (e) => { throw e; }) {
  return render(
    <NextIntlClientProvider locale={locale} messages={loadMessages(locale as never) as never} timeZone="UTC" onError={onError}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const hrefs = () => screen.getAllByRole('link').map((a) => a.getAttribute('href'));

beforeEach(() => {
  auth.status = 'unauthenticated';
});
afterEach(() => {
  vi.restoreAllMocks();
  document.cookie = 'robo_locale=; path=/; max-age=0';
});

describe('the words these pages use', () => {
  // A string that exists only as staged English renders in English under a
  // translated title in the other eight languages. Every string here must be
  // in the merged bundle of every locale — read from the files, not through
  // loadMessages, which fills gaps with English.
  it('are in all nine bundles', () => {
    for (const locale of LOCALES) {
      for (const key of COPY_KEYS) {
        const value = at(bundle(locale), ERROR_COPY_PATH[key]);
        expect(typeof value === 'string' && value.trim().length > 0, `${locale} ${ERROR_COPY_PATH[key]}`).toBe(true);
      }
    }
  });

  it('are translated, not English, outside the English bundle', () => {
    for (const locale of LOCALES) {
      if (locale === 'en') continue;
      for (const key of COPY_KEYS) {
        expect(at(bundle(locale), ERROR_COPY_PATH[key]), `${locale} ${ERROR_COPY_PATH[key]}`).not.toBe(ERROR_COPY_EN[key]);
      }
    }
  });

  it('have English fallbacks equal to what English readers get', () => {
    const en = loadMessages('en');
    for (const key of COPY_KEYS) expect(at(en, ERROR_COPY_PATH[key]), key).toBe(ERROR_COPY_EN[key]);
  });
});

describe('404 page', () => {
  it('is in the reader’s language', () => {
    inLocale('zh', <NotFound />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(bundle('zh').errors.not_found_title);
    expect(screen.getByText(bundle('zh').errors.not_found_body)).toBeInTheDocument();
    expect(screen.queryByText('That page does not exist')).toBeNull();
  });

  it('gives a visitor a home link in their language, in every locale', () => {
    for (const locale of LOCALES) {
      const view = inLocale(locale, <NotFound />);
      const link = screen.getByRole('link');
      expect(link, locale).toHaveAttribute('href', '/');
      expect(link, locale).toHaveTextContent(homeLabel(locale));
      if (locale !== 'en') expect(link.textContent, locale).not.toBe('Go to the home page');
      view.unmount();
    }
  });

  it('shows no English at all on the Chinese 404, signed in or not', () => {
    for (const status of ['unauthenticated', 'authenticated'] as const) {
      auth.status = status;
      const view = inLocale('zh', <NotFound />);
      expect(view.container.textContent, status).not.toMatch(/[A-Za-z]/);
      view.unmount();
    }
  });

  it('gives a signed-out visitor a link to the home page, not to a page behind sign-in', () => {
    inLocale('en', <NotFound />);
    expect(hrefs()).toEqual(['/']);
    expect(screen.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('link', { name: 'Go to Jobs' })).toBeNull();
  });

  it('shows the home link while the session is still loading', () => {
    auth.status = 'loading';
    inLocale('en', <NotFound />);
    expect(hrefs()).toEqual(['/']);
  });

  it('gives a signed-in user their jobs first, and the home page as well', () => {
    auth.status = 'authenticated';
    inLocale('ja', <NotFound />);
    expect(hrefs()).toEqual(['/jobs', '/']);
    expect(screen.getByRole('link', { name: bundle('ja').errors.go_home })).toHaveAttribute('href', '/jobs');
  });

  it('does not tell a visitor to go to "your jobs" in any language', () => {
    expect(bundle('en').errors.not_found_body).toBe('The address may be wrong, or the page may have moved.');
    for (const locale of LOCALES) {
      const body = bundle(locale).errors.not_found_body;
      // One sentence: the second one was the "go to your jobs" instruction.
      expect(body.split(/[.。]/).filter((s) => s.trim()).length, locale).toBe(1);
    }
  });

  it('still renders, in English, with no providers at all', () => {
    auth.status = 'no-provider';
    render(<NotFound />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('That page does not exist');
    expect(hrefs()).toEqual(['/']);
  });
});

describe('route error boundary', () => {
  const boom = Object.assign(new Error('boom'), { digest: 'd1' });

  it('is in the reader’s language', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    inLocale('zh-TW', <RouteError error={boom} reset={() => undefined} />);
    const copy = bundle('zh-TW').errors;
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(copy.error_title);
    expect(screen.getByText(copy.error_body)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.try_again })).toBeInTheDocument();
    expect(screen.queryByText('Try again')).toBeNull();
  });

  it('"Try again" re-fetches the segment when Next provides retry, and falls back to reset', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const retry = vi.fn();
    const reset = vi.fn();
    const first = inLocale('en', <RouteError error={boom} reset={reset} retry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    first.unmount();

    inLocale('en', <RouteError error={boom} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('sends a visitor home and a signed-in user to their jobs', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const visitor = inLocale('en', <RouteError error={boom} reset={() => undefined} />);
    expect(hrefs()).toEqual(['/']);
    visitor.unmount();

    const visitorDe = inLocale('de', <RouteError error={boom} reset={() => undefined} />);
    expect(screen.getByRole('link', { name: homeLabel('de') })).toHaveAttribute('href', '/');
    expect(screen.queryByText('Go to the home page')).toBeNull();
    visitorDe.unmount();

    auth.status = 'authenticated';
    inLocale('en', <RouteError error={boom} reset={() => undefined} />);
    expect(hrefs()).toEqual(['/jobs']);
  });

  it('cannot throw: no providers, or a translation layer that throws, both give English', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    auth.status = 'no-provider';
    const bare = render(<RouteError error={boom} reset={() => undefined} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Something on this page failed to load');
    bare.unmount();

    // Development makes every intl error throw (app/providers.tsx onIntlError).
    render(
      <NextIntlClientProvider locale="en" messages={{}} timeZone="UTC" onError={(e) => { throw e; }}>
        <RouteError error={boom} reset={() => undefined} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Something on this page failed to load');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('global error page', () => {
  // It replaces the root layout, so it has no provider and carries its own copy.
  it('carries the same words as the bundles, for every locale', () => {
    for (const locale of LOCALES) {
      const copy = bundle(locale).errors;
      expect(GLOBAL_ERROR_COPY[locale], locale).toEqual({ title: copy.error_title, body: copy.error_body, tryAgain: copy.try_again });
    }
  });

  // <html> cannot be rendered inside a test container, so read the pieces.
  function renderGlobal(props: { reset?: () => void; retry?: () => void }) {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return render(<GlobalError error={new Error('boom')} reset={props.reset ?? (() => undefined)} retry={props.retry} />, {
      container: document.documentElement,
      baseElement: document.documentElement,
    });
  }

  it('uses the language of the robo_locale cookie once mounted', async () => {
    document.cookie = 'robo_locale=zh; path=/';
    let view: ReturnType<typeof renderGlobal> | undefined;
    await act(async () => {
      view = renderGlobal({});
    });
    expect(document.documentElement.lang).toBe('zh');
    expect(document.querySelector('h1')?.textContent).toBe(bundle('zh').errors.error_title);
    expect(document.querySelector('button')?.textContent).toBe(bundle('zh').errors.try_again);
    view?.unmount();
  });

  it('is English without a cookie or a browser language it knows, and retries', async () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['xx-XX']);
    const retry = vi.fn();
    let view: ReturnType<typeof renderGlobal> | undefined;
    await act(async () => {
      view = renderGlobal({ retry });
    });
    expect(document.documentElement.lang).toBe('en');
    expect(document.querySelector('h1')?.textContent).toBe('Something on this page failed to load');
    fireEvent.click(document.querySelector('button')!);
    expect(retry).toHaveBeenCalledTimes(1);
    view?.unmount();
  });
});
