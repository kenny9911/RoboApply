// Root layout per brand (ARCHITECTURE.md §1.5, TASK_PLAN.md FND-2b):
// generateMetadata differs per brand, <html data-brand>, a bundle string with
// %BRAND% renders "GoApply" on the goapply host, the two root slots are
// mounted, and the client brand/flag hooks behave (fail closed).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

const request = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  cookies: {} as Record<string, string>,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(request.headers),
  cookies: async () => ({
    get: (name: string) => (request.cookies[name] ? { name, value: request.cookies[name] } : undefined),
  }),
}));
vi.mock('next/font/local', () => ({
  default: () => ({ variable: 'font-var', className: 'font-class', style: {} }),
}));

import RootLayout, { generateMetadata, generateViewport } from '../../app/layout';
import { Providers } from '../../app/providers';
import { WrongBrandNudge } from '../../components/features/brand/WrongBrandNudge';
import { AnalyticsConsent } from '../../components/features/growth/AnalyticsConsent';
import { BrandProvider, useBrand } from '../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../lib/brand/client';
import { baiduVerification, brandTitleTemplate, buildRootMetadata } from '../../lib/brand/metadata';
import { getBrand } from '../../lib/brand/registry.generated';
import { useCapabilities, useFlag, useHiringContactsMode, useSetUserFlags } from '../../lib/flags';
import { getRequestCountry, getServerBrand } from '../../lib/server/brand';

function onHost(host: string, extra: Record<string, string> = {}) {
  request.headers = { host, ...extra };
  request.cookies = {};
}

