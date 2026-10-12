// @vitest-environment node
// MKT-4G — scorer v4 on the server (MARKET_STRATEGY 2.1 point 5; MATCH 4.8): verification first, then every
// number computed from the checklist. Pure functions; every total below is worked out by hand in its comment.
import { describe, expect, it } from 'vitest';

import { SCORER_V4_EXTRACT_MAX, SCORER_V4_LEVELS, type RAJobMatchScorerV4Output, type ScorerV4RequirementAnswer } from '../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import { SENIORITY_LEVELS } from '../search/index.js';
import { DEFAULT_MATCH_TIERS, DEFAULT_MATCH_WEIGHTS, type JobRequirement, type MatchDimension } from './contract.js';
import { combineDimensions, titleLevelDimension } from './preScore.js';
import {
  CHECKLIST_EXTRACT_MAX,
  CHECKLIST_LEVELS,
  CHECKLIST_POINTS,
  CHECKLIST_UNVERIFIED_MAX_SHARE,
  DOMAIN_ANCHORS,
  ELIGIBILITY_FACTOR,
  IMPORTANCE_WEIGHT,
  LEVEL_ANCHORS,
  ScorerV4ChecklistError,
  TRAJECTORY_ANCHORS,
  borderlineTier,
  classYearEligibility,
  componentsFromChecklist,
  isClassYearLine,
  isNotJudgedRequirement,
  levelDistance,
  readRequirementChecks,
  readStoredRequirements,
  shortQuoteIn,
} from './scorerV4.js';
import { matchJob, matchUser } from './testkit.js';

const WEIGHTS = { ...DEFAULT_MATCH_WEIGHTS };

/** The PII-stripped resume the model saw (SYNTHETIC). */
const RESUME = [
  '# [removed]',
  '',
  '## Experience',
  'Senior Software Engineer, PayCo (2019-01 – present)',
  '- Built payment APIs in TypeScript and Go serving 2M users.',
  '- Ran PostgreSQL clusters for the ledger service.',
  '',
  '## Education',
  'BSc Computer Science, 2014',
  '',
  '## Skills',
  'TypeScript, Go, PostgreSQL',
].join('\n');

/** The posting text the model saw (SYNTHETIC). */
const POSTING = [
  'Backend Engineer',
  'Build APIs in TypeScript and Go. You will own our payments service.',
  "5+ years of backend experience. Kubernetes required. Bachelor's degree in Computer Science. Nice to have: Rust. We offer a gym membership.",
].join('\n\n');

const LOGISTICS: MatchDimension = { key: 'logistics', weight: 10, score: 100, status: 'scored', evidence: [{ text: 'Berlin, DE', source: 'posting', ref: 'location_met' }] };

