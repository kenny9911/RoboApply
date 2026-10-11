// WP-20 acceptance (frontend): the filters drawer writes ONE PATCH with
// baseVersion, a 409 reloads the server's version, the sponsorship toggle maps
// to needsSponsorship + the profile's workAuth, GoApply shows its own fields
// and hides sponsorship, "Only jobs that list pay" is off by default, radius
// is km or mi by country, and the count never invents a number.

import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';

import { TW_DISTRICTS_MAX as CONTRACT_TW_DISTRICTS_MAX, WORK_SHIFT_FILTERS } from '../../../server/src/features/search/contract';
import { twDistrictsResponse } from '../../../server/src/features/tw/districts';
import { TW_PAY_RULE_DEFAULT } from '../../../server/src/features/tw/payRule';
import { ActiveFilterChips } from './ActiveFilterChips';
import { FiltersDrawer } from './FiltersDrawer';
import { TW_DISTRICTS_MAX, WORK_SHIFTS, districtsLeaveOutOtherPlaces, draftCounties, mayBeTaiwanSearch, showsTaiwanPayHelper, showsTaiwanPayNote } from './FilterEditors';
import { sectionEditors } from './FilterSections';
import { TAXONOMY_TREE, fail, installFetch, ok, profile, renderWith, type RecordedCall } from './filters.testkit';

const P = '/api/v1/roboapply/search-profiles';
const TW_DISTRICTS = '/api/v1/roboapply/tw/districts';
const TW_PAY_RULE = '/api/v1/roboapply/tw/pay-rule';

afterEach(() => vi.unstubAllGlobals());

