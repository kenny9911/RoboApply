// server/src/features/match/eval/invariantSpecs.ts
//
// The ten invariants as executable specs against the TARGET contract
// (MARKET_STRATEGY.md 2.2 and 2.6; SEARCH_RETRIEVE_MATCH.md 6.3). Written
// before the fixes, so on the commit they were written on most of them fail:
// that is their job. `invariants.eval.ts` declares them as Vitest cases.
//
// Rules of this file:
//   - The code under test is reached through seams.ts only (a repository path
//     and an export, loaded at run time). A seam that does not exist yet is a
//     FAILING invariant, with the seam named in the reason.
//   - Fakes come from the MATCH test kit plus the counting fakes of world.ts.
//     No model, no embeddings endpoint, no planner, no database, no network.
//   - A spec throws with a plain reason; it never skips. Assertions use
//     node:assert so the file needs no test framework to compile or to run.

import assert from 'node:assert/strict';
import { RESUME_MD, matchJob, matchUser, searchProfileWire } from '../testkit.js';
import { INVARIANT_LIST, type InvariantInfo } from './invariantList.js';
import { countNetworkAttempts } from './offline.js';
import { FIT_SEAMS, REQUIRED_FIT_SEAMS } from './seamRegistry.js';
import { SEAMS, fitKind, isSeamMissing, loadSeam, optionalSeam, toSeamFit, type FitDimensionLike, type FitLike, type SeamFit } from './seams.js';
import { EVAL_SCORER_MODEL, createWorld, defaultUserInputs, freshAiRow, jobRecord, userWith, type World } from './world.js';

export interface InvariantSpec extends InvariantInfo {
  run(): Promise<void>;
}

const TIERS = { great: 80, good: 65, possible: 45 } as const;

// ── Reporting helpers ─────────────────────────────────────────────────────

/** One line that says why, short enough for a table. */
export function reasonOf(err: unknown): string {
  if (isSeamMissing(err)) return err.message;
  // node:assert appends a diff after the message; the first line is the reason.
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
  return message.replace(/\s+/g, ' ').trim().slice(0, 1500);
}

/** Runs every part of an invariant and reports all that failed, not only the first. */
class Parts {
  private readonly failures: string[] = [];
  async part(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.failures.push(`${name}: ${reasonOf(err)}`);
    }
  }
  done(): void {
    if (!this.failures.length) return;
    // The same missing seam reported by several parts is said once.
    const unique = [...new Set(this.failures.map((f) => f.replace(/^[^:]+: (SeamMissing: .*)$/, '$1')))];
    throw new Error(unique.join(' | '));
  }
}

async function onlyFit(world: World, userId = 'u1', jobId = 'job1'): Promise<FitLike> {
  const fits = await (await world.fit()).getFits(userId, [jobId]);
  const fit = fits.get(jobId);
  assert.ok(fit, `getFits returned no fit for ${jobId}`);
  return fit;
}

function assertNoModelCall(world: World, what: string): void {
  assert.equal(world.scorer.calls, 0, `${what} called the scorer ${world.scorer.calls} time(s); a list read never calls a model`);
}

/** A fit without the fields that change with the clock. */
function stable(fit: FitLike): Record<string, unknown> {
  const { scoredAt: _scoredAt, ...rest } = fit;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}

function dimension(fit: FitLike, key: string): FitDimensionLike | undefined {
  return (fit.dimensions ?? []).find((d) => d.key === key);
}

function withoutLogistics(fit: FitLike): unknown {
  return JSON.parse(JSON.stringify((fit.dimensions ?? []).filter((d) => d.key !== 'logistics')));
}

// ── INV-1 ─────────────────────────────────────────────────────────────────

/** A posting that says a title and a place and nothing about skills or level. */
function thinPosting(over: Parameters<typeof jobRecord>[0] = {}) {
  const text = 'We are hiring a Backend Engineer. More details are shared during the interview.';
  return jobRecord({
    id: 'job1',
    title: 'Backend Engineer',
    skills: [],
    skillsDetail: null,
    seniority: null,
    minYears: null,
    educationLevel: null,
    qualifications: null,
    description: text,
    descriptionPlain: text,
    companyIndustries: [],
    ...over,
  });
}

