// @vitest-environment node
//
// How a company interviews (prep/companyStyle.ts), with the search and the
// writing agent faked. The honesty rules: "from public sources" only with the
// results the agent cited; without a citation the style is the usual practice
// (no company stages or values); a failure is null and never remembered; a
// success is cached per brand, company, field, language and market.
// Run: npx vitest run server/src/interview-engine/prep/companyStyle.test.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  generateRequestId: () => 'req-test',
}));

import { getBrand } from '../../platform/brand/registry.js';
import { INTERVIEW_PATTERN_KEYS } from '../skills/index.js';
import type { PrepMarketContext } from './marketContext.js';
import type { WebResult } from './webSearch.js';
import { clearCompanyStyleCache, marketLanguageQuery, renderPatternIndex, researchCompanyStyle, type CompanyStyleDeps } from './companyStyle.js';

const ctxUs: PrepMarketContext = { brand: getBrand('roboapply'), formatMarket: 'intl', country: 'US', marketKey: 'us', marketLabel: 'United States and Canada' };
const ctxJp: PrepMarketContext = { ...ctxUs, country: 'JP', marketKey: 'jp', marketLabel: 'Japan' };

const result = (n: number, host = 'acme.example'): WebResult => ({
  title: `Result ${n}`,
  url: `https://${host}/page-${n}`,
  host,
  content: `Content ${n}.`,
  publishedAt: null,
});
const RESULTS = [result(1), result(2), result(3, 'blog.example.com')];

const RAW = {
  summary: 'Acme runs a recruiter screen, a technical deep dive and a values round.',
  stages: [
    { name: 'Recruiter screen', description: 'Motivation' },
    { name: 'Values round', description: 'Questions mapped to published principles' },
  ],
  values: ['Customer obsession', 'Ownership'],
  evaluates: ['Ownership of incidents'],
  questionThemes: ['A time you disagreed with your manager'],
  tips: ['Prepare two incident stories'],
  patterns: ['values-principles', 'not-a-pattern', 'project-deep-dive'],
  sourceIds: [1, '3', 99, 0, 'x'],
  basis: 'sources',
};

function makeDeps(over: Partial<CompanyStyleDeps> = {}) {
  return {
    search: vi.fn<CompanyStyleDeps['search']>(async () => RESULTS),
    write: vi.fn<CompanyStyleDeps['write']>(async () => structuredClone(RAW)),
    ...over,
  };
}

const research = (deps: CompanyStyleDeps, over: Partial<Parameters<typeof researchCompanyStyle>[0]> = {}) =>
  researchCompanyStyle({ company: 'Acme', role: 'Backend Engineer', locale: 'en', ctx: ctxUs, ...over }, deps);

beforeEach(() => {
  clearCompanyStyleCache();
});

