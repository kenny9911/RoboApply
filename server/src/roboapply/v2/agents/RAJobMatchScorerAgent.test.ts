import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SCORER_V4_ANSWER_ERROR } from '../../../features/match/scorerV4.js';
import { SENIORITY_LEVELS } from '../../../features/search/contract.js';
import {
  RAJobMatchScorerAgent,
  RAJobMatchScorerV4Agent,
  SCORER_V4_EXTRACT_MAX,
  SCORER_V4_JOB_SECTION,
  SCORER_V4_LEVELS,
  SCORER_V4_PARSE_REQUIREMENTS_CAP,
  SCORER_V4_PROMPT_VERSION,
  SCORER_V4_STATUSES,
  ScorerV4AnswerError,
  formatScorerV4Candidate,
  parseScorerV4Output,
  pickJobMatchScorerModel,
  resolvedJobMatchScorerModel,
  scorerV4Direction,
  type RAJobMatchScorerV4Input,
} from './RAJobMatchScorerAgent.js';

const MODEL_ENV_KEYS = [
  'LLM_MATCHING_MODEL',
  'LLM_MATCHING_REASONING_EFFORT',
  'LLM_MODEL',
  'LLM_SETTINGS_DB_DISABLED',
  'RA_V2_JOB_MATCH_SCORER_MODEL',
] as const;

class ScorerProbe extends RAJobMatchScorerAgent {
  readReasoningEffort() {
    return this.getReasoningEffort();
  }
}

describe('pickJobMatchScorerModel', () => {
  let savedEnv: Record<(typeof MODEL_ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      MODEL_ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as typeof savedEnv;
    for (const key of MODEL_ENV_KEYS) delete process.env[key];
    process.env.LLM_SETTINGS_DB_DISABLED = 'true';
  });

  afterEach(() => {
    for (const key of MODEL_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses LLM_MATCHING_MODEL at call time', () => {
    process.env.LLM_MATCHING_MODEL = '  deepseek/deepseek-v4-flash  ';

    expect(pickJobMatchScorerModel()).toBe('deepseek/deepseek-v4-flash');
  });

  it('does not let the retired scorer-specific env override the matching model', () => {
    process.env.LLM_MATCHING_MODEL = 'deepseek/deepseek-v4-flash';
    process.env.RA_V2_JOB_MATCH_SCORER_MODEL = 'legacy/scorer-model';

    expect(pickJobMatchScorerModel()).toBe('deepseek/deepseek-v4-flash');
  });

  it('falls through to the configured stack default when the task model is blank', () => {
    process.env.LLM_MATCHING_MODEL = '   ';
    process.env.LLM_MODEL = 'openrouter/test/default-model';

    expect(pickJobMatchScorerModel()).toBeUndefined();
    expect(resolvedJobMatchScorerModel()).toBe('openrouter/test/default-model');
  });

  it('resolves the default sentinel to the effective stack model', () => {
    process.env.LLM_MATCHING_MODEL = 'default';
    process.env.LLM_MODEL = 'openrouter/test/default-model';

    expect(resolvedJobMatchScorerModel()).toBe('openrouter/test/default-model');
  });

  it('fails before persistence when neither scorer nor stack model is configured', () => {
    expect(() => resolvedJobMatchScorerModel()).toThrow('Set LLM_MATCHING_MODEL or LLM_MODEL');
  });

  it('uses the matching-specific reasoning effort', () => {
    process.env.LLM_MATCHING_REASONING_EFFORT = ' HIGH ';

    expect(new ScorerProbe().readReasoningEffort()).toBe('high');
  });
});

// ── Scorer v4 (MKT-4G; MARKET_STRATEGY 2.1 point 5): the checklist, never a number ──
// Prompt, input order and parsing only. No model is called anywhere in this file.

