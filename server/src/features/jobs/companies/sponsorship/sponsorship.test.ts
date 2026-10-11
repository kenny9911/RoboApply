// @vitest-environment node
//
// Company sponsorship facts (JI-11): assembly per source over a fake database
// (every fact with its year, count, source name, page, file and date), the
// five-year cap, the exact-name rule and the empty case, the fact that nothing
// here speaks about a job, and who the job page opens the block for (the
// feed's own rule). Every employer here is an invented placeholder.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createFakePrisma } from '../../../../test/fakePrisma.js';
import { needsSponsorshipFor } from '../../../feed/items.js';
import { DOL_LCA_URL, UK_SPONSOR_REGISTER_LICENCE, UK_SPONSOR_REGISTER_URL, USCIS_H1B_HUB_URL } from '../../data/index.js';
import { normalizeCompanyName } from '../../normalize/index.js';
import { SPONSORSHIP_DISCLAIMER, SPONSORSHIP_FACT_KINDS, SPONSORSHIP_YEARS_PER_SOURCE, type SponsorshipFact } from './contract.js';
import { createSponsorshipService, needsSponsorshipIn, sponsorshipSourcesInUse, toUscisFact, type SponsorshipDb, type SponsorshipNeed } from './service.js';

const NAME = normalizeCompanyName('Example Employer LLC');
const IMPORTED = new Date('2026-10-10T08:00:00.000Z');
const HUB_AS_OF = new Date('2025-07-01T00:00:00.000Z');
const UK_AS_OF = new Date('2026-10-09T00:00:00.000Z');

const company = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  market: 'intl',
  nameNormalized: NAME,
  displayName: 'Example Employer',
  slug: 'example-employer',
  domain: null,
  logoUrl: null,
  website: null,
  industries: [],
  sizeBand: null,
  hqLocation: null,
  foundedYear: null,
  description: null,
  facts: {},
  ...over,
});

const lca = (fiscalYear: number, certifiedCount: number, over: Record<string, unknown> = {}) => ({
  id: `lca_${fiscalYear}`,
  employerNameNormalized: NAME,
  fiscalYear,
  certifiedCount,
  withdrawnCount: 0,
  medianWageAnnualUsd: null,
  topTitles: [],
  sourceFile: `LCA_Disclosure_Data_FY${fiscalYear}_Q4.xlsx`,
  importedAt: IMPORTED,
  ...over,
});

const hub = (fiscalYear: number, approvals: number | null, denials: number | null, over: Record<string, unknown> = {}) => ({
  id: `hub_${fiscalYear}`,
  source: 'uscis_h1b_hub',
  country: 'US',
  employerNameNormalized: NAME,
  employerName: 'EXAMPLE EMPLOYER LLC',
  period: `FY${fiscalYear}`,
  approvals,
  denials,
  town: null,
  rating: null,
  routes: [],
  sourceFile: `h1b_datahubexport-${fiscalYear}.csv`,
  sourceUrl: USCIS_H1B_HUB_URL,
  asOf: HUB_AS_OF,
  importedAt: IMPORTED,
  ...over,
});

const uk = (over: Record<string, unknown> = {}) => ({
  id: 'uk_1',
  source: 'uk_sponsor_register',
  country: 'GB',
  employerNameNormalized: NAME,
  employerName: 'Example Employer Ltd',
  period: '',
  approvals: null,
  denials: null,
  town: 'Exampletown',
  rating: 'Worker (A rating); Temporary Worker (A rating)',
  routes: ['Skilled Worker', 'Creative Worker'],
  sourceFile: 'SP_-_placeholder_register_-_2026-10-09.csv',
  sourceUrl: UK_SPONSOR_REGISTER_URL,
  asOf: UK_AS_OF,
  importedAt: IMPORTED,
  ...over,
});

function setup(seed: { companies?: unknown[]; lca?: unknown[]; register?: unknown[]; jobs?: unknown[] } = {}, viewerNeed?: (userId: string) => Promise<SponsorshipNeed | null>) {
  const db = createFakePrisma({
    seed: {
      rACompany: (seed.companies ?? [company()]) as Array<Record<string, unknown>>,
      rAH1bEmployerStat: (seed.lca ?? []) as Array<Record<string, unknown>>,
      rASponsorRegisterEntry: (seed.register ?? []) as Array<Record<string, unknown>>,
      rAJob: (seed.jobs ?? []) as Array<Record<string, unknown>>,
    },
  });
  return createSponsorshipService(db as unknown as SponsorshipDb, viewerNeed ? { viewerNeed } : {});
}

