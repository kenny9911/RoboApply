// MKT-5F (JT-6, JT-8): the pay-disclosure note reads its amount, link and
// as-of day from the server, and a Taiwan row found through Google's job index
// says so. The API wrappers are doubles (lib/api/tw); nothing reaches the
// network.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithBrand } from '../../../../../__tests__/shell/helpers';
import { toFeedItem } from '../../../../../server/src/features/feed/items';
import { cardMeta } from '../../../../../server/src/features/jobs/marketHooks';
import { TW_PAY_RULE_CALLER_MAX_AGE_S, TW_PAY_RULE_DEFAULT, TW_PAY_RULE_HOLD_MS, TW_PAY_RULE_MAX_STALE_MS } from '../../../../../server/src/features/tw/payRule';
import type { TwPayRuleView } from '../../../../../lib/api/tw';

const api = vi.hoisted(() => ({ getTwPayRule: vi.fn(), getTwDistricts: vi.fn() }));
vi.mock('../../../../../lib/api/tw', async (original) => ({ ...(await original<typeof import('../../../../../lib/api/tw')>()), ...api }));

import { TW_PAY_RULE_STALE_MS, formatRuleDate, formatTwd, httpsHref, isTaiwanSearch, twCountiesOfPlace, twPlaceKey } from '../../../../../lib/api/tw';
import { twDistrictsResponse } from '../../../../../server/src/features/tw/districts';
import { twPlaceKey as serverPlaceKey } from '../../../../../server/src/features/jobs/geo';
import { MarketJobMeta } from '../..';
import { JobMetaTw, readTwProvenance } from '../JobMetaTw';
import { NegotiablePayNote, TW_PAY_LAW_URL } from '../NegotiablePayNote';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');