class V4Probe extends RAJobMatchScorerV4Agent {
  prompt() {
    return this.getAgentPrompt();
  }
  input(i: RAJobMatchScorerV4Input) {
    return this.formatInput(i);
  }
  parse(r: string) {
    return this.parseOutput(r);
  }
  temperature() {
    return this.getTemperature();
  }
  maxTokens() {
    return this.getMaxTokens();
  }
  directive(locale: string) {
    return this.getLocaleDirective(locale);
  }
}

const v4 = new V4Probe();

const RESUME = '# [removed]\n\n## Experience\nSenior Software Engineer, PayCo (2019-01 – present)\n- Built payment APIs in TypeScript and Go serving 2M users.\n\n## Skills\nTypeScript, Go, PostgreSQL';
const PROFILE = 'Headline: Senior Software Engineer\nYears of experience: 6';

function v4Input(over: Partial<RAJobMatchScorerV4Input> = {}): RAJobMatchScorerV4Input {
  return {
    resumeMarkdown: RESUME,
    profileContext: PROFILE,
    job: { title: 'Backend Engineer', companyName: 'Acme', seniority: 'senior', educationLevel: 'master', minYears: 5, skills: ['go', 'kubernetes'], description: 'Build APIs in Go.', qualifications: '5+ years of backend experience. Kubernetes required.', responsibilities: null },
    requirements: null,
    logistics: { lines: ['Location: fits what the candidate asked for'] },
    ...over,
  };
}

/** A complete, valid answer. */
function v4Answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirements: [
      { id: 'r1', kind: 'experience', text: '5+ years of backend experience', importance: 'must', status: 'met', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' },
      { id: 'r2', kind: 'skill', text: 'Kubernetes required', importance: 'must', status: 'not_shown', evidence: '' },
    ],
    level: { post: 'senior', resume: 'senior', direction: 'match' },
    domain: { status: 'adjacent', evidence: 'Built payment APIs in TypeScript and Go serving 2M users.' },
    trajectory: { status: 'toward', evidence: '' },
    strengths: ['Your payment APIs in Go'],
    gaps: ['No Kubernetes work shown'],
    summary: 'Your backend work in Go lines up, though the post centres on Kubernetes.',
    ...over,
  };
}

