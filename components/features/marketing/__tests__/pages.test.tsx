// WP-40 subpages: /pricing (prices and caps from the plans API on both
// brands; "not open yet" only when that API says so; a buy button on every
// plan that can be bought), /features gating (fail closed) and GoApply's
// pages for the shared capabilities, the support contact form (only
// "sent" when the API confirms; email fallback), /help/ranking (every
// factor), /about (entity only when configured), /security (per brand).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getIndexStats: vi.fn(),
  getCreditCaps: vi.fn(),
  sendSupportMessage: vi.fn(),
  getPlans: vi.fn(),
}));
const auth = vi.hoisted(() => ({ status: 'unauthenticated' as 'loading' | 'authenticated' | 'unauthenticated' }));
vi.mock('../../../../lib/auth/useAuth', () => ({ useAuth: () => ({ status: auth.status, user: auth.status === 'authenticated' ? { id: 'u1' } : null }) }));

vi.mock('../../../../lib/api/support', () => ({
  getIndexStats: api.getIndexStats,
  getCreditCaps: api.getCreditCaps,
  sendSupportMessage: api.sendSupportMessage,
}));
vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPlans: api.getPlans }));
vi.mock('../../market', () => ({
  LegalFooter: () => <footer data-testid="legal-footer" />,
  PriceReference: () => null,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/pricing',
  useSearchParams: () => new URLSearchParams('utm_source=ads'),
  useParams: () => ({}),
}));

import { DEFAULT_CREDIT_CATALOG } from '../../../../server/src/platform/credits/catalog';
import { capsFromCatalog } from '../../../../server/src/features/support/service';
import { RoboApiError } from '../../../../lib/api/client';
import { plansView, unpricedPlansView } from '../../credits/__tests__/fixtures';
import { sortsFor } from '../../feed/SortMenu';
import { featuresFor, findFeature, OTHER_SORTS } from '../catalog';
import { AboutPage, HelpPage, RankingPage, SecurityPage } from '../CompanyPages';
import { FeaturePage } from '../FeaturePage';
import { PricingPage, checkoutHref } from '../PricingPage';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { loadMessages } from '../../../../lib/i18n';
import { messagesFor, renderMarketing } from './render';

beforeEach(() => {
  api.getPlans.mockImplementation(async () => plansView('roboapply'));
  api.getCreditCaps.mockImplementation(async () => capsFromCatalog(DEFAULT_CREDIT_CATALOG.roboapply));
  api.getIndexStats.mockResolvedValue({ openRoles: null, addedThisWeek: null, popularLists: [], asOf: '2026-10-10T00:00:00.000Z', partial: false });
});

/** RoboApply's capabilities with credentials configured (the job feed, alerts and AI are on for intl). */
const RA_ON = { 'ai.text': true, 'jobs.feed': true, 'jobs.alerts': true } as const;
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.status = 'unauthenticated';
});

/**
 * GoApply plans as GET /billing/plans sends them with a rail that can charge
 * (the default once the Alipay credential is set): every paid plan sellable.
 * `open: false` is the same catalog with no rail able to charge.
 */
function cnPlans(open = true) {
  const view = plansView('goapply');
  return {
    ...view,
    paymentsOpen: open,
    checkout: { ...view.checkout, rails: open ? ['alipay' as const] : [] },
    plans: view.plans.map((p) => ({ ...p, sellable: open && p.kind !== 'free', unsellableReason: null })),
  };
}

