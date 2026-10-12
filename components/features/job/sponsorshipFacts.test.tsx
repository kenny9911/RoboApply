// MKT-5G (JI-11) — the employer's sponsorship records on the job page: one
// line per fact with its year, count, source (a link to the publication), file
// and date; the disclaimer; nothing at all for an empty list; open for a viewer
// who needs sponsorship and one line for everyone else; the newest fiscal year
// of each source shown and the earlier years behind one line, so a long record
// does not push the posting down the page; RoboApply only; and no sentence, in
// the block or in its strings, that says the job sponsors.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({ getCompanySponsorship: vi.fn() }));

vi.mock('../../../lib/api/companyFacts', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCompanySponsorship: api.getCompanySponsorship,
}));
// JobOverview's other blocks have their own tests; markers stand in so this file reads the sponsorship block only.
vi.mock('../match', () => ({ JobFit: () => <div data-testid="stub-fit" />, JobKeywordCheck: () => <div data-testid="stub-keywords" /> }));
vi.mock('../compliance', () => ({ WhyThisJob: () => null }));
vi.mock('../market', () => ({
  AiGeneratedBadge: () => null,
  MarketJobMeta: () => <div data-testid="stub-market-meta" />,
  withListing: (meta: unknown) => meta,
  withOwnImport: (meta: unknown) => meta,
}));

import enMessages from '../../../i18n/messages/en.json';
import { SPONSORSHIP_DISCLAIMER } from '../../../server/src/features/jobs/companies/sponsorship/contract';
import type { CompanySponsorshipResponse, SponsorshipFact } from '../../../lib/api/companyFacts';
import type { JobDetailResponse } from '../../../lib/api/contracts/jobs/detail';
import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { JobOverview } from './JobOverview';
import { SponsorshipFacts, SponsorshipFactsBlock, splitFacts } from './SponsorshipFacts';

const DISCLAIMER = 'These are public records about the employer, not about this job. Past filings or a sponsor license do not mean this employer will sponsor this role.';
const OGL = 'Contains public sector information licensed under the Open Government Licence v3.0.';

