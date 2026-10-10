// @vitest-environment node
// WP-18 — pure inputs of the matcher: user/job context, CitationGuard, PII
// stripping, keyword rows and config parsing.
import { describe, expect, it } from 'vitest';

import { DEFAULT_MATCH_TIERS, DEFAULT_MATCH_WEIGHTS } from './contract.js';
import { getMatchTiers, getMatchWeights, precomputePerUserDay, scoreDailyBudget, tierFor } from './config.js';
import { buildMatchUser, classYearsFromTags, degreeFromText, parseMonth, postingText, toMatchJob, userNames, yearsFromRanges } from './context.js';
import { guardEvidence, normalizeForGuard } from './evidence.js';
import { buildKeywordRows, mentions, normalizeText } from './keywordRows.js';
import { stripResumeForScoring } from './pii.js';
import { RESUME_MD, defaultUserInputs, jobRecord, matchJob, matchUser } from './testkit.js';

const NOW = new Date('2026-10-10T00:00:00Z');

describe('buildMatchUser', () => {
  it('reads targets, skills, logistics, degree and years from profile, resume and search profile', () => {
    const u = buildMatchUser({ userId: 'u1', market: 'intl', ...defaultUserInputs(), resumeParsed: { skills: { technical: ['Go'], tools: ['Docker'] } } }, NOW);
    expect(u.targetTaxonomyIds).toEqual(['backend_engineer']);
    expect(u.targetSeniority).toEqual(['senior']);
    expect(u.skills).toEqual(['TypeScript', 'Go', 'Docker']);
    expect(u.salaryMin).toEqual({ amount: 60000, currency: 'EUR', period: 'year' });
    expect(u.highestDegree).toBe('bachelor');
    expect(u.yearsExperience).toBeCloseTo(7.8, 1);
    expect(u.recentTitle).toBe('Senior Software Engineer');
    expect(u.searchProfileVersion).toBe(1);
  });

  it('never reads school name or school tier, and drops sponsorship inputs on GoApply', () => {
    const inputs = defaultUserInputs();
    inputs.profile = { ...inputs.profile!, cnFields: { schoolTags: ['985', '211'], schoolName: '清华大学', graduationClass: 2027, degree: 'master' } };
    inputs.searchProfile = { version: 2, filters: { schoolTiers: ['985'], needsSponsorship: true } };
    const cn = buildMatchUser({ userId: 'u1', market: 'cn', ...inputs, resumeParsed: null }, NOW);
    expect(JSON.stringify(cn)).not.toMatch(/985|211|清华/);
    expect(cn.classYear).toBe(2027);
    expect(cn.highestDegree).toBe('master');
    expect(cn.needsSponsorship).toBeNull();
    expect(cn.workAuth).toEqual([]);
  });

  it('falls back to the resume when the profile has no dated experience; internships do not count', () => {
    const inputs = { ...defaultUserInputs(), experience: [] };
    const u = buildMatchUser(
      {
        userId: 'u1',
        market: 'intl',
        ...inputs,
        resumeParsed: {
          experience: [
            { role: 'Engineer', startDate: '2020-01', endDate: '2022-12' },
            { role: 'Intern', startDate: '2019-06', endDate: '2019-09', employmentType: 'internship' },
          ],
          education: [{ degree: 'Master of Science', field: 'CS' }],
        },
      },
      NOW,
    );
    expect(u.yearsExperience).toBe(3);
    expect(u.recentTitle).toBe('Engineer');
    expect(u.highestDegree).toBe('master');
  });

  it('degreeFromText, parseMonth, yearsFromRanges', () => {
    expect(degreeFromText('Ph.D. Physics')).toBe('phd');
    expect(degreeFromText('硕士')).toBe('master');
    expect(degreeFromText('本科')).toBe('bachelor');
    expect(degreeFromText('大专')).toBe('associate');
    expect(degreeFromText('dazhuan')).toBe('associate');
    expect(degreeFromText('Diploma of nothing')).toBeNull();
    expect(parseMonth('2020-03', NOW)).toBe(2020 * 12 + 2);
    expect(parseMonth('03/2020', NOW)).toBe(2020 * 12 + 2);
    expect(parseMonth('至今', NOW)).toBe(2026 * 12 + 9);
    expect(parseMonth('soon', NOW)).toBeNull();
    // Overlapping ranges are merged, not double counted.
    expect(yearsFromRanges([{ start: '2020-01', end: '2021-12' }, { start: '2021-01', end: '2022-12' }], NOW)).toBe(3);
    expect(yearsFromRanges([{ start: null, end: null }], NOW)).toBeNull();
  });

  it('userNames lists profile and parsed names for stripping', () => {
    expect(userNames({ userId: 'u1', market: 'intl', ...defaultUserInputs(), resumeParsed: { name: 'A. Lovelace' } })).toEqual(['A. Lovelace', 'Ada Lovelace', 'Lovelace Ada', 'Ada', 'Lovelace']);
    // Single-character CJK names are kept here; pii.namePatterns joins them (何伟) and never strips one character alone.
    const cjk = { ...defaultUserInputs(), profile: { ...defaultUserInputs().profile!, firstName: '伟', lastName: '何' } };
    expect(userNames({ userId: 'u1', market: 'cn', ...cjk, resumeParsed: null })).toEqual(['伟 何', '何 伟', '伟', '何']);
  });
});