describe('facts: every number with its year, source and date', () => {
  it('a company with LCA and USCIS rows: each fact shows the year, the count and the source (name, page, file, date)', async () => {
    const res = await setup({ lca: [lca(2025, 40), lca(2024, 31)], register: [hub(2023, 11, 2), hub(2022, 9, 0)] }).facts('intl', 'c1');
    expect(res.facts).toEqual([
      {
        kind: 'dol_lca',
        fiscalYear: 2025,
        certifiedCount: 40,
        source: { name: 'US Department of Labor, LCA disclosure data', url: DOL_LCA_URL, sourceFile: 'LCA_Disclosure_Data_FY2025_Q4.xlsx', asOf: IMPORTED.toISOString(), dated: 'imported' },
      },
      {
        kind: 'dol_lca',
        fiscalYear: 2024,
        certifiedCount: 31,
        source: { name: 'US Department of Labor, LCA disclosure data', url: DOL_LCA_URL, sourceFile: 'LCA_Disclosure_Data_FY2024_Q4.xlsx', asOf: IMPORTED.toISOString(), dated: 'imported' },
      },
      {
        kind: 'uscis_h1b_hub',
        fiscalYear: 2023,
        approvals: 11,
        denials: 2,
        employerName: 'EXAMPLE EMPLOYER LLC',
        source: { name: 'US Citizenship and Immigration Services, H-1B Employer Data Hub', url: USCIS_H1B_HUB_URL, sourceFile: 'h1b_datahubexport-2023.csv', asOf: HUB_AS_OF.toISOString(), dated: 'published' },
      },
      {
        kind: 'uscis_h1b_hub',
        fiscalYear: 2022,
        approvals: 9,
        denials: 0,
        employerName: 'EXAMPLE EMPLOYER LLC',
        source: { name: 'US Citizenship and Immigration Services, H-1B Employer Data Hub', url: USCIS_H1B_HUB_URL, sourceFile: 'h1b_datahubexport-2022.csv', asOf: HUB_AS_OF.toISOString(), dated: 'published' },
      },
    ]);
    expect(res.disclaimer).toBe(SPONSORSHIP_DISCLAIMER);
    expect(res.viewerNeedsSponsorship).toBe(false);
    // No fact without all four parts of its source.
    for (const f of res.facts) for (const part of ['name', 'url', 'sourceFile', 'asOf'] as const) expect(f.source[part], `${f.kind} ${part}`).toBeTruthy();
  });

  it('a UK-registered company: one fact with the rating and the routes, and the acknowledgement its licence asks for', async () => {
    const res = await setup({ register: [uk()] }).facts('intl', 'example-employer');
    expect(res.facts).toEqual([
      {
        kind: 'uk_sponsor_register',
        town: 'Exampletown',
        rating: 'Worker (A rating); Temporary Worker (A rating)',
        routes: ['Skilled Worker', 'Creative Worker'],
        employerName: 'Example Employer Ltd',
        source: {
          name: 'UK Visas and Immigration, Register of licensed sponsors: workers',
          url: UK_SPONSOR_REGISTER_URL,
          sourceFile: 'SP_-_placeholder_register_-_2026-10-09.csv',
          asOf: UK_AS_OF.toISOString(),
          dated: 'published',
          attribution: { text: UK_SPONSOR_REGISTER_LICENCE.statement, url: UK_SPONSOR_REGISTER_LICENCE.url },
        },
      },
    ]);
    // A name the register lists in several towns is stored with none: the fact then states none.
    const noTown = await setup({ register: [uk({ town: null, rating: null, routes: [] })] }).facts('intl', 'c1');
    expect(noTown.facts[0]).toMatchObject({ kind: 'uk_sponsor_register', town: null, rating: null, routes: [] });
  });

  it('the three sources come in one order: DOL LCA years, USCIS years, then the UK register', async () => {
    const res = await setup({ lca: [lca(2024, 3)], register: [uk(), hub(2023, 1, 0)] }).facts('intl', 'c1');
    expect(res.facts.map((f) => f.kind)).toEqual(['dol_lca', 'uscis_h1b_hub', 'uk_sponsor_register']);
    expect([...SPONSORSHIP_FACT_KINDS]).toEqual(['dol_lca', 'uscis_h1b_hub', 'uk_sponsor_register']);
  });

  it('keeps at most the five most recent fiscal years per US source', async () => {
    const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
    const res = await setup({ lca: years.map((y) => lca(y, y - 2000)), register: years.map((y) => hub(y, y - 2010, 1)) }).facts('intl', 'c1');
    const of = (kind: SponsorshipFact['kind']) => res.facts.filter((f) => f.kind === kind).map((f) => (f as { fiscalYear: number }).fiscalYear);
    expect(SPONSORSHIP_YEARS_PER_SOURCE).toBe(5);
    expect(of('dol_lca')).toEqual([2025, 2024, 2023, 2022, 2021]);
    expect(of('uscis_h1b_hub')).toEqual([2025, 2024, 2023, 2022, 2021]);
  });

  it('a company with no rows: an empty list and the disclaimer; nothing is inferred', async () => {
    const viewerNeed = vi.fn(async () => ({ needsSponsorship: true, workAuth: [] }));
    const res = await setup({}, viewerNeed).facts('intl', 'c1', { userId: 'u1' });
    expect(res).toEqual({ facts: [], disclaimer: SPONSORSHIP_DISCLAIMER, viewerNeedsSponsorship: false });
    // Nothing to show, so the viewer's answers are not even read.
    expect(viewerNeed).not.toHaveBeenCalled();
  });

  it('matches the exact normalised name only: a longer, shorter or similar name is another employer', async () => {
    const others = ['Example Employer Holdings LLC', 'Example', 'Exampel Employer LLC', 'Example Employers LLC'].map((n, i) => normalizeCompanyName(n) + (normalizeCompanyName(n) === NAME ? ` ${i}` : ''));
    const res = await setup({
      lca: others.map((n, i) => lca(2020 + i, 5, { id: `o${i}`, employerNameNormalized: n })),
      register: others.flatMap((n, i) => [hub(2020 + i, 5, 0, { id: `h${i}`, employerNameNormalized: n }), uk({ id: `u${i}`, employerNameNormalized: n })]),
    }).facts('intl', 'c1');
    expect(res.facts).toEqual([]);
    // A legal suffix is not part of the key: "Example Employer, Inc." is this company.
    const same = await setup({ register: [hub(2023, 4, 1, { employerNameNormalized: normalizeCompanyName('Example Employer, Inc.'), employerName: 'EXAMPLE EMPLOYER, INC.' })] }).facts('intl', 'c1');
    expect(same.facts).toHaveLength(1);
    expect(same.facts[0]).toMatchObject({ employerName: 'EXAMPLE EMPLOYER, INC.' });
  });

  it('a row that lacks a count is left out, never read as zero; zero itself is a fact', async () => {
    const res = await setup({ register: [hub(2024, null, 3), hub(2023, 0, 2), hub(2022, 7, null), hub(2021, 1, 0, { period: '2021' })] }).facts('intl', 'c1');
    expect(res.facts.map((f) => [f.kind, (f as { fiscalYear: number }).fiscalYear, (f as { approvals: number }).approvals, (f as { denials: number }).denials])).toEqual([['uscis_h1b_hub', 2023, 0, 2]]);
    expect(toUscisFact({ ...hub(2024, null, 3), routes: [] })).toBeNull();
  });

  it('a row of the UK register is never read as a US count, and a US row never as a licence', async () => {
    // Rows whose source and country disagree with what the importers write are not picked up by either read.
    const res = await setup({ register: [hub(2023, 5, 0, { country: 'GB' }), uk({ country: 'US' }), uk({ id: 'uk_2', source: 'uscis_h1b_hub' })] }).facts('intl', 'c1');
    expect(res.facts).toEqual([]);
  });

  it('another market\'s company is 404; a mainland company has no facts', async () => {
    const companies = [company(), company({ id: 'c2', market: 'cn', nameNormalized: NAME, slug: 'c-1234' })];
    const service = setup({ companies, lca: [lca(2025, 40)], register: [uk()] });
    await expect(service.facts('intl', 'c2')).rejects.toMatchObject({ status: 404, details: { code: 'company_not_found' } });
    await expect(service.facts('intl', 'nope')).rejects.toMatchObject({ status: 404 });
    // The same name on GoApply: these registers do not concern the mainland.
    expect(await service.facts('cn', 'c2')).toEqual({ facts: [], disclaimer: SPONSORSHIP_DISCLAIMER, viewerNeedsSponsorship: false });
  });
});

