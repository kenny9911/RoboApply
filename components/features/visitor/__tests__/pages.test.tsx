// WP-78 routes: /tools/job-alerts (static beside /tools/[tool]) renders the
// alerts form in HybridShell with the site footer, prefilled from the URL
// (clamped; a bad country is dropped), indexed on either brand while its
// `jobs.alerts` capability is on;
// /alerts/confirm/[token] renders the confirm view with the decoded token,
// never indexed and with no referrer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';

const brand = vi.hoisted(() => ({ id: 'roboapply' as 'roboapply' | 'goapply', locale: 'en' as 'en' | 'zh' }));
const api = vi.hoisted(() => ({ loadSitemapIndex: vi.fn() }));

vi.mock('../../../v3/shell/HybridShell', () => ({
  HybridShell: ({ children, footer, from }: { children: ReactNode; footer: ReactNode; from: string }) => (
    <div data-hybrid={from}>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock('../../marketing', () => ({ MarketingFooter: () => <footer data-testid="site-footer" /> }));
vi.mock('../../market', () => ({ LegalFooter: () => <footer data-testid="legal-footer" /> }));
vi.mock('..', () => ({
  JobAlertsForm: ({ initial }: { initial: unknown }) => <div data-testid="alerts-form" data-initial={JSON.stringify(initial)} />,
  AlertConfirm: ({ token }: { token: string }) => <div data-testid="confirm" data-token={token} />,
}));
vi.mock('../../../../lib/server/brand', () => ({ getServerBrandId: async () => brand.id }));
vi.mock('../../../../lib/serverLocale', () => ({ resolveLocale: async () => brand.locale }));
vi.mock('../../../../lib/server/publicApi', () => api);

import JobAlertsPage, { generateMetadata } from '../../../../app/tools/job-alerts/page';
import AlertsConfirmTokenPage, { metadata as confirmMeta } from '../../../../app/alerts/confirm/[token]/page';

const surfaces = (alerts?: boolean) => ({ status: 'ok' as const, data: { parts: [], surfaces: { browse: false, campus: false, ...(alerts === undefined ? {} : { alerts }) } } });

beforeEach(() => {
  api.loadSitemapIndex.mockReset();
  api.loadSitemapIndex.mockResolvedValue(surfaces(true));
});

afterEach(() => {
  cleanup();
  brand.id = 'roboapply';
  brand.locale = 'en';
});

describe('/tools/job-alerts', () => {
  it('renders the form in HybridShell with the site footer, prefilled from the URL', async () => {
    const { getByTestId, container } = render(
      await JobAlertsPage({ searchParams: Promise.resolve({ role: ' Data analyst ', city: 'Taipei', country: 'tw' }) }),
    );
    expect(JSON.parse(getByTestId('alerts-form').getAttribute('data-initial')!)).toEqual({ role: 'Data analyst', city: 'Taipei', country: 'TW' });
    expect(getByTestId('site-footer')).toBeTruthy();
    expect(container.querySelector('[data-hybrid="tools"]')).not.toBeNull();
    cleanup();
    const bad = render(await JobAlertsPage({ searchParams: Promise.resolve({ country: 'Taiwan', role: ['a', 'b'] }) }));
    expect(JSON.parse(bad.getByTestId('alerts-form').getAttribute('data-initial')!)).toEqual({});
  });

  it('metadata from visitor.alerts.meta; indexable on both brands while jobs.alerts is on', async () => {
    const robo = await generateMetadata();
    expect(String(robo.title)).toContain('Job alerts by email');
    expect(robo.robots).toMatchObject({ index: true });
    expect(api.loadSitemapIndex).toHaveBeenCalledWith('roboapply');
    brand.id = 'goapply';
    brand.locale = 'zh';
    const go = await generateMetadata();
    expect(go.robots).toMatchObject({ index: true });
    expect(String(go.alternates?.canonical)).toBe('https://www.goapply.top/tools/job-alerts');
    expect(String(go.title)).toMatch(/\| GoApply$/);
    expect(api.loadSitemapIndex).toHaveBeenLastCalledWith('goapply');
  });

  it.each(['roboapply', 'goapply'] as const)('%s: noindex when the brand has job alerts switched off', async (id) => {
    brand.id = id;
    brand.locale = id === 'goapply' ? 'zh' : 'en';
    api.loadSitemapIndex.mockResolvedValue(surfaces(false));
    expect((await generateMetadata()).robots).toMatchObject({ index: false });
  });

  it('an API without the field, a disabled answer or a failed read counts as on (the capability default)', async () => {
    brand.id = 'goapply';
    brand.locale = 'zh';
    api.loadSitemapIndex.mockResolvedValue(surfaces());
    expect((await generateMetadata()).robots).toMatchObject({ index: true });
    api.loadSitemapIndex.mockResolvedValue({ status: 'disabled' });
    expect((await generateMetadata()).robots).toMatchObject({ index: true });
    api.loadSitemapIndex.mockRejectedValue(new Error('down'));
    expect((await generateMetadata()).robots).toMatchObject({ index: true });
  });
});

describe('/alerts/confirm/[token]', () => {
  it('renders the confirm view with the decoded token, legal footer, noindex, no referrer', async () => {
    const { getByTestId, container } = render(await AlertsConfirmTokenPage({ params: Promise.resolve({ token: 'abc%2Ddef' }) }));
    expect(getByTestId('confirm').getAttribute('data-token')).toBe('abc-def');
    expect(getByTestId('legal-footer')).toBeTruthy();
    expect(container.querySelector('[data-hybrid="alerts"]')).not.toBeNull();
    expect(confirmMeta).toEqual({ robots: { index: false, follow: false }, referrer: 'no-referrer' });
  });
});