async function inv1(): Promise<void> {
  const parts = new Parts();
  const exactTitle = userWith(
    { taxonomyIds: ['backend_engineer'] },
    { experience: [{ title: 'Senior Backend Engineer', company: 'PayCo', startYm: '2019-01', endYm: null, current: true, kind: 'work' }] },
  );
  const cases: Array<{ name: string; job: ReturnType<typeof jobRecord>; user: ReturnType<typeof defaultUserInputs>; confidenceLow: boolean }> = [
    { name: 'a posting with a title and a place only', job: thinPosting(), user: defaultUserInputs(), confidenceLow: true },
    { name: 'the same posting, a resume with the exact title, no location filter', job: thinPosting(), user: exactTitle, confidenceLow: true },
    // The employer's industry and a place are 25 of the 100 rubric points; with the role that is exactly 60%,
    // where the strategy's two wordings meet. Never great is asserted; the confidence is left to the estimate.
    { name: 'the same posting when the employer industry is known', job: thinPosting({ companyIndustries: ['Fintech'] }), user: defaultUserInputs(), confidenceLow: false },
  ];
  for (const c of cases) {
    await parts.part(c.name, async () => {
      const world = createWorld({ jobs: [c.job], users: { u1: c.user } });
      const fit = await onlyFit(world);
      assert.equal(fitKind(fit.kind), 'estimate', `kind is ${String(fit.kind)}: nothing was scored by a model, so this is an estimate`);
      assert.notEqual(fit.tier, 'great', `tier is great (score ${fit.score}) for a posting that lists no skills and states no level`);
      if (fit.score !== null) assert.ok(fit.score < TIERS.great, `score ${fit.score} reaches Great for a posting that lists no skills and states no level`);
      if (c.confidenceLow) assert.equal(fit.confidence, 'low', `confidence is ${String(fit.confidence)} (expected low) for a posting that lists no skills and states no level`);
      assertNoModelCall(world, 'getFits');
    });
  }
  parts.done();
}

// ── INV-2 ─────────────────────────────────────────────────────────────────

const BERLIN = { label: 'Berlin', city: 'Berlin', country: 'DE', radiusKm: 40, lat: 52.52, lng: 13.405 };
const BASE_FILTERS: Record<string, unknown> = {
  taxonomyIds: ['backend_engineer'],
  seniority: ['senior'],
  locations: [BERLIN],
  salaryMin: { amount: 60000, currency: 'EUR', period: 'year' },
};

async function fitUnderFilters(filters: Record<string, unknown>): Promise<FitLike> {
  // The posting says it does not sponsor, so the sponsorship answer has something to meet.
  const job = jobRecord({ sponsorship: 'not_offered', sponsorshipEvidence: 'We cannot sponsor a visa for this role.' });
  const world = createWorld({ jobs: [job], users: { u1: userWith(filters) } });
  const fit = await onlyFit(world);
  assertNoModelCall(world, 'getFits');
  return fit;
}

async function inv2(): Promise<void> {
  const parts = new Parts();
  let base: FitLike | null = null;
  await parts.part('the fit under the saved search as it is', async () => {
    base = await fitUnderFilters(BASE_FILTERS);
    assert.ok(Array.isArray(base.dimensions) && base.dimensions.length > 0, 'the fit has no dimensions');
  });
  // Without the fit itself there is nothing to compare: the reason above says why.
  if (!base) return parts.done();
  // Filter chips: not one field of the fit may move.
  const chips: Array<[string, Record<string, unknown>]> = [
    ['Level chips set to Intern', { ...BASE_FILTERS, seniority: ['intern_newgrad'] }],
    ['Level chips set to Director', { ...BASE_FILTERS, seniority: ['director_exec'] }],
    ['Level chips removed', { ...BASE_FILTERS, seniority: [] }],
    ['Role chips set to another role', { ...BASE_FILTERS, taxonomyIds: ['registered_nurse'] }],
    ['Role chips removed', (({ taxonomyIds: _t, ...rest }) => rest)(BASE_FILTERS)],
    ['a title typed into the search', { ...BASE_FILTERS, titles: ['Landscape Architect'] }],
    ['Skills chips', { ...BASE_FILTERS, skills: ['Excel', 'Photoshop'] }],
    ['Company chips', { ...BASE_FILTERS, companies: ['Another Company'] }],
  ];
  for (const [name, filters] of chips) {
    await parts.part(name, async () => {
      const fit = await fitUnderFilters(filters);
      assert.deepEqual(stable(fit), stable(base!), `the fit changed with ${name}`);
    });
  }
  // Logistics answers: the logistics dimension moves, nothing else about what was compared.
  const answers: Array<[string, Record<string, unknown>]> = [
    ['the location answer', { ...BASE_FILTERS, locations: [{ label: 'Lisbon', city: 'Lisbon', country: 'PT', radiusKm: 40 }] }],
    ['the pay answer', { ...BASE_FILTERS, salaryMin: { amount: 200000, currency: 'EUR', period: 'year' } }],
    ['the sponsorship answer', { ...BASE_FILTERS, needsSponsorship: true }],
  ];
  for (const [name, filters] of answers) {
    await parts.part(name, async () => {
      const fit = await fitUnderFilters(filters);
      const was = base!;
      assert.deepEqual(withoutLogistics(fit), withoutLogistics(was), `a dimension other than logistics changed with ${name}`);
      assert.notDeepEqual(dimension(fit, 'logistics'), dimension(was, 'logistics'), `the logistics dimension did not change with ${name}, which the posting does not meet`);
      for (const key of ['kind', 'topOverlap', 'topGap'] as const) assert.deepEqual(fit[key], was[key], `${key} changed with ${name}`);
    });
  }
  parts.done();
}