/** What GET /tw/pay-rule answers with no stored row: the law as read on 2026-10-11. */
const DEFAULT_RULE: TwPayRuleView = { ...TW_PAY_RULE_DEFAULT, isDefault: true };
/** What it answers after an admin stores the announced amount (a config edit, no deploy). */
const NEW_RULE: TwPayRuleView = { thresholdTwd: 50000, lawLabel: '就業服務法第5條第2項第6款', sourceUrl: 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5', asOf: '2027-01-01', isDefault: false };

beforeEach(() => {
  vi.clearAllMocks();
  api.getTwPayRule.mockResolvedValue(DEFAULT_RULE);
});

const note = () => screen.getByText('Why is pay not listed?').closest('details') as HTMLElement;

describe('NegotiablePayNote: the rule comes from the server (JT-6)', () => {
  it('ACCEPT: with no stored rule the note shows NT$40,000, the law link and 2026-10-11', async () => {
    renderWithBrand(<NegotiablePayNote />);
    const stated = await screen.findByText(/lets an employer leave pay unlisted only when the regular monthly wage is NT\$40,000 or more\. That is the amount in the law as of October 11, 2026\./);
    expect(stated).toHaveAttribute('data-as-of', '2026-10-11');
    const link = within(note()).getByRole('link', { name: 'Read Article 5 in the national law database' });
    expect(link).toHaveAttribute('href', 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // The provision is shown in the law's own words, marked as Traditional Chinese.
    const provision = within(note()).getByText('就業服務法第5條第2項第6款');
    expect(provision).toHaveAttribute('lang', 'zh-Hant');
    expect(api.getTwPayRule).toHaveBeenCalledTimes(1);
  });

  it('ACCEPT: when the config says 50,000 with a new as-of day, the next load shows that, with no change to the page\'s code or copy', async () => {
    api.getTwPayRule.mockResolvedValue(NEW_RULE);
    renderWithBrand(<NegotiablePayNote />);
    const stated = await screen.findByText(/the regular monthly wage is NT\$50,000 or more\. That is the amount in the law as of January 1, 2027\./);
    expect(stated).toHaveAttribute('data-as-of', '2027-01-01');
    expect(note().textContent).not.toMatch(/40,000/);
  });

  it('the as-of day is written in the reader\'s language, and the amount always as NT$ with a thousands separator', async () => {
    renderWithBrand(<NegotiablePayNote />, { brand: 'roboapply' });
    await screen.findByText(/NT\$40,000 or more/);
    expect(formatTwd(40000)).toBe('NT$40,000');
    expect(formatTwd(50000)).toBe('NT$50,000');
    expect(formatTwd(200000)).toBe('NT$200,000');
    expect(formatRuleDate('2026-10-11', 'en')).toBe('October 11, 2026');
    expect(formatRuleDate('2026-10-11', 'zh-TW')).toBe('2026年10月11日');
    // A calendar day, not an instant: it does not move with the reader's time zone.
    expect(formatRuleDate('2027-01-01', 'en')).toBe('January 1, 2027');
    for (const bad of [0, -1, 40000.5, Number.NaN, '40000', null, undefined]) expect(formatTwd(bad), String(bad)).toBeNull();
    for (const bad of ['2026-02-30', '20261011', '2026/10/11', '', null, undefined, 7]) expect(formatRuleDate(bad, 'en'), String(bad)).toBeNull();
  });

  it('until the rule has arrived the note explains the rule without an amount, with the law link', async () => {
    let resolve!: (rule: TwPayRuleView) => void;
    api.getTwPayRule.mockReturnValue(new Promise<TwPayRuleView>((r) => (resolve = r)));
    renderWithBrand(<NegotiablePayNote />);
    expect(within(note()).getByText(/only when the regular monthly wage is at or above an amount the law sets\./)).toBeInTheDocument();
    expect(note().textContent).not.toMatch(/NT\$|\d{2},\d{3}/);
    expect(within(note()).getByRole('link', { name: 'Read Article 5 in the national law database' })).toHaveAttribute('href', TW_PAY_LAW_URL);
    resolve(DEFAULT_RULE);
    expect(await within(note()).findByText(/NT\$40,000 or more/)).toBeInTheDocument();
    expect(within(note()).queryByText(/at or above an amount the law sets/)).toBeNull();
  });

  it.each([
    ['the request fails', () => api.getTwPayRule.mockRejectedValue(new Error('offline'))],
    ['the server has no readable rule', () => api.getTwPayRule.mockResolvedValue(null)],
    ['the amount is not a whole number', () => api.getTwPayRule.mockResolvedValue({ ...DEFAULT_RULE, thresholdTwd: 'forty thousand' })],
    ['the as-of day is not a day', () => api.getTwPayRule.mockResolvedValue({ ...DEFAULT_RULE, asOf: 'soon' })],
  ])('when %s the note shows no amount at all: never a number it cannot vouch for', async (_label, arrange) => {
    arrange();
    renderWithBrand(<NegotiablePayNote />);
    await waitFor(() => expect(api.getTwPayRule).toHaveBeenCalled());
    await waitFor(() => expect(within(note()).getByText(/at or above an amount the law sets/)).toBeInTheDocument());
    expect(note().textContent).not.toMatch(/NT\$|\d{2},\d{3}|\d\s*萬/);
    expect(within(note()).getByText(/It is not this job's pay/)).toBeInTheDocument();
  });

  it('a link that is not https is never rendered: the note keeps the law database link', async () => {
    for (const sourceUrl of ['http://law.moj.gov.tw/x', 'javascript:alert(1)', '', 'law.moj.gov.tw']) {
      api.getTwPayRule.mockResolvedValue({ ...DEFAULT_RULE, sourceUrl });
      const view = renderWithBrand(<NegotiablePayNote />);
      await screen.findByText(/NT\$40,000 or more/);
      expect(within(note()).getByRole('link')).toHaveAttribute('href', TW_PAY_LAW_URL);
      view.unmount();
    }
    expect(httpsHref('https://example.gov.tw/rule')).toBe('https://example.gov.tw/rule');
    expect(httpsHref('http://example.gov.tw/rule')).toBeNull();
  });

  it('a rule read at another official page gets a plain link text: the words name the law database only when the link is that page', async () => {
    api.getTwPayRule.mockResolvedValue({ ...NEW_RULE, sourceUrl: 'https://www.mol.gov.tw/announcement/2027-pay-rule' });
    renderWithBrand(<NegotiablePayNote />);
    await screen.findByText(/NT\$50,000 or more/);
    expect(within(note()).getByRole('link', { name: 'Read the rule at its source' })).toHaveAttribute('href', 'https://www.mol.gov.tw/announcement/2027-pay-rule');
    expect(within(note()).queryByRole('link', { name: /national law database/ })).toBeNull();
  });

  it('keeps saying what it said: the rule is for employers, not this job\'s pay, and the filter context adds the toggle hint', async () => {
    renderWithBrand(<NegotiablePayNote context="filter" />);
    await screen.findByText(/NT\$40,000 or more/);
    expect(within(note()).getByText("That rule is for employers. It is not this job's pay, and pay that a posting does not list is never estimated here.")).toBeInTheDocument();
    expect(within(note()).getByText(/Turn on “Only jobs that list pay” to hide them/)).toBeInTheDocument();
  });

  it('GoApply never asks for the rule (the route answers 404 there)', async () => {
    renderWithBrand(<NegotiablePayNote />, { brand: 'goapply' });
    expect(within(note()).getByText(/at or above an amount the law sets/)).toBeInTheDocument();
    await Promise.resolve();
    expect(api.getTwPayRule).not.toHaveBeenCalled();
  });

  it('two notes on one screen share one request', async () => {
    renderWithBrand(
      <>
        <NegotiablePayNote />
        <NegotiablePayNote context="filter" />
      </>,
    );
    expect(await screen.findAllByText(/NT\$40,000 or more/)).toHaveLength(2);
    expect(api.getTwPayRule).toHaveBeenCalledTimes(1);
  });
});

describe('the amount lives in config, not in a message bundle (JT-6)', () => {
  const read = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Record<string, unknown>;
  const leaves = (node: unknown, path = '', out: Array<[string, string]> = []): Array<[string, string]> => {
    if (typeof node === 'string') out.push([path, node]);
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) leaves(v, path ? `${path}.${k}` : k, out);
    return out;
  };
  /** A statutory amount written into copy: NT$40,000, 40,000, 4萬 / 5萬, 四萬. */
  const AMOUNT = /NT\$\s?\d|\b\d{2},\d{3}\b|[4-9]\s*[萬万]|[四五]\s*[萬万]/;

  it('the staged English of the note takes {amount} and {asOf} and holds no number', () => {
    const staged = read('i18n/staging/jobsTw.en.json').jobsTw as { negotiable: Record<string, string> };
    expect(staged.negotiable.body).toContain('{amount}');
    expect(staged.negotiable.body).toContain('{asOf}');
    for (const [path, text] of leaves(staged.negotiable)) expect(text, path).not.toMatch(AMOUNT);
    expect(staged.negotiable.bodyNoAmount).not.toMatch(/\{amount\}|\{asOf\}/);
  });

  it('English as the app serves it (en.json with the staged strings over it) has no amount anywhere under jobsTw.negotiable', () => {
    const en = (read('i18n/messages/en.json').jobsTw as { negotiable: Record<string, string> }).negotiable;
    const staged = (read('i18n/staging/jobsTw.en.json').jobsTw as { negotiable: Record<string, string> }).negotiable;
    const served = { ...en, ...staged };
    for (const [key, text] of Object.entries(served)) expect(text, key).not.toMatch(AMOUNT);
    // Every key the note reads resolves.
    for (const key of ['summary', 'body', 'bodyNoAmount', 'notAFigure', 'lawLink', 'sourceLink', 'filterHint']) expect(served[key], key).toBeTruthy();
  });

  it('no other key of any locale bundle states the amount: the one changed key (jobsTw.negotiable.body) is the only place it was ever written', () => {
    // The staging merge replaces `jobsTw.negotiable.body` in en.json and drops its stale translations
    // (scripts/i18n-merge-staging.mjs: a changed English key loses its translations until they are redone),
    // so after that merge no locale bundle holds the amount. Until then it is in that one key and nowhere else.
    const dir = join(ROOT, 'i18n', 'messages');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const offenders = leaves(read(`i18n/messages/${file}`))
        .filter(([path, text]) => /40,000|4\s*[萬万]/.test(text) && path !== 'jobsTw.negotiable.body')
        .map(([path]) => path);
      expect(offenders, file).toEqual([]);
    }
  });

  it('review finding: a translation of the note that cannot take the amount lives only until the staging merge; once English is merged, every locale takes {amount} and {asOf} or has no sentence of its own', () => {
    // lib/i18n.ts puts a locale's own string over the staged English, so a translation with the amount written
    // in it would ignore the config for that reader. The staging merge deletes the translations of a changed
    // English key (scripts/i18n-merge-staging.mjs), and the locale pass writes them again with the placeholders.
    // Before the merge: en.json still differs from the staged sentence, and the old translations are the known
    // leftovers that the merge removes. After it (en.json holds the staged sentence, or staging is empty): this
    // test fails for any locale that kept a sentence without the two placeholders or with a number in it.
    const en = (read('i18n/messages/en.json').jobsTw as { negotiable: Record<string, string> }).negotiable.body;
    const staged = ((read('i18n/staging/jobsTw.en.json').jobsTw ?? {}) as { negotiable?: Record<string, string> }).negotiable?.body;
    const merged = staged === undefined || staged === en;
    const dir = join(ROOT, 'i18n', 'messages');
    const stale: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const body = ((read(`i18n/messages/${file}`).jobsTw ?? {}) as { negotiable?: Record<string, string> }).negotiable?.body;
      if (body === undefined) continue; // no sentence of its own: the reader gets English, which takes the amount
      const followsConfig = body.includes('{amount}') && body.includes('{asOf}') && !AMOUNT.test(body);
      if (!followsConfig) stale.push(file);
    }
    if (merged) expect(stale, 'after the staging merge no locale may keep a sentence that ignores the config').toEqual([]);
    else {
      // Not merged yet: English as served already takes the amount, and whatever is stale is a key the merge will treat as changed.
      expect(staged).toContain('{amount}');
      expect(en).not.toBe(staged);
    }
  });

  it('the web keeps the rule for 4 minutes and the server for 1: the note is at most 5 minutes behind an edit', () => {
    expect(TW_PAY_RULE_STALE_MS).toBe(4 * 60_000);
    expect(TW_PAY_RULE_STALE_MS).toBe(TW_PAY_RULE_CALLER_MAX_AGE_S * 1000);
    expect(TW_PAY_RULE_STALE_MS + TW_PAY_RULE_HOLD_MS).toBe(TW_PAY_RULE_MAX_STALE_MS);
  });

  it('no component of the Taiwan market holds the amount either', () => {
    for (const file of ['NegotiablePayNote.tsx', 'JobMetaTw.tsx']) {
      const code = readFileSync(join(HERE, '..', file), 'utf8').replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      expect(code, file).not.toMatch(/40[,_]?000|50[,_]?000|[4-9]\s*萬/);
    }
  });
});

describe('the amount is never a job\'s pay (JT-6)', () => {
  /** A 104-style posting that says 面議 with the floor clause: the row as the feed reads it. SYNTHETIC. */
  const row = {
    id: 'job_tw_1',
    market: 'intl',
    visibility: 'public',
    ownerUserId: null,
    title: '資深後端工程師',
    titleNormalized: '資深後端工程師',
    companyName: '範例資訊',
    companyNameNormalized: '範例資訊',
    companyId: null,
    companyLogoUrl: null,
    taxonomyIds: [],
    primaryTaxonomyId: null,
    seniority: null,
    roleType: null,
    minYears: null,
    maxYears: null,
    educationLevel: null,
    skills: [],
    skillsDetail: null,
    workModel: null,
    remoteScope: null,
    location: '台北市信義區',
    locationCity: 'Taipei',
    locationCountry: 'TW',
    geoLat: null,
    geoLng: null,
    employmentType: 'full_time',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryAnnualMin: null,
    salaryAnnualMax: null,
    salaryDisclosed: false,
    salaryText: '待遇面議(經常性薪資達4萬元或以上)',
    salaryMonths: null,
    sponsorship: null,
    sponsorshipEvidence: null,
    citizenshipRequired: null,
    clearanceRequired: null,
    employerTags: [],
    marketTags: null,
    postedAt: new Date('2026-10-09T00:00:00.000Z'),
    postedAtEstimated: true,
    firstSeenAt: new Date('2026-10-09T00:00:00.000Z'),
    lastSeenAt: new Date('2026-10-11T00:00:00.000Z'),
    expiresAt: null,
    sourceBoard: 'jsearch',
    sourceName: 'JSearch',
    originalSourceName: '104人力銀行',
    applyUrl: 'https://www.104.com.tw/job/abc12',
    sourceUrl: 'https://www.104.com.tw/job/abc12',
    atsType: null,
    isAgency: false,
    fromRecruiterBank: false,
    employerVerified: false,
    sourcePriority: 30,
    archivedAt: null,
    hasBenefits: false,
    descriptionLength: 400,
    companyIndustries: [],
    companySizeBand: null,
    companyFacts: null,
    companyDisplayName: null,
    companyLogo: null,
    skillIds: [],
    contentHash: null,
    lang: 'zh-Hant',
    titleMatchScore: null,
  };

  it('ACCEPT: the card model of a negotiable posting carries no pay figure: not 40,000, not its yearly multiple, not a pay line', () => {
    const meta = cardMeta(row as never, { brand: 'roboapply', market: 'intl', stage: 'card' });
    const item = toFeedItem(row as never, { user: null, fit: null, tracker: null, position: null, now: new Date('2026-10-11T04:00:00.000Z'), cardMeta: meta });
    // No figure on the model.
    expect(item.pay).toBeNull();
    expect(item.salary).toBeNull();
    const serialized = JSON.stringify(item);
    expect(serialized).not.toMatch(/40[,_]?000|480[,_]?000|50[,_]?000/);
    // The posting's own words are kept, minus the legal floor clause: that clause is the law, not this job's pay.
    expect(meta.ats_public).toMatchObject({ pay: { text: '待遇面議', disclosed: false, negotiable: true } });
    expect(JSON.stringify((meta.ats_public as { pay: { text: string } }).pay.text)).not.toMatch(/4\s*萬/);
  });

  it('ACCEPT: the card of that posting shows 面議 as posted and no amount, whatever the rule says', () => {
    api.getTwPayRule.mockResolvedValue(NEW_RULE);
    const meta = cardMeta(row as never, { brand: 'roboapply', market: 'intl', stage: 'card' });
    const { container } = renderWithBrand(<MarketJobMeta jobId="job_tw_1" meta={meta} variant="card" />);
    expect(screen.getByText('Pay as posted: 待遇面議')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/NT\$|\d{2},\d{3}|[4-9]\s*萬/);
    // The card does not carry the note, so it never even asks for the rule.
    expect(api.getTwPayRule).not.toHaveBeenCalled();
  });

  it('ACCEPT: on the job page the amount appears only inside the note that explains the rule, next to "it is not this job\'s pay"', async () => {
    const meta = cardMeta(row as never, { brand: 'roboapply', market: 'intl', stage: 'card' });
    renderWithBrand(<JobMetaTw jobId="job_tw_1" meta={meta} variant="detail" />);
    const region = screen.getByRole('region', { name: 'Pay and work permits' });
    await within(region).findByText(/NT\$40,000 or more/);
    // Outside the note: the posting's own words only.
    const outside = region.cloneNode(true) as HTMLElement;
    outside.querySelector('details')!.remove();
    expect(outside.textContent).toContain('Pay as posted: 待遇面議');
    expect(outside.textContent).not.toMatch(/NT\$|\d{2},\d{3}/);
    expect(within(note()).getByText(/It is not this job's pay/)).toBeInTheDocument();
  });
});

describe('JobMetaTw: a Taiwan row found through Google\'s job index (JT-8)', () => {
  const PAY = { country: 'TW', pay: { text: '待遇面議', posted: '待遇面議', disclosed: false, negotiable: true }, permitTags: [], source: { name: 'JSearch', url: 'https://www.104.com.tw/job/abc12', board: null } };
  const LISTED = { ...PAY, pay: { text: null, posted: null, disclosed: true, negotiable: false } };
  const FOUND = { via: 'google_jobs', publisher: '104人力銀行', url: 'https://www.104.com.tw/job/abc12' };
  const LINE = '104人力銀行 · found through Google job search';

  it.each(['card', 'detail'] as const)('ACCEPT (%s): reads "104人力銀行 · found through Google job search", linked to the original posting', (variant) => {
    const { container } = renderWithBrand(<JobMetaTw jobId="j1" meta={{ ats_public: PAY, tw_sources: FOUND }} variant={variant} />);
    const link = screen.getByRole('link', { name: LINE });
    expect(link).toHaveAttribute('href', 'https://www.104.com.tw/job/abc12');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelectorAll('[data-tw-provenance="google_jobs"]')).toHaveLength(1);
    // Words only: no board logo, no image at all.
    expect(container.querySelector('img, svg, picture')).toBeNull();
  });

  it('ACCEPT: a row with no publisher names only the search', () => {
    renderWithBrand(<JobMetaTw jobId="j1" meta={{ ats_public: LISTED, tw_sources: { via: 'google_jobs', publisher: null, url: 'https://www.104.com.tw/job/abc12' } }} variant="card" />);
    expect(screen.getByRole('link', { name: 'Found through Google job search' })).toHaveAttribute('href', 'https://www.104.com.tw/job/abc12');
  });

  it('ACCEPT: no LinkedIn name and no LinkedIn link is ever rendered, even if one reached the page', () => {
    for (const publisher of ['LinkedIn', 'Linked In', 'linkedin.com', '領英']) {
      const view = renderWithBrand(<JobMetaTw jobId="j1" meta={{ ats_public: LISTED, tw_sources: { via: 'google_jobs', publisher, url: 'https://tw.linkedin.com/jobs/view/1' } }} variant="detail" />);
      expect(view.container.textContent).toBe('Found through Google job search');
      expect(view.container.querySelector('a')).toBeNull();
      expect(view.container.innerHTML).not.toMatch(/linked\s*-?\s*in|領英/i);
      view.unmount();
    }
    expect(readTwProvenance({ tw_sources: { via: 'google_jobs', publisher: 'LinkedIn', url: 'https://www.linkedin.com/jobs/view/1' } })).toEqual({ via: 'google_jobs', publisher: null, url: null });
  });

  it('the job page never names the aggregator as the source of such a row: the line replaces "Source: …"', () => {
    renderWithBrand(<JobMetaTw jobId="j1" meta={{ ats_public: PAY, tw_sources: FOUND }} variant="detail" />);
    const region = screen.getByRole('region', { name: 'Pay and work permits' });
    expect(within(region).getByRole('link', { name: LINE })).toBeInTheDocument();
    expect(region.textContent).not.toMatch(/JSearch|Source:/);
    expect(within(region).queryByRole('link', { name: 'Open the original posting' })).toBeNull();
  });

  it('a row with listed pay and no permit tag still says where it came from; with no safe link the line is plain text', () => {
    const view = renderWithBrand(<JobMetaTw jobId="j2" meta={{ ats_public: LISTED, tw_sources: FOUND }} variant="card" />);
    expect(view.container.textContent).toBe(LINE);
    view.unmount();
    for (const url of ['javascript:alert(1)', '/job/1', '', null]) {
      const plain = renderWithBrand(<JobMetaTw jobId="j3" meta={{ ats_public: LISTED, tw_sources: { ...FOUND, url } } as never} variant="card" />);
      expect(plain.container.textContent).toBe(LINE);
      expect(plain.container.querySelector('a')).toBeNull();
      plain.unmount();
    }
  });

  it('nothing suggests a partnership: the wording is "found through", and the staged strings say nothing else', () => {
    const staged = JSON.parse(readFileSync(join(ROOT, 'i18n/staging/jobsTw.en.json'), 'utf8')) as { jobsTw: { meta: Record<string, string> } };
    expect(staged.jobsTw.meta.foundThroughGoogle).toBe('{publisher} · found through Google job search');
    expect(staged.jobsTw.meta.foundThroughGoogleOnly).toBe('Found through Google job search');
    for (const text of Object.values(staged.jobsTw.meta)) expect(text).not.toMatch(/partner|official|in cooperation|powered by|verified by|from 104|104|1111|Cake/i);
  });

  it('other rows are untouched: an employer-board row keeps "Source: company · job board", an open-data row keeps its attribution and gets no search line', () => {
    const board = { ...PAY, source: { name: 'Formosa Robotics · Greenhouse', url: 'https://boards.greenhouse.io/formosarobotics/jobs/1', board: 'greenhouse' } };
    const first = renderWithBrand(<JobMetaTw jobId="j4" meta={{ ats_public: board }} variant="detail" />);
    expect(screen.getByText('Source: Formosa Robotics · Greenhouse')).toBeInTheDocument();
    expect(first.container.querySelector('[data-tw-provenance]')).toBeNull();
    first.unmount();
    const sentence = '資料來源：勞動部勞動力發展署 2026「台灣就業通網站職缺清單」，依政府資料開放授權條款第1版公開釋出';
    const open = renderWithBrand(<JobMetaTw jobId="j5" meta={{ ats_public: LISTED, tw_sources: { attribution: { text: sentence, url: 'https://data.gov.tw/license' } } }} variant="card" />);
    expect(open.container.textContent).toBe(sentence);
    expect(open.container.querySelector('[data-tw-provenance]')).toBeNull();
  });

  it('readTwProvenance: only a well-formed "found through Google" value is one; anything else renders nothing', () => {
    expect(readTwProvenance({ tw_sources: FOUND })).toEqual(FOUND);
    expect(readTwProvenance({ tw_sources: { via: 'google_jobs', publisher: '  1111人力銀行 ', url: 'https://www.1111.com.tw/job/1' } })).toEqual({ via: 'google_jobs', publisher: '1111人力銀行', url: 'https://www.1111.com.tw/job/1' });
    for (const meta of [null, undefined, {}, { tw_sources: {} }, { tw_sources: { via: 'partner' } }, { tw_sources: { publisher: '104人力銀行' } }, { tw_sources: 'google_jobs' }, { tw_sources: { attribution: { text: 'x', url: 'https://data.gov.tw/license' } } }]) {
      expect(readTwProvenance(meta as never), JSON.stringify(meta)).toBeNull();
    }
    expect(readTwProvenance({ tw_sources: { via: 'google_jobs', publisher: 'x'.repeat(81), url: 7 } } as never)).toEqual({ via: 'google_jobs', publisher: null, url: null });
    const empty = renderWithBrand(<JobMetaTw jobId="j6" meta={{ tw_sources: { via: 'partner', publisher: '104人力銀行' } }} variant="card" />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it('reaches RoboApply cards through MarketJobMeta, end to end from the server\'s own card meta', () => {
    const meta = cardMeta(
      { id: 'j7', market: 'intl', provider: 'jsearch', sourceBoard: 'jsearch', locationCountry: 'TW', sourceName: 'JSearch', originalSourceName: '104人力銀行', sourceUrl: 'https://www.104.com.tw/job/abc12', applyUrl: 'https://www.104.com.tw/job/abc12', salaryDisclosed: true },
      { brand: 'roboapply', market: 'intl', stage: 'card' },
    );
    renderWithBrand(<MarketJobMeta jobId="j7" meta={meta} variant="card" />, { brand: 'roboapply' });
    expect(screen.getByRole('link', { name: LINE })).toHaveAttribute('href', 'https://www.104.com.tw/job/abc12');
  });
});

describe('lib/api/tw: the helpers the filters and the note share', () => {
  const counties = twDistrictsResponse().counties;

  it('folds a typed place the way the server folds a county\'s keys', () => {
    for (const text of ['台北市', '臺北市', ' Taipei   City ', 'ＴＡＩＰＥＩ', '新竹縣', 'Hsinchu County']) expect(twPlaceKey(text), text).toBe(serverPlaceKey(text));
    expect(twPlaceKey('臺北市')).toBe('台北市');
    expect(twPlaceKey('  Taipei   City ')).toBe('taipei city');
  });

  it('matches the place someone typed to its county, against the table the server sends', () => {
    const names = (label: string, country?: string) => twCountiesOfPlace({ label, ...(country ? { country } : {}) }, counties).map((c) => c.name);
    expect(names('台北市')).toEqual(['台北市']);
    expect(names('臺北市信義區')).toEqual(['台北市']);
    expect(names('Taipei, Taiwan')).toEqual(['台北市']);
    expect(names('taipei city')).toEqual(['台北市']);
    expect(names('新竹縣竹北市')).toEqual(['新竹縣']);
    expect(names('Chiayi')).toEqual(['嘉義市', '嘉義縣']);
    expect(names('連江縣')).toEqual(['連江縣']);
    expect(names('Austin')).toEqual([]);
    expect(names('Taipei', 'US')).toEqual([]);
    expect(names('')).toEqual([]);
  });

  it('knows a search in Taiwan by its country, a place that says TW, or (with the table) a place that names a county', () => {
    expect(isTaiwanSearch({ country: 'TW' })).toBe(true);
    expect(isTaiwanSearch({ locations: [{ label: 'x', country: 'TW' }] })).toBe(true);
    expect(isTaiwanSearch({ locations: [{ label: '新竹縣' }] }, counties)).toBe(true);
    expect(isTaiwanSearch({ locations: [{ label: '新竹縣' }] })).toBe(false);
    expect(isTaiwanSearch({ country: 'US', locations: [{ label: 'Austin', country: 'US' }] }, counties)).toBe(false);
    expect(isTaiwanSearch({ locations: [{ label: 'Taipei', country: 'US' }] }, counties)).toBe(false);
    expect(isTaiwanSearch({}, counties)).toBe(false);
  });
});