describe('toMatchJob', () => {
  it('maps a job record, class years from market tags, and the posting text', () => {
    const j = toMatchJob(jobRecord({ educationLevel: 'master', marketTags: [{ tag: 'class_year:2027', evidenceQuote: '2027届' }, { tag: 'soe', evidenceQuote: '央企' }] }));
    expect(j.educationLevel).toBe('master');
    expect(j.classYears).toEqual([2027]);
    expect(j.classYearQuote).toBe('2027届');
    expect(j.skillsDetail?.[0]).toEqual({ skill: 'TypeScript', kind: 'hard', required: true });
    expect(toMatchJob(jobRecord({ educationLevel: 'unknown-value' })).educationLevel).toBeNull();
    expect(classYearsFromTags('nope')).toEqual({ years: [], quote: null });
    expect(postingText(jobRecord())).toContain('Kubernetes required');
  });
});

describe('CitationGuard', () => {
  const sources = { resume: RESUME_MD, posting: 'Build APIs in TypeScript and Go.\n5+  years of backend experience.' };
  it('keeps verbatim quotes (whitespace/case/quote marks normalized) and drops the rest', () => {
    const kept = guardEvidence(
      [
        { text: '“Built payment APIs in TypeScript and Go”', source: 'resume' },
        { text: '5+ years of backend experience', source: 'posting' },
        { text: 'Led a team of 40 engineers', source: 'resume' }, // invented
        { text: 'Built payment APIs', source: 'posting' }, // wrong source
        { text: 'Go', source: 'resume' }, // too short
        { text: 42, source: 'resume' },
        null,
      ],
      sources,
    );
    expect(kept).toEqual([
      { text: 'Built payment APIs in TypeScript and Go', source: 'resume' },
      { text: '5+ years of backend experience', source: 'posting' },
    ]);
    expect(guardEvidence('nope', sources)).toEqual([]);
  });

  it('keeps at most 3', () => {
    const items = Array.from({ length: 5 }, () => ({ text: 'TypeScript, Go', source: 'resume' }));
    expect(guardEvidence(items, sources)).toHaveLength(3);
    expect(normalizeForGuard('A—B  “c”')).toBe('a-b "c"');
  });
});