// ── INV-3 ─────────────────────────────────────────────────────────────────

function describeFit(f: SeamFit): string {
  return `${f.score ?? 'no score'} / ${f.tier ?? 'no tier'} / ${f.kind}`;
}

async function inv3(): Promise<void> {
  const parts = new Parts();
  await parts.part('registry', () => {
    const names = new Set(FIT_SEAMS.map((s) => s.name));
    const missing = REQUIRED_FIT_SEAMS.filter((n) => !names.has(n));
    assert.deepEqual(missing, [], `surfaces missing from eval/seamRegistry.ts: ${missing.join(', ')}`);
    assert.equal(names.size, FIT_SEAMS.length, 'eval/seamRegistry.ts lists a seam name twice');
  });
  for (const scenario of ['estimate', 'ai'] as const) {
    const world = createWorld({ scores: scenario === 'ai' ? [freshAiRow()] : [] });
    let reference: SeamFit | null = null;
    await parts.part(`getFit (${scenario})`, async () => {
      const fit = await (await world.fit()).getFit('u1', 'job1');
      reference = toSeamFit(fit);
      // I2: a fresh AI fit beats an estimate; with none stored the answer is an estimate.
      assert.equal(reference.kind, scenario, `getFit answered kind ${reference.kind} with ${scenario === 'ai' ? 'a fresh stored AI fit' : 'no stored AI fit'}`);
      assert.notEqual(reference.score, null, 'getFit answered no score for a comparable pair');
    });
    for (const seam of FIT_SEAMS) {
      await parts.part(`${seam.name} (${scenario})`, async () => {
        const got = toSeamFit(await seam.read('u1', 'job1', { world, scenario }));
        // With no getFit answer the read above still proves the surface is wired; the getFit part says why there is nothing to compare.
        if (reference) assert.deepEqual(got, reference, `${seam.surface} shows ${describeFit(got)}, getFit says ${describeFit(reference)}`);
      });
    }
    await parts.part(`no model call (${scenario})`, () => {
      assert.equal(world.scorer.calls, 0, `reading the surfaces called the scorer ${world.scorer.calls} time(s)`);
    });
  }
  parts.done();
}

// ── INV-4 ─────────────────────────────────────────────────────────────────

async function inv4(): Promise<void> {
  const parts = new Parts();
  // Everything else lines up: the role, and every skill the internship lists is on the resume.
  const internship = (over: Parameters<typeof jobRecord>[0] = {}) =>
    jobRecord({
      title: 'Backend Engineering Intern',
      seniority: 'intern_newgrad',
      minYears: null,
      skills: ['typescript', 'go'],
      skillsDetail: [
        { skill: 'TypeScript', kind: 'hard', required: true },
        { skill: 'Go', kind: 'hard', required: true },
      ],
      qualifications: 'TypeScript and Go. This is a six-month internship.',
      ...over,
    });
  const cases: Array<[string, ReturnType<typeof jobRecord>, ReturnType<typeof defaultUserInputs>]> = [
    ['a senior resume, an internship in the same role', internship(), defaultUserInputs()],
    ['the same pair with the Level chips set to Intern', internship(), userWith({ ...BASE_FILTERS, seniority: ['intern_newgrad'] })],
    ['the same pair with no saved search', internship(), { ...defaultUserInputs(), searchProfile: null }],
  ];
  for (const [name, job, user] of cases) {
    await parts.part(name, async () => {
      const world = createWorld({ jobs: [job], users: { u1: user } });
      const fit = await onlyFit(world);
      assert.ok(fit.tier === null || fit.tier === 'possible' || fit.tier === 'unlikely', `tier is ${String(fit.tier)} (score ${fit.score}): a senior resume against an internship is at most possible`);
      if (fit.score !== null) assert.ok(fit.score < TIERS.good, `score ${fit.score} is Good or better for a senior resume against an internship`);
      assertNoModelCall(world, 'getFits');
    });
  }
  parts.done();
}

