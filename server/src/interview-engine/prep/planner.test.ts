// @vitest-environment node
//
// The interview plan (prep/planner.ts) with every dependency faked: the job
// loader, the resume, the market context, the company research, the role's
// web evidence and the planning agent. Checks the target (our job, a web
// posting, a pasted post, a role), how the planner's answer is cleaned, and
// the catalog fallback that keeps Start working when the model fails.
// Run: npx vitest run server/src/interview-engine/prep/planner.test.ts

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  generateRequestId: () => 'req-test',
}));

import { getBrand, type ProductBrand } from '../../platform/brand/registry.js';
import { findPersona } from '../catalog/interviewCatalog.js';
import { DOMAIN_EXPERTS } from '../catalog/domainExperts.js';
import { isMarketFormat, renderSkillIndex } from '../skills/index.js';
import { describeCompanyStyle, type PrepCompanyStyle, type PrepPlan } from './contract.js';
import type { PrepMarketContext } from './marketContext.js';
import { PrepJobNotFoundError, planInterview, resolvePlannerTarget, type PlannerDeps } from './planner.js';

const robo = getBrand('roboapply');
const go = getBrand('goapply');

const ctxFor = (brand: ProductBrand): PrepMarketContext =>
  brand.market === 'cn'
    ? { brand, formatMarket: 'cn', country: 'CN', marketKey: 'cn', marketLabel: 'Mainland China' }
    : { brand, formatMarket: 'intl', country: 'US', marketKey: 'us', marketLabel: 'United States and Canada' };

const JD = 'We build payment APIs in Go and run them on call. '.repeat(20);
const JOB = { id: 'j1', title: 'Backend Engineer', companyName: 'Acme', location: 'Berlin, Germany', jdText: JD };

const RAW_PLAN = {
  requirements: {
    summary: 'Builds and runs payment APIs.',
    seniority: 'Senior',
    mustHave: ['Go', 'Postgres', 'Go'],
    niceToHave: ['Kafka'],
    responsibilities: ['Own the ledger'],
    competencies: ['Ownership'],
  },
  interviewers: [
    { key: 'i1', name: 'Mara Klein', title: 'Recruiter', background: 'Hires engineers', style: 'Warm', archetype: 'warmup', difficulty: 1, voiceGender: 'female', focusKeys: ['f3', 'f9'], patterns: ['hr-final'] },
    { key: 'i1', name: 'Jonas Weber', title: 'Hiring manager, payments', background: 'Runs payments', style: 'Numbers first', archetype: 'dragon', difficulty: 9, voiceGender: 'male', focusKeys: ['f1'], patterns: [] },
    { name: '', title: 'Ghost' },
    { key: 'i3', name: 'Lea Braun', title: 'Senior peer', background: 'Staff engineer', style: 'Deep', archetype: 'depth', difficulty: 3, voiceGender: 'female', focusKeys: ['f2'], patterns: ['project-deep-dive'] },
  ],
  focuses: [
    { key: 'f1', label: 'Payments system design', description: 'Design a ledger', format: 'system', patterns: ['project-deep-dive'], topics: ['Idempotency', 'Reconciliation'] },
    { key: 'f2', label: 'Production incidents', description: 'Walk through an outage', format: 'incident_sre', patterns: [], topics: ['On-call'] },
    { key: 'f3', label: 'Motivation', description: 'Why Acme', format: 'interpretive_dance', patterns: [], topics: ['Why this company'] },
  ],
  recommended: { interviewerKey: 'nobody', focusKey: 'f2' },
  strategy: {
    summary: 'Starts with the ledger, then an incident.',
    stages: [{ name: 'Opening', goal: 'Rapport', share: 0.2 }],
    tactics: ['Asks for the numbers'],
    prepTips: ['Know your p99'],
  },
};

const STYLE: PrepCompanyStyle = {
  company: 'Acme',
  summary: 'Acme runs a recruiter screen, a technical deep dive and a values round.',
  stages: [{ name: 'Values round', description: 'Principles' }],
  values: ['Ownership'],
  evaluates: ['Ownership of incidents'],
  questionThemes: [],
  tips: [],
  patterns: ['values-principles'],
  sources: [{ title: 'Acme careers', url: 'https://acme.example/careers' }],
  basis: 'sources',
};

function makeDeps(over: Partial<PlannerDeps> = {}) {
  return {
    loadJob: vi.fn<PlannerDeps['loadJob']>(async (_userId, jobId) => (jobId === JOB.id ? { ...JOB } : null)),
    loadResume: vi.fn<PlannerDeps['loadResume']>(async () => null),
    marketContext: vi.fn<PlannerDeps['marketContext']>(async (input) => ctxFor(input.brand)),
    companyStyle: vi.fn<PlannerDeps['companyStyle']>(async () => null),
    roleEvidence: vi.fn<PlannerDeps['roleEvidence']>(async () => ({ text: '', sources: [] })),
    plan: vi.fn<PlannerDeps['plan']>(async () => structuredClone(RAW_PLAN)),
    ...over,
  };
}