describe('stripResumeForScoring', () => {
  it('removes name, email, phone, URLs, IDs and sensitive lines but keeps dates and content', () => {
    const md = [
      '# Ada Lovelace',
      'ada@example.com | +49 151 2345 6789 | https://linkedin.com/in/ada',
      'Address: 1 Main St, Berlin',
      'Gender: female',
      '性别：女',
      '出生年月：1995.03',
      '籍贯：浙江',
      '政治面貌：党员',
      '身份证：110101199003077777',
      'SSN 123-45-6789, TW ID A123456789',
      '![photo](data:image/png;base64,xxx)',
      '## Experience',
      'Engineer at PayCo, 2019.01 - 2023.06. Ada built the ledger.',
    ].join('\n');
    const out = stripResumeForScoring(md, { names: ['Ada Lovelace', 'Ada'] });
    for (const leaked of ['Ada', 'Lovelace', 'ada@example.com', '151 2345', 'linkedin', 'Main St', 'female', '女', '1995', '浙江', '党员', '110101', '123-45-6789', 'A123456789', 'base64']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('2019.01 - 2023.06');
    expect(out).toContain('built the ledger');
    expect(out).toContain('## Experience');
  });

  it.each([
    ['He', 'Wei'],
    ['Li', 'Na'],
    ['Ma', 'Yun'],
  ])('a short surname (%s) is removed as a whole word only; ordinary words survive', (last, first) => {
    const md = [
      `${first} ${last}`,
      `Led the machine learning team; managed the Helm charts and other Kubernetes work. ${last} shipped Linux tooling.`,
      'Main skills: Python, Make, Lisp, Mathematica.',
    ].join('\n');
    const out = stripResumeForScoring(md, { names: [`${first} ${last}`, `${last} ${first}`, first, last] });
    for (const kept of ['Led the machine learning team', 'managed the Helm charts and other Kubernetes work', 'shipped Linux tooling', 'Main skills: Python, Make, Lisp, Mathematica.']) {
      expect(out).toContain(kept);
    }
    expect(out).not.toMatch(new RegExp(`\\b${last}\\b`));
    expect(out).not.toMatch(new RegExp(`\\b${first}\\b`));
  });

  it('removes a CJK name written without a space, in either order, but never a single character', () => {
    const md = '何伟\n负责如何提升系统性能；伟何 带领团队。\n何伟在支付团队工作。';
    const out = stripResumeForScoring(md, { names: ['伟 何', '何 伟', '伟', '何'] });
    expect(out).not.toContain('何伟');
    expect(out).not.toContain('伟何');
    expect(out).toContain('负责如何提升系统性能');
    expect(out).toContain('在支付团队工作');
  });

  it('runs the shared redactor first (platform/pii): labelled passport numbers go, content stays', () => {
    const md = '## Experience\nPassport No. E12345678 (renewed)\nShipped payments in Go since 2019-03.';
    const out = stripResumeForScoring(md);
    expect(out).not.toContain('E12345678');
    expect(out).toContain('Shipped payments in Go since 2019-03.');
  });

  it('keeps ordinary lines that only start like a sensitive label', () => {
    const md = 'Photography: Lightroom\nAgents: LangChain\nRace conditions: fixed in the ledger\n地址解析服务：负责开发';
    const out = stripResumeForScoring(md);
    expect(out).toContain('Photography: Lightroom');
    expect(out).toContain('Agents: LangChain');
    expect(out).toContain('Race conditions');
  });
});

describe('keyword rows (F-RES-08)', () => {
  it('mentions: whole words for Latin terms, substring for CJK', () => {
    const t = normalizeText('Shipped Go services; used Kubernetes. 熟悉微服务架构');
    expect(mentions(t, 'go')).toBe(true);
    expect(mentions(t, 'Kubernetes')).toBe(true);
    expect(mentions(t, 'goo')).toBe(false);
    expect(mentions(t, 'c++')).toBe(false);
    expect(mentions(t, '微服务')).toBe(true);
    expect(mentions(t, '')).toBe(false);
  });

  it('builds title, years, education, skills n/m and keywords n/m rows', () => {
    const rows = buildKeywordRows({
      job: { ...matchJob({ educationLevel: 'master', skillsDetail: [{ skill: 'TypeScript', required: true }, { skill: 'Kubernetes', required: true }] }), minYears: 5 },
      user: matchUser({ skills: [] }),
      resumeText: RESUME_MD,
      keywords: [
        { keyword: 'PostgreSQL', importance: 'high' },
        { keyword: 'gRPC', importance: 'medium' },
        { keyword: 'teamwork', importance: 'low' },
      ],
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.title).toMatchObject({ status: 'met', need: 'Backend Engineer', have: 'Software Engineer' });
    expect(byKey.years).toMatchObject({ status: 'met', need: 5, have: 6 });
    expect(byKey.education).toMatchObject({ status: 'not_met', need: 'master', have: 'bachelor' });
    expect(byKey.skills).toMatchObject({ found: 2, total: 3, status: 'partly' });
    expect(byKey.skills!.items).toContainEqual({ term: 'Kubernetes', found: false, required: true });
    expect(byKey.keywords).toMatchObject({ found: 1, total: 2, status: 'partly' });
    expect(byKey.keywords!.items.map((i) => i.term)).toEqual(['PostgreSQL', 'gRPC']);
  });

  it('says not stated / unknown instead of counting a miss', () => {
    const rows = buildKeywordRows({
      job: { ...matchJob({ skills: [], skillsDetail: null, educationLevel: null }), minYears: null },
      user: matchUser({ yearsExperience: null, highestDegree: null, targetTaxonomyIds: [], recentTitle: null }),
      resumeText: '',
      keywords: null,
    });
    expect(rows.map((r) => r.status)).toEqual(['unknown', 'not_stated', 'not_stated', 'not_stated', 'not_stated']);
    const unknownYears = buildKeywordRows({ job: { ...matchJob(), minYears: 3 }, user: matchUser({ yearsExperience: null }), resumeText: '', keywords: [] });
    expect(unknownYears[1]!.status).toBe('unknown');
  });
});

describe('config', () => {
  it('weights and tiers default, parse valid JSON, and ignore invalid overrides', () => {
    expect(getMatchWeights({})).toEqual(DEFAULT_MATCH_WEIGHTS);
    expect(getMatchWeights({ MATCH_WEIGHTS: '{"skills":40}' })).toEqual({ ...DEFAULT_MATCH_WEIGHTS, skills: 40 });
    expect(getMatchWeights({ MATCH_WEIGHTS: '{"skills":-1}' })).toEqual(DEFAULT_MATCH_WEIGHTS);
    expect(getMatchWeights({ MATCH_WEIGHTS: 'not json' })).toEqual(DEFAULT_MATCH_WEIGHTS);
    expect(getMatchWeights({ MATCH_WEIGHTS: '{"title_level":0,"skills":0,"industry":0,"logistics":0,"career_path":0}' })).toEqual(DEFAULT_MATCH_WEIGHTS);
    expect(getMatchTiers({})).toEqual(DEFAULT_MATCH_TIERS);
    expect(getMatchTiers({ MATCH_TIERS: '{"great":85,"good":70,"possible":50}' })).toEqual({ great: 85, good: 70, possible: 50 });
    expect(getMatchTiers({ MATCH_TIERS: '{"great":60,"good":70}' })).toEqual(DEFAULT_MATCH_TIERS);
    expect(tierFor(null, DEFAULT_MATCH_TIERS)).toBeNull();
    expect(tierFor(81, { great: 85, good: 70, possible: 50 })).toBe('good');
  });

  it('budgets: brandEnv without fallback, defaults, invalid ignored', () => {
    expect(scoreDailyBudget('roboapply', {})).toBe(20_000);
    expect(scoreDailyBudget('roboapply', { SCORE_DAILY_BUDGET: '500' })).toBe(500);
    expect(scoreDailyBudget('goapply', { SCORE_DAILY_BUDGET: '500' })).toBe(20_000);
    expect(scoreDailyBudget('goapply', { CN_SCORE_DAILY_BUDGET: '300' })).toBe(300);
    expect(scoreDailyBudget('roboapply', { SCORE_DAILY_BUDGET: 'lots' })).toBe(20_000);
    expect(precomputePerUserDay({})).toBe(25);
    expect(precomputePerUserDay({ SCORE_PRECOMPUTE_PER_USER_DAY: '3' })).toBe(3);
  });
});