function setup(opts: { brand?: 'roboapply' | 'goapply'; locale?: string; filters?: Record<string, unknown>; count?: number | null; patch?: (c: RecordedCall) => Response } = {}) {
  const sp = profile({ filters: opts.filters ?? {} });
  const net = installFetch({
    // The Taiwan routes answer what the server answers: the committed county table and the default rule.
    [`GET ${TW_DISTRICTS}`]: () => ok(twDistrictsResponse()),
    [`GET ${TW_PAY_RULE}`]: () => ok({ ...TW_PAY_RULE_DEFAULT, isDefault: true }),
    'GET /api/v1/roboapply/taxonomy': () => ok(TAXONOMY_TREE),
    [`POST ${P}/count`]: () => ok({ count: opts.count ?? null, capped: false }),
    [`PATCH ${P}/sp_main`]: opts.patch ?? ((c) => ok({ ...sp, version: sp.version + 1, filters: (c.body as { filters: object }).filters })),
    'GET /api/v1/roboapply/profile': () => ok({ workAuth: [{ country: 'US', authorized: false, sponsorship: null }] }),
    'PATCH /api/v1/roboapply/profile': () => ok({}),
  });
  const onClose = vi.fn();
  const view = renderWith(<FiltersDrawer open onClose={onClose} profile={sp} />, { brand: opts.brand, locale: opts.locale });
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

// INT-06 (wave3 WP-93 #16): the Taiwan 面議 note beside "Only jobs that list pay".
describe('FiltersDrawer — "Why is pay not listed?" for Taiwan', () => {
  const NOTE = 'Why is pay not listed?';

  it('shows under the pay toggle for a zh-TW reader, with the filter hint and the law link', async () => {
    setup({ locale: 'zh-TW' });
    const toggle = await screen.findByLabelText(/Only jobs that list pay/);
    const note = screen.getByText(NOTE).closest('details') as HTMLElement;
    expect(toggle.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note).toHaveTextContent('Turn on “Only jobs that list pay” to hide them.');
    expect(note).toHaveTextContent('pay that a posting does not list is never estimated here');
    expect(within(note).getByRole('link')).toHaveAttribute('href', expect.stringContaining('law.moj.gov.tw'));
  });

  it('shows for a search set to Taiwan in any language (a place in TW, or country TW)', async () => {
    const first = setup({ filters: { locations: [{ label: 'Taipei', country: 'TW', radiusKm: 40 }] } });
    await screen.findByLabelText(/Only jobs that list pay/);
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    first.unmount();
    setup({ filters: { country: 'tw' } });
    await screen.findByLabelText(/Only jobs that list pay/);
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it('is absent for everyone else on RoboApply', async () => {
    setup({ filters: { locations: [{ label: 'Austin', country: 'US', radiusKm: 40 }] } });
    await screen.findByLabelText(/Only jobs that list pay/);
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('is absent on GoApply, zh-TW or not', async () => {
    setup({ brand: 'goapply', locale: 'zh-TW', filters: { locations: [{ label: '台北', country: 'TW', radiusKm: 40 }] } });
    await screen.findByLabelText(/Only jobs that list pay/);
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('showsTaiwanPayNote: the rule itself', () => {
    expect(showsTaiwanPayNote('intl', 'zh-TW', {})).toBe(true);
    expect(showsTaiwanPayNote('intl', 'en', {})).toBe(false);
    expect(showsTaiwanPayNote('intl', 'zh', {})).toBe(false);
    expect(showsTaiwanPayNote('intl', 'en', { country: 'TW' })).toBe(true);
    expect(showsTaiwanPayNote('intl', 'en', { locations: [{ label: 'Berlin', country: 'DE', radiusKm: 40 }, { label: 'Hsinchu', country: 'TW', radiusKm: 40 }] })).toBe(true);
    expect(showsTaiwanPayNote('intl', 'en', { locations: [{ label: 'Remote', radiusKm: 0 }] })).toBe(false);
    expect(showsTaiwanPayNote('cn', 'zh-TW', { country: 'TW' })).toBe(false);
    // MKT-5F: with the county table, a Taiwanese county typed with no country is a search set to Taiwan too.
    const counties = twDistrictsResponse().counties;
    expect(showsTaiwanPayNote('intl', 'en', { locations: [{ label: '新竹縣', radiusKm: 40 }] })).toBe(false);
    expect(showsTaiwanPayNote('intl', 'en', { locations: [{ label: '新竹縣', radiusKm: 40 }] }, counties)).toBe(true);
    expect(showsTaiwanPayNote('intl', 'en', { locations: [{ label: 'Austin', radiusKm: 40 }] }, counties)).toBe(false);
    expect(showsTaiwanPayNote('cn', 'en', { locations: [{ label: '新竹縣', radiusKm: 40 }] }, counties)).toBe(false);
  });
});

describe('FiltersDrawer — GoApply company size (D5)', () => {
  it('filters by company size and by employer tags in one save, and a saved size comes back selected', async () => {
    const { net, onClose } = setup({ brand: 'goapply' });
    fireEvent.click(await screen.findByRole('button', { name: '51–200 people' }));
    fireEvent.click(screen.getByRole('button', { name: 'State-owned enterprise' }));
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filters: { companySizes: ['51-200'], employerTags: ['soe'] } });
  });

  it('round-trips: a search saved with sizes opens with them pressed, on both brands', async () => {
    const go = setup({ brand: 'goapply', filters: { companySizes: ['1001-5000', '5000+'], employerTags: ['foreign'] } });
    expect(await screen.findByRole('button', { name: '1,001–5,000 people' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '5,000+ people' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '51–200 people' })).toHaveAttribute('aria-pressed', 'false');
    go.unmount();
    setup({ filters: { companySizes: ['1001-5000'] } });
    expect(await screen.findByRole('button', { name: '1,001–5,000 people' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('FiltersDrawer — GoApply', () => {
  it('shows 届别 / 学历 / 工作性质 / 实习天数 / K·N薪 / 元/天 / employer tags / 户口 / school tier and company size, and hides sponsorship', async () => {
    setup({ brand: 'goapply' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Campus and internships' })).toBeInTheDocument();
    for (const label of ['Graduation class', 'Degree the post asks for', 'Hiring track', 'Internship days a week', 'Internship pay a day', 'Months of pay a year', 'Employer type', 'Your school']) {
      expect(within(dialog).getAllByText(label).length, label).toBeGreaterThan(0);
    }
    expect(screen.getByLabelText(/Only posts that offer hukou/)).toBeInTheDocument();
    expect(screen.getByText('Minimum monthly pay (K)')).toBeInTheDocument();
    expect(screen.queryByText(/visa sponsorship/i)).toBeNull();
    // Company size sits beside employer type (D5: the same filter as RoboApply).
    expect(within(dialog).getByText('Company size')).toBeInTheDocument();
    expect(Boolean(within(dialog).getByText('Company size').compareDocumentPosition(within(dialog).getAllByText('Employer type')[0]!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
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

// MKT-5F (JT-7): district and shift filters, shown for a search in Taiwan on RoboApply only.
describe('FiltersDrawer — district and shift for a search in Taiwan (JT-7)', () => {
  const HSINCHU_COUNTY = { label: '新竹縣', city: '新竹縣', radiusKm: 40 as const };
  const districtGroup = (county: string) => screen.findByRole('group', { name: `Districts in ${county}` });

  it('ACCEPT: a Taiwanese county as the location brings its district picker and the shift control, each with its helper text', async () => {
    const { net } = setup({ filters: { locations: [HSINCHU_COUNTY] } });
    const group = await districtGroup('新竹縣');
    // The county's own 鄉鎮市區, as the postal list writes them: data, not copy.
    for (const name of ['竹北市', '湖口鄉', '竹東鎮', '新豐鄉']) expect(within(group).getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    expect(within(group).getAllByRole('button')).toHaveLength(twDistrictsResponse().counties.find((c) => c.name === '新竹縣')!.districts.length);
    // No district of another county is offered.
    expect(within(group).queryByRole('button', { name: '信義區' })).toBeNull();
    expect(within(group).getByText(/Jobs that name no district are left out/)).toBeInTheDocument();
    // The district names are open data: the list carries its source's credit line, linked to the licence text.
    const credit = screen.getByRole('link', { name: '資料來源：中華郵政股份有限公司 2026「縣市鄉鎮中英對照檔」，依政府資料開放授權條款第1版公開釋出' });
    expect(credit).toHaveAttribute('href', 'https://data.gov.tw/license');
    expect(credit.closest('[lang]')).toHaveAttribute('lang', 'zh-Hant');
    const shift = screen.getByRole('group', { name: 'Shift' });
    expect(within(shift).getAllByRole('button').map((b) => b.textContent)).toEqual(['Day', 'Evening', 'Night', 'Rotating', 'Part-time hours']);
    // The shrinking list is explained: only postings that state a shift, mostly 台灣就業通's.
    expect(within(shift).getByText(/Shows only jobs whose posting states the shift\. Most of those come from 台灣就業通/)).toBeInTheDocument();
    expect(net.to('GET', TW_DISTRICTS)).toHaveLength(1);
  });

  it('a county typed in English or in the 臺 spelling is the same county; a search by country alone has the shift control and no district picker', async () => {
    const first = setup({ filters: { locations: [{ label: 'Taipei, Taiwan', city: 'Taipei, Taiwan', radiusKm: 40 }] } });
    expect(within(await districtGroup('台北市')).getByRole('button', { name: '信義區' })).toBeInTheDocument();
    first.unmount();
    const second = setup({ filters: { locations: [{ label: '臺北市', radiusKm: 0 }] } });
    expect(within(await districtGroup('台北市')).getByRole('button', { name: '內湖區' })).toBeInTheDocument();
    second.unmount();
    const { container } = setup({ filters: { country: 'TW' } });
    expect(await screen.findByRole('group', { name: 'Shift' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Districts in/ })).toBeNull();
    // No district list on screen, so no credit line for it either.
    expect(container.ownerDocument.querySelector('[data-tw-districts-credit]')).toBeNull();
  });

  it('ACCEPT: the two controls do not appear for a United States search, and nothing asks for the county table', async () => {
    const { net } = setup({ filters: { country: 'US', locations: [{ label: 'Austin', city: 'Austin', country: 'US', radiusKm: 40 }] } });
    await screen.findByLabelText(/Only jobs that list pay/);
    await waitFor(() => expect(net.to('POST', `${P}/count`).length).toBeGreaterThan(0));
    expect(screen.queryByRole('group', { name: 'Shift' })).toBeNull();
    expect(screen.queryByRole('group', { name: /^Districts in/ })).toBeNull();
    expect(net.to('GET', TW_DISTRICTS)).toHaveLength(0);
  });

  it('a place with no country that is not in Taiwan gets neither control (the table is read once to find out)', async () => {
    const { net } = setup({ filters: { locations: [{ label: 'Tokyo', city: 'Tokyo', radiusKm: 40 }] } });
    await waitFor(() => expect(net.to('GET', TW_DISTRICTS)).toHaveLength(1));
    await screen.findByLabelText(/Only jobs that list pay/);
    expect(screen.queryByRole('group', { name: 'Shift' })).toBeNull();
    expect(screen.queryByRole('group', { name: /^Districts in/ })).toBeNull();
  });

  it('ACCEPT: the two controls do not appear on GoApply, even for a place in Taiwan, and GoApply never calls the Taiwan routes', async () => {
    const { net } = setup({ brand: 'goapply', filters: { country: 'TW', locations: [{ label: '新竹縣', country: 'TW', radiusKm: 40 }], twDistricts: ['新竹縣竹北市'], workShifts: ['rotating'] } });
    await screen.findByLabelText(/Only jobs that list pay/);
    await waitFor(() => expect(net.to('POST', `${P}/count`).length).toBeGreaterThan(0));
    expect(screen.queryByRole('group', { name: 'Shift' })).toBeNull();
    expect(screen.queryByRole('group', { name: /^Districts in/ })).toBeNull();
    expect(net.calls.filter((c) => c.path.startsWith('/api/v1/roboapply/tw/'))).toEqual([]);
    // GoApply's sections hold no Taiwan editor at all.
    const names = (market: 'intl' | 'cn') => sectionEditors(market).flatMap((sec) => sec.editors.map((e) => e.name));
    expect(names('intl')).toContain('WorkShiftEditor');
    expect(names('cn')).not.toContain('WorkShiftEditor');
    // And the count it asks for never carries the two fields.
    for (const call of net.to('POST', `${P}/count`)) {
      expect((call.body as { filters: Record<string, unknown> }).filters).not.toHaveProperty('twDistricts');
      expect((call.body as { filters: Record<string, unknown> }).filters).not.toHaveProperty('workShifts');
    }
  });

  it('ACCEPT: a district and a shift are saved with the rest of the draft in ONE PATCH, the district as <county><district>', async () => {
    const { net, onClose } = setup({ filters: { locations: [HSINCHU_COUNTY] } });
    fireEvent.click(within(await districtGroup('新竹縣')).getByRole('button', { name: '竹北市' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Shift' })).getByRole('button', { name: 'Rotating' }));
    expect(within(await districtGroup('新竹縣')).getByRole('button', { name: '竹北市' })).toHaveAttribute('aria-pressed', 'true');
    // The live count is asked with the same two filters, so the button's number is the list's.
    const saved = { locations: [HSINCHU_COUNTY], twDistricts: ['新竹縣竹北市'], workShifts: ['rotating'] };
    await waitFor(() => expect((net.to('POST', `${P}/count`).at(-1)?.body as { filters: unknown } | undefined)?.filters).toEqual(saved), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patches = net.to('PATCH', `${P}/sp_main`);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ baseVersion: 3, filters: saved });
  });

  it('ACCEPT: a saved search keeps the two fields: it opens with them pressed', async () => {
    setup({ filters: { locations: [HSINCHU_COUNTY], twDistricts: ['新竹縣竹北市', '新竹縣湖口鄉'], workShifts: ['night', 'part_time'] } });
    const group = await districtGroup('新竹縣');
    expect(within(group).getByRole('button', { name: '竹北市' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: '湖口鄉' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: '竹東鎮' })).toHaveAttribute('aria-pressed', 'false');
    const shift = screen.getByRole('group', { name: 'Shift' });
    expect(within(shift).getByRole('button', { name: 'Night' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(shift).getByRole('button', { name: 'Part-time hours' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(shift).getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a district name two counties share is two separate choices: 信義區 under 台北市 is not 信義區 under 基隆市', async () => {
    const places = [{ label: '台北市', city: '台北市', radiusKm: 40 }, { label: '基隆市', city: '基隆市', radiusKm: 40 }];
    const { net, onClose } = setup({ filters: { locations: places } });
    fireEvent.click(within(await districtGroup('台北市')).getByRole('button', { name: '信義區' }));
    expect(within(await districtGroup('台北市')).getByRole('button', { name: '信義區' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(await districtGroup('基隆市')).getByRole('button', { name: '信義區' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filters: { locations: places, twDistricts: ['台北市信義區'] } });
  });

  it('taking a county off the search takes its districts with it, and leaves the other county\'s alone', async () => {
    const places = [{ label: '台北市', city: '台北市', radiusKm: 40 }, HSINCHU_COUNTY];
    const { net, onClose } = setup({ filters: { locations: places, twDistricts: ['台北市信義區', '新竹縣竹北市'] } });
    await districtGroup('台北市');
    fireEvent.click(screen.getByRole('button', { name: 'Remove 台北市' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Districts in 台北市' })).toBeNull());
    expect(within(await districtGroup('新竹縣')).getByRole('button', { name: '竹北市' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filters: { locations: [HSINCHU_COUNTY], twDistricts: ['新竹縣竹北市'] } });
  });

  // Review finding: the picker is drawn per county but the filter is one rule for the whole search.
  const ONLY = 'Only the districts you picked are shown. Jobs in your other places are left out.';

  it('a district picked under one county says that the jobs of the other places are left out; with one place, or a district in each, it says nothing', async () => {
    const taipei = { label: '台北市', city: '台北市', radiusKm: 40 as const };
    // Two counties, a district in one: every Taipei job is left out, and the drawer says so, once.
    setup({ filters: { locations: [taipei, HSINCHU_COUNTY], twDistricts: ['新竹縣竹北市'] } });
    await districtGroup('新竹縣');
    expect(await screen.findAllByText(ONLY)).toHaveLength(1);
    // It stands under the pickers, in the location field, not inside one county's group.
    const line = screen.getByText(ONLY);
    expect(line).toHaveAttribute('data-tw-districts-only');
    expect((await districtGroup('新竹縣')).contains(line)).toBe(false);
    expect((await districtGroup('新竹縣')).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A district in the other county too: no place is left out, the line goes.
    fireEvent.click(within(await districtGroup('台北市')).getByRole('button', { name: '信義區' }));
    await waitFor(() => expect(screen.queryByText(ONLY)).toBeNull());
    // Taking it off again brings the line back.
    fireEvent.click(within(await districtGroup('台北市')).getByRole('button', { name: '信義區' }));
    expect(await screen.findByText(ONLY)).toBeInTheDocument();
    // With no district at all there is nothing to explain.
    fireEvent.click(within(await districtGroup('新竹縣')).getByRole('button', { name: '竹北市' }));
    await waitFor(() => expect(screen.queryByText(ONLY)).toBeNull());
  });

  it('one county with its district says nothing; a place outside Taiwan in the same search brings the line', async () => {
    const first = setup({ filters: { locations: [HSINCHU_COUNTY], twDistricts: ['新竹縣竹北市'] } });
    expect(within(await districtGroup('新竹縣')).getByRole('button', { name: '竹北市' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(ONLY)).toBeNull();
    first.unmount();
    vi.unstubAllGlobals();
    // A mixed search: the Tokyo jobs are left out too.
    const mixed = setup({ filters: { locations: [HSINCHU_COUNTY, { label: 'Tokyo', city: 'Tokyo', country: 'JP', radiusKm: 40 }], twDistricts: ['新竹縣竹北市'] } });
    await districtGroup('新竹縣');
    expect(await screen.findByText(ONLY)).toBeInTheDocument();
    mixed.unmount();
    vi.unstubAllGlobals();
    // GoApply has no district filter, so no line, whatever a stored row holds.
    setup({ brand: 'goapply', filters: { locations: [HSINCHU_COUNTY, { label: '台北市', city: '台北市', radiusKm: 40 }], twDistricts: ['新竹縣竹北市'] } });
    await screen.findByText('新竹縣');
    expect(screen.queryByText(ONLY)).toBeNull();
  });

  it('districtsLeaveOutOtherPlaces: the rule itself', () => {
    const counties = twDistrictsResponse().counties;
    const place = (label: string, country?: string) => ({ label, city: label, radiusKm: 40 as const, ...(country ? { country } : {}) });
    // No district chosen: nothing is left out by this filter.
    expect(districtsLeaveOutOtherPlaces({ locations: [place('台北市'), place('新竹縣')] }, counties)).toBe(false);
    expect(districtsLeaveOutOtherPlaces({ locations: [place('台北市'), place('新竹縣')], twDistricts: [] }, counties)).toBe(false);
    // One county, its own district.
    expect(districtsLeaveOutOtherPlaces({ locations: [place('新竹縣')], twDistricts: ['新竹縣竹北市'] }, counties)).toBe(false);
    // Two counties, a district in one; then a district in each.
    expect(districtsLeaveOutOtherPlaces({ locations: [place('台北市'), place('新竹縣')], twDistricts: ['新竹縣竹北市'] }, counties)).toBe(true);
    expect(districtsLeaveOutOtherPlaces({ locations: [place('台北市'), place('新竹縣')], twDistricts: ['新竹縣竹北市', '台北市信義區'] }, counties)).toBe(false);
    // The same county typed twice is one county.
    expect(districtsLeaveOutOtherPlaces({ locations: [place('Taipei'), place('臺北市')], twDistricts: ['台北市信義區'] }, counties)).toBe(false);
    // One name that means two counties: a district of one leaves the other out.
    expect(districtsLeaveOutOtherPlaces({ locations: [place('Chiayi')], twDistricts: [counties.find((c) => c.name === '嘉義市')!.districts[0]!.value] }, counties)).toBe(true);
    // A place outside Taiwan, and the whole of Taiwan as a place.
    expect(districtsLeaveOutOtherPlaces({ locations: [place('新竹縣'), place('Tokyo', 'JP')], twDistricts: ['新竹縣竹北市'] }, counties)).toBe(true);
    expect(districtsLeaveOutOtherPlaces({ locations: [place('新竹縣'), { label: 'Anywhere', country: 'TW', radiusKm: 0 }], twDistricts: ['新竹縣竹北市'] }, counties)).toBe(true);
    // A stored district of a county the search no longer names: that search's own county has none chosen.
    expect(districtsLeaveOutOtherPlaces({ locations: [place('新竹縣')], twDistricts: ['台北市信義區'] }, counties)).toBe(true);
    // Without the county table nothing can be said (and no picker is on screen).
    expect(districtsLeaveOutOtherPlaces({ locations: [place('台北市'), place('新竹縣')], twDistricts: ['新竹縣竹北市'] }, [])).toBe(false);
  });

  it('at most 20 districts: at the limit the picker says so and adds no more, and one can still be taken off', async () => {
    const tainan = twDistrictsResponse().counties.find((c) => c.name === '台南市')!;
    const twenty = tainan.districts.slice(0, TW_DISTRICTS_MAX).map((d) => d.value);
    expect(TW_DISTRICTS_MAX).toBe(20);
    const { net, onClose } = setup({ filters: { locations: [{ label: '台南市', city: '台南市', radiusKm: 0 }], twDistricts: twenty } });
    const group = await districtGroup('台南市');
    expect(within(group).getByText('You can pick up to 20 districts. Take one off to add another.')).toBeInTheDocument();
    const extra = tainan.districts[TW_DISTRICTS_MAX]!;
    fireEvent.click(within(group).getByRole('button', { name: extra.name }));
    expect(within(group).getByRole('button', { name: extra.name })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(within(group).getByRole('button', { name: tainan.districts[0]!.name }));
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect((net.to('PATCH', `${P}/sp_main`)[0].body as { filters: { twDistricts: string[] } }).filters.twDistricts).toEqual(twenty.slice(1));
  });

  it('while the county table has not arrived (or the request fails) the drawer works as before: no picker, nothing broken', async () => {
    const sp = profile({ filters: { locations: [HSINCHU_COUNTY] } });
    const net = installFetch({
      [`GET ${TW_DISTRICTS}`]: () => fail(500, 'internal_error'),
      [`POST ${P}/count`]: () => ok({ count: 7, capped: false }),
    });
    renderWith(<FiltersDrawer open onClose={vi.fn()} profile={sp} />);
    expect(await screen.findByRole('button', { name: 'Show 7 jobs' })).toBeInTheDocument();
    await waitFor(() => expect(net.to('GET', TW_DISTRICTS)).toHaveLength(1));
    expect(screen.queryByRole('group', { name: /^Districts in/ })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Shift' })).toBeNull();
    expect(screen.getByText('新竹縣')).toBeInTheDocument();
  });

  it('the rules themselves: which searches may be in Taiwan, and which counties a draft names', () => {
    const counties = twDistrictsResponse().counties;
    expect(mayBeTaiwanSearch('intl', {})).toBe(false);
    expect(mayBeTaiwanSearch('intl', { country: 'TW' })).toBe(true);
    expect(mayBeTaiwanSearch('intl', { locations: [{ label: 'Somewhere', radiusKm: 0 }] })).toBe(true);
    expect(mayBeTaiwanSearch('intl', { country: 'US', locations: [{ label: 'Austin', country: 'US', radiusKm: 40 }] })).toBe(false);
    expect(mayBeTaiwanSearch('intl', { country: 'US', workShifts: ['day'] })).toBe(true);
    expect(mayBeTaiwanSearch('cn', { country: 'TW', locations: [{ label: '台北市', radiusKm: 0 }], twDistricts: ['台北市信義區'] })).toBe(false);
    const names = (locations: Array<{ label: string; city?: string; country?: string; radiusKm: 0 }>) => draftCounties({ locations }, counties).map((c) => c.name);
    expect(names([{ label: '新竹縣竹北市', radiusKm: 0 }, { label: 'Taipei', radiusKm: 0 }, { label: '臺北市', radiusKm: 0 }])).toEqual(['新竹縣', '台北市']);
    // One city record stands for two counties; a county's own name means that county alone.
    expect(names([{ label: 'Chiayi', radiusKm: 0 }])).toEqual(['嘉義市', '嘉義縣']);
    expect(names([{ label: '嘉義縣', radiusKm: 0 }])).toEqual(['嘉義縣']);
    // A place that states another country, or names nothing in Taiwan, is no county.
    expect(names([{ label: 'Taipei', country: 'US', radiusKm: 0 }, { label: 'Austin', radiusKm: 0 }, { label: '上海', radiusKm: 0 }])).toEqual([]);
    expect(draftCounties({ locations: [{ label: '台北市', radiusKm: 0 }] }, [])).toEqual([]);
    // The client's two constants are the contract's (the browser cannot import server values, so a test holds them equal).
    expect([...WORK_SHIFTS]).toEqual(['day', 'evening', 'night', 'rotating', 'part_time']);
    expect([...WORK_SHIFTS]).toEqual([...WORK_SHIFT_FILTERS]);
    expect(TW_DISTRICTS_MAX).toBe(CONTRACT_TW_DISTRICTS_MAX);
  });
});

describe('ActiveFilterChips — district and shift chips (JT-7)', () => {
  const chipsFor = (filters: Record<string, unknown>, brand?: 'roboapply' | 'goapply') => {
    const sp = profile({ filters });
    const net = installFetch({
      'GET /api/v1/roboapply/taxonomy': () => ok(TAXONOMY_TREE),
      [`PATCH ${P}/sp_main`]: (c) => ok({ ...sp, version: sp.version + 1, filters: { ...filters, ...(c.body as { filtersPatch: object }).filtersPatch } }),
    });
    const view = renderWith(<ActiveFilterChips profile={sp} />, { brand });
    return { net, sp, ...view };
  };

  it('ACCEPT: a district chip is the district with its county, as data; a shift chip says "Shift: …"', async () => {
    chipsFor({ country: 'TW', twDistricts: ['新竹縣竹北市', '台北市信義區'], workShifts: ['rotating', 'part_time'] });
    const bar = await screen.findByRole('group', { name: 'Active filters' });
    for (const label of ['新竹縣竹北市', '台北市信義區', 'Shift: Rotating', 'Shift: Part-time hours']) expect(within(bar).getByText(label)).toBeInTheDocument();
    // Every shift value has a label of its own.
    expect(within(bar).queryByText(/Shift: (day|evening|night|rotating|part_time)$/)).toBeNull();
  });

  it('removing a chip sends one patch for that field, with the values that stay', async () => {
    const { net } = chipsFor({ country: 'TW', twDistricts: ['新竹縣竹北市', '台北市信義區'], workShifts: ['rotating'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove filter: 新竹縣竹北市' }));
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { twDistricts: ['台北市信義區'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Shift: Rotating' }));
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(2));
    expect((net.to('PATCH', `${P}/sp_main`)[1].body as { filtersPatch: unknown }).filtersPatch).toEqual({ workShifts: null });
  });

  it('GoApply shows no chip for them, whatever a stored row holds', async () => {
    chipsFor({ country: 'TW', titles: ['门店店员'], twDistricts: ['新竹縣竹北市'], workShifts: ['rotating'] }, 'goapply');
    const bar = await screen.findByRole('group', { name: 'Active filters' });
    expect(within(bar).getByText('门店店员')).toBeInTheDocument();
    expect(within(bar).queryByText('新竹縣竹北市')).toBeNull();
    expect(within(bar).queryByText(/^Shift:/)).toBeNull();
  });
});

// MKT-5F (JT-8): where stated pay comes from, next to the pay toggle, for a search in Taiwan.
describe('FiltersDrawer — the pay helper line for a search in Taiwan (JT-8)', () => {
  const HELPER = /In Taiwan, most postings that state pay come from 台灣就業通\. Postings found through job search rarely state it/;

  it('ACCEPT: a Taiwan search with a pay filter on shows the line next to the pay toggle', async () => {
    setup({ filters: { country: 'TW', includeUndisclosedPay: false } });
    const toggle = await screen.findByLabelText(/Only jobs that list pay/);
    const line = await screen.findByText(HELPER);
    expect(toggle.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // It sits before the "Why is pay not listed?" note, in the pay section.
    expect(line.compareDocumentPosition(screen.getByText('Why is pay not listed?')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.closest('[data-section]')).toHaveAttribute('data-section', 'pay');
    // Monthly pay as posted: the line names no amount and no yearly figure.
    expect(line.textContent).toMatch(/Monthly pay is shown as the posting states it\./);
    expect(line.textContent).not.toMatch(/\d|year|annual/i);
  });

  it('a pay floor is a pay filter too, and a Taiwanese county typed with no country is a Taiwan search', async () => {
    setup({ filters: { locations: [{ label: '新竹縣', city: '新竹縣', radiusKm: 40 }], salaryMin: { amount: 45000, currency: 'TWD', period: 'month' } } });
    expect(await screen.findByText(HELPER)).toBeInTheDocument();
  });

  it('review finding: the line is true with a floor alone: postings that state no pay are left out only when "Only jobs that list pay" is on, and it never says "filter by pay"', async () => {
    // A floor and the toggle OFF: the feed keeps postings that state no pay, and the toggle's own help says so right above.
    setup({ filters: { country: 'TW', salaryMin: { amount: 45000, currency: 'TWD', period: 'month' } } });
    const toggle = await screen.findByLabelText(/Only jobs that list pay/);
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("Off: jobs that don't list pay stay in your list.")).toBeInTheDocument();
    const line = await screen.findByText(HELPER);
    expect(line.textContent).toBe('In Taiwan, most postings that state pay come from 台灣就業通. Postings found through job search rarely state it, so they are left out when “Only jobs that list pay” is on. Monthly pay is shown as the posting states it.');
    expect(line.textContent).not.toMatch(/drop out|filter by pay/);
    // The toggle it names is the one on screen, in the same words.
    expect(line.textContent).toContain(toggle.closest('label')?.textContent?.match(/Only jobs that list pay/)?.[0] ?? 'missing label');
  });

  it('turning the pay filter on shows it; with no pay filter there is no line', async () => {
    setup({ filters: { country: 'TW' } });
    const toggle = await screen.findByLabelText(/Only jobs that list pay/);
    expect(screen.queryByText(HELPER)).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText(HELPER)).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText(HELPER)).toBeNull());
  });

  it('ACCEPT: a United States search with the same pay filter does not show it, in any language', async () => {
    const us = { country: 'US', locations: [{ label: 'Austin', city: 'Austin', country: 'US', radiusKm: 40 }], includeUndisclosedPay: false, salaryMin: { amount: 90000, currency: 'USD', period: 'year' } };
    const first = setup({ filters: us });
    await screen.findByLabelText(/Only jobs that list pay/);
    expect(screen.queryByText(HELPER)).toBeNull();
    first.unmount();
    // A reader in Traditional Chinese who searches the United States gets the 面議 note, not this line.
    setup({ locale: 'zh-TW', filters: us });
    await screen.findByLabelText(/Only jobs that list pay/);
    expect(screen.getByText('Why is pay not listed?')).toBeInTheDocument();
    expect(screen.queryByText(HELPER)).toBeNull();
  });

  it('is absent on GoApply', async () => {
    setup({ brand: 'goapply', filters: { country: 'TW', includeUndisclosedPay: false } });
    await screen.findByLabelText(/Only jobs that list pay/);
    expect(screen.queryByText(HELPER)).toBeNull();
  });

  it('a new pay floor on a Taiwan search is New Taiwan dollars a month, as postings there state pay; elsewhere it is what it was', async () => {
    const tw = setup({ filters: { country: 'TW' } });
    const amount = await screen.findByPlaceholderText('Amount');
    fireEvent.change(amount, { target: { value: '45000' } });
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(tw.onClose).toHaveBeenCalled());
    expect(tw.net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filters: { country: 'TW', salaryMin: { amount: 45000, currency: 'TWD', period: 'month' } } });
    tw.unmount();
    vi.unstubAllGlobals();
    // A search outside Taiwan: the brand's currency a year, unchanged.
    const us = setup({ filters: { country: 'US' } });
    fireEvent.change(await screen.findByPlaceholderText('Amount'), { target: { value: '90000' } });
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(us.onClose).toHaveBeenCalled());
    expect(us.net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filters: { country: 'US', salaryMin: { amount: 90000, currency: 'USD', period: 'year' } } });
    us.unmount();
    vi.unstubAllGlobals();
    // A floor that is already set keeps its own currency and period, in Taiwan too.
    const kept = setup({ filters: { country: 'TW', salaryMin: { amount: 60000, currency: 'USD', period: 'year' } } });
    fireEvent.change(await screen.findByPlaceholderText('Amount'), { target: { value: '70000' } });
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    await waitFor(() => expect(kept.onClose).toHaveBeenCalled());
    expect((kept.net.to('PATCH', `${P}/sp_main`)[0].body as { filters: { salaryMin: unknown } }).filters.salaryMin).toEqual({ amount: 70000, currency: 'USD', period: 'year' });
  });

  it('showsTaiwanPayHelper: the rule itself', () => {
    const counties = twDistrictsResponse().counties;
    const on = { includeUndisclosedPay: false as const };
    expect(showsTaiwanPayHelper('intl', { country: 'TW', ...on })).toBe(true);
    expect(showsTaiwanPayHelper('intl', { country: 'TW', salaryMin: { amount: 1, currency: 'TWD', period: 'month' } })).toBe(true);
    expect(showsTaiwanPayHelper('intl', { locations: [{ label: 'Hsinchu', country: 'TW', radiusKm: 40 }], ...on })).toBe(true);
    expect(showsTaiwanPayHelper('intl', { locations: [{ label: '新竹縣', radiusKm: 40 }], ...on }, counties)).toBe(true);
    // No pay filter, another country, no county table for a place with no country, the mainland brand: no line.
    expect(showsTaiwanPayHelper('intl', { country: 'TW' })).toBe(false);
    expect(showsTaiwanPayHelper('intl', { country: 'TW', includeUndisclosedPay: true })).toBe(false);
    expect(showsTaiwanPayHelper('intl', { country: 'US', ...on }, counties)).toBe(false);
    expect(showsTaiwanPayHelper('intl', { locations: [{ label: 'Taipei', country: 'US', radiusKm: 0 }], ...on }, counties)).toBe(false);
    expect(showsTaiwanPayHelper('intl', { locations: [{ label: '新竹縣', radiusKm: 40 }], ...on })).toBe(false);
    expect(showsTaiwanPayHelper('cn', { country: 'TW', ...on }, counties)).toBe(false);
  });
});