/** Depth-first search of a React element tree. */
function findElement(node: unknown, pred: (el: ReactElement) => boolean): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, pred);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (pred(node)) return node;
  return findElement((node.props as { children?: unknown }).children, pred);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ success: false, code: 'AUTH_REQUIRED' }), { status: 401 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('generateMetadata / generateViewport per brand', () => {
  it('RoboApply keeps its former head metadata', async () => {
    onHost('www.roboapply.io');
    const meta = await generateMetadata();
    expect(String(meta.metadataBase)).toBe('https://www.roboapply.io/');
    expect(meta.title).toBe('RoboApply');
    expect(meta.icons).toEqual({ icon: '/roboapply-mark.svg', shortcut: '/roboapply-mark.svg', apple: '/roboapply-logo.png' });
    expect(meta.verification).toBeUndefined();
  });

  it('GoApply gets its own origin, name and icons', async () => {
    onHost('goapply.localhost:3621');
    const meta = await generateMetadata();
    expect(String(meta.metadataBase)).toBe('https://www.goapply.top/');
    expect(meta.title).toBe('GoApply');
    expect(meta.applicationName).toBe('GoApply');
    expect(meta.icons).toMatchObject({ icon: '/goapply-mark.svg' });
    const viewport = await generateViewport();
    expect(viewport.themeColor).toEqual([
      { media: '(prefers-color-scheme: light)', color: getBrand('goapply').theme.themeColorLight },
      { media: '(prefers-color-scheme: dark)', color: getBrand('goapply').theme.themeColorDark },
    ]);
  });

  it('adds Baidu verification only for brands indexed by Baidu and only when configured', () => {
    const env = { BAIDU_SITE_VERIFICATION: 'code-123' };
    expect(baiduVerification(getBrand('roboapply'), env)).toBeNull();
    expect(baiduVerification(getBrand('goapply'), {})).toBeNull();
    expect(buildRootMetadata(getBrand('goapply'), env).verification).toEqual({ other: { 'baidu-site-verification': 'code-123' } });
    expect(buildRootMetadata(getBrand('roboapply'), env).verification).toBeUndefined();
    expect(brandTitleTemplate(getBrand('goapply'))).toBe('%s · GoApply');
  });
});

describe('lib/server/brand', () => {
  it('reads the proxy stamp on dev hosts and the host in production', async () => {
    onHost('localhost:3621', { 'x-ra-brand': 'goapply' });
    expect((await getServerBrand()).id).toBe('goapply');
    onHost('goapply.top');
    expect((await getServerBrand()).id).toBe('goapply');
  });

  it('reads the visitor country from edge headers', async () => {
    onHost('roboapply.io', { 'x-vercel-ip-country': 'cn' });
    expect(await getRequestCountry()).toBe('CN');
    onHost('roboapply.io', { 'x-vercel-ip-country': 'not-a-country' });
    expect(await getRequestCountry()).toBeNull();
  });
});

describe('RootLayout', () => {
  async function layoutFor(host: string, extra: Record<string, string> = {}) {
    onHost(host, extra);
    return (await RootLayout({ children: <p>page</p> })) as ReactElement<Record<string, unknown>>;
  }

  it('sets <html data-brand> and the brand default locale', async () => {
    const go = await layoutFor('goapply.localhost:3621');
    expect(go.props['data-brand']).toBe('goapply');
    expect(go.props.lang).toBe('zh');
    const robo = await layoutFor('localhost:3621');
    expect(robo.props['data-brand']).toBe('roboapply');
    expect(robo.props.lang).toBe('en');
  });

  it('clamps a locale the brand does not serve (cookie zh-TW on GoApply → zh)', async () => {
    onHost('goapply.localhost:3621');
    request.cookies = { robo_locale: 'zh-TW' };
    const el = (await RootLayout({ children: null })) as ReactElement<Record<string, unknown>>;
    expect(el.props.lang).toBe('zh');
  });

  it('mounts the wrong-brand nudge and analytics consent slots with the visitor country', async () => {
    const el = await layoutFor('www.roboapply.io', { 'x-vercel-ip-country': 'CN' });
    const nudge = findElement(el, (n) => n.type === WrongBrandNudge);
    const consent = findElement(el, (n) => n.type === AnalyticsConsent);
    expect(nudge?.props).toEqual({ country: 'CN', locale: 'en' });
    expect(consent?.props).toEqual({ country: 'CN' });
  });

  it('a bundle string with %BRAND% renders "GoApply" on the goapply host', async () => {
    const el = await layoutFor('goapply.localhost:3621');
    const providers = findElement(el, (n) => n.type === Providers);
    expect(providers).not.toBeNull();
    const props = providers!.props as { locale: string; messages: Record<string, unknown>; brand: { id: string } };
    expect(props.brand.id).toBe('goapply');

    function Probe() {
      const t = useTranslations('common');
      const brand = useBrand();
      return (
        <p>
          {t('app_name')} / {brand.name}
        </p>
      );
    }
    render(
      <Providers locale={props.locale} messages={props.messages} brand={props.brand as never}>
        <Probe />
      </Providers>,
    );
    expect(screen.getByText('GoApply / GoApply')).toBeInTheDocument();
  });

  it('the same string renders "RoboApply" on the roboapply host', async () => {
    const el = await layoutFor('www.roboapply.io');
    const providers = findElement(el, (n) => n.type === Providers)!;
    const props = providers.props as { locale: string; messages: Record<string, unknown> };
    function Probe() {
      return <p>{useTranslations('auth.login')('subtitle')}</p>;
    }
    render(
      <Providers locale={props.locale} messages={props.messages}>
        <Probe />
      </Providers>,
    );
    expect(screen.getByText('Sign in to RoboApply.')).toBeInTheDocument();
  });
});

describe('root slot stubs', () => {
  it('render nothing until WP-12 / WP-23 fill them', () => {
    const { container } = render(
      <>
        <WrongBrandNudge country="CN" locale="zh" />
        <AnalyticsConsent country="DE" />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('useBrand / useFlag', () => {
  function wrap(children: ReactNode, opts: { brand?: 'roboapply' | 'goapply'; seed?: Record<string, unknown> | null } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={client}>
        <BrandProvider brand={clientBrandFor(opts.brand ?? 'roboapply')} initialCapabilities={(opts.seed ?? null) as never}>
          {children}
        </BrandProvider>
      </QueryClientProvider>
    );
  }

  it('useBrand falls back to RoboApply outside a provider', () => {
    function Name() {
      return <span>{useBrand().name}</span>;
    }
    render(<Name />);
    expect(screen.getByText('RoboApply')).toBeInTheDocument();
  });

  it('fails closed while the capability request fails', async () => {
    function Coaching() {
      const on = useFlag('coaching');
      const mode = useHiringContactsMode();
      const { status } = useCapabilities();
      return <span>{`${on}|${mode}|${status}`}</span>;
    }
    render(wrap(<Coaching />));
    expect(screen.getByText('false|off|loading')).toBeInTheDocument();
    // One retry (≈1 s back-off) before the query reports an error.
    await waitFor(() => expect(screen.getByText('false|off|error')).toBeInTheDocument(), { timeout: 4000 });
  });

  it('reads the public brand payload for the current brand', async () => {
    const payload = {
      id: 'goapply',
      name: 'GoApply',
      flags: { coaching: false, copilot: true, hiringContacts: 'deeplinks_only' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(String(url)).toContain('/api/v1/public/brand');
        return new Response(JSON.stringify({ success: true, data: payload }), { status: 200 });
      }),
    );
    function Flags() {
      return <span>{`${useFlag('copilot')}|${useFlag('coaching')}|${useHiringContactsMode()}`}</span>;
    }
    render(wrap(<Flags />, { brand: 'goapply' }));
    await waitFor(() => expect(screen.getByText('true|false|deeplinks_only')).toBeInTheDocument());
  });

  it('ignores a payload for another brand and lets /auth/me flags win', async () => {
    const seed = { id: 'roboapply', name: 'RoboApply', flags: { copilot: true, hiringContacts: 'on' } };
    function Flags() {
      const set = useSetUserFlags();
      return (
        <>
          <span>{`${useFlag('copilot')}|${useFlag('coaching')}`}</span>
          <button type="button" onClick={() => set({ copilot: true, coaching: true, hiringContacts: 'off' } as never)}>
            me
          </button>
        </>
      );
    }
    render(wrap(<Flags />, { brand: 'goapply', seed }));
    expect(screen.getByText('false|false')).toBeInTheDocument();
    screen.getByRole('button', { name: 'me' }).click();
    await waitFor(() => expect(screen.getByText('true|true')).toBeInTheDocument());
  });

  it('a seeded payload is used without a request', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const seed = { id: 'roboapply', name: 'RoboApply', flags: { coaching: true, hiringContacts: 'off' } };
    function Flag() {
      return <span>{String(useFlag('coaching'))}</span>;
    }
    render(wrap(<Flag />, { seed }));
    expect(screen.getByText('true')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