describe('RAJobMatchScorerV4Agent: the prompt', () => {
  it('asks for a checklist with the four anchored statuses and never for a number', () => {
    const p = v4.prompt();
    // The anchors, word for word as the model must use them.
    for (const status of SCORER_V4_STATUSES) expect(p, status).toContain(`- ${status}:`);
    expect(p).toMatch(/met: the resume shows it plainly\. "evidence" is one EXACT quote from the resume/);
    expect(p).toMatch(/partly: the resume shows related or shorter experience/);
    expect(p).toMatch(/not_shown: nothing in the resume shows it\. "evidence" is ""/);
    expect(p).toMatch(/not_applicable: the line is not a requirement of the candidate \(for example a benefits\s+line/);
    // A quote is the phrase or line that shows the requirement: a single word decides nothing a reader can check.
    expect(p).toMatch(/Quote the phrase or the whole line that shows the\s+requirement, not a single word on its own/);
    expect(p).toContain(SCORER_V4_LEVELS.join(' | '));
    expect(p).toContain('direct (the same');
    expect(p).toContain('toward |');
    // The v3 instruction to score is gone, and so is every number in the output schema.
    expect(p).not.toMatch(/score each/i);
    expect(p).not.toMatch(/0-100/);
    expect(p).not.toMatch(/"score"/);
    expect(p).toMatch(/Never output a score, a total, a percentage/);
  });

  it('keeps the persona, the second-person rule and the hard rules of v3 (never invent; school tier and sensitive attributes are not inputs; gaps are observations)', () => {
    const p = v4.prompt();
    expect(p).toMatch(/^You are RoboApply's fit scorer/);
    expect(p).toMatch(/SECOND PERSON/);
    expect(p).toMatch(/Never invent skills or experience/);
    expect(p).toMatch(/985\/211\/双一流/);
    for (const word of ['age', 'gender', 'nationality', 'ethnicity', 'family', 'photo', '籍贯', '政治面貌']) expect(p, word).toContain(word);
    expect(p).toMatch(/Gaps are\s+observations about the resume/);
    expect(p).toMatch(/Never state a number, percentage or score/);
    // Logistics stay computed, never judged.
    expect(p).toMatch(/Location, pay and visa are NOT yours to judge/);
  });

  it('stored-requirements mode: the model returns exactly the given ids and texts and only fills status and evidence', () => {
    const p = v4.prompt();
    expect(p).toMatch(/When the input has a section "Requirements to check", return exactly those entries/);
    expect(p).toMatch(/Fill only "status" and\s+"evidence"\. Add none, drop none, reword none/);
    expect(p).toContain(`at most\n  ${SCORER_V4_EXTRACT_MAX}`);
    expect(SCORER_V4_EXTRACT_MAX).toBe(12);
  });

  it('temperature 0, 2,400 output tokens, prompt version scorer_v4, and the six level names of the search contract', () => {
    expect(v4.temperature()).toBe(0);
    expect(v4.maxTokens()).toBe(2400);
    expect(SCORER_V4_PROMPT_VERSION).toBe('scorer_v4');
    expect([...SCORER_V4_LEVELS]).toEqual([...SENIORITY_LEVELS]);
  });

  it('the written parts follow the UI language; requirement lines, quotes and fixed-list values are never translated', () => {
    const zh = v4.directive('zh')!;
    expect(zh).toMatch(/Write "strengths", "gaps" and "summary" in Chinese/);
    expect(zh).toMatch(/NEVER translate anything else\. Every "text" and every "evidence" is copied character for character/);
    expect(zh).toMatch(/kind, importance, status, the level names, direction/);
    // The strict directive of v3 asks for "evidence sentences" in the UI language: a translated quote would fail the
    // server's verbatim check, so v4 does not use it.
    expect(zh).not.toMatch(/evidence sentences/);
    expect(v4.directive('en')).toMatch(/in English/);
  });
});

describe('RAJobMatchScorerV4Agent: the input, resume first', () => {
  it('starts with the candidate block, byte for byte the same for two jobs of one person, up to the job section', () => {
    const a = v4.input(v4Input());
    const b = v4.input(
      v4Input({
        job: { title: 'Staff Data Engineer', companyName: 'Globex', seniority: 'lead_staff', educationLevel: null, minYears: 8, skills: ['spark'], description: 'Own the data platform.', qualifications: null, responsibilities: 'Lead a team of five.' },
        requirements: [{ id: 'r1', kind: 'scope', text: 'Lead a team of five', importance: 'must' }],
        logistics: { lines: ['Pay: does not fit what the candidate asked for'] },
      }),
    );
    expect(a).not.toBe(b);
    const cut = (text: string) => text.slice(0, text.indexOf(SCORER_V4_JOB_SECTION));
    expect(a.indexOf(SCORER_V4_JOB_SECTION)).toBeGreaterThan(0);
    expect(cut(a)).toBe(cut(b));
    expect(cut(a)).toBe(`${formatScorerV4Candidate({ resumeMarkdown: RESUME, profileContext: PROFILE })}\n\n`);
    // Profile, then resume, then the job, then the logistics facts last.
    expect(a.startsWith('## Candidate profile\n')).toBe(true);
    const order = ['## Candidate profile', '## Candidate resume', '## Job post', '## Qualifications', '## Location, pay and visa (computed; given as fact)'].map((h) => a.indexOf(h));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(a.trimEnd().endsWith('Output ONLY the JSON object.')).toBe(true);
    // Without a profile the resume is the first block.
    expect(v4.input(v4Input({ profileContext: null })).startsWith('## Candidate resume\n')).toBe(true);
  });

  it('states the posting facts and the logistics as given; the saved search is not an input', () => {
    const text = v4.input(v4Input());
    expect(text).toContain('Degree the post asks for: master');
    expect(text).toContain('Years of experience the post asks for: 5+');
    expect(text).toContain('Location: fits what the candidate asked for');
    expect(text).not.toMatch(/What the candidate is looking for/);
    expect(v4.input(v4Input({ logistics: { lines: [] } }))).toContain('Nothing stated to compare.');
  });

  it('with a stored list the ids, kinds, importances and texts are given one per line; without one the model is told to copy at most 12 lines', () => {
    const stored = [
      { id: 'r1', kind: 'experience' as const, text: '5+ years of backend experience', importance: 'must' as const },
      { id: 'r2', kind: 'skill' as const, text: 'Kubernetes required', importance: 'preferred' as const },
    ];
    const withList = v4.input(v4Input({ requirements: stored }));
    expect(withList).toContain('## Requirements to check\n{"id":"r1","kind":"experience","importance":"must","text":"5+ years of backend experience"}\n{"id":"r2","kind":"skill","importance":"preferred","text":"Kubernetes required"}');
    expect(withList).toMatch(/Fill the checklist for exactly the entries under "Requirements to check"/);
    const without = v4.input(v4Input({ requirements: [] }));
    expect(without).not.toContain('## Requirements to check');
    expect(without).toMatch(/Copy at most 12 requirement lines from the job post/);
    // The list sits after the job post, so it never moves the cached candidate prefix.
    expect(withList.indexOf('## Requirements to check')).toBeGreaterThan(withList.indexOf(SCORER_V4_JOB_SECTION));
  });
});

describe('RAJobMatchScorerV4Agent: parsing', () => {
  it('a valid answer parses into the typed checklist, ids kept as given', () => {
    const out = v4.parse(JSON.stringify(v4Answer()));
    expect(out.requirements).toEqual([
      { id: 'r1', kind: 'experience', text: '5+ years of backend experience', importance: 'must', status: 'met', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' },
      { id: 'r2', kind: 'skill', text: 'Kubernetes required', importance: 'must', status: 'not_shown', evidence: '' },
    ]);
    expect(out.level).toEqual({ post: 'senior', resume: 'senior', direction: 'match' });
    expect(out.domain).toEqual({ status: 'adjacent', evidence: 'Built payment APIs in TypeScript and Go serving 2M users.' });
    expect(out.trajectory).toEqual({ status: 'toward', evidence: '' });
    expect(out.strengths).toEqual(['Your payment APIs in Go']);
    expect(out.summary).toBe('Your backend work in Go lines up, though the post centres on Kubernetes.');
    // Code fences and prose around the object are tolerated, as in v3.
    expect(v4.parse('```json\n' + JSON.stringify(v4Answer()) + '\n```').requirements).toHaveLength(2);
    expect(v4.parse('Here it is:\n' + JSON.stringify(v4Answer())).level.post).toBe('senior');
    expect(parseScorerV4Output(JSON.stringify(v4Answer()))).toEqual(out);
  });

  it('a number the model adds anyway is never read: the checklist holds no score at any depth', () => {
    const withNumbers = v4Answer({
      score: 97,
      total: 97,
      percentage: '97%',
      requirements: [{ id: 'r1', kind: 'skill', text: 'Go', importance: 'must', status: 'met', evidence: 'Go', score: 100, points: 1 }],
      level: { post: 'senior', resume: 'mid', direction: 'post_higher', score: 60 },
      domain: { status: 'direct', evidence: '', score: 100 },
      trajectory: { status: 'neutral', evidence: '', score: 60 },
    });
    const out = v4.parse(JSON.stringify(withNumbers));
    const plain = v4.parse(JSON.stringify({ ...withNumbers, score: undefined, total: undefined, percentage: undefined }));
    expect(out).toEqual(plain);
    const hasNumber = (v: unknown): boolean => (typeof v === 'number' ? true : Array.isArray(v) ? v.some(hasNumber) : !!v && typeof v === 'object' ? Object.values(v).some(hasNumber) : false);
    expect(hasNumber(out)).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/score|total|percentage|points/);
  });

  it('a value outside its fixed list throws: nothing is guessed', () => {
    const entry = { id: 'r1', kind: 'skill', text: 'Go', importance: 'must', status: 'met', evidence: 'Go' };
    const bad = (over: Record<string, unknown>) => () => v4.parse(JSON.stringify(v4Answer(over)));
    expect(bad({ requirements: [{ ...entry, status: 'mostly_met' }] })).toThrow(/unknown requirement status for r1/);
    expect(bad({ requirements: [{ ...entry, status: 0.8 }] })).toThrow(/unknown requirement status/);
    expect(bad({ requirements: [{ ...entry, kind: 'certificate' }] })).toThrow(/unknown requirement kind/);
    expect(bad({ requirements: [{ ...entry, importance: 'required' }] })).toThrow(/unknown requirement importance/);
    expect(bad({ level: { post: 'principal', resume: 'senior', direction: 'match' } })).toThrow(/unknown level\.post/);
    expect(bad({ level: { post: 'senior', resume: 'unknown' } })).toThrow(/unknown level\.resume/);
    expect(bad({ domain: { status: 'close', evidence: '' } })).toThrow(/unknown domain status/);
    expect(bad({ trajectory: { status: 'sideways', evidence: '' } })).toThrow(/unknown trajectory status/);
    // Letter case and spacing are not a different value.
    expect(v4.parse(JSON.stringify(v4Answer({ requirements: [{ ...entry, status: ' MET ' }] }))).requirements[0]!.status).toBe('met');
  });

  it('kind and importance may be left out (the server reads them from a stored list); one that is given and is not on its list still throws', () => {
    const parse = (requirements: unknown[]) => v4.parse(JSON.stringify(v4Answer({ requirements }))).requirements;
    // The answer to a stored list: "Fill only status and evidence".
    expect(parse([{ id: 'r1', status: 'met', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' }])).toEqual([
      { id: 'r1', kind: null, text: '', importance: null, status: 'met', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' },
    ]);
    expect(parse([{ id: 'r1', kind: null, importance: '', text: 'Go', status: 'not_shown' }])).toEqual([{ id: 'r1', kind: null, text: 'Go', importance: null, status: 'not_shown', evidence: '' }]);
    expect(parse([{ id: 'r1', kind: 'SKILL', importance: ' Must ', status: 'partly', evidence: 'x' }])[0]).toMatchObject({ kind: 'skill', importance: 'must' });
    // Present and wrong is never read as absent.
    expect(() => parse([{ id: 'r1', kind: 'tool', status: 'met' }])).toThrow(/unknown requirement kind for r1/);
    expect(() => parse([{ id: 'r1', importance: 3, status: 'met' }])).toThrow(/unknown requirement importance for r1/);
    expect(() => parse([{ id: 'r1', kind: {}, status: 'met' }])).toThrow(/unknown requirement kind/);
    // The status is never optional.
    expect(() => parse([{ id: 'r1', kind: 'skill', importance: 'must' }])).toThrow(/unknown requirement status for r1/);
  });

  it('an answer that is not a checklist throws ScorerV4AnswerError: a refused answer, told apart from a failed call', () => {
    for (const bad of ['not json', '', '{"requirements": "none"}', JSON.stringify(v4Answer({ level: undefined })), JSON.stringify(v4Answer({ domain: { status: 'close' } }))]) {
      let thrown: unknown = null;
      try {
        v4.parse(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, bad).toBeInstanceOf(ScorerV4AnswerError);
      expect((thrown as Error).name, bad).toBe(SCORER_V4_ANSWER_ERROR);
      expect((thrown as Error).message, bad).toMatch(/^RAJobMatchScorerV4Agent: /);
    }
  });

  it('a missing part throws; an entry with neither an id nor a text is not an entry', () => {
    const without = (key: string) => () => v4.parse(JSON.stringify({ ...v4Answer(), [key]: undefined }));
    expect(without('level')).toThrow(/missing level/);
    expect(without('domain')).toThrow(/missing domain/);
    expect(without('trajectory')).toThrow(/missing trajectory/);
    expect(without('requirements')).toThrow(/missing requirements/);
    expect(() => v4.parse(JSON.stringify(v4Answer({ level: 'senior' })))).toThrow(/missing level/);
    expect(() => v4.parse('not json')).toThrow(/unparseable/);
    expect(() => v4.parse('')).toThrow(/unparseable/);
    expect(() => v4.parse('[1, 2]')).toThrow(/unparseable/);
    // A v3 answer is not a checklist.
    expect(() => v4.parse('{"dimensions":{"title_level":{"score":80}}}')).toThrow(/missing requirements/);
    // A posting with no requirement line: an empty list is a valid answer.
    expect(v4.parse(JSON.stringify(v4Answer({ requirements: [] }))).requirements).toEqual([]);
    expect(v4.parse(JSON.stringify(v4Answer({ requirements: [null, 'r1', {}, { status: 'met' }, { id: 'r9', kind: 'skill', text: '', importance: 'must', status: 'partly', evidence: 'x' }] }))).requirements).toEqual([
      { id: 'r9', kind: 'skill', text: '', importance: 'must', status: 'partly', evidence: 'x' },
    ]);
  });

  it('direction is derived from the two levels, so the three never disagree', () => {
    const level = (post: string, resume: string, direction?: string) => v4.parse(JSON.stringify(v4Answer({ level: { post, resume, direction } }))).level;
    expect(level('senior', 'mid', 'match')).toEqual({ post: 'senior', resume: 'mid', direction: 'post_higher' });
    expect(level('entry', 'senior', 'post_higher')).toEqual({ post: 'entry', resume: 'senior', direction: 'post_lower' });
    expect(level('mid', 'mid')).toEqual({ post: 'mid', resume: 'mid', direction: 'match' });
    expect(scorerV4Direction('director_exec', 'intern_newgrad')).toBe('post_higher');
  });

  it('caps: a line, a quote, the lists, and the number of entries', () => {
    const long = 'x'.repeat(900);
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `r${i + 1}`, kind: 'skill', text: long, importance: 'preferred', status: 'met', evidence: long }));
    const out = v4.parse(JSON.stringify(v4Answer({ requirements: many, domain: { status: 'direct', evidence: long }, trajectory: { status: 'toward', evidence: long }, strengths: Array.from({ length: 9 }, (_, i) => `s${i}`), gaps: [long] })));
    expect(out.requirements).toHaveLength(SCORER_V4_PARSE_REQUIREMENTS_CAP);
    expect(SCORER_V4_PARSE_REQUIREMENTS_CAP).toBeGreaterThan(SCORER_V4_EXTRACT_MAX);
    expect(out.requirements[0]!.text).toHaveLength(300);
    expect(out.requirements[0]!.evidence).toHaveLength(240);
    expect(out.domain.evidence).toHaveLength(240);
    expect(out.trajectory.evidence).toHaveLength(240);
    expect(out.strengths).toHaveLength(5);
    expect(out.gaps[0]).toHaveLength(240);
  });

  it('drops a summary that states a score', () => {
    expect(v4.parse(JSON.stringify(v4Answer({ summary: 'An 85/100 fit for you.' }))).summary).toBeNull();
    expect(v4.parse(JSON.stringify(v4Answer({ summary: '匹配度 85分' }))).summary).toBeNull();
    expect(v4.parse(JSON.stringify(v4Answer({ summary: 'You meet 80% of it.' }))).summary).toBeNull();
    expect(v4.parse(JSON.stringify(v4Answer({ summary: 'Your 5 years in Go help.' }))).summary).toBe('Your 5 years in Go help.');
    expect(v4.parse(JSON.stringify(v4Answer({ summary: 42 }))).summary).toBeNull();
  });
});