// ── INV-5 ─────────────────────────────────────────────────────────────────

type MatchTitle = (title: string, options?: { limit?: number }) => Array<{ id: string; score: number }>;
type Ancestors = (id: string) => Array<{ id: string; level: number }>;

async function inv5(): Promise<void> {
  const matchTitle = await loadSeam<MatchTitle>(SEAMS.matchTitle);
  const ancestors = await loadSeam<Ancestors>(SEAMS.taxonomyAncestors);
  const categoryOf = (title: string): string | null => {
    const best = matchTitle(title, { limit: 1 })[0];
    return best ? (ancestors(best.id).find((n) => n.level === 1)?.id ?? null) : null;
  };
  const parts = new Parts();
  for (const title of ['Java Backend Architect', 'Lead AI Architect', 'Principal Architect - Machine Learning']) {
    await parts.part(title, () => {
      assert.notEqual(categoryOf(title), 'design', `"${title}" is placed in the design category`);
    });
  }
  await parts.part('Landscape Architect', () => {
    assert.equal(categoryOf('Landscape Architect'), 'design', `"Landscape Architect" is placed in ${categoryOf('Landscape Architect') ?? 'no category'}, not in design`);
  });
  parts.done();
}

// ── INV-6 ─────────────────────────────────────────────────────────────────

interface SqlLike {
  text?: string;
  sql?: string;
  values?: unknown[];
}

async function inv6(): Promise<void> {
  const parts = new Parts();
  const wholeCountry = { label: 'US', country: 'US', radiusKm: 0 };
  const namedCountry = { label: 'United States', country: 'US', radiusKm: 40 };
  const aCity = { label: 'Austin', city: 'Austin', country: 'US', radiusKm: 40 };

  await parts.part('isCountryWideLocation', async () => {
    const isCountryWide = await loadSeam<(loc: Record<string, unknown>) => boolean>(SEAMS.isCountryWideLocation);
    assert.equal(isCountryWide(wholeCountry), true, 'a country code with no city is not read as the whole country');
    assert.equal(isCountryWide(namedCountry), true, 'a country name with no city (and a meaningless radius) is not read as the whole country');
    assert.equal(isCountryWide(aCity), false, 'a city entry is read as the whole country');
  });

  await parts.part('the locations predicate of the feed', async () => {
    const predicateFor = await loadSeam<(field: string, filters: Record<string, unknown>, scope: Record<string, unknown>) => SqlLike | null>(SEAMS.predicateFor);
    const sql = predicateFor('locations', { locations: [wholeCountry] }, { market: 'intl', now: new Date('2026-10-01T00:00:00Z') });
    assert.ok(sql, 'a country-only location produces no predicate');
    const text = String(sql.text ?? sql.sql ?? '');
    assert.match(text, /"locationCountry"\s*=/, `the predicate does not compare the country: ${text}`);
    assert.ok((sql.values ?? []).includes('US'), 'the predicate does not carry the country as a parameter');
    assert.doesNotMatch(text, /"locationCity"|"geoLat"|"geoLng"/, `a country-only location still filters by city or distance: ${text}`);
  });

  await parts.part('the location check of the estimate', async () => {
    const locationCheck = await loadSeam<(user: unknown, job: unknown) => string>(SEAMS.locationCheck);
    const user = matchUser({ locations: [{ label: 'US', country: 'US', radiusKm: 0 }], country: 'US', workModels: [] });
    const inCountry = matchJob({ location: 'Austin, TX', locationCity: 'Austin', locationCountry: 'US', geoLat: null, geoLng: null, workModel: 'onsite' });
    const elsewhere = matchJob({ location: 'Berlin', locationCity: 'Berlin', locationCountry: 'DE', geoLat: null, geoLng: null, workModel: 'onsite' });
    assert.equal(locationCheck(user, inCountry), 'met', 'a job in any city of the chosen country does not meet a country-only location');
    assert.equal(locationCheck(user, elsewhere), 'not_met', 'a job in another country meets a country-only location');
  });
  parts.done();
}