const LCA: SponsorshipFact = {
  kind: 'dol_lca',
  fiscalYear: 2025,
  certifiedCount: 1240,
  source: { name: 'US Department of Labor, LCA disclosure data', url: 'https://www.dol.gov/agencies/eta/foreign-labor/performance', sourceFile: 'LCA_Disclosure_Data_FY2025_Q4.xlsx', asOf: '2026-10-10T08:00:00.000Z', dated: 'imported' },
};
const USCIS: SponsorshipFact = {
  kind: 'uscis_h1b_hub',
  fiscalYear: 2023,
  approvals: 11,
  denials: 2,
  employerName: 'EXAMPLE EMPLOYER LLC',
  source: {
    name: 'US Citizenship and Immigration Services, H-1B Employer Data Hub',
    url: 'https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub',
    sourceFile: 'h1b_datahubexport-2023.csv',
    // Midnight UTC of the publication day: the day must not slip for a reader west of Greenwich.
    asOf: '2025-07-01T00:00:00.000Z',
    dated: 'published',
  },
};
const UK: SponsorshipFact = {
  kind: 'uk_sponsor_register',
  town: 'Exampletown',
  rating: 'Worker (A rating); Temporary Worker (A rating)',
  routes: ['Skilled Worker', 'Creative Worker'],
  employerName: 'Example Employer Ltd',
  source: {
    name: 'UK Visas and Immigration, Register of licensed sponsors: workers',
    url: 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers',
    sourceFile: 'SP_-_placeholder_register_-_2026-10-09.csv',
    asOf: '2026-10-09T00:00:00.000Z',
    dated: 'published',
    attribution: { text: OGL, url: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/' },
  },
};

const answer = (over: Partial<CompanySponsorshipResponse> = {}): CompanySponsorshipResponse => ({ facts: [LCA, USCIS, UK], disclaimer: 'server text (the page shows its own translation)', viewerNeedsSponsorship: true, ...over });

const ON = { flags: { h1bHistory: true } } as const;

afterEach(() => {
  vi.clearAllMocks();
});

function block() {
  return screen.getByTestId('sponsorship-facts');
}
function line(kind: SponsorshipFact['kind']) {
  return block().querySelector(`li[data-fact="${kind}"]`) as HTMLElement;
}

describe('SponsorshipFactsBlock: each fact with its year, count, source and date', () => {
  it('a certified-applications fact: the count, the fiscal year, the publication as a link, the file and when we imported it', () => {
    renderWithBrand(<SponsorshipFactsBlock response={answer()} companyName="Example Employer" />, ON);
    const li = line('dol_lca');
    expect(li).toHaveTextContent('1,240 H-1B labor condition applications certified in fiscal year 2025');
    const link = within(li).getByRole('link', { name: 'US Department of Labor, LCA disclosure data' });
    expect(link).toHaveAttribute('href', 'https://www.dol.gov/agencies/eta/foreign-labor/performance');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(li).toHaveTextContent('Source: US Department of Labor, LCA disclosure data · File: LCA_Disclosure_Data_FY2025_Q4.xlsx · file imported Oct 10, 2026');
    // This table carries no name as the record prints it, and no licence line.
    expect(li).not.toHaveTextContent('Listed as');
    expect(li.querySelector('[data-part="attribution"]')).toBeNull();
  });

  it('a petitions fact: approved and denied, the fiscal year, the name the record prints, the source and the file\'s date', () => {
    renderWithBrand(<SponsorshipFactsBlock response={answer()} companyName="Example Employer" />, ON);
    const li = line('uscis_h1b_hub');
    expect(li).toHaveTextContent('11 H-1B petitions approved and 2 denied in fiscal year 2023');
    expect(within(li).getByRole('link', { name: 'US Citizenship and Immigration Services, H-1B Employer Data Hub' })).toHaveAttribute('href', 'https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub');
    expect(li).toHaveTextContent('Listed as EXAMPLE EMPLOYER LLC · Source: US Citizenship and Immigration Services, H-1B Employer Data Hub · File: h1b_datahubexport-2023.csv · as of Jul 1, 2025');
  });

  it('one petition and no denial read as a sentence too; zero approvals is shown as zero', () => {
    renderWithBrand(<SponsorshipFactsBlock response={answer({ facts: [{ ...USCIS, approvals: 1, denials: 0 } as SponsorshipFact, { ...USCIS, fiscalYear: 2022, approvals: 0, denials: 3 } as SponsorshipFact, { ...LCA, certifiedCount: 1 } as SponsorshipFact] })} companyName="Example Employer" />, ON);
    expect(block()).toHaveTextContent('1 H-1B petition approved and 0 denied in fiscal year 2023');
    expect(block()).toHaveTextContent('0 H-1B petitions approved and 3 denied in fiscal year 2022');
    expect(block()).toHaveTextContent('1 H-1B labor condition application certified in fiscal year 2025');
  });

  it('a UK register fact: the licence, its type and rating, its routes and town, the register as a link, its date, and the acknowledgement its licence asks for', () => {
    renderWithBrand(<SponsorshipFactsBlock response={answer()} companyName="Example Employer" />, ON);
    const li = line('uk_sponsor_register');
    expect(li).toHaveTextContent('Licensed sponsor on the UK register');
    expect(li.querySelector('[data-part="details"]')).toHaveTextContent('Type and rating: Worker (A rating); Temporary Worker (A rating) · Routes: Skilled Worker, Creative Worker · Town: Exampletown');
    expect(within(li).getByRole('link', { name: 'UK Visas and Immigration, Register of licensed sponsors: workers' })).toHaveAttribute('href', 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers');
    expect(li).toHaveTextContent('Listed as Example Employer Ltd · Source: UK Visas and Immigration, Register of licensed sponsors: workers · File: SP_-_placeholder_register_-_2026-10-09.csv · as of Oct 9, 2026');
    expect(within(li).getByRole('link', { name: OGL })).toHaveAttribute('href', 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/');
  });

  it('a register entry with one route, no rating and no town says only what the register says', () => {
    renderWithBrand(<SponsorshipFactsBlock response={answer({ facts: [{ ...UK, rating: null, town: null, routes: ['Skilled Worker'] } as SponsorshipFact] })} companyName="Example Employer" />, ON);
    const li = line('uk_sponsor_register');
    expect(li.querySelector('[data-part="details"]')).toHaveTextContent(/^Route: Skilled Worker$/);
    // No US fact: the note about applications and petitions is not shown.
    expect(block()).not.toHaveTextContent('A certified application is not a visa approval');
  });

  it('shows the facts in the order of the answer, the note about what the US counts are, and the disclaimer', () => {
    renderWithBrand(<SponsorshipFactsBlock response={answer()} companyName="Example Employer" />, ON);
    expect([...block().querySelectorAll('li[data-fact]')].map((li) => li.getAttribute('data-fact'))).toEqual(['dol_lca', 'uscis_h1b_hub', 'uk_sponsor_register']);
    expect(block()).toHaveTextContent('Public records about this employer. Each line names its source and date.');
    expect(block()).toHaveTextContent('A certified application is not a visa approval or a hire. Petition counts are first decisions and cover new and continuing employment.');
    // The page's own (translated) disclaimer, not the server's English text.
    expect(within(block()).getByRole('note')).toHaveTextContent(DISCLAIMER);
    expect(block()).not.toHaveTextContent('server text');
  });

  it('a source address that is not a web address is never a link', () => {
    const odd = { ...UK, source: { ...UK.source, url: 'javascript:alert(1)', attribution: { text: OGL, url: 'data:text/html,x' } } } as SponsorshipFact;
    renderWithBrand(<SponsorshipFactsBlock response={answer({ facts: [odd] })} companyName="Example Employer" />, ON);
    expect(within(block()).queryAllByRole('link')).toEqual([]);
    expect(block()).toHaveTextContent('Source: UK Visas and Immigration, Register of licensed sponsors: workers');
    expect(block()).toHaveTextContent(OGL);
  });

  it('with no facts nothing is rendered: no block, no "no records" line about the employer', () => {
    const view = renderWithBrand(<SponsorshipFactsBlock response={answer({ facts: [] })} companyName="Example Employer" />, ON);
    expect(view.container).toBeEmptyDOMElement();
  });
});

describe('who the block is open for', () => {
  it('a viewer who needs sponsorship in the job\'s country sees it open, under its own title', () => {
    renderWithBrand(<SponsorshipFactsBlock response={answer({ viewerNeedsSponsorship: true })} companyName="Example Employer" />, ON);
    expect(block()).toHaveAttribute('data-open', 'true');
    expect(within(block()).getByRole('heading', { name: 'Visa sponsorship records for Example Employer' })).toBeInTheDocument();
    expect(block().querySelector('details')).toBeNull();
    expect(block()).toHaveAccessibleName('Visa sponsorship records for Example Employer');
  });

  it('everyone else gets one line that opens it', () => {
    renderWithBrand(<SponsorshipFactsBlock response={answer({ viewerNeedsSponsorship: false })} companyName="Example Employer" />, ON);
    expect(block()).toHaveAttribute('data-open', 'false');
    const details = block().querySelector('details')!;
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary')!;
    expect(summary).toHaveTextContent('Visa sponsorship records for Example Employer');
    // The same facts and the same disclaimer are behind the line; nothing is left out for these viewers.
    fireEvent.click(summary);
    expect(details.querySelectorAll('li[data-fact]')).toHaveLength(3);
    expect(within(details).getByRole('note')).toHaveTextContent(DISCLAIMER);
  });
});

describe('a long record stays short on the page: the newest fiscal year of each source, the earlier years behind one line', () => {
  // Five fiscal years of each US source (the most the answer carries) and the UK entry: eleven facts.
  const lca = [2025, 2024, 2023, 2022, 2021].map((fiscalYear, i) => ({ ...LCA, fiscalYear, certifiedCount: 100 + i }) as SponsorshipFact);
  const hub = [2023, 2022, 2021, 2020, 2019].map((fiscalYear, i) => ({ ...USCIS, fiscalYear, approvals: 10 + i }) as SponsorshipFact);
  const long = [...lca, ...hub, UK];
  const earlierOf = () => block().querySelector('details[data-part="earlier"]') as HTMLDetailsElement;
  const yearOf = (li: Element) => `${li.getAttribute('data-fact')} ${/fiscal year (\d{4})/.exec(li.textContent ?? '')?.[1] ?? ''}`.trim();

  it('open: three lines are shown, and one line opens the other eight, each still with its source, file and date', () => {
    renderWithBrand(<SponsorshipFactsBlock response={answer({ facts: long, viewerNeedsSponsorship: true })} companyName="Example Employer" />, ON);
    expect(block()).toHaveAttribute('data-open', 'true');
    const earlier = earlierOf();
    expect(earlier.open).toBe(false);
    expect(earlier.querySelector('summary')).toHaveTextContent(/^8 records from earlier fiscal years$/);
    const all = [...block().querySelectorAll('li[data-fact]')];
    expect(all).toHaveLength(11);
    expect(all.filter((li) => !earlier.contains(li)).map(yearOf)).toEqual(['dol_lca 2025', 'uscis_h1b_hub 2023', 'uk_sponsor_register']);
    // Behind the line: every earlier year, in the order of the answer, nothing left out.
    const behind = [...earlier.querySelectorAll('li[data-fact]')];
    expect(behind.map(yearOf)).toEqual(['dol_lca 2024', 'dol_lca 2023', 'dol_lca 2022', 'dol_lca 2021', 'uscis_h1b_hub 2022', 'uscis_h1b_hub 2021', 'uscis_h1b_hub 2020', 'uscis_h1b_hub 2019']);
    for (const li of behind) {
      expect(within(li as HTMLElement).getAllByRole('link', { hidden: true }).length).toBeGreaterThanOrEqual(1);
      expect(li.querySelector('[data-part="source"]')).toHaveTextContent(/Source: .+ · File: .+ · (as of|file imported) /);
    }
    expect(behind[0]).toHaveTextContent('101 H-1B labor condition applications certified in fiscal year 2024');
    fireEvent.click(earlier.querySelector('summary')!);
    // The note and the disclaimer stay outside the line: they are read whether or not it is opened.
    const note = within(block()).getByRole('note');
    expect(earlier.contains(note)).toBe(false);
    expect(note).toHaveTextContent(DISCLAIMER);
  });

  it('behind the one line that opens the block, the same: newest years first, earlier years one step further', () => {
    renderWithBrand(<SponsorshipFactsBlock response={answer({ facts: long, viewerNeedsSponsorship: false })} companyName="Example Employer" />, ON);
    const outer = block().querySelector('details')!;
    expect(outer.getAttribute('data-part')).toBeNull();
    const earlier = earlierOf();
    expect(outer.contains(earlier)).toBe(true);
    expect(earlier.querySelectorAll('li[data-fact]')).toHaveLength(8);
    expect(outer.querySelectorAll('li[data-fact]')).toHaveLength(11);
  });

  it('one earlier year reads as one; a record with one year per source has no such line', () => {
    const first = renderWithBrand(<SponsorshipFactsBlock response={answer({ facts: [LCA, { ...LCA, fiscalYear: 2024 } as SponsorshipFact] })} companyName="Example Employer" />, ON);
    expect(earlierOf().querySelector('summary')).toHaveTextContent(/^1 record from an earlier fiscal year$/);
    first.unmount();
    renderWithBrand(<SponsorshipFactsBlock response={answer()} companyName="Example Employer" />, ON);
    expect(earlierOf()).toBeNull();
  });

  it('which year is newest is read from the facts, not from their order', () => {
    const { shown, earlier } = splitFacts([...lca].reverse().concat(UK, [...hub].reverse()));
    expect(shown.map((f) => (f.kind === 'uk_sponsor_register' ? f.kind : `${f.kind} ${f.fiscalYear}`))).toEqual(['dol_lca 2025', 'uk_sponsor_register', 'uscis_h1b_hub 2023']);
    expect(earlier).toHaveLength(8);
    expect(splitFacts([])).toEqual({ shown: [], earlier: [] });
    expect(splitFacts([UK])).toEqual({ shown: [UK], earlier: [] });
  });
});

describe('SponsorshipFacts: asking for the facts', () => {
  it('asks for the company\'s facts as shown on this job page, and renders them', async () => {
    api.getCompanySponsorship.mockResolvedValue(answer());
    renderWithBrand(<SponsorshipFacts companyId="c1" companyName="Example Employer" jobId="j1" />, ON);
    await waitFor(() => expect(block()).toBeInTheDocument());
    expect(api.getCompanySponsorship).toHaveBeenCalledTimes(1);
    expect(api.getCompanySponsorship.mock.calls[0]!.slice(0, 2)).toEqual(['c1', { jobId: 'j1' }]);
    expect(block().querySelectorAll('li[data-fact]')).toHaveLength(3);
  });

  it('an empty list renders nothing', async () => {
    api.getCompanySponsorship.mockResolvedValue(answer({ facts: [], viewerNeedsSponsorship: false }));
    const view = renderWithBrand(<SponsorshipFacts companyId="c1" companyName="Example Employer" jobId="j1" />, ON);
    await waitFor(() => expect(api.getCompanySponsorship).toHaveBeenCalled());
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
    expect(screen.queryByTestId('sponsorship-facts')).toBeNull();
  });

  it('a failed request renders nothing and is not asked again: the job page does not depend on it', async () => {
    api.getCompanySponsorship.mockRejectedValue(new Error('down'));
    const view = renderWithBrand(<SponsorshipFacts companyId="c1" companyName="Example Employer" jobId="j1" />, ON);
    await waitFor(() => expect(api.getCompanySponsorship).toHaveBeenCalledTimes(1));
    expect(view.container).toBeEmptyDOMElement();
  });

  it('GoApply never asks and never renders (the capability is RoboApply\'s); neither does a job with no company record', async () => {
    api.getCompanySponsorship.mockResolvedValue(answer());
    const go = renderWithBrand(<SponsorshipFacts companyId="c1" companyName="示例科技" jobId="j1" />, { brand: 'goapply' });
    const off = renderWithBrand(<SponsorshipFacts companyId="c1" companyName="Example Employer" jobId="j1" />, { brand: 'roboapply', flags: { h1bHistory: false } });
    const pending = renderWithBrand(<SponsorshipFacts companyId="c1" companyName="Example Employer" jobId="j1" />, { brand: 'roboapply', flags: null });
    const noCompany = renderWithBrand(<SponsorshipFacts companyId={null} companyName="Example Employer" jobId="j1" />, ON);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.getCompanySponsorship).not.toHaveBeenCalled();
    for (const view of [go, off, pending, noCompany]) expect(view.container).toBeEmptyDOMElement();
  });
});

describe('on the job page (JobOverview)', () => {
  const detail = (over: Partial<JobDetailResponse['job']> = {}): JobDetailResponse =>
    ({
      job: {
        id: 'j1',
        title: 'Backend Engineer',
        companyName: 'Example Employer',
        location: 'Austin, TX',
        workModel: 'onsite',
        employmentType: 'full_time',
        seniority: 'mid',
        pay: null,
        payText: null,
        summary: null,
        sections: [{ kind: 'responsibilities', body: '- Own the payments API' }],
        skills: [],
        sponsorship: { status: 'offered', quote: 'We sponsor H-1B visas.' },
        requirements: [],
        applyUrl: null,
        postedAt: null,
        postedAtEstimated: false,
        lastSeenAt: null,
        closedAt: null,
        status: 'open',
        source: { name: 'Example board', kind: 'provider', originalName: null },
        fromRecruiterBank: false,
        employerVerified: false,
        isAgency: false,
        visibility: 'public',
        badges: [],
        campus: null,
        ...over,
      },
      company: { id: 'c1', name: 'Example Employer', slug: 'example-employer', logoUrl: null, domain: null, facts: {}, openJobs: null },
      fit: null,
      explanation: null,
      tracker: null,
      checklist: { saved: false, tailoredResumeId: null, coverLetterId: null, practiced: null, applied: false },
      similarIds: [],
      autofill: { supported: false, atsType: null },
      people: { mode: 'off', searchLinks: [] },
      marketMeta: {},
    }) as JobDetailResponse;

  it('RoboApply: the employer\'s records sit in a block of their own, after the lines quoted from this posting', async () => {
    api.getCompanySponsorship.mockResolvedValue(answer());
    renderWithBrand(<JobOverview detail={detail()} />, ON);
    await waitFor(() => expect(block()).toBeInTheDocument());
    expect(api.getCompanySponsorship.mock.calls[0]!.slice(0, 2)).toEqual(['c1', { jobId: 'j1' }]);
    const jobLines = screen.getByTestId('job-work-auth');
    // The job's own statement stays where it was, with the posting's words; the company block is a separate section after it.
    expect(jobLines).toHaveTextContent('We sponsor H-1B visas.');
    expect(jobLines.contains(block())).toBe(false);
    expect(jobLines.compareDocumentPosition(block()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block().compareDocumentPosition(screen.getByTestId('job-sections')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a posting that states nothing about sponsorship gets no job-level line from the company\'s records', async () => {
    api.getCompanySponsorship.mockResolvedValue(answer());
    renderWithBrand(<JobOverview detail={detail({ sponsorship: { status: 'not_stated', quote: null } })} />, ON);
    await waitFor(() => expect(block()).toBeInTheDocument());
    expect(screen.queryByTestId('job-work-auth')).toBeNull();
  });

  it('GoApply never renders the block, whatever the flags say', async () => {
    api.getCompanySponsorship.mockResolvedValue(answer());
    renderWithBrand(<JobOverview detail={detail()} />, { brand: 'goapply', flags: { h1bHistory: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.getCompanySponsorship).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sponsorship-facts')).toBeNull();
    expect(screen.getByTestId('job-sections')).toBeInTheDocument();
  });
});

describe('copy: the block never says the job sponsors', () => {
  const CLAIMS = [
    /sponsors? this (job|role|position)/i,
    /this (job|role|position) (sponsors|offers|provides|includes|comes with)/i,
    /(job|role|position) (is|are) sponsored/i,
    /sponsorship (is )?(available|offered|included|likely|expected)/i,
    /(likely|expected|certain|sure) to sponsor/i,
    /will sponsor (you|your)/i,
    /h-?1b (sponsored|sponsor likely)/i,
  ];
  // The block's copy, merged out of i18n/staging/companyFacts.en.json into the English bundle.
  const copy = { companyFacts: enMessages.companyFacts };
  const leaves = (node: unknown, path = ''): Array<[string, string]> =>
    typeof node === 'string' ? [[path, node]] : Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));

  it('no string of the block claims it; the only sentence that names the role is the disclaimer, and it denies it', () => {
    const strings = leaves(copy);
    expect(strings.length).toBeGreaterThan(10);
    // The disclaimer is the one sentence that names the job, and it is a denial: it is read apart below.
    const aboutTheJob = strings.filter(([, text]) => /\b(job|role|position)\b/i.test(text)).map(([path]) => path);
    expect(aboutTheJob).toEqual(['companyFacts.sponsorship.disclaimer']);
    for (const [path, text] of strings.filter(([p]) => !aboutTheJob.includes(p))) for (const claim of CLAIMS) expect(text, path).not.toMatch(claim);
    expect(copy.companyFacts.sponsorship.disclaimer).toBe(DISCLAIMER);
    // The English the API sends with every answer is the same sentence.
    expect(SPONSORSHIP_DISCLAIMER).toBe(DISCLAIMER);
    expect(DISCLAIMER).toMatch(/not about this job/);
    expect(DISCLAIMER).toMatch(/do not mean this employer will sponsor this role/);
    // Without its denial nothing of a claim is left in it.
    for (const claim of CLAIMS) expect(DISCLAIMER.replace('do not mean this employer will sponsor this role', '')).not.toMatch(claim);
    // Plain copy: brand-neutral, no dash used as punctuation.
    for (const [path, text] of strings) expect(text, path).not.toMatch(/—|–|RoboApply|GoApply/);
  });

  it('nothing the block renders claims it, open or behind its line', () => {
    for (const viewerNeedsSponsorship of [true, false]) {
      const view = renderWithBrand(<SponsorshipFactsBlock response={answer({ viewerNeedsSponsorship })} companyName="Example Employer" />, ON);
      const text = view.container.textContent ?? '';
      expect(text.length).toBeGreaterThan(200);
      // The disclaimer is printed once, whole; everything else is checked for a claim about the job.
      expect(text.split(DISCLAIMER)).toHaveLength(2);
      for (const claim of CLAIMS) expect(text.replace(DISCLAIMER, ' ')).not.toMatch(claim);
      expect(text.replace(DISCLAIMER, ' ')).not.toMatch(/\b(this|the) (job|role|position)\b/i);
      view.unmount();
    }
  });

  it('every string the component asks for is in the bundle (a missing one would print its key)', () => {
    const source = readFileSync(join(process.cwd(), 'components/features/job/SponsorshipFacts.tsx'), 'utf8');
    const keys = [...source.matchAll(/\bt(?:\.rich)?\(\s*'([\w.]+)'/g)].map((m) => m[1]!).concat(['dated.published', 'dated.imported']);
    expect(keys).toEqual(expect.arrayContaining(['title', 'intro', 'fact.dolLca', 'fact.uscis', 'fact.uk', 'fact.ukRating', 'fact.ukRoutes', 'fact.ukTown', 'earlier', 'listedAs', 'source', 'file', 'usNote', 'disclaimer']));
    const copyKeys = new Set(leaves(copy.companyFacts.sponsorship).map(([path]) => path));
    for (const key of keys) expect(copyKeys.has(key), key).toBe(true);
    // And nothing is in the namespace that the block does not use.
    expect([...copyKeys].sort()).toEqual([...new Set(keys)].sort());
  });
});