describe('which publications are in use (for a page that lists our sources)', () => {
  const read = (seed: { lca?: unknown[]; register?: unknown[] }) =>
    sponsorshipSourcesInUse(createFakePrisma({ seed: { rAH1bEmployerStat: (seed.lca ?? []) as Array<Record<string, unknown>>, rASponsorRegisterEntry: (seed.register ?? []) as Array<Record<string, unknown>> } }) as unknown as SponsorshipDb);

  it('none on a database where nothing was imported: a publication is never listed with a date written in code', async () => {
    expect(await read({})).toEqual([]);
  });

  it('each imported publication with its publisher, page, licence and the date of its newest rows', async () => {
    const older = new Date('2024-07-01T00:00:00.000Z');
    const inUse = await read({ lca: [lca(2024, 3, { importedAt: older }), lca(2025, 40)], register: [hub(2022, 9, 0, { asOf: older }), hub(2023, 11, 2), uk()] });
    expect(inUse.map((s) => [s.kind, s.publisher, s.url, s.license, s.asOf, s.dated])).toEqual([
      ['dol_lca', 'US Department of Labor', DOL_LCA_URL, 'Public record published by a US federal agency (its page states no licence)', IMPORTED.toISOString(), 'imported'],
      ['uscis_h1b_hub', 'US Citizenship and Immigration Services', USCIS_H1B_HUB_URL, 'Public record published by a US federal agency (its page states no licence)', HUB_AS_OF.toISOString(), 'published'],
      ['uk_sponsor_register', 'UK Visas and Immigration', UK_SPONSOR_REGISTER_URL, 'Open Government Licence v3.0', UK_AS_OF.toISOString(), 'published'],
    ]);
    expect(inUse[2]!.attribution).toEqual({ text: UK_SPONSOR_REGISTER_LICENCE.statement, url: UK_SPONSOR_REGISTER_LICENCE.url });
    // Only the register was imported: only the register is in use.
    expect((await read({ register: [uk()] })).map((s) => s.kind)).toEqual(['uk_sponsor_register']);
  });
});