// ── INV-7 ─────────────────────────────────────────────────────────────────

interface KeywordItem {
  term: string;
  found?: boolean;
  state?: string;
  via?: string;
}
interface KeywordRowLike {
  key: string;
  items: KeywordItem[];
}

const normTerm = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

async function inv7(): Promise<void> {
  const buildKeywordRows = await loadSeam<(input: Record<string, unknown>) => KeywordRowLike[]>(SEAMS.buildKeywordRows);
  const job = {
    ...matchJob({
      skills: ['relational databases', 'postgresql', 'postgres', 'typescript'],
      skillsDetail: [
        { skill: 'Relational databases', kind: 'hard', required: true },
        { skill: 'PostgreSQL', kind: 'hard', required: false },
        { skill: 'Postgres', kind: 'hard', required: false },
        { skill: 'TypeScript', kind: 'hard', required: true },
      ],
    }),
    minYears: null,
  };
  const user = matchUser({ skills: ['TypeScript', 'Go', 'PostgreSQL'] });
  const rows = buildKeywordRows({
    job,
    user,
    resumeText: RESUME_MD,
    keywords: [
      { keyword: 'relational databases', importance: 'high' },
      { keyword: 'PostgreSQL', importance: 'high' },
      { keyword: 'payments', importance: 'medium' },
    ],
  });
  const items = rows.filter((r) => r.key === 'skills' || r.key === 'keywords').flatMap((r) => r.items ?? []);
  const parts = new Parts();
  await parts.part('related evidence', () => {
    const item = items.find((i) => normTerm(i.term) === 'relationaldatabases');
    assert.ok(item, 'the check does not list "relational databases"');
    assert.equal(item.state, 'related', `"relational databases" has state ${String(item.state)} (expected related: the resume shows PostgreSQL, not the term itself)`);
    assert.match(String(item.via ?? ''), /postgres/i, `"relational databases" names ${String(item.via)} as what counted (expected PostgreSQL)`);
  });
  await parts.part('no skill twice', () => {
    const seen = new Map<string, string>();
    for (const i of items) {
      const key = normTerm(i.term);
      assert.ok(!seen.has(key), `"${i.term}" is listed twice`);
      seen.set(key, i.term);
    }
    const postgres = items.filter((i) => /^postgres(ql)?$/.test(normTerm(i.term)));
    assert.ok(postgres.length <= 1, `PostgreSQL is listed ${postgres.length} times (${postgres.map((i) => i.term).join(', ')})`);
  });
  parts.done();
}

// ── INV-8 ─────────────────────────────────────────────────────────────────

type RankMap = (estimate: number) => number;
type FitForRank = (input: { ai: number | null; estimate: number | null; map?: RankMap | null }) => number | null;

/**
 * The calibration maps INV-8 is checked under (strategy 2.4: a market with 500
 * (estimate, AI) pairs ranks on an isotonic map instead of the blend). Each is
 * monotone. `quality` is the AI-scale value: a row of that quality has an AI
 * score of `quality` and an estimate the map sends to `quality`.
 */
const RANK_MAPS: Array<{ name: string; map: RankMap; estimateFor: (quality: number) => number; qualities: number[] }> = [
  { name: 'the identity map', map: (e) => e, estimateFor: (q) => q, qualities: range(0, 100, 5) },
  // A step map with map(q) = q at every tested point: an isotonic fit is a step function.
  { name: 'a step map that is the identity at the tested points', map: (e) => Math.floor(e / 5) * 5, estimateFor: (q) => q, qualities: range(0, 100, 5) },
  // A map that compresses the estimate scale onto 20-80, as a fitted map does when estimates run wide.
  { name: 'a map that compresses the estimate scale', map: (e) => 20 + 0.6 * e, estimateFor: (q) => (q - 20) / 0.6, qualities: range(20, 80, 6) },
];

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
}