const R = {
  years: { id: 'a', kind: 'experience', text: '5+ years of backend experience', importance: 'must', status: 'met', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' },
  k8s: { id: 'b', kind: 'skill', text: 'Kubernetes required', importance: 'must', status: 'not_shown', evidence: '' },
  rust: { id: 'c', kind: 'skill', text: 'Nice to have: Rust', importance: 'preferred', status: 'partly', evidence: 'Built payment APIs in TypeScript and Go serving 2M users.' },
  degree: { id: 'd', kind: 'education', text: "Bachelor's degree in Computer Science", importance: 'must', status: 'met', evidence: 'BSc Computer Science, 2014' },
  gym: { id: 'e', kind: 'skill', text: 'We offer a gym membership', importance: 'must', status: 'not_applicable', evidence: '' },
} satisfies Record<string, ScorerV4RequirementAnswer>;

function answer(over: Partial<RAJobMatchScorerV4Output> = {}): RAJobMatchScorerV4Output {
  return {
    requirements: [R.years, R.k8s, R.rust, R.degree, R.gym],
    level: { post: 'senior', resume: 'senior', direction: 'match' },
    domain: { status: 'adjacent', evidence: 'Built payment APIs in TypeScript and Go serving 2M users.' },
    trajectory: { status: 'toward', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' },
    strengths: ['Your payment APIs in Go'],
    gaps: ['No Kubernetes work shown'],
    summary: 'Your backend work lines up.',
    ...over,
  };
}

const run = (out: RAJobMatchScorerV4Output, over: Partial<Parameters<typeof componentsFromChecklist>[1]> = {}) =>
  componentsFromChecklist(out, { weights: WEIGHTS, logistics: LOGISTICS, sources: { resume: RESUME, posting: POSTING }, ...over });
const score = (result: ReturnType<typeof run>, key: MatchDimension['key']) => result.dimensions.find((d) => d.key === key)!.score;

describe('the anchors', () => {
  it('are the published ones: met 1, partly 0.5, not shown 0; must 1, preferred 0.5; level 100 / 60 / 25 / 0; domain 100 / 60 / 20; trajectory 100 / 60 / 25', () => {
    expect(CHECKLIST_POINTS).toEqual({ met: 1, partly: 0.5, not_shown: 0 });
    expect(IMPORTANCE_WEIGHT).toEqual({ must: 1, preferred: 0.5 });
    expect([...LEVEL_ANCHORS]).toEqual([100, 60, 25, 0]);
    expect(DOMAIN_ANCHORS).toEqual({ direct: 100, adjacent: 60, unrelated: 20 });
    expect(TRAJECTORY_ANCHORS).toEqual({ toward: 100, neutral: 60, away: 25 });
    expect(ELIGIBILITY_FACTOR).toBe(0.5);
    expect(CHECKLIST_EXTRACT_MAX).toBe(SCORER_V4_EXTRACT_MAX);
    // The six levels of the search contract, in its order; the agent's list is the same.
    expect([...CHECKLIST_LEVELS]).toEqual([...SENIORITY_LEVELS]);
    expect([...CHECKLIST_LEVELS]).toEqual([...SCORER_V4_LEVELS]);
  });
});

describe('componentsFromChecklist: a recorded answer, worked by hand', () => {
  it('skills is the weighted share of the skill and experience lines; the total is the usual weighted sum', () => {
    const result = run(answer());
    // Judged skill and experience lines: years (must, met) 1 × 1, Kubernetes (must, not shown) 1 × 0, Rust (preferred,
    // partly) 0.5 × 0.5. The gym line is not applicable and is not a line of the checklist. 100 × 1.25 / 2.5 = 50.
    expect(score(result, 'skills')).toBe(50);
    expect(score(result, 'title_level')).toBe(100);
    expect(score(result, 'industry')).toBe(60);
    expect(score(result, 'career_path')).toBe(100);
    expect(score(result, 'logistics')).toBe(100);
    expect(result.dimensions.map((d) => d.key)).toEqual(['title_level', 'skills', 'industry', 'logistics', 'career_path']);
    expect(result.dimensions.map((d) => d.weight)).toEqual([35, 30, 15, 10, 10]);
    // (35 × 100 + 30 × 50 + 15 × 60 + 10 × 100 + 10 × 100) / 100 = 79
    expect(combineDimensions(result.dimensions)).toBe(79);
    // The logistics component is the caller's, object for object: the model never touches it.
    expect(result.dimensions.find((d) => d.key === 'logistics')).toBe(LOGISTICS);
  });

  it('the checklist that is stored: lines of the posting, numbered r1…rN, each with its verified status and quote', () => {
    const result = run(answer());
    expect(result.requirements).toEqual([
      { id: 'r1', kind: 'experience', text: '5+ years of backend experience', importance: 'must', status: 'met', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' },
      { id: 'r2', kind: 'skill', text: 'Kubernetes required', importance: 'must', status: 'not_shown', evidence: '' },
      { id: 'r3', kind: 'skill', text: 'Nice to have: Rust', importance: 'preferred', status: 'partly', evidence: 'Built payment APIs in TypeScript and Go serving 2M users.' },
      { id: 'r4', kind: 'education', text: "Bachelor's degree in Computer Science", importance: 'must', status: 'met', evidence: 'BSc Computer Science, 2014' },
    ]);
    // What is stored on the job: the same lines without the person's status.
    expect(result.extracted).toEqual(result.requirements.map(({ id, kind, text, importance }) => ({ id, kind, text, importance })));
    expect(readRequirementChecks(JSON.parse(JSON.stringify(result.requirements)))).toEqual(result.requirements);
    expect(result.level).toEqual({ post: 'senior', resume: 'senior', direction: 'match' });
    expect(result.domain).toEqual({ status: 'adjacent', evidence: 'Built payment APIs in TypeScript and Go serving 2M users.' });
    expect(result.trajectory).toEqual({ status: 'toward', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' });
  });

  it('evidence of the components is verbatim text only: resume quotes of what is shown, the posting line of what is not', () => {
    const result = run(answer());
    expect(result.dimensions.find((d) => d.key === 'skills')!.evidence).toEqual([
      { text: 'Senior Software Engineer, PayCo (2019-01 – present)', source: 'resume' },
      { text: 'Built payment APIs in TypeScript and Go serving 2M users.', source: 'resume' },
      { text: 'Kubernetes required', source: 'posting' },
    ]);
    expect(result.dimensions.find((d) => d.key === 'industry')!.evidence).toEqual([{ text: 'Built payment APIs in TypeScript and Go serving 2M users.', source: 'resume' }]);
    expect(result.dimensions.find((d) => d.key === 'career_path')!.evidence).toEqual([{ text: 'Senior Software Engineer, PayCo (2019-01 – present)', source: 'resume' }]);
    expect(result.dimensions.find((d) => d.key === 'title_level')!.evidence).toEqual([]);
    for (const d of result.dimensions.filter((x) => x.key !== 'logistics')) {
      for (const e of d.evidence) expect((e.source === 'resume' ? RESUME : POSTING).includes(e.text), e.text).toBe(true);
    }
  });
});

describe('verification comes before any number', () => {
  it('a "met" with an invented quote becomes "not shown" and lowers the component', () => {
    const honest = run(answer());
    const invented = run(answer({ requirements: [{ ...R.years, evidence: 'Led a team of 40 engineers across three continents.' }, R.k8s, R.rust, R.degree] }));
    expect(invented.requirements[0]).toMatchObject({ id: 'r1', status: 'not_shown', evidence: '' });
    // 100 × (0 + 0 + 0.25) / 2.5 = 10
    expect(score(invented, 'skills')).toBe(10);
    expect(score(invented, 'skills')!).toBeLessThan(score(honest, 'skills')!);
    // The same for "partly", and for a claim with no quote at all.
    expect(run(answer({ requirements: [{ ...R.rust, evidence: 'Shipped a Rust service.' }] })).requirements[0]).toMatchObject({ status: 'not_shown', evidence: '' });
    expect(run(answer({ requirements: [{ ...R.years, evidence: '' }] })).requirements[0]).toMatchObject({ status: 'not_shown', evidence: '' });
    expect(run(answer({ requirements: [{ ...R.years, evidence: '   ' }] })).requirements[0]!.status).toBe('not_shown');
  });

  it('a quote is matched as written: markup, quote marks, spacing and letter case do not matter; a paraphrase does', () => {
    const quoted = (evidence: string) => run(answer({ requirements: [{ ...R.years, evidence }] })).requirements[0]!;
    expect(quoted('"Built payment APIs in TypeScript and Go serving 2M users."')).toMatchObject({ status: 'met', evidence: 'Built payment APIs in TypeScript and Go serving 2M users.' });
    expect(quoted('- Built payment APIs in   TypeScript and Go serving 2M users.').status).toBe('met');
    expect(quoted('built PAYMENT apis in typescript and go').status).toBe('met');
    expect(quoted('Built payments APIs with TypeScript & Go for 2M users').status).toBe('not_shown');
    // A quote from the posting is not evidence about the person.
    expect(quoted('You will own our payments service.').status).toBe('not_shown');
  });

  it('a requirement line that is not in the posting disappears, with whatever was claimed about it; the copy is then not stored as the posting\'s list', () => {
    const base = run(answer());
    expect(base.unverified).toBe(0);
    const padded = run(answer({ requirements: [...answer().requirements, { id: 'z', kind: 'skill', text: '10 years of COBOL', importance: 'must', status: 'met', evidence: 'TypeScript, Go, PostgreSQL' }] }));
    expect(padded.requirements).toEqual(base.requirements);
    expect(score(padded, 'skills')).toBe(50);
    expect(JSON.stringify(padded)).not.toContain('COBOL');
    // One line of five was not the posting's: this score stands, and the list is not written to the job.
    expect(padded.unverified).toBe(1);
    expect(padded.extracted).toBeNull();
  });

  // The review's probes: the same judgments, with the lines the resume does not show reworded by the model.
  const NOT_SHOWN = { status: 'not_shown' as const, evidence: '' };
  const own: ScorerV4RequirementAnswer = { id: 'o', kind: 'experience', text: 'You will own our payments service', importance: 'must', ...NOT_SHOWN };
  const OWN_REWORDED = { ...own, text: 'Own the payments service' };
  const K8S_REWORDED = { ...R.k8s, text: 'Kubernetes experience is required' };

  it('a line that disappears must not raise the number: a copy with more than a third of its lines missing from the posting is refused', () => {
    // Verbatim: one required line met, two not shown. 100 × 1 / 3 = 33.
    const verbatim = run(answer({ requirements: [R.years, R.k8s, own] }));
    expect(score(verbatim, 'skills')).toBe(33);
    expect(verbatim.extracted).toHaveLength(3);
    // The two "not shown" lines reworded: dropping them would read 100 × 1 / 1 = 100. Refused instead.
    expect(() => run(answer({ requirements: [R.years, K8S_REWORDED, OWN_REWORDED] }))).toThrow(ScorerV4ChecklistError);
    expect(() => run(answer({ requirements: [R.years, K8S_REWORDED, OWN_REWORDED] }))).toThrow(/2 of the 3 copied requirement lines are not in the posting/);
    // Both lines not shown, both reworded: nothing would be left and the component would read "not stated". Refused.
    expect(score(run(answer({ requirements: [R.k8s, own] })), 'skills')).toBe(0);
    expect(() => run(answer({ requirements: [K8S_REWORDED, OWN_REWORDED] }))).toThrow(/2 of the 2 copied/);
    // A line with no text, or with no kind or importance, cannot be placed either: it counts as missing.
    expect(() => run(answer({ requirements: [{ ...R.years, text: '' }] }))).toThrow(/1 of the 1 copied/);
    expect(() => run(answer({ requirements: [{ ...R.years, kind: null }] }))).toThrow(/1 of the 1 copied/);
    expect(() => run(answer({ requirements: [R.k8s, { ...R.years, importance: null }] }))).toThrow(/1 of the 2 copied/);
  });

  it('up to a third of the copied lines may be missing: the score is computed from the rest and the copy is not stored', () => {
    expect(CHECKLIST_UNVERIFIED_MAX_SHARE).toBeCloseTo(1 / 3, 12);
    // One of three reworded: exactly a third. The score stands for this person (100 × 1 / 2 = 50)…
    const one = run(answer({ requirements: [R.years, R.k8s, OWN_REWORDED] }));
    expect(one.requirements.map((r) => r.text)).toEqual(['5+ years of backend experience', 'Kubernetes required']);
    expect(score(one, 'skills')).toBe(50);
    expect(one.unverified).toBe(1);
    // …and the thinned list never becomes the posting's checklist for everyone.
    expect(one.extracted).toBeNull();
    // Two of six: still a third. Three of eight is more.
    const six = [R.years, R.k8s, R.rust, R.degree, K8S_REWORDED, OWN_REWORDED];
    expect(run(answer({ requirements: six })).unverified).toBe(2);
    expect(() => run(answer({ requirements: [...six, own, { ...R.rust, text: 'Rust would be a plus' }] }))).toThrow(/3 of the 8 copied/);
    // A line the model says is not a requirement, a line that is never judged and the same line twice are not
    // copied lines: they count neither as kept nor as missing.
    const posting = `${POSTING}\n\n年龄35岁以下`;
    const quiet = run(answer({ requirements: [R.years, R.gym, { ...R.gym, text: 'A benefit the posting does not list' }, { ...own, text: '年龄35岁以下' }, { ...own, text: '年龄 35 岁以内（改写）' }, { ...R.years, id: 'again' }] }), { sources: { resume: RESUME, posting } });
    expect(quiet.requirements.map((r) => r.text)).toEqual(['5+ years of backend experience']);
    expect(quiet.unverified).toBe(0);
    expect(quiet.extracted).toHaveLength(1);
  });

  it('a copy with no skill or experience line left is refused when the answer had one, or when the posting itself lists skills or years; an empty copy when it has a qualifications section', () => {
    const scope = { id: 's', kind: 'scope' as const, text: 'You will own our payments service', importance: 'must' as const, ...NOT_SHOWN };
    const domain = { id: 'm', kind: 'domain' as const, text: 'our payments service', importance: 'preferred' as const, ...NOT_SHOWN };
    // Three lines of other kinds are in the posting; the one skill line is not. One of four is tolerated as a
    // share, but the lines that count are gone: "not stated" would be an answer about the copy, not the posting.
    expect(() => run(answer({ requirements: [R.degree, scope, domain, K8S_REWORDED] }))).toThrow(/no copied skill or experience line is in the posting/);
    // The answer has no such line at all. For a posting that lists none either, that is a true answer…
    const none = run(answer({ requirements: [R.degree, scope] }));
    expect(score(none, 'skills')).toBeNull();
    expect(none.extracted).toHaveLength(2);
    expect(score(run(answer({ requirements: [] })), 'skills')).toBeNull();
    // …for a posting that lists hard skills or states years of experience it is not the posting's checklist.
    const listed = { posting: { listsSkillsOrYears: true } };
    expect(() => run(answer({ requirements: [R.degree, scope] }), listed)).toThrow(/the posting lists skills or years of experience and the answer has no skill or experience line/);
    expect(() => run(answer({ requirements: [] }), listed)).toThrow(ScorerV4ChecklistError);
    expect(() => run(answer({ requirements: [R.gym] }), listed)).toThrow(ScorerV4ChecklistError);
    // A qualifications section has at least one line: a copy with none of it is refused…
    const section = { posting: { hasQualifications: true } };
    expect(() => run(answer({ requirements: [] }), section)).toThrow(/the posting has a qualifications section and the answer copied no line of it/);
    expect(() => run(answer({ requirements: [R.gym] }), section)).toThrow(ScorerV4ChecklistError);
    // …but a section that asks for a degree and nothing else (a campus posting) is truly copied by its degree line.
    const degreeOnly = run(answer({ requirements: [R.degree] }), section);
    expect(degreeOnly.requirements.map((r) => r.kind)).toEqual(['education']);
    expect(score(degreeOnly, 'skills')).toBeNull();
    expect(degreeOnly.extracted).toHaveLength(1);
    // With a stored list none of this is read: the list is the posting's, whatever it holds.
    const stored: JobRequirement[] = [{ id: 'r1', kind: 'education', text: "Bachelor's degree in Computer Science", importance: 'must' }];
    expect(score(run(answer({ requirements: [{ ...R.degree, id: 'r1' }] }), { stored, posting: { listsSkillsOrYears: true, hasQualifications: true } }), 'skills')).toBeNull();
  });

  it('a model\'s own copy: at most 12 lines, one per line of the posting, ids r1…rN whatever the model called them', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `Requirement number ${String(i + 1).padStart(2, '0')} of the role`);
    const posting = lines.join('\n');
    const requirements: ScorerV4RequirementAnswer[] = lines.map((text, i) => ({ id: `x${99 - i}`, kind: 'skill', text, importance: 'preferred', status: 'not_shown', evidence: '' }));
    // The same line twice (once in another letter case): one entry.
    requirements.splice(1, 0, { ...requirements[0]!, id: 'dup', text: lines[0]!.toUpperCase() });
    const result = run(answer({ requirements }), { sources: { resume: RESUME, posting } });
    expect(result.requirements).toHaveLength(12);
    expect(result.requirements.map((r) => r.id)).toEqual(Array.from({ length: 12 }, (_, i) => `r${i + 1}`));
    expect(result.requirements.map((r) => r.text)).toEqual(lines.slice(0, 12));
    expect(result.extracted).toHaveLength(12);
  });

  it('nothing the model returns can set a component or the total: numbers it adds are not read, and the answer is not changed', () => {
    const out = answer();
    const withNumbers = {
      ...out,
      score: 99,
      total: 99,
      dimensions: { skills: { score: 100 } },
      requirements: out.requirements.map((r) => ({ ...r, score: 100, points: 1, weight: 5 })),
      level: { ...out.level, score: 100 },
      domain: { ...out.domain, score: 100 },
    } as unknown as RAJobMatchScorerV4Output;
    const frozen = JSON.stringify(withNumbers);
    const result = run(withNumbers);
    expect(result).toEqual(run(out));
    expect(JSON.stringify(withNumbers)).toBe(frozen);
    expect(JSON.stringify(result.requirements)).not.toMatch(/score|points|weight/);
  });
});

describe('a quote of one or two characters is a true quote when it stands as a word of its own', () => {
  /** A resume whose skills are short names (SYNTHETIC). */
  const SHORT = ['## Experience', 'Data Engineer, Example Cloud (2020-03 – present)', '- Moved the billing jobs to Google Cloud.', '', '## Education', '北京大学 本科 计算机科学', '', '## Skills', 'TypeScript, Go, C#, R, SQL, AI'].join('\n');
  const line = (text: string, evidence: string, over: Partial<ScorerV4RequirementAnswer> = {}): ScorerV4RequirementAnswer => ({ id: text, kind: 'skill', text, importance: 'must', status: 'met', evidence, ...over });
  const posting = 'Go. C#. R. AI. Rust. 本科. 硕士. Kubernetes required.';
  const check = (requirements: ScorerV4RequirementAnswer[], resume = SHORT) => run(answer({ requirements }), { sources: { resume, posting } });

  it('"Go", "C#", "R" and "AI" quoted from a skills line stay met, with the quote shown', () => {
    const result = check([line('Go', 'Go'), line('C#', 'C#'), line('R', 'R'), line('AI', '"AI"')]);
    expect(result.requirements.map((r) => [r.text, r.status, r.evidence])).toEqual([['Go', 'met', 'Go'], ['C#', 'met', 'C#'], ['R', 'met', 'R'], ['AI', 'met', 'AI']]);
    expect(score(result, 'skills')).toBe(100);
    // The two-character requirement lines themselves were kept as lines of the posting.
    expect(result.extracted).toHaveLength(4);
  });

  it('a short quote that is only part of another word is not a quote: "Go" is not in "Google Cloud"', () => {
    const noGo = SHORT.replace('TypeScript, Go, C#, R, SQL, AI', 'TypeScript, SQL');
    expect(check([line('Go', 'Go')], noGo).requirements[0]).toMatchObject({ status: 'not_shown', evidence: '' });
    expect(shortQuoteIn('Go', 'Moved the billing jobs to Google Cloud.')).toBeNull();
    expect(shortQuoteIn('Go', 'TypeScript, Go, PostgreSQL')).toBe('Go');
    expect(shortQuoteIn('go', 'Languages: Go.')).toBe('go');
    expect(shortQuoteIn('“Go”', '- **Go**, Rust')).toBe('Go');
    // A sign that makes it another name: C is not C++ or C#, R is not R&D.
    expect(shortQuoteIn('C', 'C++, C#')).toBeNull();
    expect(shortQuoteIn('C', 'C, C++')).toBe('C');
    expect(shortQuoteIn('R', 'R&D engineer')).toBeNull();
    expect(shortQuoteIn('AI', 'Maintained the email pipeline')).toBeNull();
    expect(shortQuoteIn('ML', 'HTML and XML')).toBeNull();
    // No letter in it: never a quote. Three characters and more are the CitationGuard's.
    expect(shortQuoteIn('5', '5 years')).toBeNull();
    expect(shortQuoteIn('--', 'a -- b')).toBeNull();
    expect(shortQuoteIn('', 'anything')).toBeNull();
    expect(shortQuoteIn('SQL', 'TypeScript, SQL')).toBeNull();
  });

  it('本科 quoted from "北京大学 本科" stays met and a required degree line does not halve the level; one Han character is never a quote', () => {
    const degree = check([line('Go', 'Go'), line('本科', '本科', { kind: 'education' })]);
    expect(degree.requirements[1]).toMatchObject({ text: '本科', status: 'met', evidence: '本科' });
    expect(score(degree, 'title_level')).toBe(100);
    // The resume does not say 硕士: the claim is not kept and the required degree halves the level, as before.
    const missing = check([line('Go', 'Go'), line('硕士', '硕士', { kind: 'education' })]);
    expect(missing.requirements[1]).toMatchObject({ status: 'not_shown', evidence: '' });
    expect(score(missing, 'title_level')).toBe(50);
    expect(shortQuoteIn('本科', '北京大学 本科 计算机科学')).toBe('本科');
    expect(shortQuoteIn('英语', '语言：英语（流利）')).toBe('英语');
    expect(shortQuoteIn('本', '北京大学 本科')).toBeNull();
    expect(shortQuoteIn('科', '北京大学 本科')).toBeNull();
    expect(shortQuoteIn('C语', 'C语言')).toBeNull();
    expect(shortQuoteIn('日語', '言語: 日語、英語')).toBe('日語');
  });
});

describe('weights and the cases with nothing to judge', () => {
  it('a preferred line counts half of a required one', () => {
    const preferred = { ...R.rust, status: 'met' as const };
    // must not shown (1 × 0) and preferred met (0.5 × 1): 100 × 0.5 / 1.5 = 33.3
    expect(score(run(answer({ requirements: [R.k8s, preferred] })), 'skills')).toBe(33);
    // must met (1 × 1) and preferred not shown (0.5 × 0): 100 × 1 / 1.5 = 66.7
    expect(score(run(answer({ requirements: [R.years, { ...R.rust, status: 'not_shown', evidence: '' }] })), 'skills')).toBe(67);
    expect(score(run(answer({ requirements: [R.years] })), 'skills')).toBe(100);
    expect(score(run(answer({ requirements: [R.k8s] })), 'skills')).toBe(0);
    expect(score(run(answer({ requirements: [R.rust] })), 'skills')).toBe(50);
  });

  it('only skill and experience lines enter the skills component; education, domain and scope lines are listed and not counted there', () => {
    const scope = { id: 's', kind: 'scope' as const, text: 'You will own our payments service', importance: 'must' as const, status: 'not_shown' as const, evidence: '' };
    const domain = { id: 'm', kind: 'domain' as const, text: 'our payments service', importance: 'preferred' as const, status: 'met' as const, evidence: 'Built payment APIs in TypeScript and Go serving 2M users.' };
    const result = run(answer({ requirements: [R.years, scope, domain, R.degree] }));
    expect(result.requirements.map((r) => r.kind)).toEqual(['experience', 'scope', 'domain', 'education']);
    expect(score(result, 'skills')).toBe(100);
  });

  it('skills is not stated when the posting has no skill or experience line; the total renormalizes over what is stated', () => {
    const result = run(answer({ requirements: [R.degree, R.gym], domain: { status: 'not_stated', evidence: 'anything' }, trajectory: { status: 'no_history', evidence: 'anything' } }));
    expect(result.dimensions.find((d) => d.key === 'skills')).toMatchObject({ score: null, status: 'not_stated', evidence: [] });
    expect(result.dimensions.find((d) => d.key === 'industry')).toMatchObject({ score: null, status: 'not_stated', evidence: [] });
    expect(result.dimensions.find((d) => d.key === 'career_path')).toMatchObject({ score: null, status: 'not_stated', evidence: [] });
    expect(result.domain).toEqual({ status: 'not_stated', evidence: '' });
    expect(result.trajectory).toEqual({ status: 'no_history', evidence: '' });
    // Only title_level (100) and logistics (100) are stated: (35 × 100 + 10 × 100) / 45 = 100
    expect(combineDimensions(result.dimensions)).toBe(100);
    // An empty checklist is the same case, for a posting that lists no skills and no qualifications itself.
    expect(score(run(answer({ requirements: [] })), 'skills')).toBeNull();
    // Every line not applicable: nothing was judged, so nothing is stated (never 0).
    expect(score(run(answer({ requirements: [R.gym] })), 'skills')).toBeNull();
  });

  it('logistics not stated drops out of the total like any other component', () => {
    const none: MatchDimension = { key: 'logistics', weight: 10, score: null, status: 'not_stated', evidence: [] };
    // (35 × 100 + 30 × 50 + 15 × 60 + 10 × 100) / 90 = 76.7
    expect(combineDimensions(run(answer(), { logistics: none }).dimensions)).toBe(77);
  });

  it('domain and trajectory: one anchor each; a quote that cannot be found is not shown and the judgment stands', () => {
    const anchors: Array<[RAJobMatchScorerV4Output['domain']['status'], number | null]> = [['direct', 100], ['adjacent', 60], ['unrelated', 20], ['not_stated', null]];
    for (const [status, expected] of anchors) expect(score(run(answer({ domain: { status, evidence: '' } })), 'industry'), status).toBe(expected);
    const paths: Array<[RAJobMatchScorerV4Output['trajectory']['status'], number | null]> = [['toward', 100], ['neutral', 60], ['away', 25], ['no_history', null]];
    for (const [status, expected] of paths) expect(score(run(answer({ trajectory: { status, evidence: '' } })), 'career_path'), status).toBe(expected);

    const invented = run(answer({ domain: { status: 'direct', evidence: 'Ten years in payments at a bank.' }, trajectory: { status: 'toward', evidence: 'Promoted every year.' } }));
    expect(invented.dimensions.find((d) => d.key === 'industry')).toMatchObject({ score: 100, evidence: [] });
    expect(invented.dimensions.find((d) => d.key === 'career_path')).toMatchObject({ score: 100, evidence: [] });
    expect(invented.domain.evidence).toBe('');
    expect(invented.trajectory.evidence).toBe('');
    // A domain quote may come from the posting (what the employer does); it is labelled as the posting's.
    const fromPost = run(answer({ domain: { status: 'adjacent', evidence: 'You will own our payments service.' } }));
    expect(fromPost.dimensions.find((d) => d.key === 'industry')!.evidence).toEqual([{ text: 'You will own our payments service.', source: 'posting' }]);
  });
});

describe('title_level: the level distance, then stated eligibility', () => {
  it('same level 100, one apart 60, two 25, more 0, in both directions', () => {
    const at = (post: (typeof CHECKLIST_LEVELS)[number], resume: (typeof CHECKLIST_LEVELS)[number]) => score(run(answer({ level: { post, resume, direction: 'match' } })), 'title_level');
    expect(at('senior', 'senior')).toBe(100);
    expect(at('senior', 'mid')).toBe(60);
    expect(at('mid', 'senior')).toBe(60);
    expect(at('senior', 'entry')).toBe(25);
    expect(at('entry', 'senior')).toBe(25);
    expect(at('senior', 'intern_newgrad')).toBe(0);
    expect(at('intern_newgrad', 'director_exec')).toBe(0);
    expect(at('director_exec', 'lead_staff')).toBe(60);
    expect(levelDistance('intern_newgrad', 'director_exec')).toBe(5);
    expect(levelDistance('mid', 'mid')).toBe(0);
  });

  it('halved when a required education line is not shown; a preferred one, or one shown in part, does not halve', () => {
    const degree = (over: Partial<ScorerV4RequirementAnswer>) => run(answer({ requirements: [R.years, { ...R.degree, ...over }] }));
    const missing = degree({ status: 'not_shown', evidence: '' });
    expect(score(missing, 'title_level')).toBe(50);
    // The posting's own line says why.
    expect(missing.dimensions.find((d) => d.key === 'title_level')!.evidence).toEqual([{ text: "Bachelor's degree in Computer Science", source: 'posting' }]);
    expect(score(degree({ status: 'partly' }), 'title_level')).toBe(100);
    expect(score(degree({ status: 'not_shown', evidence: '', importance: 'preferred' }), 'title_level')).toBe(100);
    expect(score(degree({ status: 'not_applicable', evidence: '' }), 'title_level')).toBe(100);
    // A "met" degree with an invented quote is not shown, and so it halves too: an unverifiable claim is not kept.
    expect(score(degree({ evidence: 'PhD in Computer Science, MIT' }), 'title_level')).toBe(50);
    // One level apart and a missing required degree: 60 × 0.5 = 30. Two such lines halve once.
    const two = run(answer({ level: { post: 'senior', resume: 'mid', direction: 'post_higher' }, requirements: [{ ...R.degree, status: 'not_shown', evidence: '' }, { ...R.degree, id: 'd2', text: 'Kubernetes required', status: 'not_shown', evidence: '' }] }));
    expect(score(two, 'title_level')).toBe(30);
    // The education line is not part of the skills component.
    expect(score(missing, 'skills')).toBe(100);
  });

  it('GoApply: a stated 届别 that excludes the person halves it, by the estimate\'s rule and once', () => {
    const excluded = { excluded: true, text: '面向2027届毕业生' };
    const plain = run(answer(), { classYear: excluded });
    expect(score(plain, 'title_level')).toBe(50);
    expect(plain.dimensions.find((d) => d.key === 'title_level')!.evidence).toEqual([{ text: '面向2027届毕业生', source: 'posting', ref: 'class_year' }]);
    expect(score(run(answer(), { classYear: { excluded: false, text: '面向2027届毕业生' } }), 'title_level')).toBe(100);
    expect(score(run(answer(), { classYear: null }), 'title_level')).toBe(100);

    // A missing required degree AND an excluded class year are two facts: 100 × 0.5 × 0.5 = 25.
    const both = run(answer({ requirements: [{ ...R.degree, status: 'not_shown', evidence: '' }] }), { classYear: excluded });
    expect(score(both, 'title_level')).toBe(25);

    // The 届别 line of the checklist is the same fact as the profile rule: on GoApply the rule decides it alone.
    const posting = `${POSTING}\n\n面向2027届毕业生`;
    const classLine: ScorerV4RequirementAnswer = { id: 'y', kind: 'education', text: '面向2027届毕业生', importance: 'must', status: 'not_shown', evidence: '' };
    const sources = { resume: RESUME, posting };
    expect(score(run(answer({ requirements: [classLine] }), { sources, classYear: excluded }), 'title_level')).toBe(50);
    // The profile states no class year (or one the posting accepts): no penalty, as in the estimate.
    expect(score(run(answer({ requirements: [classLine] }), { sources, classYear: { excluded: false, text: '面向2027届毕业生' } }), 'title_level')).toBe(100);
    // Outside GoApply there is no profile rule, so the line is judged like any other education line.
    expect(score(run(answer({ requirements: [classLine] }), { sources }), 'title_level')).toBe(50);
  });

  it('classYearEligibility is the estimate\'s rule, case for case', () => {
    const cases: Array<{ market: string; classYears: number[]; classYear: number | null }> = [];
    for (const market of ['cn', 'intl']) for (const classYears of [[], [2027], [2026, 2027]]) for (const classYear of [null, 2026, 2027, 2024]) cases.push({ market, classYears, classYear });
    for (const c of cases) {
      const user = matchUser({ market: c.market, classYear: c.classYear });
      const job = matchJob({ market: c.market, classYears: c.classYears, classYearQuote: c.classYears.length ? '面向应届毕业生' : null });
      const estimateHalves = titleLevelDimension(user, job, WEIGHTS).evidence.some((e) => e.ref === 'class_year');
      const mine = classYearEligibility(user, job);
      expect(mine?.excluded ?? false, JSON.stringify(c)).toBe(estimateHalves);
      expect(mine === null, JSON.stringify(c)).toBe(c.market !== 'cn');
    }
    expect(classYearEligibility(matchUser({ market: 'cn', classYear: 2024 }), matchJob({ market: 'cn', classYears: [2026, 2027], classYearQuote: null }))).toEqual({ excluded: true, text: '2026, 2027' });
    expect(isClassYearLine('面向2027届毕业生')).toBe(true);
    expect(isClassYearLine('2026 届本科及以上学历')).toBe(true);
    expect(isClassYearLine('仅限应届生')).toBe(true);
    expect(isClassYearLine('Class of 2027')).toBe(true);
    expect(isClassYearLine('Graduating between 2026 and 2027')).toBe(true);
    expect(isClassYearLine('本科及以上学历，计算机相关专业')).toBe(false);
    expect(isClassYearLine("Bachelor's degree in Computer Science")).toBe(false);
  });
});

describe('the posting\'s stored list: every person is judged against the same lines', () => {
  const stored: JobRequirement[] = [
    { id: 'r1', kind: 'experience', text: '5+ years of backend experience', importance: 'must' },
    { id: 'r2', kind: 'skill', text: 'Kubernetes required', importance: 'must' },
    { id: 'r3', kind: 'skill', text: 'Nice to have: Rust', importance: 'preferred' },
  ];
  const filled = (over: Array<Partial<ScorerV4RequirementAnswer>> = []): ScorerV4RequirementAnswer[] => [
    { id: 'r1', kind: 'experience', text: '5+ years of backend experience', importance: 'must', status: 'met', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)', ...over[0] },
    { id: 'r2', kind: 'skill', text: 'Kubernetes required', importance: 'must', status: 'not_shown', evidence: '', ...over[1] },
    { id: 'r3', kind: 'skill', text: 'Nice to have: Rust', importance: 'preferred', status: 'not_shown', evidence: '', ...over[2] },
  ];

  it('id, kind, text and importance come from the store, never from the model; nothing new is stored', () => {
    const tampered = filled([{ text: 'One year of backend experience', kind: 'skill', importance: 'preferred' }, { importance: 'preferred' }, {}]);
    const result = run(answer({ requirements: tampered }), { stored });
    expect(result.requirements.map(({ id, kind, text, importance }) => ({ id, kind, text, importance }))).toEqual(stored);
    expect(result.extracted).toBeNull();
    // must met 1, must not shown 0, preferred not shown 0: 100 × 1 / 2.5 = 40
    expect(score(result, 'skills')).toBe(40);
  });

  it('an answer that names a stored line by its id only (no kind, no importance, no text) is a full answer', () => {
    const bare: ScorerV4RequirementAnswer[] = filled().map((a) => ({ id: a.id, kind: null, text: '', importance: null, status: a.status, evidence: a.evidence }));
    const result = run(answer({ requirements: bare }), { stored });
    expect(result.requirements).toEqual(run(answer({ requirements: filled() }), { stored }).requirements);
    expect(score(result, 'skills')).toBe(40);
    expect(result.unverified).toBe(0);
  });

  it('two people scored on the same job read the same ids and lines; only status and evidence differ', () => {
    const first = run(answer({ requirements: filled() }), { stored });
    const second = run(answer({ requirements: filled([{ status: 'not_shown', evidence: '' }, {}, { status: 'met', evidence: 'TypeScript, Go, PostgreSQL' }]) }), { stored, sources: { resume: RESUME, posting: POSTING } });
    const lines = (r: typeof first) => r.requirements.map(({ id, kind, text, importance }) => ({ id, kind, text, importance }));
    expect(lines(first)).toEqual(lines(second));
    expect(first.requirements.map((r) => r.status)).toEqual(['met', 'not_shown', 'not_shown']);
    expect(second.requirements.map((r) => r.status)).toEqual(['not_shown', 'not_shown', 'met']);
  });

  it('a model cannot take a stored line out of the score: its "not_applicable" reads "not shown" (M4 cross-review)', () => {
    // Four must-have lines the posting's stored list holds; the resume shows one.
    const four: JobRequirement[] = [
      { id: 'r1', kind: 'experience', text: '5+ years of backend experience', importance: 'must' },
      { id: 'r2', kind: 'skill', text: 'Kubernetes required', importance: 'must' },
      { id: 'r3', kind: 'skill', text: 'Terraform required', importance: 'must' },
      { id: 'r4', kind: 'experience', text: 'Experience leading an on-call rotation', importance: 'must' },
    ];
    const answers = (rest: ScorerV4RequirementAnswer['status']): ScorerV4RequirementAnswer[] => [
      { ...four[0]!, status: 'met', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' },
      ...four.slice(1).map((line) => ({ ...line, status: rest, evidence: '' })),
    ];
    const notShown = run(answer({ requirements: answers('not_shown') }), { stored: four });
    const notApplicable = run(answer({ requirements: answers('not_applicable') }), { stored: four });
    // One of four must-have lines: 25. Before this rule the second answer left three lines out and read 100.
    expect(score(notShown, 'skills')).toBe(25);
    expect(score(notApplicable, 'skills')).toBe(25);
    expect(notApplicable.requirements.map((r) => r.status)).toEqual(['met', 'not_shown', 'not_shown', 'not_shown']);
    expect(notApplicable.requirements).toEqual(notShown.requirements);
    expect(notApplicable.dimensions).toEqual(notShown.dimensions);
    // A required degree answered "not applicable" halves the level like one answered "not shown": the same line for everyone.
    const degree: JobRequirement[] = [{ id: 'r1', kind: 'education', text: "Bachelor's degree in Computer Science", importance: 'must' }];
    const level = (status: ScorerV4RequirementAnswer['status']) => score(run(answer({ requirements: [{ ...degree[0]!, status, evidence: '' }] }), { stored: degree }), 'title_level');
    expect(level('not_applicable')).toBe(level('not_shown'));
    expect(level('not_applicable')).toBe(50);
    // The server's own "never judged" lines stay not applicable (an age line, a school tier), whatever was answered.
    const age: JobRequirement[] = [{ id: 'r1', kind: 'experience', text: '年龄35岁以下', importance: 'must' }, four[1]!];
    const withAge = run(answer({ requirements: [{ ...age[0]!, status: 'not_applicable', evidence: '' }, { ...age[1]!, status: 'not_applicable', evidence: '' }] }), { stored: age });
    expect(withAge.requirements.map((r) => r.status)).toEqual(['not_applicable', 'not_shown']);
    // A COPIED line the model marks not applicable is still not a line of the checklist (nothing to store or judge).
    expect(run(answer()).requirements.map((r) => r.text)).not.toContain('We offer a gym membership');
  });

  it('the stored order is kept, an entry the list does not have is ignored, and an answer that leaves a line out is refused', () => {
    const shuffled = [...filled()].reverse();
    const extra: ScorerV4RequirementAnswer = { id: 'r9', kind: 'skill', text: 'Go', importance: 'must', status: 'met', evidence: 'TypeScript, Go, PostgreSQL' };
    const result = run(answer({ requirements: [extra, ...shuffled] }), { stored });
    expect(result.requirements.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(score(result, 'skills')).toBe(40);
    expect(() => run(answer({ requirements: filled().slice(0, 2) }), { stored })).toThrow(ScorerV4ChecklistError);
    expect(() => run(answer({ requirements: filled().slice(0, 2) }), { stored })).toThrow(/no entry for requirement r3/);
    expect(() => run(answer({ requirements: [] }), { stored })).toThrow(/r1/);
    // A stored line is not checked against the posting text again: the store is the posting's list.
    expect(run(answer({ requirements: filled() }), { stored, sources: { resume: RESUME, posting: 'Another text entirely.' } }).requirements).toHaveLength(3);
    // An empty stored list is "no list": the model's own copy is verified against the posting.
    expect(run(answer(), { stored: [] }).extracted).toHaveLength(4);
  });

  it('readStoredRequirements: the v1 document, its four fields per line, one entry per id; anything else is "no list"', () => {
    const doc = { v: 1, contentHash: 'h', model: 'm', extractedAt: '2026-10-10T08:00:00.000Z', items: stored };
    expect(readStoredRequirements(doc)).toEqual(stored);
    // A field a later writer adds to a line does not hide the list; a bad line and a repeated id are dropped.
    expect(readStoredRequirements({ ...doc, items: [{ ...stored[0], skillId: 'sk_1' }, { id: 'r1', kind: 'skill', text: 'again', importance: 'must' }, { id: 'r5', kind: 'tool', text: 'x', importance: 'must' }, null, 'r2'] })).toEqual([stored[0]]);
    for (const none of [null, undefined, 'r1', [], {}, { v: 2, items: stored }, { v: 1 }, { v: 1, items: [] }, { v: 1, items: [{ id: '', kind: 'skill', text: 'x', importance: 'must' }] }]) {
      expect(readStoredRequirements(none), JSON.stringify(none)).toBeNull();
    }
    // A stored list longer than the scorer's own cap is judged on its first 12 lines, the same 12 for everyone.
    const long = Array.from({ length: 20 }, (_, i): JobRequirement => ({ id: `r${i + 1}`, kind: 'skill', text: `Line ${i + 1}`, importance: 'preferred' }));
    expect(readStoredRequirements({ ...doc, items: long })!.map((r) => r.id)).toEqual(long.slice(0, 12).map((r) => r.id));
    expect(readStoredRequirements({ ...doc, items: long }, { max: 3 })).toHaveLength(3);
    // A list is the posting's for the text it was copied from: with the posting's hash given, a list of another
    // text (or one that says nothing about its text) is "no list". Without a hash given, any v1 list is read.
    expect(readStoredRequirements(doc, { contentHash: 'h' })).toEqual(stored);
    expect(readStoredRequirements(doc, { contentHash: 'another-text' })).toBeNull();
    expect(readStoredRequirements({ v: 1, items: stored }, { contentHash: 'h' })).toBeNull();
    expect(readStoredRequirements({ v: 1, items: stored })).toEqual(stored);
    expect(readStoredRequirements(doc, { contentHash: null })).toEqual(stored);
    expect(readRequirementChecks(null)).toEqual([]);
    expect(readRequirementChecks([{ id: 'r1', kind: 'skill', text: 'Go', importance: 'must', status: 'shown', evidence: '' }])).toEqual([]);
  });
});

describe('lines that are never judged', () => {
  const NEVER = [
    '年龄35岁以下',
    '35 周岁以内',
    'Candidates must be under the age of 35',
    'Aged 25-35',
    '25 to 35 years old',
    '限男性',
    '女性优先',
    'Male candidates preferred',
    'Marital status: single',
    '已婚已育优先',
    '本地户口优先',
    '籍贯不限，党员优先',
    '政治面貌：中共党员',
    '形象气质佳，五官端正',
    '请附近照',
    '985/211 院校本科及以上学历',
    '双一流高校毕业',
    'Degree from a top 50 university',
    'Ivy League education preferred',
    'Must be a US citizen',
    'U.S. citizens or permanent residents only',
    'Must be a citizen of the United States',
    'US citizenship required',
    'Eligible to work in Singapore',
    'Authorized to work in the UK without sponsorship',
    'Visa sponsorship is not available',
    '需持有有效工作签证',
  ];
  const ORDINARY = [
    '5+ years of backend experience',
    'Experience managing a team of five',
    'Average response time under 200 ms',
    'Fluent in a second language',
    'Debugging race conditions in concurrent code',
    'Photo editing in Lightroom',
    'Knowledge of Visa and Mastercard network rules',
    'Sponsorship sales experience',
    'An active security clearance',
    'Must be able to work with citizens and stakeholders',
    'Experience caring for senior citizens',
    'Senior stakeholder management',
    'Three years of page speed optimisation',
    '女装电商运营经验',
    '熟悉民法典优先',
    'ISO 27001 experience',
    '本科及以上学历，计算机相关专业',
    '写过一本技术书籍',
    'Kubernetes required',
    "Bachelor's degree in Computer Science",
    // The topic as the work itself (immigration, global mobility, education sales, public-sector systems, products
    // for an age group): these are the posting's core requirements and stay in the checklist.
    'Knowledge of immigration law: work permits, green card petitions',
    'Experience with citizenship applications (paralegal)',
    'Experience managing Visa sponsorship programs for clients',
    'Experience with I-9 and work authorization verification',
    'Requires experience selling sponsorship packages',
    'Experience selling to top universities',
    'Target schools partnership management experience',
    'Design systems for users aged 65 and older',
    'Serve seniors over the age of 65',
    'Must manage over 20 direct reports',
    'Candidates must have at least 10 years of experience',
    'Familiarity with 211 call center systems',
    '211 East Street warehouse operations',
    'You will manage national accounts only',
    'Must be a national account manager',
    'Experience teaching religion and ethics',
    '负责民族品牌推广',
    '民族品牌营销经验',
    '党员管理系统开发经验',
    '户籍管理系统经验',
    '熟悉权限管理和户籍系统',
    '要求熟悉户籍管理',
    '熟悉工作签证办理流程',
    '熟悉中国国籍法',
    '负责985院校客户销售',
    '服务211家以上客户',
    '负责重点大学客户拓展',
    '婚姻家庭咨询经验',
    '证件照拍摄及修图经验',
    '面向18岁以上用户的产品设计经验',
    '负责3-6岁年龄段儿童教育产品',
    '10年以上Java经验',
    'Current knowledge of work permit rules',
    'Requires knowledge of work permit processing',
    'Submit product photo retouching samples',
    '提供证件照拍摄服务',
    'Candidates should handle hardware older than 10 years',
    '有限女装公司运营经验',
    '熟悉本市户籍管理政策',
    'Experience in graduate recruitment',
  ];
  /** More wordings about the applicant, beyond the first list. */
  const NEVER_MORE = [
    '年龄：25-35岁',
    '年龄不超过35岁',
    '年龄在22-30岁之间',
    'Age limit: 35',
    'Must be at least 21 years old',
    'Applicants aged 25-35',
    '性别不限',
    '限北京户口',
    '要求本地户籍',
    '中共党员优先',
    '限党员',
    '民族：汉族',
    '少数民族优先',
    '请提供近期免冠照片',
    'Please attach a recent photo',
    'Nationality: Singaporean',
    '要求中国国籍',
    'We are unable to sponsor visas',
    'Must not require sponsorship now or in the future',
    'Must have the right to work in the UK',
    'Work permit required',
    'Green card required',
    'EU nationals only',
    '985/211优先',
    '重点大学本科及以上学历',
    'Graduate of a top-tier university',
    'MBA from a target school',
    'Must be younger than 35',
    'Include your photo',
    '请附一寸照片',
    'Requires work authorization in the US',
    'Must have a valid work permit',
    '仅限女性',
  ];

  it('age, gender, marital status, 籍贯 and 户口, political status, appearance, school tier, citizenship and work authorization match; ordinary requirement text does not', () => {
    for (const line of [...NEVER, ...NEVER_MORE]) expect(isNotJudgedRequirement(line), line).toBe(true);
    for (const line of ORDINARY) expect(isNotJudgedRequirement(line), line).toBe(false);
  });

  it('the topic word alone is not enough: a line about the work stays a requirement and is judged like any other', () => {
    // An immigration paralegal posting: its core lines are counted, and a resume that does not show them reads 0, not "not stated".
    const lines = ['Knowledge of immigration law: work permits, green card petitions', 'Experience with citizenship applications (paralegal)'];
    const posting = lines.join('\n');
    const result = run(answer({ requirements: lines.map((text, i) => ({ id: `x${i}`, kind: 'experience' as const, text, importance: 'must' as const, status: 'not_shown' as const, evidence: '' })) }), { sources: { resume: RESUME, posting }, posting: { listsSkillsOrYears: true, hasQualifications: true } });
    expect(result.requirements.map((r) => r.status)).toEqual(['not_shown', 'not_shown']);
    expect(score(result, 'skills')).toBe(0);
    expect(result.extracted).toHaveLength(2);
  });

  it('a known over-match is on the safe side: such a line is left out, never held against anyone', () => {
    // A school tier next to a degree word reads as a school-tier line also when the line is about the work.
    expect(isNotJudgedRequirement('Experience in graduate admissions at elite universities')).toBe(true);
    expect(isNotJudgedRequirement('985/211高校毕业生招聘经验')).toBe(true);
  });

  it('a stored line of that kind is not applicable for everyone, whatever the model answered; a copied one is not kept', () => {
    const stored: JobRequirement[] = [
      { id: 'r1', kind: 'experience', text: '年龄35岁以下', importance: 'must' },
      { id: 'r2', kind: 'education', text: '985/211 院校本科及以上学历', importance: 'must' },
      { id: 'r3', kind: 'skill', text: 'Kubernetes required', importance: 'must' },
    ];
    const answers: ScorerV4RequirementAnswer[] = [
      { ...stored[0]!, status: 'not_shown', evidence: '' },
      { ...stored[1]!, status: 'not_shown', evidence: '' },
      { ...stored[2]!, status: 'not_shown', evidence: '' },
    ];
    const result = run(answer({ requirements: answers }), { stored });
    expect(result.requirements.map((r) => r.status)).toEqual(['not_applicable', 'not_applicable', 'not_shown']);
    // The age line is not in the skills component and the school-tier line does not halve the level.
    expect(score(result, 'skills')).toBe(0);
    expect(score(result, 'title_level')).toBe(100);
    // Even a "met" is not kept: the line is not judged at all.
    const met = run(answer({ requirements: [{ ...answers[0]!, status: 'met', evidence: 'TypeScript, Go, PostgreSQL' }, answers[1]!, answers[2]!] }), { stored });
    expect(met.requirements[0]).toMatchObject({ status: 'not_applicable', evidence: '' });

    const posting = `${POSTING}\n\n年龄35岁以下\n\nMust be a US citizen`;
    const copied = run(answer({ requirements: [R.years, { id: 'x', kind: 'experience', text: '年龄35岁以下', importance: 'must', status: 'not_shown', evidence: '' }, { id: 'y', kind: 'scope', text: 'Must be a US citizen', importance: 'must', status: 'not_shown', evidence: '' }] }), { sources: { resume: RESUME, posting } });
    expect(copied.requirements.map((r) => r.text)).toEqual(['5+ years of backend experience']);
    expect(copied.extracted).toHaveLength(1);
    expect(score(copied, 'skills')).toBe(100);
  });
});

describe('borderlineTier: a new total within 3 points of an edge takes the estimate\'s side of it (I5)', () => {
  const T = { ...DEFAULT_MATCH_TIERS };

  it('the two cases of the plan: 66 with an estimate of 58 is Possible; 69 is Good', () => {
    expect(borderlineTier(66, 58, T)).toEqual({ tier: 'possible', edge: 65 });
    expect(borderlineTier(69, 58, T)).toEqual({ tier: 'good', edge: null });
  });

  it.each([
    // total, estimate, tier, edge
    [63, 70, 'good', 65],
    [64, 70, 'good', 65],
    [65, 64, 'possible', 65],
    [65, 65, 'good', 65],
    [67, 20, 'possible', 65],
    [67, 90, 'good', 65], // the estimate is far above: still only the tier just over this edge
    [62, 70, 'possible', null], // 3 points under: no longer within
    [68, 10, 'good', null], // 3 points over
    [78, 85, 'great', 80],
    [79, 70, 'good', 80],
    [80, 79, 'good', 80],
    [82, 60, 'good', 80],
    [83, 60, 'great', null],
    [77, 95, 'good', null],
    [43, 50, 'possible', 45],
    [44, 20, 'unlikely', 45],
    [46, 30, 'unlikely', 45],
    [47, 45, 'possible', 45],
    [48, 30, 'possible', null],
    [42, 90, 'unlikely', null],
    [0, 100, 'unlikely', null],
    [100, 0, 'great', null],
  ] as const)('total %s, estimate %s → %s (edge %s)', (total, estimate, tier, edge) => {
    expect(borderlineTier(total, estimate, T)).toEqual({ tier, edge });
  });

  it('with no estimate the total keeps its own tier; configured edges are read, and the nearer of two close edges decides', () => {
    expect(borderlineTier(66, null, T)).toEqual({ tier: 'good', edge: null });
    expect(borderlineTier(66, undefined, T)).toEqual({ tier: 'good', edge: null });
    expect(borderlineTier(66, Number.NaN, T)).toEqual({ tier: 'good', edge: null });
    const custom = { great: 85, good: 70, possible: 50 };
    expect(borderlineTier(71, 60, custom)).toEqual({ tier: 'possible', edge: 70 });
    expect(borderlineTier(66, 58, custom)).toEqual({ tier: 'possible', edge: null });
    const close = { great: 90, good: 52, possible: 50 };
    expect(borderlineTier(52, 40, close)).toEqual({ tier: 'possible', edge: 52 });
    expect(borderlineTier(50, 60, close)).toEqual({ tier: 'possible', edge: 50 });
  });

  it('three runs that scatter around an edge store one tier', () => {
    for (const estimate of [58, 71]) {
      const tiers = [63, 64, 65, 66, 67].map((total) => borderlineTier(total, estimate, T).tier);
      expect(new Set(tiers).size, String(estimate)).toBe(1);
    }
  });
});
