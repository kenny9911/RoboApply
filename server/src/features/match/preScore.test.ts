// @vitest-environment node
// The quick estimate, version 2 (MARKET_STRATEGY 2.2, 2.4; SM-3): table tests
// per component, the priors, the logistics rule, coverage and confidence, and
// the rule that no chip of the saved search moves a fit (invariant I3).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { current as currentVocabulary, resetVocabularyForTests, setVocabularyForTests } from '../skills/index.js';
import { getMatchPriors } from './config.js';
import { DEFAULT_MATCH_PRIORS, DEFAULT_MATCH_TIERS, DEFAULT_MATCH_WEIGHTS, tierForScore } from './contract.js';
import {
  LOGISTICS_BY_FILTERS_REF,
  combineDimensions,
  combineWithPriors,
  confidenceFor,
  coverageOf,
  degreeMeets,
  evidenceRoles,
  hardFiltersOf,
  industryDimension,
  isByFilters,
  carriesSkillIds,
  hardSkillList,
  isAmbiguousAbbreviation,
  jobSkillCheck,
  jobSkillList,
  labelLocaleFor,
  listedSkillCheck,
  postingStates,
  termCheck,
  textShowsSkill,
  userShows,
  userSkillIdSet,
  levelGap,
  locationCheck,
  logisticsDimension,
  logisticsForEstimate,
  needsSponsorshipFor,
  payCheck,
  postingCoverageOf,
  preScore,
  preScoreDimensions,
  preScoreLimit,
  resumeSeniority,
  roleIdOfTitle,
  seniorityFactor,
  skillKey,
  skillsDimension,
  splitSkills,
  normalizeText,
  taxonomyOverlap,
  titleLevelDimension,
  titleOverlap,
  visaCheck,
  type MatchUser,
} from './preScore.js';
import { buildKeywordRows } from './keywordRows.js';
import { buildMatchUser, payAsPosted, toMatchJob, type UserMatchInputs } from './context.js';
import { FIXTURE_SKILLS, defaultUserInputs, jobRecord, matchJob, matchUser, skillRecord } from './testkit.js';

const W = { ...DEFAULT_MATCH_WEIGHTS };
const P = { ...DEFAULT_MATCH_PRIORS };
const CFG = { weights: W, tiers: { ...DEFAULT_MATCH_TIERS } };
const NOW = new Date('2026-10-10T00:00:00Z');
/** No logistics answers at all: nothing to check, nothing guaranteed. */
const NO_LOGISTICS: Pick<MatchUser, 'locations' | 'workModels' | 'country' | 'salaryMin'> = { locations: [], workModels: [], country: null, salaryMin: null };

describe('taxonomy distance', () => {
  it.each([
    ['backend_engineer', 'backend_engineer', 1],
    ['swe_backend', 'backend_engineer', 1], // inside the user's target group
    ['software_engineering', 'frontend_engineer', 1], // inside the user's target category
    ['platform_engineer', 'backend_engineer', 0.6], // same group
    ['frontend_engineer', 'backend_engineer', 0.3], // same category
    ['account_executive', 'backend_engineer', 0], // unrelated
    ['not_a_node', 'backend_engineer', 0],
  ])('%s vs %s → %s', (target, job, expected) => {
    expect(taxonomyOverlap(target, job)).toBe(expected);
  });

  it('the job falls back to its title when it carries no taxonomy ids; the person falls back to their most recent title', () => {
    const job = matchJob({ taxonomyIds: [], primaryTaxonomyId: null, title: 'Senior Backend Engineer' });
    expect(titleOverlap(matchUser(), job)).toBe(1);
    // A hand-built person with no `evidenceRoleIds`: the role their most recent title names.
    expect(evidenceRoles({ recentTitle: 'Backend Engineer' })).toEqual(['backend_engineer']);
    expect(titleOverlap({ recentTitle: 'Backend Engineer' }, job)).toBe(1);
    expect(titleOverlap({ recentTitle: null }, job)).toBeNull();
    // An explicit empty list is "the record shows no role": the title is not consulted again.
    expect(titleOverlap({ evidenceRoleIds: [], recentTitle: 'Backend Engineer' }, job)).toBeNull();
    // Ids that are not taxonomy nodes are dropped.
    expect(evidenceRoles({ evidenceRoleIds: ['not_a_node', 'backend_engineer', 'backend_engineer'], recentTitle: null })).toEqual(['backend_engineer']);
  });

  it('the saved search is never the role: a job inside the Role filter is not a fit for passing the filter (I3)', () => {
    const teacher = matchUser({ evidenceRoleIds: ['school_teacher'], recentTitle: 'Teacher', targetTaxonomyIds: ['data_analyst'], targetTitles: ['Data Analyst'] });
    const analyst = matchJob({ title: 'Data Analyst', taxonomyIds: ['data_ai', 'data_analytics', 'data_analyst'], primaryTaxonomyId: 'data_analyst' });
    expect(titleOverlap(teacher, analyst)).toBe(0);
    expect(titleLevelDimension(teacher, analyst, W)).toMatchObject({ status: 'scored', score: 0 });
  });
});

describe('seniority factor', () => {
  it.each([
    [['senior'], 'senior', 1],
    [['mid'], 'senior', 0.7],
    [['entry'], 'senior', 0.3],
    [['intern_newgrad'], 'senior', 0],
    [['mid', 'lead_staff'], 'senior', 0.7],
    [[], 'senior', 0.8],
    [['senior'], null, 0.8],
  ])('%j vs %s → %s', (targets, job, f) => {
    expect(seniorityFactor(targets as string[], job as string | null)).toBe(f);
  });
});

describe('title_level = taxonomy overlap × seniority × stated eligibility', () => {
  it('scores overlap × factor and cites the posting title', () => {
    const d = titleLevelDimension(matchUser({ recentTitle: 'Software Engineer', yearsExperience: 4 }), matchJob({ seniority: 'senior' }), W);
    expect(d).toMatchObject({ key: 'title_level', status: 'scored', score: 70, weight: 35 });
    expect(d.evidence[0]).toEqual({ text: 'Backend Engineer', source: 'posting', ref: 'title' });
  });

  it('halves when the posting states a degree the user does not have', () => {
    const d = titleLevelDimension(matchUser({ highestDegree: 'bachelor' }), matchJob({ educationLevel: 'master' }), W);
    expect(d.score).toBe(50);
    expect(d.evidence.some((e) => e.ref === 'education_required')).toBe(true);
    // Unknown user degree: no penalty (never inferred).
    expect(titleLevelDimension(matchUser({ highestDegree: null }), matchJob({ educationLevel: 'master' }), W).score).toBe(100);
  });

  it('GoApply: a stated 届别 the user is not in halves title_level; unstated does nothing', () => {
    const cnUser = matchUser({ market: 'cn', classYear: 2026 });
    const stated = matchJob({ market: 'cn', classYears: [2027], classYearQuote: '面向2027届毕业生' });
    const d = titleLevelDimension(cnUser, stated, W);
    expect(d.score).toBe(50);
    expect(d.evidence).toContainEqual({ text: '面向2027届毕业生', source: 'posting', ref: 'class_year' });
    expect(titleLevelDimension(cnUser, matchJob({ market: 'cn', classYears: [2026] }), W).score).toBe(100);
    expect(titleLevelDimension(cnUser, matchJob({ market: 'cn', classYears: [] }), W).score).toBe(100);
  });

  it('degreeMeets', () => {
    expect(degreeMeets('master', 'bachelor')).toBe(true);
    expect(degreeMeets('associate', 'bachelor')).toBe(false);
    expect(degreeMeets(null, 'bachelor')).toBeNull();
    expect(degreeMeets('phd', null)).toBeNull();
    expect(degreeMeets('phd', 'none')).toBeNull();
  });
});

describe('skills = Σ weight shown / Σ weight listed over the first 10 hard skills (required 1, preferred 0.5)', () => {
  it.each([
    [['TypeScript', 'Go'], ['typescript', 'go', 'kubernetes'], 67],
    [['typescript', 'GO', 'Kubernetes'], ['typescript', 'go', 'kubernetes'], 100],
    [[], ['typescript'], 0],
    [['Node.js'], ['nodejs'], 100],
  ])('user %j vs job %j → %s', (userSkills, jobSkills, score) => {
    const d = skillsDimension(matchUser({ skills: userSkills as string[] }), matchJob({ skills: jobSkills as string[] }), W);
    expect(d.score).toBe(score);
  });

  it('counts the first 10 only, required ones first', () => {
    const many = Array.from({ length: 20 }, (_, i) => `skill${i}`);
    const d = skillsDimension(matchUser({ skills: many.slice(0, 10) }), matchJob({ skills: many }), W);
    expect(d.score).toBe(100);
    // The person shows only the last ten: none of the ten that are counted.
    expect(skillsDimension(matchUser({ skills: many.slice(10) }), matchJob({ skills: many }), W).score).toBe(0);
    // Required skills are counted before the others, wherever the posting lists them.
    const detail = many.map((skill, i) => ({ skill, kind: 'hard', required: i >= 15 }));
    const requiredOnly = matchUser({ skills: many.slice(15) });
    // 5 required shown (5 × 1) of 5 required + 5 preferred (5 × 1 + 5 × 0.5).
    expect(skillsDimension(requiredOnly, matchJob({ skills: [], skillsDetail: detail }), W).score).toBe(Math.round((100 * 5) / 7.5));
  });

  it('a required skill counts 1 and a preferred one 0.5', () => {
    const job = matchJob({
      skills: [],
      skillsDetail: [
        { skill: 'Kubernetes', kind: 'hard', required: true },
        { skill: 'TypeScript', kind: 'hard', required: false },
        { skill: 'Go', kind: 'hard', required: false },
      ],
    });
    // Shows the two preferred ones: (0.5 + 0.5) / (1 + 0.5 + 0.5).
    expect(skillsDimension(matchUser({ skills: ['TypeScript', 'Go'] }), job, W).score).toBe(50);
    // Shows only the required one: 1 / 2.
    expect(skillsDimension(matchUser({ skills: ['Kubernetes'] }), job, W).score).toBe(50);
    // Shows the required one and one preferred: 1.5 / 2.
    expect(skillsDimension(matchUser({ skills: ['Kubernetes', 'Go'] }), job, W).score).toBe(75);
  });

  it('soft skills are shown and never counted; a posting that lists only soft skills states no skills', () => {
    const softOnly = matchJob({
      skills: ['communication', 'attention to detail'],
      skillsDetail: [
        { skill: 'Communication', kind: 'soft', required: true },
        { skill: 'Attention to detail', kind: 'soft', required: false },
      ],
    });
    expect(skillsDimension(matchUser({ skills: ['Communication'] }), softOnly, W)).toMatchObject({ status: 'not_stated', score: null });
    expect(splitSkills(matchUser(), softOnly)).toEqual({ aligned: [], related: [], missing: [], missingRequired: [], softSkills: ['Communication', 'Attention to detail'], unchecked: [] });
    expect(preScore(matchUser(), softOnly, CFG).softSkills).toEqual(['Communication', 'Attention to detail']);

    // Mixed: the soft skill is in neither the numerator nor the denominator.
    const mixed = matchJob({
      skills: ['typescript', 'teamwork', 'go'],
      skillsDetail: [
        { skill: 'TypeScript', kind: 'hard', required: true },
        { skill: 'Teamwork', kind: 'soft', required: true },
      ],
    });
    // TypeScript (required, shown) 1, Go (no detail entry, so hard and preferred; shown) 0.5 → 1.5 / 1.5.
    expect(skillsDimension(matchUser({ skills: ['TypeScript', 'Go'] }), mixed, W).score).toBe(100);
    expect(jobSkillList(mixed).map((s) => [s.skill, s.kind, s.required])).toEqual([
      ['TypeScript', 'hard', true],
      ['Teamwork', 'soft', true],
      ['Go', 'hard', false],
    ]);
    expect(splitSkills(matchUser({ skills: ['TypeScript'] }), mixed)).toEqual({ aligned: ['TypeScript'], related: [], missing: ['Go'], missingRequired: [], softSkills: ['Teamwork'], unchecked: [] });
    // The gap on a card is never a soft skill.
    expect(preScore(matchUser({ skills: [] }), mixed, CFG).topGap).toBe('TypeScript');
  });

  it('is not stated when the posting lists no skills; evidence names a missing required skill', () => {
    expect(skillsDimension(matchUser(), matchJob({ skills: [], skillsDetail: null }), W).status).toBe('not_stated');
    const d = skillsDimension(
      matchUser({ skills: ['TypeScript'] }),
      matchJob({ skills: [], skillsDetail: [{ skill: 'Go', required: false }, { skill: 'Kubernetes', required: true }, { skill: 'TypeScript', required: true }] }),
      W,
    );
    expect(d.evidence).toContainEqual({ text: 'Kubernetes', source: 'posting', ref: 'skill_missing' });
    expect(d.evidence).toContainEqual({ text: 'TypeScript', source: 'resume', ref: 'skill_have' });
  });

  it('a skill written only in the resume body counts as shown — and agrees with the keyword check', () => {
    const resume = 'Senior engineer. Ran our Kubernetes clusters and wrote Go services.';
    const user = matchUser({ skills: ['TypeScript'], resumeTextNorm: normalizeText(resume) });
    const job = matchJob({ skills: ['typescript', 'go', 'kubernetes', 'rust'], skillsDetail: null });
    // Stored lower case, shown in the usual spelling.
    expect(splitSkills(user, job)).toEqual({ aligned: ['TypeScript', 'Go', 'Kubernetes'], related: [], missing: ['Rust'], missingRequired: [], softSkills: [], unchecked: [] });
    expect(skillsDimension(user, job, W).score).toBe(75);
    expect(skillsDimension(user, job, W).evidence).toContainEqual({ text: 'Rust', source: 'posting', ref: 'skill_missing' });
    const skillsRow = buildKeywordRows({ job: { ...job, minYears: null }, user, resumeText: resume, keywords: null }).find((r) => r.key === 'skills')!;
    expect(skillsRow.items.filter((i) => !i.found).map((i) => i.term)).toEqual(['Rust']);
    // Whole words only: "Go" is not found inside "Google".
    const google = matchUser({ skills: [], resumeTextNorm: normalizeText('Worked at Google.') });
    expect(splitSkills(google, matchJob({ skills: ['go'], skillsDetail: null })).missing).toEqual(['Go']);
  });

  it('skillKey normalizes punctuation and case', () => {
    expect(skillKey(' Node.JS ')).toBe('nodejs');
    expect(skillKey('C++')).toBe('c++');
    expect(skillKey('C#')).not.toBe(skillKey('C++'));
  });
});