async function inv8(): Promise<void> {
  const fitForRank = await loadSeam<FitForRank>(SEAMS.fitForRank);
  const recommendedRank = await loadSeam<(row: unknown, fit: number | null, ctx: unknown) => number>(SEAMS.recommendedRank);
  const feedRow = await loadSeam<(over: Record<string, unknown>) => Record<string, unknown>>(SEAMS.feedRow);
  const now = new Date('2026-10-01T12:00:00.000Z');
  const ctx = {
    now,
    affinity: { taxonomy: {}, company: {}, skill: {}, updatedAt: null },
    preferredCompanyKeys: new Set<string>(),
    goal: { goal: null, filters: {} },
  };
  // Two postings that differ in nothing but their id; one has been read by the model, one has not.
  const same = { postedAt: new Date(now.getTime() - 86_400_000), firstSeenAt: new Date(now.getTime() - 86_400_000) };
  const scoredRow = feedRow({ id: 'scored', ...same, companyName: 'Same Co', companyNameNormalized: 'same co' });
  const unscoredRow = feedRow({ id: 'unscored', ...same, companyName: 'Same Co', companyNameNormalized: 'same co' });
  const parts = new Parts();

  /** The two inequalities of the invariant for one pair of equal quality. */
  const neverBelow = (scored: number | null, unscored: number | null) => {
    assert.equal(typeof scored, 'number', `fitForRank answered ${String(scored)} for a job with an AI score`);
    assert.equal(typeof unscored, 'number', `fitForRank answered ${String(unscored)} for a job with an estimate only`);
    assert.ok((scored as number) >= (unscored as number) - 1e-9, `ranking input ${scored} for the scored job is below ${unscored} for the unscored job of equal quality`);
    const a = recommendedRank(scoredRow, scored, ctx);
    const b = recommendedRank(unscoredRow, unscored, ctx);
    assert.ok(a >= b - 1e-9, `the scored job ranks at ${a}, below the unscored job of equal quality at ${b}`);
  };

  // Before a market has a calibration map: no map is passed.
  for (let quality = 0; quality <= 100; quality += 5) {
    await parts.part(`equal quality ${quality}`, () => {
      // Equal true quality: the model's score agrees with the estimate.
      const unscored = fitForRank({ ai: null, estimate: quality });
      neverBelow(fitForRank({ ai: quality, estimate: quality }), unscored);
      // One scale, no handicap: an unscored row is ranked on its estimate as it is (the old "estimate minus 5" is gone).
      assert.equal(unscored, quality, `an unscored job with estimate ${quality} is ranked on ${String(unscored)}; without a calibration map the ranking input of an unscored job is its estimate`);
    });
  }

  // With the market's calibration map: the same invariant on the other branch of the ranking input.
  for (const m of RANK_MAPS) {
    for (const quality of m.qualities) {
      await parts.part(`${m.name}, equal quality ${quality}`, () => {
        const estimate = m.estimateFor(quality);
        neverBelow(fitForRank({ ai: quality, estimate, map: m.map }), fitForRank({ ai: null, estimate, map: m.map }));
      });
    }
  }
  parts.done();
}

// ── INV-9 ─────────────────────────────────────────────────────────────────

async function inv9(): Promise<void> {
  const parts = new Parts();
  const absurd = { min: 60_000_000, max: 60_000_000, currency: 'USD', period: 'hour' };

  await parts.part('payPlausible', async () => {
    const payPlausible = await loadSeam<(p: Record<string, unknown>) => boolean>(SEAMS.payPlausible);
    assert.equal(payPlausible(absurd), false, '"$60,000,000 an hour" is read as plausible pay');
    assert.equal(payPlausible({ min: 90_000, max: 110_000, currency: 'USD', period: 'year' }), true, 'an ordinary yearly range is read as implausible');
  });

  await parts.part('the Highest pay sort', async () => {
    const annualPay = await loadSeam<(row: unknown) => number | null>(SEAMS.annualPay);
    const sortCandidates = await loadSeam<(cands: unknown[], sort: string, opts?: unknown) => Array<{ row: { id: string } }>>(SEAMS.sortCandidates);
    const feedRow = await loadSeam<(over: Record<string, unknown>) => Record<string, unknown>>(SEAMS.feedRow);
    // A row stored before the rule existed: the figure sits in the pay columns.
    const typo = feedRow({
      id: 'typo',
      salaryDisclosed: true,
      salaryMin: absurd.min,
      salaryMax: absurd.max,
      salaryCurrency: 'USD',
      salaryPeriod: 'hour',
      salaryAnnualMin: 2_000_000_000,
      salaryAnnualMax: 2_000_000_000,
      salaryText: '$60,000,000 an hour',
    });
    const ordinary = feedRow({ id: 'ordinary', salaryDisclosed: true, salaryMin: 90_000, salaryMax: 110_000, salaryCurrency: 'USD', salaryPeriod: 'year', salaryAnnualMin: 90_000, salaryAnnualMax: 110_000 });
    const none = feedRow({ id: 'none' });
    assert.equal(annualPay(typo), null, 'the implausible figure is used as the job\'s pay');
    assert.equal(annualPay(ordinary), 110_000);
    const cand = (row: unknown) => ({ row, badge: null, fit: null, rank: 0 });
    const order = sortCandidates([cand(typo), cand(none), cand(ordinary)], 'highest_pay', { currency: 'USD' }).map((c) => c.row.id);
    assert.equal(order[0], 'ordinary', `"Highest pay" lists ${order.join(', ')}: the implausible figure is sorted as pay`);
  });
  parts.done();
}

