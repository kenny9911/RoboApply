// WP-78 routes: /tools/job-alerts (static beside /tools/[tool]) renders the
// alerts form in HybridShell with the site footer, prefilled from the URL
// (clamped; a bad country is dropped) and noindex on GoApply;
// /alerts/confirm/[token] renders the confirm view with the decoded token,
// never indexed and with no referrer.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';

const brand = vi.hoisted(() => ({ id: 'roboapply' as 'roboapply' | 'goapply' }));

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
vi.mock('../../../../lib/serverLocale', () => ({ resolveLocale: async () => 'en' }));

import JobAlertsPage, { generateMetadata } from '../../../../app/tools/job-alerts/page';
import AlertsConfirmTokenPage, { metadata as confirmMeta } from '../../../../app/alerts/confirm/[token]/page';

afterEach(() => {
  cleanup();
  brand.id = 'roboapply';
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

  it('metadata from visitor.alerts.meta; indexable on RoboApply, not on GoApply', async () => {
    const robo = await generateMetadata();
    expect(String(robo.title)).toContain('Job alerts by email');
    expect(robo.robots).toMatchObject({ index: true });
    brand.id = 'goapply';
    expect((await generateMetadata()).robots).toMatchObject({ index: false });
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