// ── Canonical skills (SM-6; MARKET_STRATEGY 2.1 point 4; MATCH 4.4 point 3) ──

describe('canonical skills in the estimate: a posting that carries skill ids is compared by them', () => {
  beforeEach(() => setVocabularyForTests(FIXTURE_SKILLS));
  afterEach(() => resetVocabularyForTests());

  /** A posting as enrichment v3 writes it: every skill with the id of its canonical skill. */
  const posting = (detail: Array<{ skill: string; skillId: string | null; required?: boolean; kind?: string }>, more: Parameters<typeof matchJob>[0] = {}) =>
    matchJob({
      skills: detail.map((d) => d.skill.toLowerCase()),
      skillsDetail: detail.map((d) => ({ skill: d.skill, kind: d.kind ?? 'hard', required: d.required === true, skillId: d.skillId })),
      skillIds: [...new Set(detail.map((d) => d.skillId).filter((id): id is string => !!id))],
      ...more,
    });
  const check = (user: ReturnType<typeof matchUser>, job: ReturnType<typeof matchJob>, skill: string) => {
    const s = jobSkillList(job).find((x) => x.skill === skill)!;
    return jobSkillCheck(user, s, { locale: 'en' });
  };

  it('the three states and what each counts: shown the whole weight, related half, not shown nothing', () => {
    const job = posting([
      { skill: 'TypeScript', skillId: 'typescript', required: true },
      { skill: 'Relational databases', skillId: 'relational_databases', required: true },
      { skill: 'Kubernetes', skillId: 'kubernetes', required: true },
    ]);
    const user = matchUser({ skills: ['TypeScript', 'PostgreSQL'] });
    expect(check(user, job, 'TypeScript')).toEqual({ state: 'shown', via: null, credit: 1 });
    expect(check(user, job, 'Relational databases')).toEqual({ state: 'related', via: 'PostgreSQL', credit: 0.5 });
    expect(check(user, job, 'Kubernetes')).toEqual({ state: 'not_shown', via: null, credit: 0 });
    // (1 + 0.5 + 0) / 3.
    expect(skillsDimension(user, job, W).score).toBe(50);
  });

  it('ACCEPT: "relational databases" (required) with PostgreSQL on the resume is related: half, neither missing nor fully shown', () => {
    const job = posting([{ skill: 'relational databases', skillId: 'relational_databases', required: true }]);
    const user = matchUser({ skills: ['PostgreSQL'] });
    expect(skillsDimension(user, job, W).score).toBe(50);
    const split = splitSkills(user, job);
    expect(split.aligned).toEqual(['Relational databases']);
    expect(split.related).toEqual(['Relational databases']);
    expect(split.missing).toEqual([]);
    expect(skillsDimension(user, job, W).evidence).toEqual([{ text: 'Relational databases', source: 'resume', ref: 'skill_related' }]);
    // The same posting against someone who lists the term itself, and someone who shows neither.
    expect(skillsDimension(matchUser({ skills: ['Relational databases'] }), job, W).score).toBe(100);
    expect(skillsDimension(matchUser({ skills: ['Figma'] }), job, W).score).toBe(0);
    // Two steps down the chain is still related (postgresql → sql → relational_databases); a sibling says nothing.
    expect(check(matchUser({ skills: ['MySQL'] }), posting([{ skill: 'PostgreSQL', skillId: 'postgresql' }]), 'PostgreSQL').state).toBe('not_shown');
    // Never the other way round: the broad term on a resume does not show the named technology.
    expect(check(matchUser({ skills: ['Relational databases'] }), posting([{ skill: 'PostgreSQL', skillId: 'postgresql' }]), 'PostgreSQL').state).toBe('not_shown');
  });

  it('ACCEPT: a posting that lists "Postgres" and "PostgreSQL" counts one skill, under the usual spelling', () => {
    const job = posting([
      { skill: 'Postgres', skillId: 'postgresql', required: false },
      { skill: 'PostgreSQL', skillId: 'postgresql', required: true },
      { skill: 'Kubernetes', skillId: 'kubernetes', required: true },
    ]);
    expect(jobSkillList(job).map((s) => [s.skill, s.skillId, s.required])).toEqual([
      ['PostgreSQL', 'postgresql', true],
      ['Kubernetes', 'kubernetes', true],
    ]);
    // One of two required skills shown: 1 / 2, not 1.5 / 2.5.
    expect(skillsDimension(matchUser({ skills: ['Postgres'] }), job, W).score).toBe(50);
    expect(preScore(matchUser({ skills: ['Postgres'] }), job, CFG)).toMatchObject({ topOverlap: 'PostgreSQL', topGap: 'Kubernetes' });
    // "Node.js", "node" and "NodeJS" are one skill too, whichever the resume writes.
    const node = posting([
      { skill: 'node', skillId: 'nodejs' },
      { skill: 'NodeJS', skillId: 'nodejs' },
      { skill: 'Node.js', skillId: 'nodejs' },
    ]);
    expect(jobSkillList(node).map((s) => s.skill)).toEqual(['Node.js']);
    expect(skillsDimension(matchUser({ skills: ['nodejs'] }), node, W).score).toBe(100);
    // An id that was merged into another skill is that skill: the old id resolves through the vocabulary.
    const merged = posting([
      { skill: 'Postgres', skillId: 'postgres' },
      { skill: 'PostgreSQL', skillId: 'postgresql' },
    ]);
    expect(jobSkillList(merged).map((s) => [s.skill, s.skillId])).toEqual([['PostgreSQL', 'postgresql']]);
  });

  it('ACCEPT: the row enrichment v3 writes (one entry per skill, every spelling in `skills`) counts "postgres" and "PostgreSQL" as one skill', () => {
    // Exactly what reconcile stores for a posting that says "postgres", "PostgreSQL" and "communication":
    // one skillsDetail entry per canonical id, and RAJob.skills keeps every spelling for search.
    const job = matchJob({
      skills: ['postgres', 'postgresql', 'communication'],
      skillsDetail: [
        { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias' },
        { skill: 'communication', kind: 'soft', required: true, skillId: 'communication', via: 'alias' },
      ],
      skillIds: ['postgresql'],
    });
    expect(jobSkillList(job)).toEqual([
      { skill: 'PostgreSQL', skillId: 'postgresql', required: true, kind: 'hard', term: 'postgresql', also: ['postgres'] },
      { skill: 'Communication', skillId: 'communication', required: true, kind: 'soft', term: 'communication' },
    ]);
    // The second spelling is not a second, id-less skill: one hard skill is listed and the person shows it.
    expect(hardSkillList(job)).toHaveLength(1);
    const user = matchUser({ skills: ['PostgreSQL'], resumeTextNorm: null });
    expect(skillsDimension(user, job, W)).toMatchObject({ score: 100, evidence: [{ text: 'PostgreSQL', source: 'resume', ref: 'skill_have' }] });
    expect(splitSkills(user, job)).toEqual({ aligned: ['PostgreSQL'], related: [], missing: [], missingRequired: [], softSkills: ['Communication'], unchecked: [] });
    expect(skillsDimension(matchUser({ skills: [], resumeTextNorm: null }), job, W).score).toBe(0);

    // Three skills, each under two spellings, the model's string first or second: three entries, and the soft one stays soft.
    const wide = matchJob({
      skills: ['postgres', 'PostgreSQL', 'k8s', 'Kubernetes', 'communication skills', 'Communication'],
      skillsDetail: [
        { skill: 'PostgreSQL', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias' },
        { skill: 'Kubernetes', kind: 'hard', required: true, skillId: 'kubernetes', via: 'alias' },
        { skill: 'Communication', kind: 'soft', required: false, skillId: 'communication', via: 'alias' },
      ],
      skillIds: ['postgresql', 'kubernetes'],
    });
    expect(jobSkillList(wide).map((s) => [s.skill, s.kind, s.also ?? []])).toEqual([
      ['PostgreSQL', 'hard', ['postgres']],
      ['Kubernetes', 'hard', ['k8s']],
      ['Communication', 'soft', ['communication skills']],
    ]);
    const both = matchUser({ skills: ['PostgreSQL', 'Kubernetes'], resumeTextNorm: null });
    expect(skillsDimension(both, wide, W).score).toBe(100);
    expect(splitSkills(both, wide)).toMatchObject({ aligned: ['PostgreSQL', 'Kubernetes'], missing: [], softSkills: ['Communication'], unchecked: [] });
    expect(preScore(both, wide, CFG).topGap).toBeNull();
  });

  it('a row that carries ids: `skillsDetail` is the list; a string of `skills` is a spelling of an entry or nothing', () => {
    const job = matchJob({
      // "pg database" reached PostgreSQL by a route this vocabulary does not know; "container platform" was a guess.
      skills: ['postgresql', 'pg database', 'container platform', 'k8s', 'wound care'],
      skillsDetail: [
        { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias' },
        { skill: 'container platform', kind: 'hard', required: true, skillId: 'kubernetes', via: 'embedding' },
        // A string enrichment could not map has an entry of its own, without an id.
        { skill: 'wound care', kind: 'hard', required: false, skillId: null, via: 'none' },
      ],
      skillIds: ['postgresql', 'kubernetes'],
    });
    expect(jobSkillList(job).map((s) => [s.skill, s.skillId, s.guessed ?? false, s.also ?? []])).toEqual([
      ['PostgreSQL', 'postgresql', false, []],
      // "k8s" is a name the vocabulary knows for the guessed skill: it is no longer a guess, and it is labelled.
      ['Kubernetes', 'kubernetes', false, ['k8s']],
      ['Wound care', null, false, []],
    ]);
    // Without that second spelling the guess stays a guess, in the posting's own words.
    const guessOnly = { ...job, skills: ['postgresql', 'container platform', 'wound care'] };
    expect(jobSkillList(guessOnly).map((s) => [s.skill, s.guessed ?? false])).toEqual([
      ['PostgreSQL', false],
      ['Container platform', true],
      ['Wound care', false],
    ]);
    // A posting whose detail carries no id is read as before: every string of `skills` is a skill.
    const legacy = matchJob({ skills: ['postgres', 'postgresql'], skillsDetail: [{ skill: 'postgresql', kind: 'hard', required: true }] });
    expect(jobSkillList(legacy).map((s) => [s.skill, s.skillId])).toEqual([
      ['PostgreSQL', null],
      ['Postgres', null],
    ]);
  });

  it('ACCEPT: an unreviewed skill changes no score, and nothing calls it missing', () => {
    const base = posting([
      { skill: 'TypeScript', skillId: 'typescript', required: true },
      { skill: 'Kubernetes', skillId: 'kubernetes', required: true },
    ]);
    const withUnreviewed = posting([
      { skill: 'TypeScript', skillId: 'typescript', required: true },
      { skill: 'Vertex AI', skillId: 'vertex_ai', required: true },
      { skill: 'Kubernetes', skillId: 'kubernetes', required: true },
      // An id the vocabulary does not hold at all.
      { skill: 'Quantum widgets', skillId: 'quantum_widgets', required: true },
    ]);
    for (const skills of [['TypeScript'], ['TypeScript', 'Vertex AI'], ['Kubernetes', 'Quantum widgets'], []]) {
      const user = matchUser({ skills, resumeTextNorm: null });
      expect(skillsDimension(user, withUnreviewed, W).score, skills.join(',')).toBe(skillsDimension(user, base, W).score);
      expect(preScore(user, withUnreviewed, CFG).score, skills.join(',')).toBe(preScore(user, base, CFG).score);
    }
    const split = splitSkills(matchUser({ skills: ['TypeScript', 'Vertex AI'] }), withUnreviewed);
    // The one the resume names is shown as such; the others are neither aligned nor missing.
    expect(split.aligned).toEqual(['TypeScript', 'Vertex AI']);
    expect(split.missing).toEqual(['Kubernetes']);
    expect(split.unchecked).toEqual(['Quantum widgets']);
    // The gap on a card is never a skill nobody has reviewed.
    expect(preScore(matchUser({ skills: [] }), withUnreviewed, CFG).topGap).toBe('TypeScript');
    expect(preScore(matchUser({ skills: ['TypeScript', 'Kubernetes'] }), withUnreviewed, CFG).topGap).toBeNull();
  });

  it('a string enrichment could not map (no id) is still compared by the string rule, next to skills that carry ids', () => {
    // Enrichment maps by exact name until label vectors exist: a posting outside the vocabulary keeps most of its
    // skills as strings. They must stay in the number, or one mapped skill would decide the whole part.
    const job = posting([
      { skill: 'Excel', skillId: 'excel', required: true },
      { skill: 'Patient assessment', skillId: null, required: true },
      { skill: 'Wound care', skillId: null, required: true },
      { skill: 'IV therapy', skillId: null, required: false },
    ]);
    expect(carriesSkillIds(job)).toBe(true);
    const nurse = matchUser({ skills: ['Patient assessment', 'Wound care'], resumeTextNorm: null });
    // 0 (Excel) + 1 + 1 + 0 of 1 + 1 + 1 + 0.5.
    expect(skillsDimension(nurse, job, W).score).toBe(Math.round(200 / 3.5));
    expect(splitSkills(nurse, job)).toMatchObject({ aligned: ['Patient assessment', 'Wound care'], missing: ['Excel', 'IV therapy'], unchecked: [] });
    expect(check(nurse, job, 'Wound care')).toEqual({ state: 'shown', via: null, credit: 1 });
    expect(check(nurse, job, 'IV therapy')).toEqual({ state: 'not_shown', via: null, credit: 0 });
    // The same strings in a posting that carries no ids at all count exactly the same.
    const legacy = matchJob({ skills: ['excel', 'patient assessment', 'wound care', 'iv therapy'], skillsDetail: job.skillsDetail!.map(({ skill, kind, required }) => ({ skill, kind, required })) });
    expect(skillsDimension(nurse, legacy, W).score).toBe(skillsDimension(nurse, job, W).score);
  });

  it('an id that is only a machine guess (the nearest vector) is shown and never compared: no score moves, nothing is called missing', () => {
    const base = posting([{ skill: 'TypeScript', skillId: 'typescript', required: true }]);
    const guessed = matchJob({
      skills: ['typescript', 'container platform'],
      skillsDetail: [
        { skill: 'TypeScript', kind: 'hard', required: true, skillId: 'typescript', via: 'alias' },
        // Enrichment found Kubernetes as the nearest skill of "container platform": a guess, not a name.
        { skill: 'Container platform', kind: 'hard', required: true, skillId: 'kubernetes', via: 'embedding' },
      ],
      skillIds: ['typescript', 'kubernetes'],
    });
    // The guess keeps the posting's own words: it is not labelled as the skill it was guessed to be.
    expect(jobSkillList(guessed).map((s) => [s.skill, s.skillId, s.guessed ?? false])).toEqual([
      ['TypeScript', 'typescript', false],
      ['Container platform', 'kubernetes', true],
    ]);
    for (const skills of [['TypeScript'], ['TypeScript', 'Kubernetes'], []]) {
      const user = matchUser({ skills, resumeTextNorm: null });
      expect(skillsDimension(user, guessed, W).score, skills.join(',')).toBe(skillsDimension(user, base, W).score);
    }
    const split = splitSkills(matchUser({ skills: ['TypeScript'], resumeTextNorm: null }), guessed);
    expect(split.missing).toEqual([]);
    expect(split.unchecked).toEqual(['Container platform']);
    // The same skill also listed under a name the vocabulary knows is compared as usual.
    const named = matchJob({
      skills: ['container platform', 'k8s'],
      skillsDetail: [
        { skill: 'Container platform', kind: 'hard', required: true, skillId: 'kubernetes', via: 'embedding' },
        { skill: 'K8s', kind: 'hard', required: false, skillId: 'kubernetes', via: 'alias' },
      ],
      skillIds: ['kubernetes'],
    });
    expect(jobSkillList(named).map((s) => [s.skill, s.required, s.guessed ?? false])).toEqual([['Kubernetes', true, false]]);
    expect(splitSkills(matchUser({ skills: [], resumeTextNorm: null }), named).missing).toEqual(['Kubernetes']);
  });

  it('a posting whose skills are all waiting for review states skills, and its skills part is not compared', () => {
    const job = posting([
      { skill: 'Vertex AI', skillId: 'vertex_ai', required: true },
      { skill: 'Quantum widgets', skillId: 'quantum_widgets', required: false },
    ]);
    const user = matchUser({ skills: ['Vertex AI'] });
    expect(skillsDimension(user, job, W)).toMatchObject({ status: 'not_stated', score: null });
    // It lists skills (the card shows them), so the reason is never "this post lists no skills".
    expect(hardSkillList(job).map((s) => s.skill)).toEqual(['Vertex AI', 'Quantum widgets']);
    expect(postingStates(job).skills).toBe(true);
    expect(preScore(user, job, CFG).confidenceReason).not.toBe('no_skills_listed');
    // The skills part counts at its prior, like any part that cannot be compared.
    const noSkills = preScore(user, matchJob({ skills: [], skillsDetail: null }), CFG);
    expect(preScore(user, job, CFG).score).toBe(noSkills.score);
  });

  it('soft skills are never counted: the vocabulary says what is soft, whatever the posting marked', () => {
    const job = posting([
      { skill: 'TypeScript', skillId: 'typescript', required: true },
      // Marked hard by the model, soft in the vocabulary: the vocabulary wins.
      { skill: 'communication skills', skillId: 'communication', required: true, kind: 'hard' },
    ]);
    expect(jobSkillList(job).map((s) => [s.skill, s.kind])).toEqual([
      ['TypeScript', 'hard'],
      ['Communication', 'soft'],
    ]);
    expect(skillsDimension(matchUser({ skills: ['TypeScript'] }), job, W).score).toBe(100);
    expect(splitSkills(matchUser({ skills: [] }), job)).toMatchObject({ missing: ['TypeScript'], softSkills: ['Communication'] });
  });

  it('a certificate is compared like a hard skill; one whose only trace is an ambiguous abbreviation is neither claimed nor denied', () => {
    const job = posting([
      { skill: 'CPA', skillId: 'cpa', required: true },
      { skill: 'Excel', skillId: 'excel', required: true },
    ]);
    const listed = matchUser({ skills: ['CPA', 'Excel'] });
    expect(skillsDimension(listed, job, W).score).toBe(100);
    // The licence written out is found in the text; so is its Chinese name.
    expect(check(matchUser({ skills: [], resumeTextNorm: normalizeText('Certified Public Accountant since 2019.') }), job, 'CPA').state).toBe('shown');
    expect(check(matchUser({ skills: [], resumeTextNorm: normalizeText('持有注册会计师证书。') }), job, 'CPA').state).toBe('shown');
    // "CPA" in a marketing sentence is cost per acquisition as often as the licence: not counted either way.
    const marketer = matchUser({ skills: ['Excel'], resumeTextNorm: normalizeText('Cut CPA by 20% across paid social.') });
    expect(check(marketer, job, 'CPA')).toEqual({ state: 'unscored', via: null, credit: null });
    expect(skillsDimension(marketer, job, W).score).toBe(100);
    // Withheld is withheld everywhere: the card does not claim what the check declined to ("What lines up: CPA").
    expect(splitSkills(marketer, job)).toMatchObject({ aligned: ['Excel'], missing: [], unchecked: ['CPA'] });
    expect(preScore(marketer, job, CFG)).toMatchObject({ topOverlap: 'Excel', topGap: null });
    const onlyCpa = posting([{ skill: 'CPA', skillId: 'cpa', required: true }]);
    expect(splitSkills(marketer, onlyCpa)).toMatchObject({ aligned: [], missing: [], unchecked: ['CPA'] });
    expect(preScore(marketer, onlyCpa, CFG).topOverlap).toBeNull();
    expect(skillsDimension(marketer, onlyCpa, W)).toMatchObject({ status: 'not_stated', score: null, evidence: [] });
    // No trace at all is a plain not shown.
    expect(check(matchUser({ skills: ['Excel'], resumeTextNorm: normalizeText('Managed the quarterly close.') }), job, 'CPA').state).toBe('not_shown');
  });

  it('a name that is also an ordinary word: shown when the resume writes it, never proof of a broader skill from a sentence', () => {
    const job = posting([
      { skill: 'Go', skillId: 'go', required: true },
      { skill: 'React', skillId: 'react', required: true },
      { skill: 'Frontend frameworks', skillId: 'frontend_frameworks', required: true },
    ]);
    const prose = matchUser({ skills: [], resumeTextNorm: normalizeText('Wrote services in Go. I react quickly to incidents.') });
    // The question "does the resume say Go?" reads the sentence, as the string rule always did.
    expect(check(prose, job, 'Go').state).toBe('shown');
    expect(check(prose, job, 'React').state).toBe('shown');
    // The person's own skills do not include a word taken from a sentence, so it shows nothing broader.
    expect([...userSkillIdSet(prose)]).toEqual([]);
    expect(check(prose, job, 'Frontend frameworks').state).toBe('not_shown');
    // Listed as a skill, React shows the broader term.
    expect(check(matchUser({ skills: ['React'] }), job, 'Frontend frameworks')).toEqual({ state: 'related', via: 'React', credit: 0.5 });
    // "Google" is not Go, and "net revenue" is not .NET.
    expect(check(matchUser({ skills: [], resumeTextNorm: normalizeText('Worked at Google on ads.') }), job, 'Go').state).toBe('not_shown');
  });

  it('an abbreviation with another reading in a sentence proves nothing: neither claimed nor denied, unless the posting writes the skill that way', () => {
    setVocabularyForTests([...FIXTURE_SKILLS, skillRecord('photoshop', 'Photoshop', { aliases: ['adobe photoshop', 'ps'] }), skillRecord('pytorch', 'PyTorch', { parentId: 'machine_learning' })]);
    const job = posting([
      { skill: 'Machine learning', skillId: 'machine_learning', required: true },
      { skill: 'Photoshop', skillId: 'photoshop', required: true },
      { skill: 'Node.js', skillId: 'nodejs', required: true },
      { skill: 'TypeScript', skillId: 'typescript', required: true },
      { skill: 'Excel', skillId: 'excel', required: true },
      { skill: 'Go', skillId: 'go', required: true },
    ]);
    const resume = normalizeText('Administered 500 ml of saline per shift.\nPS: available at once.\nLooked after a 5-node cluster of beds.\nKept the ward rota in Excel.');
    const nurse = matchUser({ skills: [], resumeTextNorm: resume, recentTitle: 'Registered Nurse' });
    for (const skill of ['Machine learning', 'Photoshop', 'Node.js']) expect(check(nurse, job, skill), skill).toEqual({ state: 'unscored', via: null, credit: null });
    // A full word that is also an ordinary one is still read from a sentence, as the string rule always did.
    expect(check(nurse, job, 'Excel')).toEqual({ state: 'shown', via: null, credit: 1 });
    expect(check(nurse, job, 'TypeScript').state).toBe('not_shown');
    // Counted: Excel of Excel, TypeScript and Go. The three abbreviations are in neither sum.
    expect(skillsDimension(nurse, job, W).score).toBe(33);
    expect(splitSkills(nurse, job)).toMatchObject({ aligned: ['Excel'], missing: ['TypeScript', 'Go'], unchecked: ['Machine learning', 'Photoshop', 'Node.js'] });
    // The string rule on the same strings never met "Machine learning" by "ml" either: Excel of all six.
    const legacy = matchJob({ skills: ['machine learning', 'photoshop', 'node.js', 'typescript', 'excel', 'go'], skillsDetail: job.skillsDetail!.map(({ skill, kind, required }) => ({ skill, kind, required })) });
    expect(skillsDimension(nurse, legacy, W).score).toBe(17);
    expect(splitSkills(nurse, legacy)).toMatchObject({ aligned: ['Excel'], unchecked: [] });

    // Listed as a skill, or written out, the skill is shown.
    expect(check(matchUser({ skills: ['ML'], resumeTextNorm: resume }), job, 'Machine learning').state).toBe('shown');
    expect(check(matchUser({ skills: [], resumeTextNorm: normalizeText('Three years of machine learning on tabular data.') }), job, 'Machine learning').state).toBe('shown');
    // A more specific skill the person lists is real evidence, whatever else the text holds.
    expect(check(matchUser({ skills: ['PyTorch'], resumeTextNorm: resume }), job, 'Machine learning')).toEqual({ state: 'related', via: 'PyTorch', credit: 0.5 });
    // The posting itself writes the abbreviation: what the string rule always counted still counts.
    const engineer = matchUser({ skills: [], resumeTextNorm: normalizeText('Shipped ML models to production.') });
    expect(check(engineer, posting([{ skill: 'ML', skillId: 'machine_learning', required: true }]), 'Machine learning').state).toBe('shown');
    expect(check(engineer, job, 'Machine learning').state).toBe('unscored');
    // The second spelling `skills` keeps counts as the posting's own too.
    const both = matchJob({ skills: ['machine learning', 'ml'], skillsDetail: [{ skill: 'machine learning', kind: 'hard', required: true, skillId: 'machine_learning', via: 'alias' }], skillIds: ['machine_learning'] });
    expect(check(engineer, both, 'Machine learning').state).toBe('shown');

    // What is an abbreviation with another reading, and what is a word.
    for (const name of ['ML', 'ps', 'node', 'TS', 'AI', 'CPA', 'NLP']) expect(isAmbiguousAbbreviation(name), name).toBe(true);
    for (const name of ['Go', 'React', 'Excel', 'SAP', 'SQL', 'AWS', 'Machine learning', 'Node.js', 'C#', '机器学习']) expect(isAmbiguousAbbreviation(name), name).toBe(false);
    // One sentence at a time (what the keyword check may quote).
    const vocabulary = currentVocabulary();
    expect(textShowsSkill(vocabulary, 'machine_learning', 'Administered 500 ml of saline per shift.', ['Machine learning'])).toBe(false);
    expect(textShowsSkill(vocabulary, 'machine_learning', 'Shipped ML models to production.', ['ML'])).toBe(true);
    expect(textShowsSkill(vocabulary, 'machine_learning', 'Three years of machine learning.', ['Machine learning'])).toBe(true);
    expect(textShowsSkill(vocabulary, 'go', 'Wrote services in Go.', ['Golang'])).toBe(true);
    expect(textShowsSkill(vocabulary, 'cpa', 'Cut CPA by 20% across paid social.', ['CPA'])).toBe(false);
  });

  it('the person\'s canonical skills: listed skills and reviewed skills the resume text names; computed once per person', () => {
    const user = matchUser({ skills: ['Postgres', 'k8s', 'Vertex AI'], resumeTextNorm: normalizeText('Trained models; 熟悉机器学习。') });
    const ids = userSkillIdSet(user);
    expect([...ids].sort()).toEqual(['kubernetes', 'machine_learning', 'postgresql', 'vertex_ai']);
    expect(userSkillIdSet(user)).toBe(ids);
    // Another vocabulary is another answer for the same person.
    setVocabularyForTests([skillRecord('postgresql', 'PostgreSQL', { aliases: ['postgres'] })]);
    expect([...userSkillIdSet(user)]).toEqual(['postgresql']);
  });

  it('labels follow the reader: the request language, else the posting\'s; Taiwan never gets a Simplified label', () => {
    const job = posting([
      { skill: 'machine learning', skillId: 'machine_learning', required: true },
      { skill: 'cpa', skillId: 'cpa', required: true },
      { skill: 'postgres', skillId: 'postgresql', required: true },
    ]);
    expect(jobSkillList(job, 'en').map((s) => s.skill)).toEqual(['Machine learning', 'CPA', 'PostgreSQL']);
    expect(jobSkillList(job, 'zh').map((s) => s.skill)).toEqual(['机器学习', '注册会计师', 'PostgreSQL']);
    // CPA has no Traditional label: Taiwan reads the English one, never 注册会计师.
    expect(jobSkillList(job, 'zh-TW').map((s) => s.skill)).toEqual(['機器學習', 'CPA', 'PostgreSQL']);
    expect(jobSkillList(job, 'zh-HK').map((s) => s.skill)).toEqual(['機器學習', 'CPA', 'PostgreSQL']);
    // With no request language: the posting's own, else the market's.
    expect(labelLocaleFor(matchJob({ lang: 'zh-TW' }))).toBe('zh-TW');
    expect(labelLocaleFor(matchJob({ market: 'cn' }))).toBe('zh');
    expect(labelLocaleFor(matchJob())).toBe('en');
    expect(labelLocaleFor(matchJob({ market: 'cn', lang: 'en' }), { locale: 'zh-TW' })).toBe('zh-TW');
    expect(jobSkillList({ ...job, lang: 'zh-TW' }).map((s) => s.skill)).toEqual(['機器學習', 'CPA', 'PostgreSQL']);
    expect(jobSkillList({ ...job, market: 'cn' }).map((s) => s.skill)).toEqual(['机器学习', '注册会计师', 'PostgreSQL']);
    // RAJob.lang as the column holds it: 'en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'other'.
    expect(jobSkillList({ ...job, lang: 'zh-Hans' }).map((s) => s.skill)).toEqual(['机器学习', '注册会计师', 'PostgreSQL']);
    expect(jobSkillList({ ...job, lang: 'zh-Hant' }).map((s) => s.skill)).toEqual(['機器學習', 'CPA', 'PostgreSQL']);
    expect(jobSkillList({ ...job, market: 'cn', lang: 'en' }).map((s) => s.skill)).toEqual(['Machine learning', 'CPA', 'PostgreSQL']);
    // 'other' (a short or mixed text), 'ja' and 'ko' name no language a label exists in: the market decides.
    for (const lang of ['other', 'ja', 'ko', 'fr', '']) {
      expect(labelLocaleFor(matchJob({ market: 'cn', lang })), lang).toBe('zh');
      expect(labelLocaleFor(matchJob({ market: 'intl', lang })), lang).toBe('en');
    }
    expect(jobSkillList({ ...job, market: 'cn', lang: 'other' }).map((s) => s.skill)).toEqual(['机器学习', '注册会计师', 'PostgreSQL']);
    // The card's overlap and gap carry the same label, once.
    const tw = preScore(matchUser({ skills: ['機器學習'], locale: 'zh-TW' }), job, CFG);
    expect(tw).toMatchObject({ topOverlap: '機器學習', topGap: 'CPA' });
    // An empty label means "show the posting's own string": an unreviewed skill written in Simplified, read in Taiwan.
    setVocabularyForTests([...FIXTURE_SKILLS, skillRecord('飞书', '飞书', { labelZh: '飞书', status: 'unreviewed' }), skillRecord('data_lake', 'Data lake', { labelZh: '数据湖' })]);
    const own = posting([
      { skill: '数据湖', skillId: 'data_lake' },
      { skill: '飞书', skillId: '飞书' },
    ]);
    expect(jobSkillList(own, 'zh-TW').map((s) => s.skill)).toEqual(['Data lake', '飞书']);
  });

  it('ACCEPT: a posting with empty skillIds is compared by its strings: the estimate MKT-1F computed, under any vocabulary', () => {
    // The same strings, once without ids and once with: only the second reads the vocabulary.
    const strings = ['relational databases', 'postgres', 'postgresql', 'kubernetes'];
    const legacy = matchJob({ skills: strings, skillsDetail: strings.map((skill) => ({ skill, kind: 'hard', required: true })) });
    const user = matchUser({ skills: ['PostgreSQL'], resumeTextNorm: null });
    expect(carriesSkillIds(legacy)).toBe(false);
    expect(jobSkillList(legacy).map((s) => [s.skill, s.skillId])).toEqual([
      ['Relational databases', null],
      ['Postgres', null],
      ['PostgreSQL', null],
      ['Kubernetes', null],
    ]);
    // The string rule: "relational databases" is shown by PostgreSQL (whole weight), "postgres" is another string.
    expect(skillsDimension(user, legacy, W).score).toBe(50);
    // With ids: one PostgreSQL (shown), relational databases related (half), Kubernetes not shown: 1.5 / 3.
    const enriched = matchJob({
      skills: strings,
      skillsDetail: [
        { skill: 'relational databases', kind: 'hard', required: true, skillId: 'relational_databases' },
        { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql' },
        { skill: 'kubernetes', kind: 'hard', required: true, skillId: 'kubernetes' },
      ],
      skillIds: ['relational_databases', 'postgresql', 'kubernetes'],
    });
    expect(carriesSkillIds(enriched)).toBe(true);
    expect(skillsDimension(user, enriched, W).score).toBe(50);
    expect(jobSkillList(enriched)).toHaveLength(3);
    // The vocabulary does not move a posting without ids: any vocabulary, the same estimate, number and words.
    const whole = (r: ReturnType<typeof preScore>) => ({ score: r.score, tier: r.tier, coverage: r.coverage, confidence: r.confidence, limit: r.limit, dimensions: r.dimensions, topOverlap: r.topOverlap, topGap: r.topGap, softSkills: r.softSkills });
    const before = whole(preScore(user, legacy, CFG));
    expect(before.dimensions.find((d) => d.key === 'skills')).toMatchObject({ score: 50, status: 'scored' });
    // What the string rule says: "Postgres" is another string than PostgreSQL, and the card says what the number counted.
    expect(before).toMatchObject({ topOverlap: 'Relational databases', topGap: 'Postgres' });
    const split = splitSkills(user, legacy);
    setVocabularyForTests([]);
    expect(whole(preScore(user, legacy, CFG))).toEqual(before);
    expect(splitSkills(user, legacy)).toEqual(split);
    resetVocabularyForTests();
    expect(whole(preScore(user, legacy, CFG))).toEqual(before);
    expect(splitSkills(user, legacy)).toEqual(split);
  });

  it('a skill without an id: one answer for the number, its evidence and the card; the keyword check and a bare term also read the vocabulary', () => {
    // The resume says 机器学习; the posting, not yet re-enriched, says "machine learning".
    const job = matchJob({ skills: ['machine learning', 'kubernetes'], skillsDetail: null });
    const user = matchUser({ skills: ['机器学习'], resumeTextNorm: null });
    // Counted as before: neither string is on the resume. The card says what the number counted.
    expect(skillsDimension(user, job, W)).toMatchObject({ score: 0, evidence: [{ text: 'Machine learning', source: 'posting', ref: 'skill_missing' }] });
    expect(splitSkills(user, job)).toMatchObject({ aligned: [], missing: ['Machine learning', 'Kubernetes'], unchecked: [] });
    expect(preScore(user, job, CFG)).toMatchObject({ topOverlap: null, topGap: 'Machine learning' });
    for (const s of jobSkillList(job)) expect(jobSkillCheck(user, s, { locale: 'en' })).toEqual({ state: 'not_shown', via: null, credit: 0 });

    // A posting that asks for "k8s" and "ReactJS" of a person who lists Kubernetes and React: 0 / 100 and no line that
    // says the resume mentions them. (Re-enriched, the same posting carries ids and scores 100.)
    const short = matchJob({ skills: ['k8s', 'ReactJS'], skillsDetail: [{ skill: 'k8s', kind: 'hard', required: true }, { skill: 'ReactJS', kind: 'hard', required: true }] });
    const listed = matchUser({ skills: ['Kubernetes', 'React'], resumeTextNorm: null });
    const part = skillsDimension(listed, short, W);
    expect(part.score).toBe(0);
    expect(part.evidence.map((e) => e.ref)).toEqual(['skill_missing']);
    expect(splitSkills(listed, short)).toMatchObject({ aligned: [], missing: ['K8s', 'ReactJS'] });
    expect(preScore(listed, short, CFG)).toMatchObject({ topOverlap: null, topGap: 'K8s' });
    const enriched = matchJob({
      skills: ['k8s', 'reactjs'],
      skillsDetail: [
        { skill: 'k8s', kind: 'hard', required: true, skillId: 'kubernetes', via: 'alias' },
        { skill: 'reactjs', kind: 'hard', required: true, skillId: 'react', via: 'alias' },
      ],
      skillIds: ['kubernetes', 'react'],
    });
    expect(skillsDimension(listed, enriched, W).score).toBe(100);
    expect(splitSkills(listed, enriched)).toMatchObject({ aligned: ['Kubernetes', 'React'], missing: [] });

    // The keyword check may say more than the string rule: it must not tell a person they lack what they list under
    // another name. So may a bare term (a term the model picked, a skill of the competitiveness report).
    const row = buildKeywordRows({ job: { ...short, minYears: null }, user: listed, resumeText: '', keywords: null }).find((r) => r.key === 'skills')!;
    expect(row.items.map((i) => [i.term, i.state])).toEqual([
      ['Kubernetes', 'shown'],
      ['React', 'shown'],
    ]);
    expect(listedSkillCheck(user, 'machine learning', 'machine_learning')).toEqual({ state: 'shown', via: null });
    expect(termCheck(user, 'machine learning')).toEqual({ state: 'shown', via: null });
    expect(userShows(user, 'ML')).toBe(true);
    expect(userShows(user, 'Kubernetes')).toBe(false);
    // A soft skill and a skill nobody has reviewed are never answered by the vocabulary for a bare term.
    expect(termCheck(matchUser({ skills: ['Communication skills'] }), 'communication').state).toBe('not_shown');
    expect(termCheck(matchUser({ skills: ['Vertex AI'] }), 'vertex ai').state).toBe('shown');
    expect(termCheck(matchUser({ skills: [] }), 'vertex ai').state).toBe('not_shown');
    // A trace with another reading: the keyword check says nothing, a yes-or-no caller gets no.
    const nurse = matchUser({ skills: [], resumeTextNorm: normalizeText('Administered 500 ml of saline per shift.') });
    expect(listedSkillCheck(nurse, 'machine learning', 'machine_learning').state).toBe('unscored');
    expect(termCheck(nurse, 'machine learning').state).toBe('not_shown');
    expect(userShows(nurse, 'machine learning')).toBe(false);
  });
});

describe('industry', () => {
  it('shared industry = 100, none shared = 0, unknown on either side = not stated', () => {
    expect(industryDimension(matchUser(), matchJob(), W).score).toBe(100);
    expect(industryDimension(matchUser({ employerIndustries: ['Retail'] }), matchJob(), W).score).toBe(0);
    expect(industryDimension(matchUser({ employerIndustries: [] }), matchJob(), W).status).toBe('not_stated');
    expect(industryDimension(matchUser(), matchJob({ companyIndustries: [] }), W).status).toBe('not_stated');
  });
});

describe('logistics (deterministic, never a constant)', () => {
  it.each([
    ['inside the radius', {}, {}, 'met'],
    ['outside the radius', {}, { geoLat: 48.137, geoLng: 11.575, locationCity: 'Munich', location: 'Munich, DE' }, 'not_met'],
    ['same city by name', { locations: [{ label: 'Berlin', city: 'Berlin', country: 'DE', radiusKm: 0 }] }, {}, 'met'],
    ['country only', { locations: [{ label: 'Germany', country: 'DE', radiusKm: 0 }] }, { locationCity: 'Hamburg' }, 'met'],
    ['remote-only user, onsite job', { workModels: ['remote'] }, {}, 'not_met'],
    ['remote job, remote user', { workModels: ['remote'] }, { workModel: 'remote', remoteScope: 'global' }, 'met'],
    ['remote job scoped to another country', { workModels: ['remote'] }, { workModel: 'remote', remoteScope: 'US' }, 'not_met'],
    ['onsite-only user, remote job', { workModels: ['onsite'] }, { workModel: 'remote' }, 'not_met'],
    ['no preferences', { locations: [], workModels: [], country: null }, {}, 'not_stated'],
    ['job location unknown', {}, { locationCity: null, locationCountry: null, geoLat: null, geoLng: null, location: null }, 'not_stated'],
  ])('location: %s', (_name, user, job, expected) => {
    expect(locationCheck(matchUser(user as never), matchJob(job as never))).toBe(expected);
  });

  it.each([
    ['annual max ≥ min', {}, {}, 'met'],
    ['annual max < min', { salaryMin: { amount: 100000, currency: 'EUR', period: 'year' } }, {}, 'not_met'],
    ['monthly minimum annualized', { salaryMin: { amount: 7000, currency: 'EUR', period: 'month' } }, {}, 'met'],
    ['hourly minimum annualized', { salaryMin: { amount: 50, currency: 'EUR', period: 'hour' } }, {}, 'not_met'],
    ['undisclosed pay', {}, { salaryAnnualMin: null, salaryAnnualMax: null }, 'not_stated'],
    ['other currency', { salaryMin: { amount: 60000, currency: 'USD', period: 'year' } }, {}, 'not_stated'],
    ['no minimum set', { salaryMin: null }, {}, 'not_stated'],
  ])('pay: %s', (_name, user, job, expected) => {
    expect(payCheck(matchUser(user as never), matchJob(job as never))).toBe(expected);
  });

  it('visa: only when the user needs sponsorship; silence is not stated, never inferred', () => {
    const needs = matchUser({ needsSponsorship: true });
    expect(visaCheck(needs, matchJob({ sponsorship: 'offered' }))).toBe('met');
    expect(visaCheck(needs, matchJob({ sponsorship: 'not_offered' }))).toBe('not_met');
    expect(visaCheck(needs, matchJob({ sponsorship: null }))).toBe('not_stated');
    expect(visaCheck(matchUser({ needsSponsorship: false }), matchJob({ sponsorship: 'not_offered' }))).toBeNull();
    expect(visaCheck(needs, matchJob({ market: 'cn', sponsorship: 'not_offered' }))).toBeNull();
  });

  it('visa evidence quotes only the post’s own words, never the sponsorship enum', () => {
    const needs = matchUser({ needsSponsorship: true });
    const noQuote = logisticsDimension(needs, matchJob({ sponsorship: 'offered', sponsorshipEvidence: null }), W);
    expect(noQuote.evidence).toContainEqual({ text: '', source: 'posting', ref: 'visa_offered' });
    const quoted = logisticsDimension(needs, matchJob({ sponsorship: 'not_offered', sponsorshipEvidence: 'Visa sponsorship is not available.' }), W);
    expect(quoted.evidence).toContainEqual({ text: 'Visa sponsorship is not available.', source: 'posting', ref: 'visa_not_offered' });
  });

  it('TW-09: the per-country work-authorization answer wins over the search-profile toggle', () => {
    const tw = matchJob({ locationCountry: 'TW', locationCity: 'Taipei' });
    expect(needsSponsorshipFor(matchUser({ needsSponsorship: false, workAuth: [{ country: 'TW', authorized: false, sponsorship: 'now' }] }), tw)).toBe(true);
    expect(needsSponsorshipFor(matchUser({ needsSponsorship: true, workAuth: [{ country: 'TW', authorized: true, sponsorship: null }] }), tw)).toBe(false);
    expect(needsSponsorshipFor(matchUser({ needsSponsorship: true, workAuth: [{ country: 'US', authorized: true, sponsorship: 'no' }] }), tw)).toBe(true);
  });

  it('FIX-3: pay evidence is the posting\'s own words when it has them (18-28K·15薪), never our annual arithmetic', () => {
    const cnUser = matchUser({ market: 'cn', country: 'CN', locations: [], salaryMin: { amount: 15000, currency: 'CNY', period: 'month' } });
    const cnJob = matchJob({ market: 'cn', locationCountry: 'CN', locationCity: '上海', salaryCurrency: 'CNY', salaryAnnualMin: 270000, salaryAnnualMax: 420000, payAsPosted: '18-28K·15薪' });
    const pay = logisticsDimension(cnUser, cnJob, W).evidence.find((e) => e.ref === 'pay_met');
    expect(pay).toEqual({ text: '18-28K·15薪', source: 'posting', ref: 'pay_met' });
    // No words from the posting: the compared figures, as before.
    const bare = logisticsDimension(cnUser, { ...cnJob, payAsPosted: null }, W).evidence.find((e) => e.ref === 'pay_met');
    expect(bare?.text).toBe('CNY 270000–420000');
    // GoApply has no visa part at all.
    expect(logisticsDimension(cnUser, cnJob, W).evidence.some((e) => e.ref?.startsWith('visa'))).toBe(false);
    // The record → job mapping drops a label the pasted line carried and words with no amount.
    expect(payAsPosted('薪资：18-28K·15薪')).toBe('18-28K·15薪');
    expect(payAsPosted('Salary: $90,000 - $110,000 a year')).toBe('$90,000 - $110,000 a year');
    expect(payAsPosted('面议')).toBeNull();
    expect(payAsPosted(null)).toBeNull();
    expect(toMatchJob(jobRecord({ salaryText: '薪资:18-28K·15薪' })).payAsPosted).toBe('18-28K·15薪');
  });

  it('averages the stated checks; all not stated → not stated', () => {
    const half = logisticsDimension(matchUser({ salaryMin: { amount: 100000, currency: 'EUR', period: 'year' } }), matchJob(), W);
    expect(half.score).toBe(50);
    expect(half.evidence.map((e) => e.ref)).toEqual(['location_met', 'pay_not_met']);
    const none = logisticsDimension(matchUser({ locations: [], workModels: [], country: null, salaryMin: null }), matchJob(), W);
    expect(none.status).toBe('not_stated');
  });
});

describe('the estimate is about the resume, and only claims what it compared', () => {
  // An 8-year engineer whose latest title states no level.
  const senior = matchUser({ recentTitle: 'Software Engineer', yearsExperience: 8 });

  it.each([
    ['Senior Software Engineer', 2, 'senior'], // the title states it
    ['Software Engineer', 8, 'senior'], // else the years
    ['Software Engineer', 4, 'mid'],
    ['Software Engineer', 1.5, 'entry'],
    ['Software Engineer', 0, 'intern_newgrad'],
    ['Software Engineering Intern', 0.3, 'intern_newgrad'],
    ['Principal Engineer', 12, 'lead_staff'],
    ['VP of Engineering', 15, 'director_exec'],
    ['Software Engineer', null, null],
    [null, null, null],
  ])('resume level: %s, %s years → %s', (title, years, level) => {
    expect(resumeSeniority(title as string | null, years as number | null)).toBe(level);
  });

  it('a role two or more levels from the resume is at most Possible, however well the rest lines up (a senior resume against an internship)', () => {
    // Everything else is perfect: same role, every skill, same industry, location and pay met.
    const perfect = { skills: ['typescript', 'go'], skillsDetail: null };
    for (const seniority of ['intern_newgrad', 'entry']) {
      const r = preScore(senior, matchJob({ ...perfect, seniority }), CFG);
      expect(r.score, seniority).toBeLessThan(CFG.tiers.good);
      expect(r.tier === 'great' || r.tier === 'good', seniority).toBe(false);
    }
    // One level away or the same level is not limited.
    expect(preScore(senior, matchJob({ ...perfect, seniority: 'senior' }), CFG).tier).toBe('great');
    expect(preScore(senior, matchJob({ ...perfect, seniority: 'mid' }), CFG).score).toBeGreaterThanOrEqual(CFG.tiers.good);
    // An unknown level on either side limits nothing (never inferred).
    expect(levelGap(senior, null)).toBeNull();
    expect(levelGap(matchUser({ recentTitle: null, yearsExperience: null }), 'senior')).toBeNull();
  });

  it('a post with no skills and a role we cannot place gets NO score from location and pay alone', () => {
    const job = matchJob({ title: 'Cleared Zzz', taxonomyIds: [], primaryTaxonomyId: null, skills: [], skillsDetail: null, companyIndustries: [] });
    const r = preScore(senior, job, CFG);
    // The location and pay only repeat the person's own filters: nothing at all is compared.
    expect(r.dimensions.filter((d) => d.status === 'scored').map((d) => d.key)).toEqual([]);
    expect(r).toMatchObject({ score: null, tier: null, topGap: null, topOverlap: null, limit: null, confidence: 'low' });
    // The same when the location and pay are facts (no filter guarantees them): they say nothing about the work.
    const facts = preScore({ ...senior, hardFilters: { location: false, pay: false } }, job, CFG);
    expect(facts.dimensions.filter((d) => d.status === 'scored').map((d) => d.key)).toEqual(['logistics']);
    expect(facts).toMatchObject({ score: null, tier: null, limit: null, confidence: 'low' });
  });

  it('under half of the comparable weight compared → Possible at most; the limit never raises a score', () => {
    // Only the role (35 of 90) could be compared.
    const user = matchUser({ ...senior, employerIndustries: [], ...NO_LOGISTICS });
    const r = preScore(user, matchJob({ skills: [], skillsDetail: null }), CFG);
    expect(r.dimensions.filter((d) => d.status === 'scored').map((d) => d.key)).toEqual(['title_level']);
    expect(r.limit).toBe(CFG.tiers.good - 1);
    // 35 × 100 + priors for the rest: 3500 + 1170 + 360 + 500 + 450 = 59.8.
    expect(r.score).toBe(60);
    expect(r.tier).toBe('possible');
    // A filter-guaranteed logistics part is not evidence: it does not lift the job over the half.
    const guaranteed = preScore(matchUser({ ...senior, employerIndustries: [] }), matchJob({ skills: [], skillsDetail: null }), CFG);
    expect(guaranteed.limit).toBe(CFG.tiers.good - 1);

    const full = preScore(senior, matchJob(), CFG);
    expect(preScoreLimit(full.dimensions, 0, CFG.tiers)).toBe(100);
    expect(full.score).toBe(combineWithPriors(full.dimensions, P));
    const unrelated = preScore(senior, matchJob({ taxonomyIds: ['sales', 'account_executive'], primaryTaxonomyId: 'account_executive', title: 'Account Executive', skills: ['salesforce'] }), CFG);
    expect(unrelated.tier === 'great' || unrelated.tier === 'good').toBe(false);
  });
});

describe('priors, not renormalisation (MARKET_STRATEGY 2.4)', () => {
  // A person whose logistics answers are profile facts, not filters: a met check is real information.
  const noFilters = { ...NO_LOGISTICS, country: 'DE', hardFilters: { location: false, pay: false } };

  it('the worked example: no skills, a perfect title and logistics really met give 64.8, so 65 at most and never Great', () => {
    const user = matchUser({ recentTitle: 'Senior Software Engineer', employerIndustries: [], ...noFilters });
    const job = matchJob({ skills: [], skillsDetail: null, companyIndustries: [] });
    const r = preScore(user, job, CFG);
    expect(r.dimensions.map((d) => [d.key, d.score])).toEqual([
      ['title_level', 100],
      ['skills', null],
      ['industry', null],
      ['logistics', 100],
      ['career_path', null],
    ]);
    // (35 × 100 + 30 × 39 + 15 × 24 + 10 × 100 + 10 × 45) / 100 = 64.8
    expect(combineWithPriors(r.dimensions, P)).toBe(65);
    expect(r.score).toBeLessThanOrEqual(65);
    expect(r.tier).not.toBe('great');
    // Renormalising alone would have said 100.
    expect(combineDimensions(r.dimensions)).toBe(100);
  });

  it('each not-stated component contributes its own prior at its full weight', () => {
    const scored = (key: string, score: number) => ({ key, weight: W[key as keyof typeof W], score, status: 'scored' as const, evidence: [] });
    const missing = (key: string) => ({ key, weight: W[key as keyof typeof W], score: null, status: 'not_stated' as const, evidence: [] });
    const all = ['title_level', 'skills', 'industry', 'logistics', 'career_path'];
    // Nothing stated: the weighted mean of the priors.
    const none = all.map(missing) as never;
    expect(combineWithPriors(none, P)).toBe(Math.round((35 * 44 + 30 * 39 + 15 * 24 + 10 * 50 + 10 * 45) / 100));
    for (const key of all) {
      // Everything else at 100, this one not stated: it counts at its prior, not at 100 and not at 0.
      const dims = all.map((k) => (k === key ? missing(k) : scored(k, 100))) as never;
      const expected = Math.round((100 * (100 - W[key as keyof typeof W]) + P[key as keyof typeof P] * W[key as keyof typeof W]) / 100);
      expect(combineWithPriors(dims, P), key).toBe(expected);
    }
    // Other priors (a market's own): the same arithmetic.
    const custom = { title_level: 10, skills: 20, industry: 30, logistics: 40, career_path: 50 };
    expect(combineWithPriors(none, custom)).toBe(Math.round((35 * 10 + 30 * 20 + 15 * 30 + 10 * 40 + 10 * 50) / 100));
    // `preScore` reads the priors of its config.
    const job = matchJob({ skills: [], skillsDetail: null });
    const low = preScore(matchUser(), job, { ...CFG, priors: { ...P, skills: 0 } }).score!;
    const high = preScore(matchUser(), job, { ...CFG, priors: { ...P, skills: 60 } }).score!;
    expect(high - low).toBe(Math.round((30 * 60) / 100));
  });

  it('a no-skills job is never Great, whatever else it says', () => {
    const everything = matchUser({ recentTitle: 'Senior Backend Engineer', ...noFilters, salaryMin: { amount: 60000, currency: 'EUR', period: 'year' } });
    const r = preScore(everything, matchJob({ skills: [], skillsDetail: null }), CFG);
    // title 100, industry 100, logistics 100: 3500 + 1170 + 1500 + 1000 + 450 = 76.2
    expect(r.score).toBe(76);
    expect(r.tier).toBe('good');
    expect(r.limit).toBe(CFG.tiers.great - 1);
  });

  it('nothing to compare → null, never 0', () => {
    const user = matchUser({ evidenceRoleIds: [], recentTitle: null, skills: [], employerIndustries: [], ...NO_LOGISTICS });
    const r = preScore(user, matchJob({ skills: [], taxonomyIds: [], primaryTaxonomyId: null, title: 'Zzz', companyIndustries: [] }), CFG);
    expect(r.score).toBeNull();
    expect(r.tier).toBeNull();
    expect(r.kind).toBe('pre');
  });

  it('getMatchPriors: defaults, a per-key override, the GoApply override with its fallback, and a malformed value', () => {
    expect(getMatchPriors('roboapply', {})).toEqual({ title_level: 44, skills: 39, industry: 24, logistics: 50, career_path: 45 });
    expect(getMatchPriors('roboapply', { MATCH_PRIORS: '{"skills":30,"logistics":"70"}' })).toEqual({ ...P, skills: 30, logistics: 70 });
    // GoApply reads CN_MATCH_PRIORS when it is set, else the shared value, then the defaults (D5).
    expect(getMatchPriors('goapply', { MATCH_PRIORS: '{"skills":30}', CN_MATCH_PRIORS: '{"skills":55}' }).skills).toBe(55);
    expect(getMatchPriors('goapply', { MATCH_PRIORS: '{"skills":30}' }).skills).toBe(30);
    expect(getMatchPriors('goapply', {})).toEqual(P);
    // RoboApply never reads the CN value.
    expect(getMatchPriors('roboapply', { CN_MATCH_PRIORS: '{"skills":55}' }).skills).toBe(39);
    // One malformed key keeps the defaults whole.
    for (const bad of ['{"skills":"x"}', '{"skills":-1}', '{"skills":101}', '{"skills":null}', '{"skills":true}', '{"skills":""}', 'not json', '[1,2]', '']) {
      expect(getMatchPriors('roboapply', { MATCH_PRIORS: bad }), bad).toEqual(P);
    }
  });
});

describe('logistics in the estimate: a check met only through your own filter adds nothing', () => {
  const pay = { amount: 60000, currency: 'EUR', period: 'year' } as const;

  it('every stated check met and filter-guaranteed → not compared: it counts at the prior, and the evidence says so', () => {
    // Location (a search location) and pay (a pay floor) are both filters, and both met.
    const user = matchUser();
    const job = matchJob();
    expect(hardFiltersOf(user)).toEqual({ location: true, pay: true });
    const { dimension, byFilters } = logisticsForEstimate(user, job, W);
    expect(byFilters).toBe(true);
    // No number nobody measured: the part is not stated, like any part the estimate cannot compare.
    expect(dimension).toMatchObject({ key: 'logistics', status: 'not_stated', score: null, weight: W.logistics });
    // One line, never empty: what the filters already guaranteed, in the posting's own words.
    expect(dimension.evidence).toEqual([{ text: 'Berlin, DE · EUR 70000–90000', source: 'posting', ref: LOGISTICS_BY_FILTERS_REF }]);
    expect(isByFilters(dimension)).toBe(true);
    expect(isByFilters(logisticsDimension(user, job, W))).toBe(false);
    // The facts themselves (the AI score's form) are unchanged: 100.
    expect(logisticsDimension(user, job, W).score).toBe(100);
    // In the estimate the part contributes the logistics prior at its full weight, and is out of the coverage.
    const r = preScore(user, job, CFG);
    expect(r.dimensions.find((d) => d.key === 'logistics')).toEqual(dimension);
    expect(r.coverage).toBe(0.8);
    const withPrior = (logistics: number) => preScore(user, job, { ...CFG, priors: { ...P, logistics } });
    // Another prior for the market moves the total by weight × difference: 10 × (90 − 50) / 100 = 4 points.
    expect(withPrior(90).score! - withPrior(50).score!).toBe(4);
    // The same total as a person with no logistics answers at all (the prior, not 100).
    const really = preScore(matchUser({ hardFilters: { location: false, pay: false } }), job, CFG);
    expect(really.dimensions.find((d) => d.key === 'logistics')!.score).toBe(100);
    expect(really.score! - r.score!).toBe(5);
  });

  it('with no words to quote the part is a plain not-stated one: never an empty evidence line', () => {
    // Met by distance, and the posting carries coordinates but no place words.
    const user = matchUser({ salaryMin: null });
    const job = matchJob({ location: null, locationCity: null, locationCountry: null });
    const { dimension, byFilters } = logisticsForEstimate(user, job, W);
    expect(locationCheck(user, job)).toBe('met');
    expect(byFilters).toBe(true);
    expect(dimension).toMatchObject({ status: 'not_stated', score: null, evidence: [] });
    for (const d of preScore(user, job, CFG).dimensions) for (const e of d.evidence) expect(e.text.trim(), `${d.key} ${e.ref}`).not.toBe('');
  });

  it('an offered sponsorship is a fact of the posting, never guaranteed by the "I need sponsorship" filter', () => {
    // The filter only removes postings that say they do not sponsor; silent ones stay. So "offered" is information.
    const user = matchUser({ needsSponsorship: true });
    const offered = matchJob({ sponsorship: 'offered', sponsorshipEvidence: 'We sponsor visas.' });
    const scored = logisticsForEstimate(user, offered, W);
    expect(scored.byFilters).toBe(false);
    expect(scored.dimension).toMatchObject({ status: 'scored', score: 100 });
    expect(scored.dimension.evidence.map((e) => e.ref)).toEqual(['location_met', 'pay_met', 'visa_offered']);
    // The sponsorship check alone, with no quote in the posting: scored as a fact, and no by-filters line at all.
    const visaOnly = matchUser({ ...NO_LOGISTICS, needsSponsorship: true });
    const bare = logisticsForEstimate(visaOnly, matchJob({ sponsorship: 'offered', sponsorshipEvidence: null }), W);
    expect(bare.byFilters).toBe(false);
    expect(bare.dimension).toMatchObject({ status: 'scored', score: 100 });
    expect(bare.dimension.evidence.some((e) => e.ref === LOGISTICS_BY_FILTERS_REF)).toBe(false);
    // A posting silent on sponsorship: the visa check is not stated, so only the filtered checks remain → not compared.
    expect(logisticsForEstimate(user, matchJob(), W).byFilters).toBe(true);
    // A posting that says no is a real penalty: 2 of 3 met.
    expect(logisticsForEstimate(user, matchJob({ sponsorship: 'not_offered', sponsorshipEvidence: 'No visa sponsorship.' }), W).dimension.score).toBe(67);
    // The offer is worth points in the total: 10 × (100 − 50) / 100 over the silent posting.
    expect(preScore(user, offered, CFG).score! - preScore(user, matchJob(), CFG).score!).toBe(5);
  });

  it('really met without a filter → 100, as a fact', () => {
    // The country is a profile fact and the visa need a per-country work-authorisation answer: no filter guarantees either.
    const user = matchUser({ locations: [], workModels: [], country: 'DE', salaryMin: null, needsSponsorship: false, workAuth: [{ country: 'DE', authorized: false, sponsorship: 'now' }], hardFilters: { location: false, pay: false } });
    const job = matchJob({ sponsorship: 'offered', sponsorshipEvidence: 'We sponsor visas.' });
    const { dimension, byFilters } = logisticsForEstimate(user, job, W);
    expect(byFilters).toBe(false);
    expect(dimension.score).toBe(100);
    expect(dimension.evidence.some((e) => e.ref === LOGISTICS_BY_FILTERS_REF)).toBe(false);
    expect(preScore(user, job, CFG).coverage).toBe(0.9);
    // One real check next to a guaranteed one is information: 100, not the prior.
    const mixed = matchUser({ needsSponsorship: false, workAuth: [{ country: 'DE', authorized: false, sponsorship: 'now' }] });
    expect(logisticsForEstimate(mixed, job, W)).toMatchObject({ byFilters: false, dimension: { score: 100 } });
  });

  it('not met is a real penalty, filter or not: 100 × met / stated', () => {
    const user = matchUser({ salaryMin: { amount: 100000, currency: 'EUR', period: 'year' } });
    const half = logisticsForEstimate(user, matchJob(), W);
    expect(half.byFilters).toBe(false);
    expect(half.dimension.score).toBe(50);
    expect(half.dimension.evidence.map((e) => e.ref)).toEqual(['location_met', 'pay_not_met']);
    const none = logisticsForEstimate(matchUser({ salaryMin: { amount: 100000, currency: 'EUR', period: 'year' }, workModels: ['remote'] }), matchJob(), W);
    expect(none.dimension.score).toBe(0);
    // Nothing stated on either side → not stated, and the prior is applied by the total.
    const silent = logisticsForEstimate(matchUser(NO_LOGISTICS), matchJob(), W);
    expect(silent.dimension).toMatchObject({ status: 'not_stated', evidence: [] });
    expect(silent.byFilters).toBe(false);
  });

  it('a hand-built person: location is a filter when a location, a work model or a country is set; pay with a floor; never the visa answer', () => {
    expect(hardFiltersOf(matchUser({ ...NO_LOGISTICS, needsSponsorship: null }))).toEqual({ location: false, pay: false });
    expect(hardFiltersOf(matchUser({ ...NO_LOGISTICS, country: 'DE' })).location).toBe(true);
    expect(hardFiltersOf(matchUser({ ...NO_LOGISTICS, workModels: ['remote'] })).location).toBe(true);
    expect(hardFiltersOf(matchUser({ ...NO_LOGISTICS, salaryMin: pay })).pay).toBe(true);
    expect(hardFiltersOf(matchUser({ needsSponsorship: true }))).toEqual({ location: true, pay: true });
    expect(hardFiltersOf(matchUser({ ...NO_LOGISTICS, needsSponsorship: true }))).toEqual({ location: false, pay: false });
  });
});

describe('coverage and confidence', () => {
  it.each([
    [0.49, 'low'],
    [0.5, 'medium'],
    [0.74, 'medium'],
    [0.75, 'high'],
    [0, 'low'],
    [1, 'high'],
  ])('coverage %s → %s', (coverage, confidence) => {
    expect(confidenceFor(coverage)).toBe(confidence);
    // A thin posting (or an onboarding-only level) is low whatever the coverage.
    expect(confidenceFor(coverage, true)).toBe('low');
  });

  it('the thresholds as the estimate reaches them, through the weights', () => {
    // Only the role is comparable (no skills, no industry, no logistics answers): coverage = the title weight.
    const user = matchUser({ employerIndustries: [], ...NO_LOGISTICS });
    const job = matchJob({ skills: [], skillsDetail: null });
    const at = (title: number) => preScore(user, job, { ...CFG, weights: { title_level: title, skills: 100 - title - 10, industry: 0, logistics: 0, career_path: 10 } });
    // The posting states its role and level and nothing else: `title` of 90 points. Under 60% → low, whatever the coverage.
    expect(at(49)).toMatchObject({ coverage: 0.49, confidence: 'low' });
    expect(at(50)).toMatchObject({ coverage: 0.5, confidence: 'low', postingCoverage: 0.556 });
    // From 54 of 90 the posting states 60%: the coverage decides.
    expect(at(54)).toMatchObject({ coverage: 0.54, confidence: 'medium', postingCoverage: 0.6, confidenceReason: null });
    expect(at(74)).toMatchObject({ coverage: 0.74, confidence: 'medium' });
    expect(at(75)).toMatchObject({ coverage: 0.75, confidence: 'high' });
  });

  it('coverage: the weight of the parts backed on both sides; career_path never counts', () => {
    const full = preScoreDimensions(matchUser({ ...NO_LOGISTICS, country: 'DE', hardFilters: { location: false, pay: false } }), matchJob(), W);
    expect(full.filter((d) => d.status === 'scored').map((d) => d.key)).toEqual(['title_level', 'skills', 'industry', 'logistics']);
    expect(coverageOf(full)).toBe(0.9);
    // A logistics part met only through the person's own filters is not scored, so it is not in the coverage.
    const byFilters = preScoreDimensions(matchUser(), matchJob(), W);
    expect(byFilters.filter((d) => d.status === 'scored').map((d) => d.key)).toEqual(['title_level', 'skills', 'industry']);
    expect(coverageOf(byFilters)).toBe(0.8);
    expect(coverageOf([{ key: 'career_path', weight: 10, score: 80, status: 'scored', evidence: [] }])).toBe(0);
  });

  it('what the posting states: role and level, hard skills, the employer industry, a location or pay', () => {
    expect(postingCoverageOf(matchJob(), W)).toBe(1);
    // A role with no stated level is half of that part.
    expect(postingCoverageOf(matchJob({ seniority: null }), W)).toBeCloseTo((17.5 + 30 + 15 + 10) / 90, 6);
    expect(postingCoverageOf(matchJob({ skills: [], skillsDetail: null }), W)).toBeCloseTo(60 / 90, 6);
    expect(postingCoverageOf(matchJob({ companyIndustries: [] }), W)).toBeCloseTo(75 / 90, 6);
    const nowhere = { location: null, locationCity: null, locationCountry: null, geoLat: null, geoLng: null, workModel: null, salaryAnnualMin: null, salaryAnnualMax: null };
    expect(postingCoverageOf(matchJob(nowhere), W)).toBeCloseTo(80 / 90, 6);
    // Pay alone states the logistics part.
    expect(postingCoverageOf(matchJob({ ...nowhere, salaryAnnualMax: 90000 }), W)).toBe(1);
    expect(postingCoverageOf(matchJob({ title: 'Zzz', taxonomyIds: [], primaryTaxonomyId: null }), W)).toBeCloseTo(55 / 90, 6);
  });

  it('I4: a posting that states under 60% of the rubric is never Great and its confidence is low', () => {
    // No skills and no level: under 60% whatever else the posting says (industry and location are stated here).
    const thin = matchJob({ skills: [], skillsDetail: null, seniority: null });
    expect(postingCoverageOf(thin, W)).toBeLessThan(0.6);
    for (const user of [matchUser(), matchUser({ recentTitle: 'Senior Backend Engineer', ...NO_LOGISTICS, country: 'DE', hardFilters: { location: false, pay: false } })]) {
      const r = preScore(user, thin, CFG);
      expect(r.confidence).toBe('low');
      expect(r.confidenceReason).toBe('no_skills_listed');
      expect(r.tier).not.toBe('great');
      expect(r.limit).toBeLessThanOrEqual(CFG.tiers.great - 1);
    }
    // The cap holds even with priors that would lift the total past the Great line.
    const lifted = preScore(matchUser(), matchJob({ seniority: null, companyIndustries: [], location: null, locationCity: null, locationCountry: null, geoLat: null, geoLng: null, workModel: null, salaryAnnualMin: null, salaryAnnualMax: null }), {
      ...CFG,
      priors: { title_level: 100, skills: 100, industry: 100, logistics: 100, career_path: 100 },
    });
    expect(lifted.postingCoverage).toBeLessThan(0.6);
    expect(lifted.score).toBe(CFG.tiers.great - 1);
    expect(lifted.confidence).toBe('low');
  });

  it('the reason is the first that applies: no skills, no level, no role evidence, no resume, few details', () => {
    const thinBase = { companyIndustries: [], location: null, locationCity: null, locationCountry: null, geoLat: null, geoLng: null, workModel: null, salaryAnnualMin: null, salaryAnnualMax: null };
    const reason = (user: Parameters<typeof preScore>[0], job: Parameters<typeof preScore>[1]) => {
      const r = preScore(user, job, CFG);
      expect(r.confidence).toBe('low');
      return r.confidenceReason;
    };
    expect(reason(matchUser(), matchJob({ skills: [], skillsDetail: null, companyIndustries: [] }))).toBe('no_skills_listed');
    expect(reason(matchUser(), matchJob({ ...thinBase, seniority: null }))).toBe('no_level_stated');
    const noRole = matchUser({ evidenceRoleIds: [], skills: [], employerIndustries: [], ...NO_LOGISTICS });
    expect(reason(noRole, matchJob())).toBe('no_role_evidence');
    const noResume = matchUser({ skills: [], resumeSeniority: 'intern_newgrad', levelSource: 'onboarding', hasResume: false });
    expect(reason(noResume, matchJob())).toBe('no_resume');
    // A level that is only the onboarding answer: low, even with every part compared.
    expect(reason(matchUser({ resumeSeniority: 'intern_newgrad', levelSource: 'onboarding' }), matchJob({ seniority: 'intern_newgrad' }))).toBe('few_details');
    // High or medium confidence carries no reason.
    expect(preScore(matchUser(), matchJob(), CFG)).toMatchObject({ confidence: 'high', confidenceReason: null });
  });
});

describe('I3: no chip of the saved search moves a fit', () => {
  /** The same person (profile, experience, resume) with another saved search. */
  const person = (filters: Record<string, unknown>, over: Partial<UserMatchInputs> = {}) =>
    buildMatchUser({ userId: 'u1', market: 'intl', ...defaultUserInputs(), resumeParsed: { skills: ['TypeScript', 'Go'] }, ...over, searchProfile: { version: 1, filters } }, NOW);
  const BASE = defaultUserInputs().searchProfile!.filters as Record<string, unknown>;
  const jobs = [
    matchJob(),
    matchJob({ id: 'intern', title: 'Software Engineering Intern', seniority: 'intern_newgrad' }),
    matchJob({ id: 'analyst', title: 'Data Analyst', taxonomyIds: ['data_ai', 'data_analytics', 'data_analyst'], primaryTaxonomyId: 'data_analyst', skills: ['sql'] }),
    matchJob({ id: 'thin', skills: [], skillsDetail: null, seniority: null }),
  ];

  it.each([
    ['seniority', { seniority: ['intern_newgrad', 'entry'] }],
    ['seniority removed', { seniority: undefined }],
    ['taxonomyIds', { taxonomyIds: ['data_analyst'] }],
    ['taxonomyIds removed', { taxonomyIds: undefined }],
    ['titles', { titles: ['Data Analyst', 'Product Manager'] }],
    ['skills', { skills: ['sql', 'excel'] }],
    ['companies', { companies: ['Acme', 'PayCo'], excludedCompanies: ['Globex'], preferredCompanies: ['Initech'] }],
    ['all of them at once', { seniority: ['director_exec'], taxonomyIds: ['account_executive'], titles: ['Teacher'], skills: ['salesforce'], companies: ['Acme'] }],
  ])('changing filters.%s changes no field of the result', (_name, change) => {
    const before = person(BASE);
    const after = person({ ...BASE, ...change });
    for (const job of jobs) expect(preScore(after, job, CFG), job.id).toEqual(preScore(before, job, CFG));
  });

  it.each([
    ['the location', { locations: [{ label: 'Munich', city: 'Munich', country: 'DE', radiusKm: 30, lat: 48.137, lng: 11.575 }] }],
    ['the pay floor', { salaryMin: { amount: 150000, currency: 'EUR', period: 'year' } }],
    ['no pay floor', { salaryMin: undefined }],
    ['the sponsorship answer', { needsSponsorship: true }],
  ])('changing only %s changes the logistics part and the total, and no other part', (_name, change) => {
    const before = person(BASE);
    const after = person({ ...BASE, ...change });
    const job = matchJob({ sponsorship: 'not_offered', sponsorshipEvidence: 'No visa sponsorship.' });
    const a = preScore(before, job, CFG);
    const b = preScore(after, job, CFG);
    const others = (r: typeof a) => r.dimensions.filter((d) => d.key !== 'logistics');
    const logistics = (r: typeof a) => r.dimensions.find((d) => d.key === 'logistics')!;
    expect(others(b)).toEqual(others(a));
    expect(logistics(b)).not.toEqual(logistics(a));
    // The total moves by the logistics part alone: its weight times the change of its score.
    const moved = (W.logistics * ((logistics(b).score ?? P.logistics) - (logistics(a).score ?? P.logistics))) / 100;
    expect(Math.abs(b.score! - a.score! - moved)).toBeLessThanOrEqual(1);
    expect([b.topOverlap, b.topGap, b.softSkills, b.postingCoverage]).toEqual([a.topOverlap, a.topGap, a.softSkills, a.postingCoverage]);
  });

  it('the Level chips do not move any fit, and a senior resume against an internship is at most Possible', () => {
    const scores = [['senior'], [], ['mid'], ['intern_newgrad', 'entry'], ['director_exec']].map((seniority) => preScore(person({ ...BASE, seniority }), jobs[0]!, CFG).score);
    expect(new Set(scores).size).toBe(1);
    // The chips include the internship level: the resume is still a senior engineer's.
    const intern = preScore(person({ ...BASE, seniority: ['intern_newgrad'] }), jobs[1]!, CFG);
    expect(intern.score).toBeLessThan(CFG.tiers.good);
    expect(intern.tier === 'great' || intern.tier === 'good').toBe(false);
  });

  it('two recent titles of "Teacher" give a low title_level for a Data Analyst job, even when the saved search targets data analysts', () => {
    const teacher = person(
      { ...BASE, taxonomyIds: ['data_analyst'], titles: ['Data Analyst'], seniority: ['mid'] },
      {
        experience: [
          { title: 'Teacher', company: 'Lincoln High', startYm: '2021-09', endYm: null, current: true, kind: 'work' },
          { title: 'Teacher', company: 'Roosevelt Middle School', startYm: '2017-09', endYm: '2021-06', current: false, kind: 'work' },
        ],
      },
    );
    expect(teacher.evidenceRoleIds).toEqual(['school_teacher']);
    expect(teacher.targetTaxonomyIds).toEqual(['data_analyst']);
    const title = preScore(teacher, jobs[2]!, CFG).dimensions.find((d) => d.key === 'title_level')!;
    expect(title).toMatchObject({ status: 'scored', score: 0 });
    // The same search for a person whose record shows a data analyst: a full title match.
    const analyst = person({ ...BASE, taxonomyIds: ['data_analyst'] }, { experience: [{ title: 'Data Analyst', company: 'Acme', startYm: '2020-01', endYm: null, current: true, kind: 'work' }] });
    expect(preScore(analyst, matchJob({ ...jobs[2]!, seniority: 'mid' }), CFG).dimensions.find((d) => d.key === 'title_level')!.score).toBeGreaterThanOrEqual(70);
  });
});

describe('role evidence comes from the record', () => {
  const inputs = (over: Partial<UserMatchInputs>): UserMatchInputs => ({ userId: 'u1', market: 'intl', ...defaultUserInputs(), experience: [], resumeParsed: null, ...over });

  it('from the profile experience: the two most recent titles, the current one first', () => {
    const u = buildMatchUser(
      inputs({
        experience: [
          { title: 'Product Manager', company: 'A', startYm: '2015-01', endYm: '2018-12', current: false, kind: 'work' },
          { title: 'Data Analyst', company: 'B', startYm: '2022-01', endYm: null, current: true, kind: 'work' },
          { title: 'Teacher', company: 'C', startYm: '2010-01', endYm: '2014-12', current: false, kind: 'work' },
        ],
      }),
      NOW,
    );
    // The current job, then the first listed: the third title is not evidence.
    expect(u.evidenceRoleIds).toEqual(['data_analyst', 'product_manager']);
  });

  it('from the parsed resume when the profile has no experience', () => {
    const u = buildMatchUser(inputs({ resumeParsed: { experience: [{ role: 'Senior Backend Engineer', startDate: '2020-01', endDate: 'Present' }, { title: 'Data Analyst' }, { role: 'Teacher' }] } }), NOW);
    expect(u.evidenceRoleIds).toEqual(['backend_engineer', 'data_analyst']);
  });

  it('from a headline that names a role, whole or in its first part', () => {
    expect(buildMatchUser(inputs({ profile: { ...defaultUserInputs().profile!, headline: 'Data Analyst' } }), NOW).evidenceRoleIds).toEqual(['data_analyst']);
    expect(buildMatchUser(inputs({ profile: { ...defaultUserInputs().profile!, headline: 'Data Analyst | SQL, Python, dashboards' } }), NOW).evidenceRoleIds).toEqual(['data_analyst']);
    // A headline that names no role is no evidence.
    expect(buildMatchUser(inputs({ profile: { ...defaultUserInputs().profile!, headline: 'Curious, kind, always learning' } }), NOW).evidenceRoleIds).toEqual([]);
    // It adds to the experience titles.
    const both = buildMatchUser(inputs({ profile: { ...defaultUserInputs().profile!, headline: 'Product Manager' }, experience: [{ title: 'Data Analyst', company: 'B', startYm: '2022-01', endYm: null, current: true, kind: 'work' }] }), NOW);
    expect(both.evidenceRoleIds).toEqual(['data_analyst', 'product_manager']);
  });

  it('a person\'s title is placed by the same rule as a posting\'s title: Taiwan titles are folded for the match', () => {
    // Traditional Chinese titles, including Taiwan vocabulary (資料 for 数据): the role tree carries Simplified aliases.
    expect(roleIdOfTitle('資深後端工程師')).toBe('backend_engineer');
    expect(roleIdOfTitle('資料分析師')).toBe('data_analyst');
    expect(roleIdOfTitle('后端开发工程师')).toBe('backend_engineer');
    expect(roleIdOfTitle('Senior Backend Engineer')).toBe('backend_engineer');
    expect(roleIdOfTitle('   ')).toBeNull();
    expect(roleIdOfTitle(null)).toBeNull();
    const tw = buildMatchUser(inputs({ experience: [{ title: '資深後端工程師', company: '某科技', startYm: '2019-01', endYm: null, current: true, kind: 'work' }] }), NOW);
    expect(tw.evidenceRoleIds).toEqual(['backend_engineer']);
    // And the job side: a Taiwan posting with no stored role is placed from its title the same way.
    expect(titleOverlap(tw, matchJob({ title: '後端工程師', taxonomyIds: [], primaryTaxonomyId: null }))).toBe(1);
  });

  it('no evidence → the title part is not stated and takes its prior; the saved search is not read for it', () => {
    // The saved search names a role, a title and a level; the record (no experience, no resume, no headline) shows none.
    const search = { version: 1, filters: { taxonomyIds: ['backend_engineer'], titles: ['Backend Engineer'], seniority: ['senior'] } };
    const u = buildMatchUser(inputs({ searchProfile: search, employerIndustries: [], profile: { ...defaultUserInputs().profile!, country: null } }), NOW);
    expect(u.evidenceRoleIds).toEqual([]);
    expect(u.targetTaxonomyIds).toEqual(['backend_engineer']);
    const r = preScore({ ...u, skills: ['TypeScript', 'Go', 'Kubernetes'] }, matchJob(), CFG);
    const title = r.dimensions.find((d) => d.key === 'title_level')!;
    expect(title).toMatchObject({ status: 'not_stated', score: null });
    // skills 100, the rest at their priors: 35 × 44 + 30 × 100 + 15 × 24 + 10 × 50 + 10 × 45 = 58.5
    expect(r.score).toBe(Math.round((35 * 44 + 30 * 100 + 15 * 24 + 10 * 50 + 10 * 45) / 100));
    expect(r).toMatchObject({ coverage: 0.3, confidence: 'low', confidenceReason: 'no_role_evidence' });
    // With the role filter the old estimate said 100 here; now a job inside the filter is at most Possible on skills alone.
    expect(r.tier).toBe('possible');
  });
});

describe('combining and tiers', () => {
  it('the AI total still renormalises over the scored components (its arithmetic is unchanged)', () => {
    const dims = preScoreDimensions(matchUser({ employerIndustries: [] }), matchJob(), W);
    expect(dims.find((d) => d.key === 'industry')!.status).toBe('not_stated');
    expect(dims.find((d) => d.key === 'career_path')!.status).toBe('not_stated');
    // Logistics only repeats the person's filters here, so the estimate does not compare it either.
    expect(dims.find((d) => d.key === 'logistics')!.status).toBe('not_stated');
    // title 100 (35) + skills 67 (30), over 65
    expect(combineDimensions(dims)).toBe(Math.round((35 * 100 + 30 * 67) / 65));
    // The estimate: the same parts, with the priors for the three that are not compared.
    expect(combineWithPriors(dims, P)).toBe(Math.round((35 * 100 + 30 * 67 + 15 * 24 + 10 * 50 + 10 * 45) / 100));
    // With location and pay as facts the AI arithmetic counts them: title 100 (35) + skills 67 (30) + logistics 100 (10), over 75.
    const facts = preScoreDimensions(matchUser({ employerIndustries: [], hardFilters: { location: false, pay: false } }), matchJob(), W);
    expect(combineDimensions(facts)).toBe(Math.round((35 * 100 + 30 * 67 + 10 * 100) / 75));
  });

  it.each([
    [80, 'great'],
    [79, 'good'],
    [65, 'good'],
    [64, 'possible'],
    [45, 'possible'],
    [44, 'unlikely'],
    [0, 'unlikely'],
  ])('tier boundaries 80/65/45: %s → %s', (score, tier) => {
    expect(tierForScore(score)).toBe(tier);
  });

  it('preScore returns the tier, an overlap and a gap from real fields, with its coverage and confidence', () => {
    const r = preScore(matchUser(), matchJob({ skillsDetail: [{ skill: 'Kubernetes', required: true }] }), CFG);
    expect(r.kind).toBe('pre');
    expect(r.topGap).toBe('Kubernetes');
    expect(r.topOverlap).toBe('TypeScript');
    expect(r.tier).toBe(tierForScore(r.score!));
    expect(r).toMatchObject({ coverage: 0.8, confidence: 'high', confidenceReason: null, postingCoverage: 1, softSkills: [], limit: 100 });
  });

  it('GoApply: school tier is never an input (C15)', () => {
    const base = matchUser({ market: 'cn' });
    const job = matchJob({ market: 'cn' });
    const withTier = { ...base, schoolTiers: ['985'], schoolTags: ['985', '211'], schoolName: '清华大学' } as never;
    expect(preScore(withTier, job, CFG)).toEqual(preScore(base, job, CFG));
  });
});