describe('the facts never speak about a job', () => {
  it('the disclaimer says so, and no part of an answer claims a job sponsors', async () => {
    expect(SPONSORSHIP_DISCLAIMER).toMatch(/about the employer, not about this job/);
    expect(SPONSORSHIP_DISCLAIMER).toMatch(/do not mean this employer will sponsor this role/);
    const res = await setup({ lca: [lca(2025, 40)], register: [hub(2023, 11, 2), uk()], jobs: [{ id: 'j1', market: 'intl', companyId: 'c1', locationCountry: 'US', visibility: 'public', ownerUserId: null }] }).facts('intl', 'c1', { userId: 'u1', jobId: 'j1' });
    const text = JSON.stringify(res);
    for (const claim of [/sponsors this (job|role)/i, /this (job|role) (offers|provides|includes) (visa )?sponsorship/i, /will sponsor you/i, /sponsorship (is )?(available|offered|likely)/i, /likely to sponsor/i]) expect(text).not.toMatch(claim);
    // A fact carries no job id, no badge and no verdict: only the record.
    for (const f of res.facts) expect(Object.keys(f).sort()).toEqual(f.kind === 'dol_lca' ? ['certifiedCount', 'fiscalYear', 'kind', 'source'] : f.kind === 'uscis_h1b_hub' ? ['approvals', 'denials', 'employerName', 'fiscalYear', 'kind', 'source'] : ['employerName', 'kind', 'rating', 'routes', 'source', 'town']);
  });
});