// ── INV-10 ────────────────────────────────────────────────────────────────

function goApplyWorld(): World {
  const job = jobRecord({
    market: 'cn',
    title: '后端开发工程师',
    location: '上海',
    locationCity: '上海',
    locationCountry: 'CN',
    geoLat: null,
    geoLng: null,
    salaryAnnualMin: 240000,
    salaryAnnualMax: 336000,
    salaryCurrency: 'CNY',
  });
  const user = userWith({ taxonomyIds: ['backend_engineer'], locations: [{ label: '上海', city: '上海', country: 'CN', radiusKm: 0 }] });
  // GoApply, 个性化推荐 granted, the "Use AI" consent NOT given.
  return createWorld({ brand: 'goapply', aiAllowed: false, jobs: [job], users: { u1: user } });
}

function zeroCalls(world: World, what: string, network: { attempts: number; hosts: string[] }, extra: Array<[string, number]> = []): void {
  assert.equal(world.scorer.calls, 0, `${what} called the scorer ${world.scorer.calls} time(s)`);
  assert.equal(world.embeddings.calls, 0, `${what} called the embeddings client ${world.embeddings.calls} time(s)`);
  assert.equal(world.planner.calls, 0, `${what} called the search planner ${world.planner.calls} time(s)`);
  for (const [name, n] of extra) assert.equal(n, 0, `${what} ${name} ${n} time(s)`);
  assert.equal(network.attempts, 0, `${what} attempted ${network.attempts} network call(s) (${network.hosts.join(', ')})`);
}

