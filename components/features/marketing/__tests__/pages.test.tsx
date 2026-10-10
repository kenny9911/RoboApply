// WP-40 subpages: /pricing (prices and caps from config, GoApply "not open
// yet"), /features gating (fail closed), the support contact form (only
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
import { plansView } from '../../credits/__tests__/fixtures';
import { findFeature } from '../catalog';
import { AboutPage, HelpPage, RankingPage, SecurityPage } from '../CompanyPages';
import { FeaturePage } from '../FeaturePage';
import { PricingPage } from '../PricingPage';
import { renderMarketing } from './render';

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
});

describe('/pricing', () => {
  it('prints every RoboApply plan from the catalog with its renewal rule', async () => {
    const { container } = renderMarketing(<PricingPage />, { flags: { ...RA_ON, copilot: true, agent: true } });
    await waitFor(() => expect(container.querySelector('[data-plan="pro_monthly"]')).not.toBeNull());
    const card = (key: string) => within(container.querySelector(`[data-plan="${key}"]`) as HTMLElement);
    expect(card('pro_monthly').getByText('$24.99 / month')).toBeInTheDocument();
    expect(card('pro_monthly').getByText(/Renews every month until you cancel/)).toBeInTheDocument();
    expect(card('pro_weekly').getByText('$9.99 / week')).toBeInTheDocument();
    expect(card('pro_weekly').getByText(/About \$43\.29 a month/)).toBeInTheDocument();
    expect(card('pro_quarterly').getByText(/Save 19% compared with paying monthly/)).toBeInTheDocument();
    expect(card('pro_week_pass').getByText(/7 days of Pro/)).toBeInTheDocument();
    expect(card('practice_pack_5').getByText(/5 practice interviews, usable for 12 months/)).toBeInTheDocument();
    expect(screen.queryByText(/Not open yet/)).toBeNull();
    // Refunds + cancel (intl)
    expect(screen.getByRole('link', { name: 'Read the refund policy' })).toHaveAttribute('href', '/legal/refunds');
    expect(screen.getByTestId('cancel-footer-link')).toHaveAttribute('href', '/cancel');
    // CTA keeps utm_*
    expect(card('free').getByRole('link', { name: 'Start free' })).toHaveAttribute('href', '/signup?from=pricing%3Afree&utm_source=ads');
  });

  it('a plan without a configured price says so instead of inventing one', async () => {
    api.getPlans.mockImplementation(async () => plansView('roboapply', {}));
    const { container } = renderMarketing(<PricingPage />);
    await waitFor(() => expect(container.querySelector('[data-plan="pro_monthly"]')).not.toBeNull());
    expect(within(container.querySelector('[data-plan="pro_monthly"]') as HTMLElement).getByText('Price not set yet')).toBeInTheDocument();
  });

  it('prints caps from the credit catalog ("Up to N a day", never unlimited)', async () => {
    const { container } = renderMarketing(<PricingPage />, { flags: { ...RA_ON, copilot: true, agent: true } });
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

  it('GoApply shows the fee schedule as not open yet (R-15)', async () => {
    api.getPlans.mockImplementation(async () => plansView('goapply'));
    api.getCreditCaps.mockImplementation(async () => capsFromCatalog(DEFAULT_CREDIT_CATALOG.goapply));
    const { container } = renderMarketing(<PricingPage />, { brand: 'goapply' });
    await waitFor(() => expect(container.querySelector('[data-plan="pro_monthly"]')).not.toBeNull());
    expect(screen.getByText(/Paid plans can't be bought yet/)).toBeInTheDocument();
    const monthly = within(container.querySelector('[data-plan="pro_monthly"]') as HTMLElement);
    expect(monthly.getByText('Not open yet')).toBeInTheDocument();
    expect(monthly.getByText('¥39, paid once')).toBeInTheDocument();
    expect(screen.getByText('Refund rules will be published before paid plans open.')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/RoboApply|\$/);
  });

  it('GoApply without the job feed, alerts or AI lists none of them (R-04, R-13, R-14)', async () => {
    api.getPlans.mockImplementation(async () => plansView('goapply'));
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
});

describe('/about and /security', () => {
  it('names the operating entity only when configured', () => {
    const first = renderMarketing(<AboutPage entity={null} supportEmail="support@roboapply.io" />);
    expect(screen.getByText('Company details are listed in the terms of service.')).toBeInTheDocument();
    expect(first.container.textContent).not.toMatch(/users|customers|rated/i);
    first.unmount();
    renderMarketing(<AboutPage entity="Example Ltd" supportEmail="support@roboapply.io" />);
    expect(screen.getByText('RoboApply is operated by Example Ltd.')).toBeInTheDocument();
  });

  it('describes AI routing per brand', () => {
    const ra = renderMarketing(<SecurityPage supportEmail="support@roboapply.io" />);
    expect(screen.getByText(/never sent to AI services in mainland China/)).toBeInTheDocument();
    expect(screen.getByText(/we email you/)).toBeInTheDocument();
    ra.unmount();
    renderMarketing(<SecurityPage supportEmail="support@goapply.top" />, { brand: 'goapply' });
    expect(screen.getByText(/AI processing starts only after you turn it on/)).toBeInTheDocument();
    expect(screen.queryByText(/mainland China/)).toBeNull();
  });
});