describe('who the job page opens the block for', () => {
  const job = (over: Record<string, unknown> = {}) => ({ id: 'j1', market: 'intl', companyId: 'c1', locationCountry: 'US', visibility: 'public', ownerUserId: null, ...over });
  const seed = { lca: [lca(2025, 40)], jobs: [job(), job({ id: 'j_gb', locationCountry: 'GB' }), job({ id: 'j_other', companyId: 'c9', locationCountry: 'GB' }), job({ id: 'j_private', locationCountry: 'GB', visibility: 'private', ownerUserId: 'u2' })] };
  const need = (over: Partial<SponsorshipNeed> = {}): SponsorshipNeed => ({ needsSponsorship: null, workAuth: [], ...over });

  it('is the feed\'s badge rule, case for case', () => {
    const users: Array<SponsorshipNeed | null> = [
      null,
      need(),
      need({ needsSponsorship: true }),
      need({ needsSponsorship: false }),
      need({ workAuth: [{ country: 'US', sponsorship: 'now' }] }),
      need({ workAuth: [{ country: 'US', sponsorship: 'later' }] }),
      need({ needsSponsorship: true, workAuth: [{ country: 'US', sponsorship: 'no' }] }),
      need({ needsSponsorship: true, workAuth: [{ country: 'US', sponsorship: null }] }),
      need({ needsSponsorship: false, workAuth: [{ country: 'GB', sponsorship: 'now' }] }),
    ];
    for (const user of users) {
      for (const country of ['US', 'GB', 'TW', null]) {
        const matchUser = user ? { needsSponsorship: user.needsSponsorship, workAuth: user.workAuth.map((w) => ({ country: w.country, authorized: null, sponsorship: w.sponsorship ?? null })) } : null;
        expect(needsSponsorshipIn(user, country), `${JSON.stringify(user)} in ${country}`).toBe(needsSponsorshipFor(matchUser, country));
      }
    }
    // Spelled out: the answer for the job's country wins over the general one, both ways.
    expect(needsSponsorshipIn(need({ needsSponsorship: true, workAuth: [{ country: 'US', sponsorship: 'no' }] }), 'US')).toBe(false);
    expect(needsSponsorshipIn(need({ needsSponsorship: false, workAuth: [{ country: 'GB', sponsorship: 'now' }] }), 'GB')).toBe(true);
    expect(needsSponsorshipIn(need({ needsSponsorship: false, workAuth: [{ country: 'GB', sponsorship: 'now' }] }), 'US')).toBe(false);
  });

  it('reads the country of the job the facts are shown on, and only of a job of this company the viewer may see', async () => {
    const answers = need({ needsSponsorship: false, workAuth: [{ country: 'GB', sponsorship: 'now' }] });
    const viewerNeed = vi.fn(async () => answers);
    const service = setup(seed, viewerNeed);
    const opened = async (viewer: { userId: string | null; jobId?: string | null }) => (await service.facts('intl', 'c1', viewer)).viewerNeedsSponsorship;
    expect(await opened({ userId: 'u1', jobId: 'j_gb' })).toBe(true);
    expect(await opened({ userId: 'u1', jobId: 'j1' })).toBe(false); // a US job: the general answer (no)
    expect(await opened({ userId: 'u1' })).toBe(false); // no job: the general answer
    expect(await opened({ userId: 'u1', jobId: 'j_other' })).toBe(false); // another company's job is not this page's job
    expect(await opened({ userId: 'u1', jobId: 'j_private' })).toBe(false); // someone else's import
    expect(await opened({ userId: 'u2', jobId: 'j_private' })).toBe(true); // the owner's own import
    expect(await opened({ userId: 'u1', jobId: 'missing' })).toBe(false);
    expect(viewerNeed).toHaveBeenCalledWith('u1');
  });

  it('nobody without a session; and a failure to read the viewer\'s answers never fails the facts', async () => {
    const viewerNeed = vi.fn(async () => need({ needsSponsorship: true }));
    expect((await setup(seed, viewerNeed).facts('intl', 'c1', { userId: null, jobId: 'j1' })).viewerNeedsSponsorship).toBe(false);
    expect((await setup(seed, viewerNeed).facts('intl', 'c1')).viewerNeedsSponsorship).toBe(false);
    expect(viewerNeed).not.toHaveBeenCalled();
    expect((await setup(seed, viewerNeed).facts('intl', 'c1', { userId: 'u1', jobId: 'j1' })).viewerNeedsSponsorship).toBe(true);
    // Without the dependency (a caller that has no viewer answers), nobody is treated as needing sponsorship.
    expect((await setup(seed).facts('intl', 'c1', { userId: 'u1', jobId: 'j1' })).viewerNeedsSponsorship).toBe(false);
    const failing = await setup(seed, async () => Promise.reject(new Error('profile store down'))).facts('intl', 'c1', { userId: 'u1', jobId: 'j1' });
    expect(failing.facts).toHaveLength(1);
    expect(failing.viewerNeedsSponsorship).toBe(false);
  });
});
