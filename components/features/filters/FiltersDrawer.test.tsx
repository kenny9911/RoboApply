// WP-20 acceptance (frontend): the filters drawer writes ONE PATCH with
// baseVersion, a 409 reloads the server's version, the sponsorship toggle maps
// to needsSponsorship + the profile's workAuth, GoApply shows its own fields
// and hides sponsorship, "Only jobs that list pay" is off by default, radius
// is km or mi by country, and the count never invents a number.

import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';

import { FiltersDrawer } from './FiltersDrawer';
import { TAXONOMY_TREE, fail, installFetch, ok, profile, renderWith, type RecordedCall } from './filters.testkit';

const P = '/api/v1/roboapply/search-profiles';

afterEach(() => vi.unstubAllGlobals());

function setup(opts: { brand?: 'roboapply' | 'goapply'; filters?: Record<string, unknown>; count?: number | null; patch?: (c: RecordedCall) => Response } = {}) {
  const sp = profile({ filters: opts.filters ?? {} });
  const net = installFetch({
    'GET /api/v1/roboapply/taxonomy': () => ok(TAXONOMY_TREE),
    [`POST ${P}/count`]: () => ok({ count: opts.count ?? null, capped: false }),
    [`PATCH ${P}/sp_main`]: opts.patch ?? ((c) => ok({ ...sp, version: sp.version + 1, filters: (c.body as { filters: object }).filters })),
    'GET /api/v1/roboapply/profile': () => ok({ workAuth: [{ country: 'US', authorized: false, sponsorship: null }] }),
    'PATCH /api/v1/roboapply/profile': () => ok({}),
  });
  const onClose = vi.fn();
  const view = renderWith(<FiltersDrawer open onClose={onClose} profile={sp} />, { brand: opts.brand });
  return { net, onClose, sp, ...view };
}

describe('FiltersDrawer — RoboApply', () => {
  it('renders the four sections with sponsorship, company size and the recruiter filter (no Pro note)', async () => {
    setup();
    const dialog = await screen.findByRole('dialog');
    for (const name of ['Basic', 'Pay and sponsorship', 'Interests', 'Companies']) expect(within(dialog).getByRole('heading', { name })).toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: 'Campus and internships' })).toBeNull();
    expect(screen.getByLabelText('I need visa sponsorship in United States', { exact: false })).not.toBeChecked();
    expect(screen.getByText('Company size')).toBeInTheDocument();
    expect(screen.getByText(/Many posts don't say company size/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Recruiter-posted jobs only/)).toBeInTheDocument();
    expect(screen.getByText(/recruiters posted on RoboHire/)).toBeInTheDocument();
    expect(screen.queryByText(/\bPro\b/)).toBeNull();
    // "Only jobs that list pay" is off by default.
    expect(screen.getByLabelText(/Only jobs that list pay/)).not.toBeChecked();
    // No funding-stage filter.
    expect(screen.queryByText(/funding|stage/i)).toBeNull();
  });

  it('says "Show jobs" with no number until the feed counts, then "Show N jobs"', async () => {
    setup({ count: null });
    expect(await screen.findByRole('button', { name: 'Show jobs' })).toBeInTheDocument();
    vi.unstubAllGlobals();
    setup({ count: 42 });
    expect(await screen.findByRole('button', { name: 'Show 42 jobs' })).toBeInTheDocument();
  });

  it('saves the whole draft in ONE PATCH with baseVersion', async () => {
    const { net, onClose } = setup({ filters: { titles: ['Analyst'] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Remote' }));
    fireEvent.click(screen.getByRole('button', { name: 'Senior' }));
    fireEvent.click(screen.getByLabelText(/Only jobs that list pay/));
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patches = net.to('PATCH', `${P}/sp_main`);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({
      baseVersion: 3,
      filters: { titles: ['Analyst'], workModels: ['remote'], seniority: ['senior'], includeUndisclosedPay: false },
    });
  });

  it('maps the sponsorship toggle to needsSponsorship and the profile workAuth answer for that country', async () => {
    const { net, onClose } = setup();
    fireEvent.click(await screen.findByLabelText(/I need visa sponsorship in United States/));
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filters: { needsSponsorship: true } });
    expect(net.to('PATCH', '/api/v1/roboapply/profile')[0].body).toEqual({ workAuth: [{ country: 'US', authorized: false, sponsorship: 'now' }] });
  });

  it('on 409 loads the server version into the draft and says so; nothing closes', async () => {
    const current = profile({ version: 4, filters: { titles: ['Nurse'] } });
    const { onClose } = setup({ patch: () => fail(409, 'version_conflict', { currentVersion: 4, profile: current }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Remote' }));
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    expect(await screen.findByText(/changed somewhere else/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Nurse')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remote' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('closes without a write when nothing changed', async () => {
    const { net, onClose } = setup({ filters: { titles: ['Analyst'] } });
    fireEvent.click(await screen.findByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(net.writes().filter((c) => c.path.endsWith('/sp_main'))).toHaveLength(0);
  });

  it('shows radius in miles for a US location and km for Taiwan', async () => {
    setup({ filters: { locations: [{ label: 'Austin', country: 'US', radiusKm: 40 }, { label: 'Taipei', country: 'TW', radiusKm: 40 }] } });
    const radii = await screen.findAllByLabelText('Distance');
    expect((radii[0] as HTMLSelectElement).selectedOptions[0].textContent).toBe('Within 25 mi');
    expect((radii[1] as HTMLSelectElement).selectedOptions[0].textContent).toBe('Within 40 km');
  });
});

describe('FiltersDrawer — GoApply', () => {
  it('shows 届别 / 学历 / 工作性质 / 实习天数 / K·N薪 / 元/天 / employer tags / 户口 / school tier and hides sponsorship and company size', async () => {
    setup({ brand: 'goapply' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Campus and internships' })).toBeInTheDocument();
    for (const label of ['Graduation class', 'Degree the post asks for', 'Hiring track', 'Internship days a week', 'Internship pay a day', 'Months of pay a year', 'Employer type', 'Your school']) {
      expect(within(dialog).getAllByText(label).length, label).toBeGreaterThan(0);
    }
    expect(screen.getByLabelText(/Only posts that offer hukou/)).toBeInTheDocument();
    expect(screen.getByText('Minimum monthly pay (K)')).toBeInTheDocument();
    expect(screen.queryByText(/visa sponsorship/i)).toBeNull();
    expect(screen.queryByText('Company size')).toBeNull();
    expect(screen.queryByText('Leave out jobs that require')).toBeNull();
    expect(screen.getByText(/recruiters posted on GoHire/)).toBeInTheDocument();
  });

  it('saves K a month as CNY monthly pay and N薪 as salaryMonthsMin', async () => {
    const { net, onClose } = setup({ brand: 'goapply' });
    fireEvent.change(await screen.findByLabelText('Minimum monthly pay (K)'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Months of pay a year'), { target: { value: '13' } });
    fireEvent.click(screen.getByRole('button', { name: 'Campus hiring' }));
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({
      baseVersion: 3,
      filters: { salaryMin: { amount: 15000, currency: 'CNY', period: 'month' }, salaryMonthsMin: 13, employmentType: ['campus'] },
    });
    expect(net.to('PATCH', '/api/v1/roboapply/profile')).toHaveLength(0);
  });
});