describe('researchCompanyStyle', () => {
  it('a style that cites its results is "from public sources", with exactly the cited results as sources', async () => {
    const deps = makeDeps();
    const style = await research(deps);
    expect(style).toEqual({
      company: 'Acme',
      summary: RAW.summary,
      stages: RAW.stages,
      values: RAW.values,
      evaluates: RAW.evaluates,
      questionThemes: RAW.questionThemes,
      tips: RAW.tips,
      patterns: ['values-principles', 'project-deep-dive'],
      // [1] and "3" are cited; 99, 0 and "x" are not results.
      sources: [
        { title: 'Result 1', url: 'https://acme.example/page-1' },
        { title: 'Result 3', url: 'https://blog.example.com/page-3' },
      ],
      basis: 'sources',
    });
    // Two English queries on a market without a local-language one: the company and the role only.
    expect(deps.search.mock.calls).toEqual([
      ['"Acme" Backend Engineer interview process rounds questions', ctxUs],
      ['"Acme" careers how we hire interview process tips for candidates', ctxUs],
    ]);
    const [input] = deps.write.mock.calls[0]!;
    expect(input).toMatchObject({ company: 'Acme', role: 'Backend Engineer', marketLabel: 'United States and Canada', locale: 'en' });
    expect(input.evidence).toContain('[1] Result 1 — https://acme.example/page-1\nContent 1.');
    expect(input.evidence).toContain('[3] Result 3 — https://blog.example.com/page-3');
    for (const key of INTERVIEW_PATTERN_KEYS) expect(input.patternIndex).toContain(`- ${key}: `);
  });

  it('without a citation the style is the usual practice: basis "general", no company stages, values or sources', async () => {
    for (const raw of [{ ...RAW, sourceIds: [] }, { ...RAW, sourceIds: undefined }, { ...RAW, sourceIds: [42] }]) {
      clearCompanyStyleCache();
      const style = await research(makeDeps({ write: vi.fn(async () => structuredClone(raw)) }));
      expect(style).toMatchObject({ company: 'Acme', basis: 'general', stages: [], values: [], sources: [] });
      // What it says about the usual practice is kept.
      expect(style?.evaluates).toEqual(RAW.evaluates);
      expect(style?.tips).toEqual(RAW.tips);
    }
  });

  it('with no search results at all, the agent writes from nothing and the style is general', async () => {
    const deps = makeDeps({ search: vi.fn(async () => null) });
    const style = await research(deps);
    expect(deps.write.mock.calls[0]![0].evidence).toBe('');
    expect(style).toMatchObject({ basis: 'general', sources: [], stages: [], values: [] });
  });

  it('an agent failure is null and not remembered: the next setup tries again', async () => {
    const deps = makeDeps({
      write: vi.fn<CompanyStyleDeps['write']>().mockRejectedValueOnce(new Error('model down')).mockResolvedValue(structuredClone(RAW)),
    });
    expect(await research(deps)).toBeNull();
    const second = await research(deps);
    expect(second?.basis).toBe('sources');
    expect(deps.write).toHaveBeenCalledTimes(2);
  });

  it('an unusable answer (no summary) is null and not remembered either', async () => {
    const deps = makeDeps({
      write: vi.fn<CompanyStyleDeps['write']>().mockResolvedValueOnce({ ...RAW, summary: '' }).mockResolvedValue(structuredClone(RAW)),
    });
    expect(await research(deps)).toBeNull();
    expect(await research(deps)).not.toBeNull();
    expect(deps.write).toHaveBeenCalledTimes(2);
  });

  it('a second setup for the same company is served from the cache (whatever its spelling)', async () => {
    const deps = makeDeps();
    const first = await research(deps);
    const searches = deps.search.mock.calls.length;
    const second = await research(deps, { company: '  ACME ' });
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.search).toHaveBeenCalledTimes(searches);
    expect(second).toEqual(first);
    // Another language, market or brand is researched on its own.
    await research(deps, { locale: 'ja' });
    await research(deps, { ctx: ctxJp });
    await research(deps, { ctx: { ...ctxUs, brand: getBrand('goapply') } });
    expect(deps.write).toHaveBeenCalledTimes(4);
  });

  it('asks in the job market’s language too, and merges both answers without repeating a page', async () => {
    const deps = makeDeps({
      search: vi.fn(async (query: string) => (query.includes('面接') ? [result(2), result(4, 'note.example')] : [result(1), result(2)])),
    });
    await research(deps, { ctx: ctxJp });
    expect(deps.search.mock.calls.map(([query]) => query)).toEqual([
      '"Acme" Backend Engineer interview process rounds questions',
      '"Acme" careers how we hire interview process tips for candidates',
      'Acme Backend Engineer 面接 選考フロー 体験談',
    ]);
    const evidence = deps.write.mock.calls[0]![0].evidence;
    expect(evidence.match(/page-2/g)).toHaveLength(1);
    expect(evidence).toContain('[3] Result 4 — https://note.example/page-4');
  });

  it('interleaves the queries’ results, so the company’s own pages are not crowded out of the eight kept', async () => {
    const many = Array.from({ length: 9 }, (_, i) => result(i + 1, 'reviews.example'));
    const own = { ...result(100), title: 'How we hire at Acme' };
    const deps = makeDeps({ search: vi.fn(async (query: string) => (query.includes('how we hire') ? [own] : many)) });
    await research(deps);
    const evidence = deps.write.mock.calls[0]![0].evidence;
    expect(evidence).toContain('[2] How we hire at Acme — https://acme.example/page-100');
    // Eight results at most reach the agent.
    expect(evidence).toContain('[8] ');
    expect(evidence).not.toContain('[9] ');
  });

  it('one failed search does not stop the research', async () => {
    const deps = makeDeps({
      search: vi.fn(async (query: string) => {
        if (query.includes('面接')) throw new Error('timeout');
        return [result(1)];
      }),
      write: vi.fn(async () => ({ ...structuredClone(RAW), sourceIds: [1] })),
    });
    const style = await research(deps, { ctx: ctxJp });
    expect(style?.sources).toEqual([{ title: 'Result 1', url: 'https://acme.example/page-1' }]);
  });

  it('an empty company name researches nothing', async () => {
    const deps = makeDeps();
    expect(await research(deps, { company: '   ' })).toBeNull();
    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('a quote in the company name cannot break out of the quoted query', async () => {
    const deps = makeDeps();
    await research(deps, { company: 'Acme "Labs"' });
    expect(deps.search.mock.calls[0]![0]).toBe('"Acme Labs" Backend Engineer interview process rounds questions');
  });
});

describe('marketLanguageQuery', () => {
  it.each([
    ['cn', 'Acme 后端工程师 面试流程 面经 几轮'],
    ['tw', 'Acme 后端工程师 面試 流程 心得'],
    ['jp', 'Acme 后端工程师 面接 選考フロー 体験談'],
    ['kr', 'Acme 后端工程师 면접 후기 전형'],
    ['de', 'Acme 后端工程师 Vorstellungsgespräch Ablauf Erfahrungen'],
    ['fr', "Acme 后端工程师 entretien d'embauche déroulement"],
    ['es', 'Acme 后端工程师 entrevista de trabajo proceso de selección'],
    ['br', 'Acme 后端工程师 entrevista processo seletivo etapas'],
  ])('%s', (market, expected) => {
    expect(marketLanguageQuery('Acme', '后端工程师', market)).toBe(expected);
  });

  it('English-language markets need no second query', () => {
    for (const market of ['us', 'uk', 'in', 'sea', 'unknown']) expect(marketLanguageQuery('Acme', 'Engineer', market)).toBeNull();
  });
});

describe('renderPatternIndex', () => {
  it('lists every pattern once, id first', () => {
    const lines = renderPatternIndex().split('\n');
    expect(lines).toHaveLength(INTERVIEW_PATTERN_KEYS.length);
    INTERVIEW_PATTERN_KEYS.forEach((key, i) => expect(lines[i]).toMatch(new RegExp(`^- ${key}: `)));
  });
});