describe('/pricing', () => {
  it('prints every RoboApply plan from the catalog with its renewal rule', async () => {
    const { container } = renderMarketing(<PricingPage />, { flags: { ...RA_ON, copilot: true, agent: true } });
    await waitFor(() => expect(container.querySelector('[data-plan="pro_monthly"]')).not.toBeNull());
    const card = (key: string) => within(container.querySelector(`[data-plan="${key}"]`) as HTMLElement);
    expect(card('pro_monthly').getByText('$24.99 / month')).toBeInTheDocument();
    expect(card('pro_monthly').getByText(/Renews every month until you cancel/)).toBeInTheDocument();
    expect(card('pro_weekly').getByText('$9.99 / week')).toBeInTheDocument();
    // The same computed labels as the plan sheet: a whole "about" amount and the rounded-down saving.
    expect(card('pro_weekly').getByText('About $43 a month')).toBeInTheDocument();
    expect(card('pro_quarterly').getByText(/Save 26% compared with paying monthly/)).toBeInTheDocument();
    expect(card('pro_week_pass').getByText(/7 days of Pro/)).toBeInTheDocument();
    expect(card('practice_pack_5').getByText(/5 practice interviews, usable for 12 months/)).toBeInTheDocument();
    expect(screen.queryByText(/Not open yet/)).toBeNull();
    // Refunds + cancel (intl)
    expect(screen.getByRole('link', { name: 'Read the refund policy' })).toHaveAttribute('href', '/legal/refunds');
    expect(screen.getByTestId('cancel-footer-link')).toHaveAttribute('href', '/cancel');
    // CTA keeps utm_*
    expect(card('free').getByRole('link', { name: 'Start free' })).toHaveAttribute('href', '/signup?from=pricing%3Afree&utm_source=ads');
    // Every plan that can be bought has its button: sign-up for a visitor…
    expect(card('pro_monthly').getByRole('link', { name: 'Create a free account to buy' })).toHaveAttribute('href', '/signup?from=pricing%3Apro_monthly&utm_source=ads');
    expect(card('practice_pack_5').getByRole('link', { name: 'Create a free account to buy' })).toBeInTheDocument();
  });

  it('a signed-in visitor goes from a plan to checkout with that plan selected', async () => {
    auth.status = 'authenticated';
    const { container } = renderMarketing(<PricingPage />, { flags: RA_ON });
    await waitFor(() => expect(container.querySelector('[data-plan="pro_monthly"]')).not.toBeNull());
    const link = within(container.querySelector('[data-plan="pro_monthly"]') as HTMLElement).getByRole('link', { name: 'Choose this plan' });
    expect(link).toHaveAttribute('href', '/settings/billing?plan=pro_monthly#plans');
    expect(checkoutHref('pro week pass')).toBe('/settings/billing?plan=pro%20week%20pass#plans');
    expect(screen.queryByRole('link', { name: 'Create a free account to buy' })).toBeNull();
  });

  it('a plan the API sends with no amount is not printed at all: no card, no invented price, no "Price not set yet"', async () => {
    api.getPlans.mockImplementation(async () => unpricedPlansView());
    const { container } = renderMarketing(<PricingPage />);
    await waitFor(() => expect(api.getPlans).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Loading plans…')).toBeNull());
    // Only the Free card is left.
    expect(Array.from(container.querySelectorAll('[data-plan]')).map((el) => el.getAttribute('data-plan'))).toEqual(['free']);
    expect(container.textContent).not.toContain('Price not set yet');
    expect(container.textContent).not.toMatch(/\$[1-9]/);
  });

  it('prints caps from the credit catalog ("Up to N a day", never unlimited)', async () => {
    const { container } = renderMarketing(<PricingPage />, { flags: { ...RA_ON, 'notify.email': true, copilot: true, agent: true } });
    await waitFor(() => expect(container.querySelector('[data-caps-table]')).not.toBeNull());
    const table = within(container.querySelector('[data-caps-table]') as HTMLElement);
    const row = (name: string) => within(table.getByRole('row', { name: new RegExp(`^${name}`) }));
    expect(row('Tailored resumes').getByText('2 a day')).toBeInTheDocument();
    expect(row('Tailored resumes').getByText('Up to 50 a day')).toBeInTheDocument();
    expect(row('Ready-to-apply kits').getByText('Up to 30 a week')).toBeInTheDocument();
    expect(row('Saved searches').getByText('10')).toBeInTheDocument();
    expect(row('Instant job alert emails').getByText('1 a day')).toBeInTheDocument();
    expect(table.getByText('Fit analyses')).toBeInTheDocument();
    expect(screen.getByText(/The job list, fit scores and gap lines/)).toBeInTheDocument();
    expect(table.queryByText(/Form fills/)).toBeNull(); // no published extension
    expect(container.textContent).not.toMatch(/unlimited/i);
  });

  it('hides caps of features that are off', async () => {
    const { container } = renderMarketing(<PricingPage />, { flags: { copilot: false, agent: false } });
    await waitFor(() => expect(container.querySelector('[data-caps-table]')).not.toBeNull());
    expect(container.querySelector('[data-caps-table]')!.textContent).not.toMatch(/Assistant messages|Ready-to-apply kits/);
  });

  // FIX-8 carry-over: an instant alert is an email, so the row needs a mail transport too.
  it.each(['roboapply', 'goapply'] as const)('%s: the instant-alert row needs job alerts and email', async (brand) => {
    if (brand === 'goapply') {
      api.getPlans.mockImplementation(async () => cnPlans());
      api.getCreditCaps.mockImplementation(async () => capsFromCatalog(DEFAULT_CREDIT_CATALOG.goapply));
    }
    const noMail = renderMarketing(<PricingPage />, { brand, flags: { ...RA_ON, 'notify.email': false } });
    await waitFor(() => expect(noMail.container.querySelector('[data-caps-table]')).not.toBeNull());
    expect(noMail.container.querySelector('[data-cap-row="instant_alerts"]')).toBeNull();
    expect(noMail.container.querySelector('[data-cap-row="saved_searches"]')).not.toBeNull();
    noMail.unmount();
    const on = renderMarketing(<PricingPage />, { brand, flags: { ...RA_ON, 'notify.email': true } });
    await waitFor(() => expect(on.container.querySelector('[data-cap-row="instant_alerts"]')).not.toBeNull());
  });

  // D5 / D6 (G108): GoApply's page follows the plans API exactly as RoboApply's does.
  it('GoApply lists the week, month and quarter passes and the two practice packs with their CNY amounts and a buy button', async () => {
    api.getPlans.mockImplementation(async () => cnPlans());
    api.getCreditCaps.mockImplementation(async () => capsFromCatalog(DEFAULT_CREDIT_CATALOG.goapply));
    const { container } = renderMarketing(<PricingPage />, { brand: 'goapply', flags: RA_ON });
    await waitFor(() => expect(container.querySelector('[data-plan="pro_monthly"]')).not.toBeNull());
    const card = (key: string) => within(container.querySelector(`[data-plan="${key}"]`) as HTMLElement);
    const expected: Array<[string, string, string]> = [
      ['pro_week_pass', 'Member week pass', '¥12, paid once'],
      ['pro_monthly', 'Member 30-day pass', '¥39, paid once'],
      ['pro_quarterly', 'Member 90-day pass', '¥99, paid once'],
      ['practice_pack_5', 'Practice pack (5 interviews)', '¥29, paid once'],
      ['practice_pack_15', 'Practice pack (15 interviews)', '¥79, paid once'],
    ];
    for (const [key, name, price] of expected) {
      expect(card(key).getByRole('heading', { name })).toBeInTheDocument();
      expect(card(key).getByText(price)).toBeInTheDocument();
      expect(card(key).getByRole('link', { name: 'Create a free account to buy' })).toHaveAttribute('href', `/signup?from=pricing%3A${key}&utm_source=ads`);
      expect(card(key).queryByText('Not open yet')).toBeNull();
    }
    expect(card('pro_monthly').getByText('30 days of Pro. One-time payment. It does not renew automatically when it ends.')).toBeInTheDocument();
    expect(card('pro_week_pass').getByText(/7 days of Pro/)).toBeInTheDocument();
    expect(card('practice_pack_15').getByText(/15 practice interviews, usable for 12 months/)).toBeInTheDocument();
    // Nothing on the page says payments are closed, and nothing is priced in dollars.
    expect(container.querySelector('[data-pricing-not-open]')).toBeNull();
    expect(screen.queryByText(/Paid plans can't be bought yet|Not open yet/)).toBeNull();
    expect(screen.queryByText(/Refund rules will be published before paid plans open/)).toBeNull();
    expect(container.textContent).not.toMatch(/RoboApply|\$/);
    // What follows from the rail: one-time passes, their refund rules, no cancel entry.
    expect(screen.getByText('Memberships are one-time passes. They never renew automatically.')).toBeInTheDocument();
    const refunds = within(container.querySelector('[data-pass-refunds]') as HTMLElement);
    expect(refunds.getByText(/within 7 days \(week pass: within 48 hours\)/)).toBeInTheDocument();
    expect(refunds.getByText(/Practice packs: you can get a refund while no interview from the pack has been used/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask for a refund from the Help page' })).toHaveAttribute('href', '/help');
    expect(screen.queryByTestId('cancel-footer-link')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Read the refund policy' })).toBeNull();
  });

  it('GoApply, signed in: each pass leads to checkout', async () => {
    auth.status = 'authenticated';
    api.getPlans.mockImplementation(async () => cnPlans());
    const { container } = renderMarketing(<PricingPage />, { brand: 'goapply' });
    await waitFor(() => expect(container.querySelector('[data-plan="pro_quarterly"]')).not.toBeNull());
    for (const key of ['pro_week_pass', 'pro_monthly', 'pro_quarterly', 'practice_pack_5', 'practice_pack_15']) {
      expect(within(container.querySelector(`[data-plan="${key}"]`) as HTMLElement).getByRole('link', { name: 'Choose this plan' })).toHaveAttribute('href', `/settings/billing?plan=${key}#plans`);
    }
  });

  it('"Not open yet" shows only when the plans API says no plan can be bought, on either brand; prices stay', async () => {
    api.getPlans.mockImplementation(async () => cnPlans(false));
    const go = renderMarketing(<PricingPage />, { brand: 'goapply' });
    await waitFor(() => expect(go.container.querySelector('[data-plan="pro_monthly"]')).not.toBeNull());
    expect(screen.getByText(/Paid plans can't be bought yet/)).toBeInTheDocument();
    const monthly = within(go.container.querySelector('[data-plan="pro_monthly"]') as HTMLElement);
    expect(monthly.getByText('Not open yet')).toBeInTheDocument();
    expect(monthly.getByText('¥39, paid once')).toBeInTheDocument();
    expect(monthly.queryByRole('link')).toBeNull();
    go.unmount();
    // The same rule on RoboApply: no Stripe key on the deployment → the same note.
    api.getPlans.mockImplementation(async () => ({ ...plansView('roboapply'), paymentsOpen: false }));
    const ra = renderMarketing(<PricingPage />, { flags: RA_ON });
    await waitFor(() => expect(ra.container.querySelector('[data-plan="pro_monthly"]')).not.toBeNull());
    expect(within(ra.container.querySelector('[data-plan="pro_monthly"]') as HTMLElement).getByText('Not open yet')).toBeInTheDocument();
    expect(within(ra.container.querySelector('[data-plan="pro_monthly"]') as HTMLElement).queryByRole('link')).toBeNull();
  });

  it('while the plans are loading or could not be read, nothing claims payments are closed', async () => {
    let release: (v: unknown) => void = () => undefined;
    api.getPlans.mockImplementation(() => new Promise((r) => (release = r)));
    const { container } = renderMarketing(<PricingPage />, { brand: 'goapply' });
    expect(screen.getByText('Loading plans…')).toBeInTheDocument();
    expect(container.querySelector('[data-pricing-not-open]')).toBeNull();
    expect(screen.queryByText('Not open yet')).toBeNull();
    release(cnPlans());
    await waitFor(() => expect(container.querySelector('[data-plan="pro_monthly"]')).not.toBeNull());
    expect(container.querySelector('[data-pricing-not-open]')).toBeNull();
  });

  it('a plan the bundle has no name for yet shows the catalog label, never a message key', async () => {
    api.getPlans.mockImplementation(async () => {
      const view = cnPlans();
      const monthly = view.plans.find((p) => p.key === 'pro_monthly')!;
      return { ...view, plans: [...view.plans, { ...monthly, key: 'student_monthly', defaultLabel: '学生月卡', amountMinor: 2900, isDefaultSelection: false }] };
    });
    const { container } = renderMarketing(<PricingPage />, { brand: 'goapply' });
    await waitFor(() => expect(container.querySelector('[data-plan="student_monthly"]')).not.toBeNull());
    const card = within(container.querySelector('[data-plan="student_monthly"]') as HTMLElement);
    expect(card.getByRole('heading').textContent).not.toMatch(/credits\.plans|plans\.goapply/);
    expect(card.getByText('¥29, paid once')).toBeInTheDocument();
  });

  it('GoApply with the job feed, alerts or AI switched off lists none of them (R-04)', async () => {
    api.getPlans.mockImplementation(async () => cnPlans());
    api.getCreditCaps.mockImplementation(async () => capsFromCatalog(DEFAULT_CREDIT_CATALOG.goapply));
    const { container } = renderMarketing(<PricingPage />, {
      brand: 'goapply',
      flags: { 'jobs.feed': false, 'jobs.alerts': false, 'ai.text': false, 'jobs.campusCalendar': true },
    });
    await waitFor(() => expect(container.querySelector('[data-caps-table]')).not.toBeNull());
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/job list|fit score|gap lines|Explore|filters|search/i);
    expect(text).not.toMatch(/job alert|Saved searches/i);
    expect(container.querySelector('[data-cap-row="saved_searches"]')).toBeNull();
    expect(container.querySelector('[data-cap-row="instant_alerts"]')).toBeNull();
    const table = container.querySelector('[data-caps-table]')!.textContent ?? '';
    expect(table).not.toMatch(/Fit analyses|Tailored resumes|Cover letters|Resume checks|AI edits|Message drafts/);
    expect(within(container.querySelector('[data-plan="free"]') as HTMLElement).getByText('Your resume, your applications board and reminders.')).toBeInTheDocument();
    expect(screen.getByText('Your resume, your applications board and deadline reminders.')).toBeInTheDocument();
    expect(screen.getByText('The campus calendar is free too.')).toBeInTheDocument();
  });

  it('calls the caps "Limits" and says weekly limits reset weekly', async () => {
    renderMarketing(<PricingPage />, { flags: { ...RA_ON, agent: true } });
    expect(screen.getByRole('heading', { level: 2, name: 'Limits' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Daily limits' })).toBeNull();
    expect(screen.getByText(/weekly limits at local midnight on Monday/)).toBeInTheDocument();
  });
});

describe('/features/[slug]', () => {
  it('renders an ungated page with its Example and FAQ', () => {
    const { container } = renderMarketing(<FeaturePage def={findFeature('roboapply', 'job-matches')!} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Jobs ranked by fit, with the reason in plain words' })).toBeInTheDocument();
    expect(within(container.querySelector('[data-example]') as HTMLElement).getByText('Example')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Do recruiter-posted jobs rank higher?' })).toBeInTheDocument();
    for (const a of container.querySelectorAll('a[href^="/signup"]')) {
      expect(a.getAttribute('href')).toBe('/signup?from=feature%3Ajob-matches&utm_source=ads');
    }
  });

  it('a gated page shows nothing until the flag is on, and "not available" when it is off', () => {
    const def = findFeature('roboapply', 'ready-to-apply')!;
    const off = renderMarketing(<FeaturePage def={def} />, { flags: { agent: false } });
    expect(off.container.querySelector('[data-feature-unavailable]')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: /Each week, applications prepared/ })).toBeNull();
    off.unmount();
    renderMarketing(<FeaturePage def={def} />, { flags: { agent: true } });
    expect(screen.getByRole('heading', { level: 1, name: /Each week, applications prepared/ })).toBeInTheDocument();
    expect(screen.getByText(/You open each application and submit it yourself/)).toBeInTheDocument();
  });

  // D5 (G118): GoApply's pages for the capabilities both brands share, plus 内推码.
  it.each([
    ['job-matches', 'Jobs ranked by fit, with the reason in plain words', { 'jobs.feed': true }],
    ['resume-tailoring', 'A version of your resume for each job', {}],
    ['cover-letters', 'A cover letter for this job, from your own resume', {}],
    ['ready-to-apply', 'Each week, applications prepared for you to review', { agent: true }],
    ['referral-codes', "Referral codes for the company you're applying to", { 'cn.referralCodes': true }],
  ] as const)('GoApply /features/%s renders its page with an Example, three steps and two questions', (slug, title, flags) => {
    const def = findFeature('goapply', slug)!;
    const { container } = renderMarketing(<FeaturePage def={def} />, { brand: 'goapply', flags });
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(within(container.querySelector('[data-example]') as HTMLElement).getByText('Example')).toBeInTheDocument();
    expect(container.querySelectorAll('ol li')).toHaveLength(3);
    expect(container.querySelectorAll('#feature-faq article')).toHaveLength(2);
    const text = container.textContent ?? '';
    // No raw message key, no other brand, and no claim that anything is submitted for the user (D1).
    expect(text).not.toMatch(/landing\.features|RoboApply|%BRAND%/);
    expect(text).not.toMatch(/auto-?appl|apply for you|submit(s|ted)? for you|we apply|one-click apply/i);
    for (const a of container.querySelectorAll('a[href^="/signup"]')) {
      expect(a.getAttribute('href')).toBe(`/signup?from=feature%3A${slug}&utm_source=ads`);
    }
  });

  it('GoApply job matches says where jobs come from and that it does not cover the whole market (D3)', () => {
    renderMarketing(<FeaturePage def={findFeature('goapply', 'job-matches')!} />, { brand: 'goapply', flags: { 'jobs.feed': true } });
    expect(screen.getByText(/Each job names its source and links to the original post/)).toBeInTheDocument();
    expect(screen.getByText(/GoApply does not list every job on the market/)).toBeInTheDocument();
    expect(screen.getByText(/apply there yourself/)).toBeInTheDocument();
  });

  // The page is about listed jobs. `jobs.feed` is on by default, so the page is ungated (server HTML,
  // indexable); it goes away only once the operator is known to have closed postings.
  it('GoApply job matches: printed before the capabilities are known, "not available" once jobs.feed is known to be off', () => {
    const def = findFeature('goapply', 'job-matches')!;
    expect(def).toMatchObject({ gate: null, needs: 'jobs.feed' });
    const pending = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    try {
      const unknown = renderWithProviders(
        <BrandProvider brand={clientBrandFor('goapply')} initialCapabilities={null}>
          <FeaturePage def={def} />
        </BrandProvider>,
        { intlMessages: messagesFor('goapply') },
      );
      expect(screen.getByRole('heading', { level: 1, name: 'Jobs ranked by fit, with the reason in plain words' })).toBeInTheDocument();
      unknown.unmount();
    } finally {
      pending.mockRestore();
    }
    const off = renderMarketing(<FeaturePage def={def} />, { brand: 'goapply', flags: { 'jobs.feed': false } });
    expect(off.container.querySelector('[data-feature-unavailable]')).not.toBeNull();
    expect(screen.queryByText(/Each job names its source/)).toBeNull();
    off.unmount();
    // RoboApply's page has no such switch: it prints whatever the flags say.
    expect(findFeature('roboapply', 'job-matches')!.needs).toBeUndefined();
    renderMarketing(<FeaturePage def={findFeature('roboapply', 'job-matches')!} />, { flags: { 'jobs.feed': false } });
    expect(screen.getByRole('heading', { level: 1, name: 'Jobs ranked by fit, with the reason in plain words' })).toBeInTheDocument();
  });

  it('GoApply ready-to-apply and referral codes say plainly what they do not do', () => {
    const kit = renderMarketing(<FeaturePage def={findFeature('goapply', 'ready-to-apply')!} />, { brand: 'goapply', flags: { agent: true } });
    expect(screen.getByText(/You open each application and submit it yourself/)).toBeInTheDocument();
    expect(screen.getByText('No. It never submits an application or contacts an employer.')).toBeInTheDocument();
    kit.unmount();
    renderMarketing(<FeaturePage def={findFeature('goapply', 'referral-codes')!} />, { brand: 'goapply', flags: { 'cn.referralCodes': true } });
    expect(screen.getAllByText(/It does not decide the outcome/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Codes that are sold or traded are refused/)).toBeInTheDocument();
  });

  it('GoApply gated pages fail closed like RoboApply’s: "not available" while the capability is off', () => {
    for (const [slug, flags] of [['ready-to-apply', { agent: false }], ['referral-codes', { 'cn.referralCodes': false }], ['assistant', { copilot: false }]] as const) {
      const view = renderMarketing(<FeaturePage def={findFeature('goapply', slug)!} />, { brand: 'goapply', flags });
      expect(view.container.querySelector('[data-feature-unavailable]'), slug).not.toBeNull();
      view.unmount();
    }
  });

  it('every GoApply feature page has complete copy in English and in the staged Chinese', async () => {
    const en = (messagesFor('goapply') as { landing: { features: { goapply: Record<string, Record<string, unknown>> } } }).landing.features.goapply;
    const zhStaged = (await import('../../../../i18n/staging/landing.zh.json')).default.landing.features.goapply as Record<string, Record<string, unknown>>;
    const zhBundle = (loadMessages('zh', 'goapply') as { landing: { features: { goapply: Record<string, Record<string, unknown>> } } }).landing.features.goapply;
    const shape = (o: unknown): string[] => (o && typeof o === 'object' ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (typeof v === 'string' ? [k] : shape(v).map((c) => `${k}.${c}`))).sort() : []);
    const reference = shape(en.resume);
    // metaTitle, metaDescription, eyebrow, title, sub, three sample lines, three steps and two questions.
    expect(reference).toHaveLength(18);
    for (const def of featuresFor('goapply')) {
      expect([def.key, shape(en[def.key])]).toEqual([def.key, reference]);
      // Chinese: already in the bundle (older pages) or staged by this change (the new ones).
      const zh = zhStaged[def.key] ?? zhBundle[def.key];
      expect([def.key, shape(zh)]).toEqual([def.key, reference]);
      expect(JSON.stringify(zh)).toMatch(/[一-鿿]/);
    }
  });

  it('interview practice needs voice on RoboApply and AI text on GoApply', () => {
    const ra = findFeature('roboapply', 'interview-practice')!;
    const ga = findFeature('goapply', 'interview-practice')!;
    expect(ra.gate).toBe('ai.interviewVoice');
    expect(ga.gate).toBe('ai.text');
    const off = renderMarketing(<FeaturePage def={ra} />, { flags: { 'ai.interviewVoice': false } });
    expect(off.container.querySelector('[data-feature-unavailable]')).not.toBeNull();
    off.unmount();
    const cnOff = renderMarketing(<FeaturePage def={ga} />, { brand: 'goapply', flags: { 'ai.text': false } });
    expect(cnOff.container.querySelector('[data-feature-unavailable]')).not.toBeNull();
    cnOff.unmount();
    renderMarketing(<FeaturePage def={ra} />, { flags: { 'ai.interviewVoice': true } });
    expect(screen.getByRole('heading', { level: 1, name: 'Practice the interview for this exact job' })).toBeInTheDocument();
  });

  it('the interview-practice FAQ promises no recording switch the product does not have (D3)', () => {
    renderMarketing(<FeaturePage def={findFeature('roboapply', 'interview-practice')!} />, { flags: { 'ai.interviewVoice': true } });
    const answer = screen.getByText(/written transcript of your answers/);
    expect(answer.textContent).not.toMatch(/turn recording on|nothing is recorded/i);
    expect(answer.textContent).toMatch(/Audio and video aren't recorded by default/);
  });

  it('the extension pages need a published extension even with the flag on', () => {
    const { container } = renderMarketing(<FeaturePage def={findFeature('goapply', 'form-filler')!} />, { brand: 'goapply', flags: { extension: true } });
    expect(container.querySelector('[data-feature-unavailable]')).not.toBeNull();
  });
});

describe('contact form', () => {
  function fill() {
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'me@example.test' } });
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'billing' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'I was charged twice this month.' } });
  }

  it('validates before sending', () => {
    renderMarketing(<HelpPage supportEmail="support@roboapply.io" />);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Write at least 10 characters.')).toBeInTheDocument();
    expect(api.sendSupportMessage).not.toHaveBeenCalled();
  });

  it('says sent only after the API confirms', async () => {
    api.sendSupportMessage.mockResolvedValue({ received: true });
    renderMarketing(<HelpPage supportEmail="support@roboapply.io" />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Message sent to our support inbox'));
    expect(api.sendSupportMessage).toHaveBeenCalledWith(expect.objectContaining({ email: 'me@example.test', topic: 'billing', locale: 'en' }));
    expect(api.sendSupportMessage.mock.calls[0]![0].pageUrl).not.toMatch(/\?/);
  });

  it('falls back to the inbox address when sending fails or the daily limit is hit', async () => {
    api.sendSupportMessage.mockRejectedValueOnce(
      new RoboApiError('x', { status: 501, payload: { code: 'provider_not_configured', details: { supportEmail: 'help@roboapply.example' } } }),
    );
    renderMarketing(<HelpPage supportEmail="support@roboapply.io" />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("couldn't be sent. Email us at help@roboapply.example"));
    api.sendSupportMessage.mockRejectedValueOnce(new RoboApiError('x', { status: 429, payload: { code: 'rate_limited' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('most messages allowed for today. Email us at support@roboapply.io'));
  });

  it('the help page shows the inbox and the useful links', () => {
    renderMarketing(<HelpPage supportEmail="support@roboapply.io" />);
    expect(screen.getByRole('link', { name: 'support@roboapply.io' })).toHaveAttribute('href', 'mailto:support@roboapply.io');
    expect(screen.getByRole('link', { name: 'How ranking works' })).toHaveAttribute('href', '/help/ranking');
    expect(screen.getByTestId('cancel-footer-link')).toBeInTheDocument();
  });
});

describe('/help/ranking', () => {
  it('lists every factor with its weight and what ranking never uses', () => {
    const { container } = renderMarketing(<RankingPage />);
    for (const [key, pct] of [['fit', 55], ['freshness', 20], ['affinity', 15], ['source', 10]] as const) {
      expect(within(container.querySelector(`[data-factor="${key}"]`) as HTMLElement).getByText(`${pct}% of the order`)).toBeInTheDocument();
    }
    expect(screen.getByText('Whether a job was posted by a recruiter. That is a filter only.')).toBeInTheDocument();
    expect(screen.getByText(/Great fit 80 and up · Good fit 65 to 79 · Possible 45 to 64 · Unlikely under 45/)).toBeInTheDocument();
    expect(screen.getByText('No more than 2 jobs from the same company in any 20 in a row.')).toBeInTheDocument();
    expect(screen.getByText('This is not your chance of getting hired.')).toBeInTheDocument();
    expect(screen.queryByText(/personalised recommendations are off/)).toBeNull();
  });

  it('GoApply adds the non-personalised order note', () => {
    renderMarketing(<RankingPage />, { brand: 'goapply' });
    expect(screen.getByText(/On GoApply, if personalised recommendations are off/)).toBeInTheDocument();
  });

  // FIX-7 carry-over: GoApply's sort menu has a fourth sort; the page names it with the menu's own label.
  it('GoApply names its fourth sort (applications closing soonest); RoboApply, which has no such sort, does not', () => {
    const go = renderMarketing(<RankingPage />, { brand: 'goapply' });
    expect(sortsFor('cn')).toContain('deadline');
    expect(go.container.querySelector('[data-ranking-deadline-sort]')).toHaveTextContent('Applications closing soonest lists jobs by the date their applications close, soonest first.');
    go.unmount();
    const ra = renderMarketing(<RankingPage />);
    expect(sortsFor('intl')).not.toContain('deadline');
    expect(ra.container.querySelector('[data-ranking-deadline-sort]')).toBeNull();
    expect(ra.container.textContent).not.toMatch(/Applications closing soonest/);
  });

  // INT-06 (wave3 WP-93 #17): the rules and goal points the ranking code applies.
  it('shows the two ordering rules and the points each career goal adds (the contract numbers)', () => {
    const { container } = renderMarketing(<RankingPage />);
    const rule = (key: string) => container.querySelector(`[data-rule="${key}"]`) as HTMLElement;
    expect(within(rule('sponsorship_first')).getByRole('heading', { name: 'Visa sponsorship first' })).toBeInTheDocument();
    expect(rule('sponsorship_first')).not.toHaveTextContent(/points/);
    expect(within(rule('skills_boost')).getByText('Up to 10 points')).toBeInTheDocument();
    const goal = (key: string) => container.querySelector(`[data-goal="${key}"]`) as HTMLElement;
    for (const [key, points] of [['more_senior', 6], ['management', 6], ['higher_pay', 6], ['flexibility', 4]] as const) {
      expect(within(goal(key)).getByText(`+${points} points`)).toBeInTheDocument();
    }
    expect(container.querySelectorAll('[data-goal]')).toHaveLength(4);
    expect(screen.getByText('Other goals do not change the order.')).toBeInTheDocument();
    // The heading and the note match what is on the page: two rules, and goals.
    expect(container.querySelectorAll('[data-rule]')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'More rules' })).toBeInTheDocument();
    expect(screen.getByText(/The rules and goals below add points/)).toBeInTheDocument();
  });

  it('GoApply: no sponsorship rule and no career-goal block (neither is asked there); the skills rule stays', () => {
    const { container } = renderMarketing(<RankingPage />, { brand: 'goapply' });
    expect(container.querySelector('[data-rule="sponsorship_first"]')).toBeNull();
    expect(container.querySelector('[data-rule="skills_boost"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-goal]')).toHaveLength(0);
    expect(screen.queryByText(/career goal/)).toBeNull();
    // One rule on the page: the heading says one, and the note mentions no goals.
    expect(container.querySelectorAll('[data-rule]')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'One more rule' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Two more rules|More rules/ })).toBeNull();
    expect(screen.getByText('Each job gets a ranking score out of 100 from the four factors. The rule below adds points to that score.')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/goals? below/);
  });
});

// FIX-7: the page said "Best fit" while the sort menu said "Your best fits".
describe('/help/ranking names the other sorts as the sort menu does', () => {
  const sortLabels = (brand: 'roboapply' | 'goapply') => (messagesFor(brand) as { jobs: { workspace: { sort: Record<string, string> } } }).jobs.workspace.sort;

  it('prints the menu’s own labels, whatever they are', () => {
    renderMarketing(<RankingPage />);
    const labels = sortLabels('roboapply');
    expect(labels.best_fit).toBe('Your best fits');
    expect(screen.getByText(`${labels.newest}, ${labels.best_fit} and ${labels.highest_pay} each sort by that one thing only.`)).toBeInTheDocument();
    expect(screen.queryByText(/Best fit and Highest pay/)).toBeNull();
  });

  it('follows a renamed sort without a second edit', () => {
    const messages = JSON.parse(JSON.stringify(messagesFor('roboapply'))) as { jobs: { workspace: { sort: Record<string, string> } } };
    messages.jobs.workspace.sort.best_fit = 'Closest to your resume';
    renderWithProviders(
      <BrandProvider brand={clientBrandFor('roboapply')}>
        <RankingPage />
      </BrandProvider>,
      { intlMessages: messages as never },
    );
    expect(screen.getByText(/^Newest, Closest to your resume and Highest pay each sort/)).toBeInTheDocument();
  });

  it('lists exactly the sorts the feed offers besides Recommended, each with a placeholder in the sentence', () => {
    expect(OTHER_SORTS.map((s) => s.sort)).toEqual(sortsFor('intl').filter((s) => s !== 'recommended'));
    for (const s of OTHER_SORTS) expect(sortsFor('cn')).toContain(s.sort);
    const sentence = (messagesFor('roboapply') as { landing: { ranking: Record<string, string> } }).landing.ranking.otherSorts!;
    for (const s of OTHER_SORTS) expect(sentence).toContain(`{${s.param}}`);
  });

  // Review of FIX-7: a new key would have shown the English sentence in every
  // other locale until it was translated. The key keeps its name, so each
  // locale shows its own sentence — spelled out or with placeholders.
  it.each(['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'] as const)('%s keeps a translated sentence, never the English one', (locale) => {
    const messages = loadMessages(locale, 'goapply') as { landing: { ranking: Record<string, string> }; jobs: { workspace: { sort: Record<string, string> } } };
    expect(messages.landing.ranking.otherSortsNamed).toBeUndefined();
    const view = renderWithProviders(
      <BrandProvider brand={clientBrandFor('goapply')}>
        <RankingPage />
      </BrandProvider>,
      { intlMessages: messages as never, intlLocale: locale },
    );
    const text = view.container.querySelector('[aria-labelledby="ranking-other"]')?.textContent ?? '';
    expect(text).not.toMatch(/each sort by that one thing only|sort by that one thing/);
    expect(text).not.toMatch(/\{\w+\}/);
    // Newest and Highest pay are named as the menu names them in every locale today.
    expect(text).toContain(messages.jobs.workspace.sort.newest);
    expect(text).toContain(messages.jobs.workspace.sort.highest_pay);
  });
});

describe('/about and /security', () => {
  // FIX-8 carry-over: "we email you about a new sign-in" is said only where email can be sent.
  it.each(['roboapply', 'goapply'] as const)('%s /security says "we email you" unless email is known to be off', (brand) => {
    const on = renderMarketing(<SecurityPage supportEmail="support@example.test" />, { brand, flags: { 'notify.email': true } });
    expect(screen.getByText(/we email you/)).toBeInTheDocument();
    on.unmount();
    // Before the capabilities arrive (the server HTML, the first paint) the sentence is there: email is on by default.
    const pending = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    try {
      const unknown = renderWithProviders(
        <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={null}>
          <SecurityPage supportEmail="support@example.test" />
        </BrandProvider>,
        { intlMessages: messagesFor(brand) },
      );
      expect(screen.getByText(/we email you/)).toBeInTheDocument();
      unknown.unmount();
    } finally {
      pending.mockRestore();
    }
    renderMarketing(<SecurityPage supportEmail="support@example.test" />, { brand, flags: { 'notify.email': false } });
    expect(screen.queryByText(/we email you/)).toBeNull();
    // The other account facts stay.
    expect(screen.getByText(/Passwords are stored only as salted one-way hashes/)).toBeInTheDocument();
  });

  it('names the operating entity only when configured', () => {
    const first = renderMarketing(<AboutPage entity={null} supportEmail="support@roboapply.io" />);
    expect(screen.getByText('Company details are listed in the terms of service.')).toBeInTheDocument();
    expect(first.container.textContent).not.toMatch(/users|customers|rated/i);
    first.unmount();
    renderMarketing(<AboutPage entity="Example Ltd" supportEmail="support@roboapply.io" />);
    expect(screen.getByText('RoboApply is operated by Example Ltd.')).toBeInTheDocument();
  });

  it('describes AI routing per brand', () => {
    const ra = renderMarketing(<SecurityPage supportEmail="support@roboapply.io" />, { flags: { 'notify.email': true } });
    expect(screen.getByText(/never sent to AI services in mainland China/)).toBeInTheDocument();
    expect(screen.getByText(/we email you/)).toBeInTheDocument();
    ra.unmount();
    renderMarketing(<SecurityPage supportEmail="support@goapply.top" />, { brand: 'goapply' });
    expect(screen.getByText(/AI processing starts only after you turn it on/)).toBeInTheDocument();
    expect(screen.queryByText(/mainland China/)).toBeNull();
  });
});