async function inv10(): Promise<void> {
  const parts = new Parts();

  await parts.part('getFit', async () => {
    const world = goApplyWorld();
    await installEmbeddingsFake(world);
    const net = await countNetworkAttempts(async () => {
      const api = await world.fit();
      // Even when the caller allows a model call: the consent decides.
      const fit = await api.getFit('u1', 'job1', { allowModelCall: true, mode: 'on_demand' });
      assert.equal(fitKind(fit.kind), 'estimate', `getFit answered kind ${String(fit.kind)} without the AI consent`);
      await api.getFits('u1', ['job1']);
    });
    zeroCalls(world, 'getFit', net);
  });

  await parts.part('a feed query', async () => {
    const world = goApplyWorld();
    await installEmbeddingsFake(world);
    const createFeedQueryService = await loadSeam<(deps: Record<string, unknown>) => Record<string, (...args: unknown[]) => Promise<unknown>>>(SEAMS.createFeedQueryService);
    const createMatchService = await loadSeam<(deps: unknown) => Record<string, unknown>>(SEAMS.createMatchService);
    const FakeFeedRepo = await loadSeam<new () => { rows: unknown[] }>(SEAMS.FakeFeedRepo);
    const feedRow = await loadSeam<(over: Record<string, unknown>) => Record<string, unknown>>(SEAMS.feedRow);
    const repo = new FakeFeedRepo();
    const day = 86_400_000;
    repo.rows.push(
      feedRow({
        id: 'job1',
        market: 'cn',
        title: '后端开发工程师',
        titleNormalized: '后端开发工程师',
        workModel: 'onsite',
        remoteScope: null,
        location: '上海',
        locationCity: '上海',
        locationCountry: 'CN',
        postedAt: new Date(world.now.getTime() - day),
        firstSeenAt: new Date(world.now.getTime() - day),
        lastSeenAt: new Date(world.now.getTime() - 3_600_000),
      }),
    );
    // The feed reads the one fit through `getFits` once that exists (MKT-1F); before that it has its own read.
    const fitApi = await world.fit().catch((err) => {
      if (isSeamMissing(err)) return null;
      throw err;
    });
    const profile = searchProfileWire({ filters: {}, version: 1 });
    const service = createFeedQueryService({
      repo,
      match: { ...createMatchService(world.deps), ...(fitApi ? { getFits: fitApi.raw.getFits, getFit: fitApi.raw.getFit } : {}) },
      search: { getActive: async () => profile, get: async () => profile },
      personalized: async () => true,
      consumeRefresh: async () => ({ allowed: true, retryAfterSec: 0 }),
      aiAllowed: async () => false,
      planner: (text: string, ctx: unknown) => world.planner.plan(text, ctx),
      postingsAllowed: () => true,
      embeddings: world.embeddings,
      env: {},
      now: () => world.now,
    });
    const ctx = { userId: 'u1', market: 'cn', brandId: 'goapply', now: world.now };
    let listed = 0;
    let nlRefused = false;
    const net = await countNetworkAttempts(() =>
      world.inBrand(async () => {
        const page = (await service.query!(ctx, { sort: 'recommended' })) as { items?: unknown[] };
        listed = page.items?.length ?? 0;
        // A natural-language search is a model call: without the consent it is refused before the planner runs.
        await service.nlQuery!(ctx, { text: 'backend jobs in Shanghai' }, 'zh').then(
          () => undefined,
          () => {
            nlRefused = true;
          },
        );
      }),
    );
    assert.ok(listed > 0, 'the feed query listed no job, so it proves nothing');
    assert.equal(nlRefused, true, 'a natural-language search was answered without the AI consent');
    zeroCalls(world, 'the feed query', net);
  });

  await parts.part('the precompute cron', async () => {
    const world = goApplyWorld();
    await installEmbeddingsFake(world);
    world.repo.state.active = [{ id: 'u1', brand: 'goapply', lastActiveAt: new Date(world.now.getTime() - 3_600_000) }];
    const createScorePrecompute = await loadSeam<(getDeps: () => Promise<unknown>) => (ctx: unknown) => Promise<Record<string, unknown>>>(SEAMS.createScorePrecompute);
    const createMatchService = await loadSeam<(deps: unknown) => Record<string, unknown>>(SEAMS.createMatchService);
    const queued = { calls: 0 };
    const task = createScorePrecompute(async () => ({
      service: createMatchService(world.deps),
      repo: world.repo,
      aiAllowed: async () => false,
      resolveModel: async () => EVAL_SCORER_MODEL,
      routeAllowed: () => true,
      consume: async () => ({ allowed: true, retryAfterSec: 0, remaining: 100, windows: [] }),
      enqueue: async () => {
        queued.calls += 1;
        return { id: 'w1', created: true };
      },
      candidateIds: async () => ['job1'],
      embeddings: world.embeddings,
      env: {},
    }));
    const start = Date.now();
    const budget = { startedAt: start, deadline: start + 240_000, budgetMs: 240_000, remainingMs: () => 240_000, elapsedMs: () => 0, exhausted: () => false };
    let result: Record<string, unknown> = {};
    const net = await countNetworkAttempts(() =>
      world.inBrand(async () => {
        result = await task({ name: 'score-precompute', brand: world.brand, budget, now: world.now });
      }),
    );
    assert.ok(Number(result.processed ?? 0) >= 1, `the cron looked at no user (${JSON.stringify(result)}), so it proves nothing`);
    // A queued score item is a model call a few minutes later.
    zeroCalls(world, 'the precompute cron', net, [['queued an AI score', queued.calls]]);
  });
  parts.done();
}

/** Put the counting fake behind the embeddings client once that module exists (MKT-2H); before, there is no client to call. */
async function installEmbeddingsFake(world: World): Promise<void> {
  const set = await optionalSeam<(fake: unknown) => void>(SEAMS.setEmbeddingsClientForTests);
  if (set) set(world.embeddings);
}

// ── The list ──────────────────────────────────────────────────────────────

const RUNNERS: Record<string, () => Promise<void>> = {
  'INV-1': inv1,
  'INV-2': inv2,
  'INV-3': inv3,
  'INV-4': inv4,
  'INV-5': inv5,
  'INV-6': inv6,
  'INV-7': inv7,
  'INV-8': inv8,
  'INV-9': inv9,
  'INV-10': inv10,
};

export const INVARIANTS: readonly InvariantSpec[] = INVARIANT_LIST.map((info) => {
  const run = RUNNERS[info.id];
  if (!run) throw new Error(`no spec for ${info.id}`);
  return { ...info, run };
});