const plan = (deps: PlannerDeps, over: Partial<Parameters<typeof planInterview>[0]> = {}) =>
  planInterview({ userId: 'u1', brand: robo, locale: 'en', body: { role: 'Backend Engineer' }, ...over }, deps);

function expectValidPanel(result: PrepPlan, market: 'intl' | 'cn') {
  expect(result.interviewers.length).toBeGreaterThanOrEqual(2);
  for (const interviewer of result.interviewers) {
    const persona = findPersona(interviewer.baseId);
    expect(persona, interviewer.baseId).toBeDefined();
    expect(persona!.archetype).toBe(interviewer.archetype);
  }
  for (const focus of result.focuses) expect(isMarketFormat(focus.format, market), focus.format).toBe(true);
  const interviewerKeys = result.interviewers.map((i) => i.key);
  const focusKeys = result.focuses.map((f) => f.key);
  expect(new Set(interviewerKeys).size).toBe(interviewerKeys.length);
  expect(new Set(focusKeys).size).toBe(focusKeys.length);
  expect(interviewerKeys).toContain(result.recommended.interviewerKey);
  expect(focusKeys).toContain(result.recommended.focusKey);
}

describe('planInterview: the target', () => {
  it('an unknown job id is a PrepJobNotFoundError, before anything is researched or planned', async () => {
    const deps = makeDeps();
    const err = await plan(deps, { body: { jobId: 'missing' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrepJobNotFoundError);
    expect((err as PrepJobNotFoundError).code).toBe('job_not_found');
    expect(deps.loadJob).toHaveBeenCalledWith('u1', 'missing', 'intl');
    for (const dep of [deps.marketContext, deps.companyStyle, deps.roleEvidence, deps.loadResume, deps.plan]) expect(dep).not.toHaveBeenCalled();
    // GoApply loads only mainland jobs.
    await plan(deps, { brand: go, body: { jobId: 'missing' } }).catch(() => undefined);
    expect(deps.loadJob).toHaveBeenLastCalledWith('u1', 'missing', 'cn');
  });

  it('plans from our job: its post is authoritative, its company is researched, its location sets the market', async () => {
    const deps = makeDeps({ loadResume: vi.fn(async () => 'Five years of Go at a bank.') });
    const result = await plan(deps, { userName: 'Jane Doe', body: { jobId: 'j1' } });

    expect(deps.marketContext).toHaveBeenCalledWith({ userId: 'u1', brand: robo, locale: 'en', countryHint: 'DE' });
    expect(deps.companyStyle).toHaveBeenCalledWith(expect.objectContaining({ company: 'Acme', role: 'Backend Engineer', locale: 'en', ctx: ctxFor(robo) }));
    // A full post needs no web research of the role.
    expect(deps.roleEvidence).not.toHaveBeenCalled();
    // The account name is a known value the resume loader redacts.
    expect(deps.loadResume).toHaveBeenCalledWith('u1', 'j1', ['Jane Doe']);
    const [input] = deps.plan.mock.calls[0]!;
    expect(input).toMatchObject({
      role: 'Backend Engineer',
      company: 'Acme',
      industry: null,
      locale: 'en',
      sessionLanguage: 'en',
      durationMinutes: 20,
      jdText: JD.trim(),
      webEvidence: null,
      companyStyle: null,
      resumeContext: 'Five years of Go at a bank.',
      skillIndex: renderSkillIndex('intl'),
    });
    expect(input.marketSummary).toContain('United States and Canada');
    expect(input.domain).toContain(DOMAIN_EXPERTS.software.labelEn);

    expect(result).toMatchObject({
      v: 1,
      role: 'Backend Engineer',
      company: 'Acme',
      jobId: 'j1',
      market: 'us',
      language: 'en',
      posting: { title: 'Backend Engineer', company: 'Acme', location: 'Berlin, Germany', url: null },
      domain: { key: 'software', label: DOMAIN_EXPERTS.software.labelEn },
      companyStyle: null,
      sources: [],
    });
    expect(result.fallback).toBeUndefined();
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
  });

  it('the candidate’s own role, company and settings outrank the job’s', async () => {
    const deps = makeDeps();
    const result = await plan(deps, { body: { jobId: 'j1', role: 'Staff Backend Engineer', company: 'Globex', industry: 'Fintech', durationMinutes: 30, language: 'de' } });
    expect(result).toMatchObject({ role: 'Staff Backend Engineer', company: 'Globex', industry: 'Fintech', jobId: 'j1' });
    expect(deps.plan.mock.calls[0]![0]).toMatchObject({ durationMinutes: 30, sessionLanguage: 'de', locale: 'en', company: 'Globex' });
  });

  it('a web posting brings its title, company and country', async () => {
    const deps = makeDeps();
    const result = await plan(deps, {
      body: { posting: { title: 'Data Scientist', company: 'Globex', location: 'Tokyo, Japan', url: 'https://jobs.lever.co/globex/1' } },
    });
    expect(deps.loadJob).not.toHaveBeenCalled();
    expect(deps.marketContext).toHaveBeenCalledWith(expect.objectContaining({ countryHint: 'JP' }));
    expect(result).toMatchObject({
      role: 'Data Scientist',
      company: 'Globex',
      jobId: null,
      posting: { title: 'Data Scientist', company: 'Globex', location: 'Tokyo, Japan', url: 'https://jobs.lever.co/globex/1' },
    });
    // No post text: the role is researched on the web.
    expect(deps.roleEvidence).toHaveBeenCalledWith('Data Scientist', ctxFor(robo));
  });

  it('a posting link is kept whole (up to 2048 characters) or not at all; longer fields are clipped', async () => {
    const APPLY = 'https://jobs.example/apply?ref=';
    const exactly2048 = APPLY + 'x'.repeat(2048 - APPLY.length);
    const kept = await resolvePlannerTarget(
      { userId: 'u1', market: 'intl', body: { role: 'R'.repeat(400), posting: { title: 'Data Scientist', url: exactly2048 } } },
      { loadJob: vi.fn() },
    );
    expect(kept.posting?.url).toBe(exactly2048);
    expect(kept.role).toBe('R'.repeat(200));
    const dropped = await resolvePlannerTarget(
      { userId: 'u1', market: 'intl', body: { posting: { title: 'T'.repeat(400), company: 'C'.repeat(200), location: 'L'.repeat(400), url: `${exactly2048}x` } } },
      { loadJob: vi.fn() },
    );
    expect(dropped.posting).toEqual({ title: 'T'.repeat(200), company: 'C'.repeat(120), location: 'L'.repeat(160), url: null });
    expect(dropped).toMatchObject({ role: 'T'.repeat(200), company: 'C'.repeat(120) });
  });

  it('a pasted post without a role names the role from the post', async () => {
    const target = await resolvePlannerTarget({ userId: 'u1', market: 'intl', body: { jdText: 'Job title: Senior Data Engineer\nWe build pipelines.' } }, { loadJob: vi.fn() });
    expect(target).toMatchObject({ role: 'Senior Data Engineer', company: null, jobId: null, jdText: 'Job title: Senior Data Engineer\nWe build pipelines.', posting: null, countryHint: null });
  });
});

describe('planInterview: the planner’s answer is cleaned', () => {
  it('valid ids, unique keys, catalog personas, real focus keys and a valid recommendation', async () => {
    const result = await plan(makeDeps());
    expectValidPanel(result, 'intl');
    expect(result.interviewers.map((i) => [i.key, i.name, i.archetype, i.difficulty])).toEqual([
      ['i1', 'Mara Klein', 'warmup', 1],
      ['i2', 'Jonas Weber', 'behavioral', 3],
      ['i3', 'Lea Braun', 'depth', 3],
    ]);
    expect(result.interviewers[1].baseId).toBe('bishop'); // behavioral, male, demanding
    expect(result.focuses.map((f) => [f.key, f.format])).toEqual([
      ['f1', 'system'],
      ['f2', 'incident_sre'],
      ['f3', 'behavioral'],
    ]);
    // Focus keys an interviewer was given that no focus has are dropped.
    expect(result.interviewers[0].focusKeys).toEqual(['f3']);
    // The recommended focus is kept; the unknown interviewer becomes the one suited to that focus.
    expect(result.recommended).toEqual({ interviewerKey: 'i3', focusKey: 'f2' });
    expect(result.requirements.mustHave).toEqual(['Go', 'Postgres']);
    expect(result.strategy).toEqual(RAW_PLAN.strategy);
  });

  it('an unknown recommended focus becomes the first focus', async () => {
    const result = await plan(makeDeps({ plan: vi.fn(async () => ({ ...structuredClone(RAW_PLAN), recommended: { interviewerKey: 'i1', focusKey: 'zz' } })) }));
    expect(result.recommended).toEqual({ interviewerKey: 'i1', focusKey: 'f1' });
  });
});

describe('planInterview: the catalog fallback', () => {
  it('a planner failure still returns a plan of catalog interviewers and formats', async () => {
    const deps = makeDeps({ plan: vi.fn(async () => Promise.reject(new Error('model down'))) });
    const result = await plan(deps, { body: { role: 'Backend Engineer' } });
    expect(result.fallback).toBe(true);
    expectValidPanel(result, 'intl');
    for (const interviewer of result.interviewers) expect(interviewer.name).toBe(findPersona(interviewer.baseId)!.name);
    // A technical role gets a technical round and the technical interviewer.
    expect(result.focuses.map((f) => f.format)).toEqual(['behavioral', 'technical', 'screening', 'culture']);
    expect(result.interviewers.map((i) => i.baseId)).toEqual(['priya', 'kai', 'maya']);
    // Nothing model-written: no requirements rather than untranslated catalog text.
    expect(result.requirements).toEqual({ summary: '', seniority: '', mustHave: [], niceToHave: [], responsibilities: [], competencies: [] });
    expect(result.strategy).toEqual({ summary: '', stages: [], tactics: [], prepTips: [] });
    expect(result.focuses.map((f) => f.format)).not.toContain('cn_ai_interview');
  });

  it('too few usable interviewers or focuses is a failure too', async () => {
    const oneInterviewer = makeDeps({ plan: vi.fn(async () => ({ ...structuredClone(RAW_PLAN), interviewers: [RAW_PLAN.interviewers[0]] })) });
    expect((await plan(oneInterviewer)).fallback).toBe(true);
    const oneFocus = makeDeps({ plan: vi.fn(async () => ({ ...structuredClone(RAW_PLAN), focuses: [RAW_PLAN.focuses[0], { label: '' }] })) });
    expect((await plan(oneFocus)).fallback).toBe(true);
  });

  it('the GoApply fallback offers the AI-interview format', async () => {
    const deps = makeDeps({ plan: vi.fn(async () => Promise.reject(new Error('model down'))) });
    const result = await plan(deps, { brand: go, locale: 'zh', body: { role: '产品经理' } });
    expect(result).toMatchObject({ fallback: true, market: 'cn' });
    expectValidPanel(result, 'cn');
    expect(result.focuses.map((f) => f.format)).toContain('cn_ai_interview');
    // A role without a field still gets a case round and the case interviewer.
    expect(result.focuses.map((f) => f.format)).toEqual(['behavioral', 'case', 'cn_ai_interview', 'culture']);
    expect(result.interviewers.map((i) => i.baseId)).toEqual(['priya', 'okonkwo', 'maya']);
  });
});

describe('planInterview: company research and sources', () => {
  it('the researched style is passed to the planner and returned; its sources lead plan.sources', async () => {
    const deps = makeDeps({
      companyStyle: vi.fn(async () => STYLE),
      roleEvidence: vi.fn(async () => ({ text: '[1] Backend role guide — https://guide.example/backend\nWhat backend engineers do.', sources: [{ title: 'Backend role guide', url: 'https://guide.example/backend' }] })),
    });
    const result = await plan(deps, { body: { role: 'Backend Engineer', company: 'Acme' } });
    expect(result.companyStyle).toEqual(STYLE);
    expect(result.sources).toEqual([
      { title: 'Acme careers', url: 'https://acme.example/careers' },
      { title: 'Backend role guide', url: 'https://guide.example/backend' },
    ]);
    const [input] = deps.plan.mock.calls[0]!;
    expect(input.companyStyle).toBe(describeCompanyStyle(STYLE));
    expect(input.companyStyle).toContain('Acme (from public sources)');
    expect(input.webEvidence).toContain('Backend role guide');
    // The fallback keeps the research too.
    const failing = makeDeps({ companyStyle: vi.fn(async () => STYLE), plan: vi.fn(async () => Promise.reject(new Error('down'))) });
    const fallback = await plan(failing, { body: { role: 'Backend Engineer', company: 'Acme' } });
    expect(fallback).toMatchObject({ fallback: true, companyStyle: STYLE, sources: STYLE.sources });
  });

  it('without a company nothing is researched about one', async () => {
    const deps = makeDeps();
    const result = await plan(deps, { body: { role: 'Backend Engineer' } });
    expect(deps.companyStyle).not.toHaveBeenCalled();
    expect(result.companyStyle).toBeNull();
    expect(deps.plan.mock.calls[0]![0].companyStyle).toBeNull();
  });

  it('a failed role search or resume lookup never fails the plan', async () => {
    const deps = makeDeps({
      roleEvidence: vi.fn(async () => Promise.reject(new Error('search down'))),
      loadResume: vi.fn(async () => Promise.reject(new Error('db down'))),
    });
    const result = await plan(deps, { body: { role: 'Backend Engineer' } });
    expect(result.fallback).toBeUndefined();
    expect(deps.plan.mock.calls[0]![0]).toMatchObject({ webEvidence: null, resumeContext: null });
  });
});
