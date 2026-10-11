// @vitest-environment node
// MKT-1D — live mode with a mocked LLM and a fake query function: the judge
// prompt, the judge cache, the model refusals, the recruiter audit round trip,
// the read-only snapshot, scorer stability, the dated report and the refusal
// without EVAL_LIVE. No network, no database.
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentBrandId } from '../../../../lib/requestContext.js';
import { loadPersonas } from '../fixtures/load.js';
import { buildReport, readAudit } from '../run.js';
import { EVAL_DIR, REPO_ROOT, setFitModuleForTests } from '../seams.js';
import type { SuiteContext } from '../suite.js';
import { AUDIT_COLUMNS, auditCsv, auditKappa, auditSample, exportAudit, importAudit, pairId, parseAuditCsv, parseCsv, type AuditPair } from './audit.js';
import { LiveRefused, assertLive, brandOfMarket, personaSummary, runLive, type LiveDeps } from './index.js';
import { JudgeRefused, assertJudgeModel, judgeCacheKey, judgePair, judgePairs, parseJudgeAnswer, personaContentHash, postingContentHash, type JudgeCall } from './judge.js';
import { JUDGE_PROMPT_VERSION, buildJudgeMessages, type JudgePersona, type JudgePosting } from './judgePrompt.js';
import { renderReportMd } from './report.js';
import { recencyVariant, snapshotRowsSql, takeSnapshot, type SnapshotQuery, type WithReadOnly } from './snapshot.js';
import { runStability, stabilitySample } from './stability.js';

afterEach(() => setFitModuleForTests(null));

const tmp = (name: string) => mkdtempSync(path.join(tmpdir(), `eval-live-${name}-`));

const persona: JudgePersona = { id: 'intl-p01', summary: 'Looking for: backend engineer\nLevel: mid; 4 years of experience', resumeMarkdown: '# Persona INTL-01 (synthetic)\n\n## Skills\nJava, Go' };
const posting: JudgePosting = { id: 'job-1', title: 'Backend Engineer', companyName: 'Quillmere Labs (synthetic)', location: 'Austin, TX', payText: null, description: 'You will be responsible for payment services.', qualifications: 'Required: Java, Go.' };

function countingCall(answer: unknown = { grade: 2, reason: 'Same role, most requirements shown.' }): JudgeCall & { calls: Array<{ model: string }> } {
  const calls: Array<{ model: string }> = [];
  const fn = (async (_messages, options) => {
    calls.push({ model: options.model });
    return typeof answer === 'function' ? (answer as () => unknown)() : answer;
  }) as JudgeCall & { calls: Array<{ model: string }> };
  fn.calls = calls;
  return fn;
}

describe('the judge prompt', () => {
  it('is fixed and versioned', () => {
    expect(JUDGE_PROMPT_VERSION).toBe('judge_v1');
    const messages = buildJudgeMessages(persona, posting);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(buildJudgeMessages(persona, posting)).toEqual(messages);
    expect(messages).toMatchInlineSnapshot(`
      [
        {
          "content": "You are an experienced recruiter. You judge how well one job posting matches one job seeker.
      You are given the job seeker (what they are looking for and their resume) and the posting.
      Work through these steps before you answer:
      1. What work does the posting ask for, at what level, with which must-have requirements?
      2. What does the resume show: recent roles, level, skills, and what the person says they want?
      3. How close is the role? How close is the level? Which must-have requirements does the resume show, and which not?
      4. Is there a stated condition the person does not meet (a required degree, a class year, no visa sponsorship when they need it)?
      Then give one grade:
      3 = excellent match: the same kind of work at a level the person could hold now, and the resume shows most must-have requirements.
      2 = good match: closely related work or a level one step away, and the resume shows a fair share of the must-have requirements.
      1 = related: the same broad field, but a different role, a level two or more steps away, or few must-have requirements shown.
      0 = not relevant: different work, or a stated condition rules the person out.
      A posting that says too little to judge (no requirements, no level) is at most 2.
      An internship is at most 1 for a person with several years of experience.
      Judge only what is written. Do not assume skills the resume does not show. The language of the resume and of the posting may differ; that alone never lowers the grade.
      Answer with JSON only: {"grade": 0 | 1 | 2 | 3, "reason": "one sentence"}.",
          "role": "system",
        },
        {
          "content": "## Job seeker
      Looking for: backend engineer
      Level: mid; 4 years of experience

      ### Resume
      # Persona INTL-01 (synthetic)

      ## Skills
      Java, Go

      ## Posting
      Title: Backend Engineer
      Employer: Quillmere Labs (synthetic)
      Location: Austin, TX
      Pay: not stated

      ### Description
      You will be responsible for payment services.

      ### Requirements
      Required: Java, Go.",
          "role": "user",
        },
      ]
    `);
  });
});

describe('the judge', () => {
  it('refuses to run with no judge model, or with the scorer\'s own model', () => {
    expect(() => assertJudgeModel(undefined, 'vendor/scorer')).toThrow(JudgeRefused);
    expect(() => assertJudgeModel('  ', 'vendor/scorer')).toThrow(/EVAL_JUDGE_MODEL is not set/);
    expect(() => assertJudgeModel('vendor/scorer', 'vendor/scorer')).toThrow(/different, stronger model/);
    expect(() => assertJudgeModel('openrouter/vendor/scorer', 'vendor/Scorer')).toThrow(JudgeRefused);
    expect(assertJudgeModel('vendor/judge-large', 'vendor/scorer')).toBe('vendor/judge-large');
    expect(assertJudgeModel('vendor/judge-large', null)).toBe('vendor/judge-large');
  });

  it('never calls a model when it refuses', async () => {
    const call = countingCall();
    const deps = { judgeModel: 'vendor/scorer', scorerModel: 'vendor/scorer', call, cacheDir: tmp('refuse') };
    await expect(judgePair(persona, posting, deps)).rejects.toBeInstanceOf(JudgeRefused);
    await expect(judgePairs([{ persona, posting }], { ...deps, judgeModel: null })).rejects.toBeInstanceOf(JudgeRefused);
    expect(call.calls).toEqual([]);
  });

  it('caches by prompt version, persona and posting text: the second call costs nothing', async () => {
    const cacheDir = tmp('cache');
    const call = countingCall();
    const deps = { judgeModel: 'vendor/judge-large', scorerModel: 'vendor/scorer', call, cacheDir };
    const first = await judgePair(persona, posting, deps);
    expect(first).toMatchObject({ personaId: 'intl-p01', postingId: 'job-1', grade: 2, cached: false, model: 'vendor/judge-large', promptVersion: 'judge_v1' });
    const second = await judgePair(persona, posting, deps);
    expect(second).toMatchObject({ grade: 2, cached: true });
    expect(call.calls).toHaveLength(1);
    expect(readdirSync(cacheDir)).toEqual([`${judgeCacheKey(JUDGE_PROMPT_VERSION, persona.id, personaContentHash(persona), postingContentHash(posting))}.json`]);
    // A changed posting is judged again; so is another persona.
    await judgePair(persona, { ...posting, qualifications: 'Required: Java, Go, Kafka.' }, deps);
    await judgePair({ ...persona, id: 'intl-p02' }, posting, deps);
    expect(call.calls).toHaveLength(3);
    // An answer written by another judge model is not reused.
    await judgePair(persona, posting, { ...deps, judgeModel: 'vendor/judge-other' });
    expect(call.calls).toHaveLength(4);
    expect(call.calls.at(-1)).toEqual({ model: 'vendor/judge-other' });
  });

  it('judges again when anything the prompt shows has changed, under the same ids', async () => {
    const call = countingCall();
    const deps = { judgeModel: 'vendor/judge-large', scorerModel: 'vendor/scorer', call, cacheDir: tmp('content') };
    await judgePair(persona, posting, deps);
    // Regenerated fixtures: the same persona id with another resume, or another summary.
    await judgePair({ ...persona, resumeMarkdown: `${persona.resumeMarkdown}, Kafka` }, posting, deps);
    await judgePair({ ...persona, summary: `${persona.summary}\nWhere: DE` }, posting, deps);
    // The same posting id with another employer, place or pay line: all three are in the prompt.
    await judgePair(persona, { ...posting, companyName: 'Brindlewick Systems (synthetic)' }, deps);
    await judgePair(persona, { ...posting, location: 'Remote' }, deps);
    await judgePair(persona, { ...posting, payText: 'USD 90,000 to 110,000 a year' }, deps);
    expect(call.calls).toHaveLength(6);
    // Unchanged again: every one of the six is a cache hit.
    expect((await judgePair(persona, posting, deps)).cached).toBe(true);
    expect((await judgePair(persona, { ...posting, location: 'Remote' }, deps)).cached).toBe(true);
    expect(call.calls).toHaveLength(6);
    // The posting id is not part of what was judged.
    expect(postingContentHash(posting)).toBe(postingContentHash({ ...posting, id: 'other-id' } as JudgePosting));
  });

  it('keeps a pair it could not grade out of the labels', async () => {
    const answers: unknown[] = [{ grade: 3, reason: 'ok' }, { grade: 7 }, 'here you go: {"grade": 1, "reason": "related"}'];
    const call = countingCall(() => answers.shift());
    const batch = await judgePairs(
      [{ persona, posting }, { persona, posting: { ...posting, id: 'job-2', title: 'Other' } }, { persona, posting: { ...posting, id: 'job-3', title: 'Third' } }],
      { judgeModel: 'vendor/judge-large', scorerModel: 'vendor/scorer', call, cacheDir: tmp('batch') },
    );
    expect(batch.verdicts.map((v) => [v.postingId, v.grade])).toEqual([
      ['job-1', 3],
      ['job-3', 1],
    ]);
    expect(batch).toMatchObject({ calls: 2, cacheHits: 0 });
    expect(batch.failed).toEqual([{ personaId: 'intl-p01', postingId: 'job-2', error: 'the judge answered grade 7 (expected 0, 1, 2 or 3)' }]);
    expect(() => parseJudgeAnswer('no json here')).toThrow(/no JSON object/);
    expect(parseJudgeAnswer({ grade: '0', reason: 5 })).toEqual({ grade: 0, reason: '' });
  });
});

describe('the recruiter audit', () => {
  const pairs: AuditPair[] = Array.from({ length: 40 }, (_, i) => ({
    personaId: `p${String(i % 8).padStart(2, '0')}`,
    postingId: `job-${i}`,
    market: 'intl',
    judgeGrade: i % 4,
    personaSummary: 'Looking for: data analyst\nLevel: mid',
    personaResume: '# Persona (synthetic)\n\n## Skills\nSQL, Python',
    postingTitle: i === 3 ? 'Analyst, "Growth" team' : `Title ${i}`,
    postingText: 'Line one, with a comma.\nLine two.',
  }));
  const JUDGE = { judgeModel: 'vendor/judge-large', promptVersion: JUDGE_PROMPT_VERSION };

  it('samples a tenth of the judged pairs of every market, the same pairs every time', () => {
    const sample = auditSample(pairs);
    expect(sample).toHaveLength(4);
    expect(auditSample([...pairs].reverse()).map(pairId)).toEqual(sample.map(pairId));
    expect(auditSample([])).toEqual([]);
    expect(auditSample(pairs.slice(0, 3))).toHaveLength(1);
    // Two markets of very different size: neither is left out of the sample.
    const two = [...pairs, ...pairs.slice(0, 4).map((p) => ({ ...p, market: 'cn', personaId: `cn-${p.personaId}` }))];
    const bothMarkets = auditSample(two);
    expect(bothMarkets.filter((p) => p.market === 'intl')).toHaveLength(4);
    expect(bothMarkets.filter((p) => p.market === 'cn')).toHaveLength(1);
  });

  it('writes a blind CSV: what the judge saw, an empty grade column and no judge grade anywhere', () => {
    const csv = auditCsv(pairs.slice(0, 5));
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([...AUDIT_COLUMNS]);
    expect(AUDIT_COLUMNS).toContain('persona_resume');
    expect(rows).toHaveLength(6);
    // The recruiter grades on the resume the judge graded on.
    expect(rows[1]![4]).toBe('# Persona (synthetic)\n\n## Skills\nSQL, Python');
    expect(rows[4]![5]).toBe('Analyst, "Growth" team');
    expect(rows[1]![6]).toBe('Line one, with a comma.\nLine two.');
    for (const r of rows.slice(1)) expect(r[7]).toBe('');
    expect(csv).not.toMatch(/judge/i);
  });

  it('never writes a cell a spreadsheet would read as a formula', () => {
    const risky: AuditPair = {
      ...pairs[0]!,
      postingTitle: '=HYPERLINK("https://example.test","Apply")',
      postingText: '- 5+ years of experience\n- SQL\n+ a bonus\n@mention',
      personaSummary: '+1 on relocation',
      personaResume: '@home\t=1+1',
    };
    const csv = auditCsv([risky]);
    const row = parseCsv(csv)[1]!;
    expect(row[3]).toBe("'+1 on relocation");
    expect(row[4]).toBe("'@home\t=1+1");
    expect(row[5]).toBe(`'=HYPERLINK("https://example.test","Apply")`);
    // The text is whole; only the first character of the cell is neutralised.
    expect(row[6]).toBe("'- 5+ years of experience\n- SQL\n+ a bonus\n@mention");
    for (const c of row) expect(c).not.toMatch(/^[=+\-@\t\r]/);
    // An ordinary cell is untouched, and the pair id reads back as it was written.
    expect(row[0]).toBe(pairId(risky));
    expect(parseAuditCsv(csv)[0]).toEqual({ pairId: pairId(risky), grade: null });
  });

  /** The recruiters' file: the exported CSV with the last column filled. */
  const graded = (csvFile: string, human: (pair: string) => string): string =>
    parseCsv(readFileSync(csvFile, 'utf8'))
      .map((r, i) => (i === 0 ? r : [...r.slice(0, AUDIT_COLUMNS.length - 1), human(r[0]!)]))
      .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
      .join('\n');

  it('round trip: export, grades come back, kappa is computed and stored with the judge it audited', () => {
    const snapshots = tmp('audit');
    const dir = path.join(snapshots, '2026-10-01');
    // Nine recruiters' worth of the same four-pair pattern, over two markets; one posting starts like a bullet list.
    const many: AuditPair[] = Array.from({ length: 36 }, (_, i) => ({
      personaId: `p${Math.floor(i / 4)}`,
      postingId: `job-${i % 4}`,
      market: i < 24 ? 'intl' : 'cn',
      judgeGrade: i % 4,
      personaSummary: 's',
      personaResume: 'resume',
      postingTitle: `T${i % 4}`,
      postingText: i % 4 === 0 ? '- 5+ years of experience\n- SQL' : 'text',
    }));
    const out = exportAudit({ pairs: many, dir, share: 1, ...JUDGE });
    expect(out).toMatchObject({ sampled: 36, markets: { intl: 24, cn: 12 } });
    expect(JSON.parse(readFileSync(out.keyFile, 'utf8'))).toMatchObject({ judgeModel: 'vendor/judge-large', promptVersion: 'judge_v1', pairs: { 'p0::job-3': { grade: 3, market: 'intl' }, 'p8::job-0': { grade: 0, market: 'cn' } } });
    // The recruiters agree with the judge on grades 0, 1 and 2 and give a 2 where the judge gave a 3.
    const csvFile = path.join(dir, 'graded.csv');
    writeFileSync(csvFile, graded(out.csvFile, (pair) => ({ 0: '0', 1: '1', 2: '2', 3: '2' })[pair.slice(-1)]!));
    const result = importAudit({ csvFile, snapshotsDir: snapshots, now: new Date('2026-10-02T00:00:00Z') });
    // Per four pairs: observed weighted disagreement (1/9)/4; expected (32/9)/16; kappa = 1 - (1/36)/(2/9) = 0.875.
    expect(result.kappa).toBeCloseTo(0.875, 10);
    expect(result).toMatchObject({ pairs: 36, ungraded: 0, trusted: true, distrust: null, threshold: 0.6, minPairs: 30, judgeModel: 'vendor/judge-large', promptVersion: 'judge_v1', markets: { intl: 24, cn: 12 } });
    expect(readAudit(snapshots)).toEqual({ kappa: result.kappa, pairs: 36, judgeModel: 'vendor/judge-large', promptVersion: 'judge_v1', markets: { intl: 24, cn: 12 } });
    // A CSV that comes back somewhere else is matched with the key of the newest run.
    const elsewhere = path.join(tmp('elsewhere'), 'from-recruiters.csv');
    writeFileSync(elsewhere, readFileSync(csvFile, 'utf8'));
    expect(importAudit({ csvFile: elsewhere, snapshotsDir: snapshots, now: new Date('2026-10-03T00:00:00Z') }).kappa).toBeCloseTo(0.875, 10);
  });

  it('a handful of graded pairs is not an audit, however well they agree', () => {
    const snapshots = tmp('few');
    const dir = path.join(snapshots, '2026-10-01');
    const four: AuditPair[] = [0, 1, 2, 3].map((g) => ({ personaId: 'p1', postingId: `job-${g}`, market: 'intl', judgeGrade: g, personaSummary: 's', personaResume: 'r', postingTitle: `T${g}`, postingText: 'text' }));
    const out = exportAudit({ pairs: four, dir, share: 1, ...JUDGE });
    const csvFile = path.join(dir, 'graded.csv');
    writeFileSync(csvFile, graded(out.csvFile, (pair) => pair.slice(-1)));
    const result = importAudit({ csvFile, snapshotsDir: snapshots, now: new Date('2026-10-02T00:00:00Z') });
    expect(result).toMatchObject({ kappa: 1, pairs: 4, trusted: false });
    expect(result.distrust).toBe('the audit holds 4 graded pairs; 30 are needed');
  });

  it('stays untrusted below 0.6, and never counts an empty or malformed grade', () => {
    const key = { a: 0, b: 1, c: 2, d: 3, e: 3 };
    const csv = ['pair_id,human_grade_0_to_3', 'a,3', 'b,2', 'c,1', 'd,0', 'e,', 'zzz,2', 'c2,five'].join('\n');
    const k = auditKappa(key, parseAuditCsv(csv));
    expect(k.pairs).toBe(4);
    expect(k.ungraded).toBe(3);
    expect(k.graded).toEqual(['a', 'b', 'c', 'd']);
    expect(k.kappa).toBeLessThan(0);
    expect(() => parseAuditCsv('a,b\n1,2')).toThrow(/pair_id and human_grade_0_to_3 are required/);
    const snapshots = tmp('untrusted');
    const keyFile = path.join(snapshots, 'audit.key.json');
    const file = path.join(snapshots, 'in.csv');
    writeFileSync(file, csv);
    // A key that does not say whose grades it holds cannot be imported: the audit would trust any judge.
    writeFileSync(keyFile, JSON.stringify(key));
    expect(() => importAudit({ csvFile: file, snapshotsDir: snapshots, now: new Date() })).toThrow(/does not say which judge model and prompt version/);
    writeFileSync(keyFile, JSON.stringify({ ...JUDGE, pairs: Object.fromEntries(Object.entries(key).map(([id, grade]) => [id, { grade, market: 'cn' }])) }));
    const result = importAudit({ csvFile: file, snapshotsDir: snapshots, now: new Date() });
    expect(result).toMatchObject({ trusted: false, pairs: 4, markets: { cn: 4 } });
    expect(() => importAudit({ csvFile: path.join(snapshots, 'missing.csv'), snapshotsDir: snapshots, now: new Date() })).toThrow(/not found/);
  });
});

describe('scorer stability', () => {
  it('three identical runs: ICC 1 and no tier flip; a failed run drops the pair', async () => {
    const pairs = Array.from({ length: 6 }, (_, i) => ({ personaId: 'p', postingId: `j${i}` }));
    const scores: Record<string, number> = { j0: 30, j1: 50, j2: 66, j3: 81, j4: 90, j5: 12 };
    const steady = await runStability(pairs, async (p) => scores[p.postingId]!);
    expect(steady).toMatchObject({ icc: 1, tierFlipRate: 0, pairs: 6, runs: 3, dropped: 0 });
    // One pair crosses the Good threshold in the third run; one pair fails in the second.
    const wobble = await runStability(pairs, async (p, run) => {
      if (p.postingId === 'j5' && run === 1) throw new Error('model timeout');
      return p.postingId === 'j2' && run === 2 ? 64 : scores[p.postingId]!;
    });
    expect(wobble.pairs).toBe(5);
    expect(wobble.dropped).toBe(1);
    expect(wobble.tierFlipRate).toBeCloseTo(0.2, 10);
    expect(wobble.icc).toBeGreaterThan(0.99);
    expect((await runStability(pairs, async () => 1, { maxPairs: 2, runs: 2 })).scores).toEqual([[1, 1], [1, 1]]);
  });

  it('draws its pairs over every persona, the same draw each time, never the first personas in order', () => {
    // 40 personas with 50 pooled postings each, in the order a run collects them.
    const all = Array.from({ length: 2000 }, (_, i) => ({ personaId: `p${String(Math.floor(i / 50)).padStart(2, '0')}`, postingId: `job-${i % 50}` }));
    const drawn = stabilitySample(all);
    expect(drawn).toHaveLength(100);
    expect(new Set(drawn.map((p) => `${p.personaId}::${p.postingId}`)).size).toBe(100);
    expect(stabilitySample([...all].reverse())).toEqual(drawn);
    // Every persona is in the sample before any is in it a third time: 100 pairs over 40 personas is 2 or 3 each.
    const perPersona = new Map<string, number>();
    for (const p of drawn) perPersona.set(p.personaId, (perPersona.get(p.personaId) ?? 0) + 1);
    expect(perPersona.size).toBe(40);
    expect(new Set(perPersona.values())).toEqual(new Set([2, 3]));
    // Not the same postings for every persona either.
    expect(new Set(drawn.map((p) => p.postingId)).size).toBeGreaterThan(30);
    expect(stabilitySample(all.slice(0, 7))).toHaveLength(7);
    expect(stabilitySample([])).toEqual([]);
  });
});

// ── The snapshot and the whole live run, with fakes ───────────────────────

interface FakeDb {
  statements: string[];
  withReadOnly: WithReadOnly;
}

function rawRow(id: string, title: string, role: [string, string, string], market: 'intl' | 'cn' = 'intl') {
  return {
    id,
    market,
    visibility: 'public',
    ownerUserId: null,
    title,
    companyName: 'Fixture Employer (synthetic)',
    descriptionPlain: `We are hiring a ${title}.`,
    qualifications: 'Required: SQL.',
    taxonomyIds: role,
    primaryTaxonomyId: role[2],
    seniority: 'mid',
    minYears: 2,
    maxYears: null,
    educationLevel: null,
    skills: ['sql'],
    skillsDetail: [{ skill: 'SQL', kind: 'hard', required: true }],
    workModel: 'onsite',
    remoteScope: null,
    location: 'Austin, TX',
    locationCity: 'Austin',
    locationCountry: 'US',
    geoLat: null,
    geoLng: null,
    salaryAnnualMin: null,
    salaryAnnualMax: null,
    salaryCurrency: null,
    salaryText: null,
    sponsorship: null,
    sponsorshipEvidence: null,
    marketTags: null,
    postedAt: new Date('2026-09-28T00:00:00Z'),
    companyIndustries: null,
  };
}

/** A database that only answers the two statements a snapshot makes, and records them. */
function fakeDb(): FakeDb {
  const statements: string[] = [];
  const rows = [rawRow('live-1', 'Data Analyst', ['data_ai', 'data_analytics', 'data_analyst']), rawRow('live-2', 'Backend Engineer', ['software_engineering', 'swe_backend', 'backend_engineer']), rawRow('live-3', 'Registered Nurse', ['healthcare', 'clinical', 'registered_nurse'])];
  const query: SnapshotQuery = async <T,>(sql: { sql: string; values: unknown[] }) => {
    statements.push(sql.sql);
    if (/^SELECT j\."id"\s*\n/.test(sql.sql)) return rows.map((r) => ({ id: r.id })) as T[];
    const ids = sql.values.find((v) => Array.isArray(v)) as string[];
    return rows.filter((r) => ids.includes(r.id)) as T[];
  };
  return { statements, withReadOnly: async (fn) => fn(query) };
}

const ROLES: Array<[string, [string, string, string]]> = [
  ['Data Analyst', ['data_ai', 'data_analytics', 'data_analyst']],
  ['Backend Engineer', ['software_engineering', 'swe_backend', 'backend_engineer']],
  ['Registered Nurse', ['healthcare', 'clinical', 'registered_nurse']],
  ['Marketing Manager', ['marketing', 'marketing_brand', 'marketing_manager']],
];

/** A database with `perMarket` public postings in each market; the candidate statement answers the market it was asked for. */
function twoMarketDb(perMarket: number): FakeDb {
  const statements: string[] = [];
  const rows = (['intl', 'cn'] as const).flatMap((market) =>
    // Each posting has its own text: the judge's cache is keyed by what a posting says, not by its id.
    Array.from({ length: perMarket }, (_, i) => ({ ...rawRow(`${market}-live-${String(i).padStart(2, '0')}`, ROLES[i % ROLES.length]![0], ROLES[i % ROLES.length]![1], market), descriptionPlain: `We are hiring a ${ROLES[i % ROLES.length]![0]}. Reference ${market}-${i}.` })),
  );
  const query: SnapshotQuery = async <T,>(sql: { sql: string; values: unknown[] }) => {
    statements.push(sql.sql);
    const market = sql.values.includes('cn') ? 'cn' : 'intl';
    if (/^SELECT j\."id"\s*\n/.test(sql.sql)) return rows.filter((r) => r.market === market).map((r) => ({ id: r.id })) as T[];
    const ids = sql.values.find((v) => Array.isArray(v)) as string[];
    return rows.filter((r) => ids.includes(r.id) && r.market === market) as T[];
  };
  return { statements, withReadOnly: async (fn) => fn(query) };
}

describe('the snapshot', () => {
  it('lists its columns: never SELECT * and never the search vector', () => {
    const sql = snapshotRowsSql(['a', 'b'], 'cn');
    expect(sql.sql).not.toMatch(/SELECT\s+\*|j\.\*|searchTsv/);
    expect(sql.sql).toContain('FROM "RAJob" j');
    expect(sql.sql).toContain(`j."visibility" = 'public'`);
    expect(sql.values).toEqual([['a', 'b'], 'cn']);
  });

  it('pools the top of every retrieval variant per persona inside one read-only reader', async () => {
    const db = fakeDb();
    const personas = loadPersonas('intl')!.slice(0, 2);
    const extra = { name: 'second', candidateIds: async () => ['live-3', 'live-1', 'gone'] };
    const snap = await takeSnapshot({ market: 'intl', personas, withReadOnly: db.withReadOnly, variants: [recencyVariant, extra], now: new Date('2026-10-01T12:00:00Z'), perVariant: 2 });
    expect(snap.date).toBe('2026-10-01');
    expect(snap.variants).toEqual(['recency', 'second']);
    expect(snap.pools).toHaveLength(2);
    expect(snap.pools[0]).toEqual({ personaId: personas[0]!.id, variants: { recency: ['live-1', 'live-2'], second: ['live-3', 'live-1'] }, pooled: ['live-1', 'live-2', 'live-3'] });
    expect(snap.rows.map((r) => r.id).sort()).toEqual(['live-1', 'live-2', 'live-3']);
    expect(snap.rows[0]).toMatchObject({ description: 'We are hiring a Data Analyst.', companyIndustries: [], postedAt: '2026-09-28T00:00:00.000Z', archivedAt: null });
    // The candidate statement is the feed's own, for the persona's role and place, public rows only.
    expect(db.statements[0]).toContain('FROM "RAJob" j');
    expect(db.statements[0]).toContain('"taxonomyIds"');
    expect(db.statements.every((s) => /^SELECT/.test(s))).toBe(true);
  });
});

describe('a live run', () => {
  const ctx = (over: Partial<SuiteContext> = {}): SuiteContext => ({ markets: ['intl'], live: true, repoRoot: REPO_ROOT, evalDir: EVAL_DIR, fixturesDir: path.join(EVAL_DIR, 'fixtures'), now: new Date('2026-10-01T12:00:00Z'), ...over });

  it('refuses without EVAL_LIVE=1: no database read, no model call, nothing written', async () => {
    expect(() => assertLive({})).toThrow(LiveRefused);
    expect(() => assertLive({ EVAL_LIVE: 'true' })).toThrow(LiveRefused);
    expect(() => assertLive({ EVAL_LIVE: '1' })).not.toThrow();
    const db = fakeDb();
    const call = countingCall();
    const snapshotsDir = path.join(tmp('refused'), '.snapshots');
    const deps: Partial<LiveDeps> = { withReadOnly: db.withReadOnly, judgeCall: call, scorerModel: async () => 'vendor/scorer', scoreOnce: async () => 50 };
    await expect(runLive({ exportAudit: false, ctx: ctx(), snapshotsDir, env: {}, log: () => undefined, deps })).rejects.toBeInstanceOf(LiveRefused);
    expect(db.statements).toEqual([]);
    expect(call.calls).toEqual([]);
    expect(existsSync(snapshotsDir)).toBe(false);
  });

  it('snapshots, judges, measures and writes a dated report under the snapshots folder only', async () => {
    setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'fitShim.ts'));
    const db = fakeDb();
    const call = countingCall({ grade: 2, reason: 'related work' });
    const scored: string[] = [];
    const snapshotsDir = path.join(tmp('run'), '.snapshots');
    const env = { EVAL_LIVE: '1', EVAL_JUDGE_MODEL: 'vendor/judge-large' };
    const deps: Partial<LiveDeps> = {
      withReadOnly: db.withReadOnly,
      judgeCall: call,
      scorerModel: async () => 'vendor/scorer',
      scoreOnce: async ({ persona: p, row }) => {
        scored.push(`${p.id}:${row.id}`);
        return 40 + (row.id.charCodeAt(5) % 3) * 20;
      },
    };
    const logs: string[] = [];
    const live = await runLive({ exportAudit: true, ctx: ctx(), snapshotsDir, env, log: (l) => logs.push(l), deps });

    // 40 personas x 3 pooled postings, each judged once with the judge model.
    expect(call.calls).toHaveLength(120);
    expect(new Set(call.calls.map((c) => c.model))).toEqual(new Set(['vendor/judge-large']));
    expect(logs[0]).toBe('intl: 40 personas, 120 pooled candidates, 3 postings read (read-only).');
    // Stability: 100 pairs, three runs.
    expect(scored).toHaveLength(300);

    const measures = live.suites.flatMap((s) => s.measures.map((m) => ({ ...m, layer: s.layer })));
    const ranking = measures.filter((m) => m.layer === 'ranking');
    // Career changers are judged and reported on their own rows, outside the gated value.
    expect(ranking.map((m) => [m.metric, m.market, m.subset ?? null, m.scope, m.labels, m.n])).toEqual([
      ['ndcg_at_10', 'intl', null, 'live', 'judged', 37],
      ['ndcg_at_20', 'intl', null, 'live', 'judged', 37],
      ['ndcg_at_10', 'intl', 'career_changer', 'live', 'judged', 3],
      ['ndcg_at_20', 'intl', 'career_changer', 'live', 'judged', 3],
    ]);
    // The scorer and estimate-against-AI gates are reported for the market they were measured in.
    expect(measures.find((m) => m.metric === 'icc_3_runs')).toMatchObject({ layer: 'scorer', market: 'intl', value: 1, n: 100, labels: 'none' });
    expect(measures.find((m) => m.metric === 'tier_flip_rate')).toMatchObject({ market: 'intl', value: 0 });
    expect(measures.find((m) => m.layer === 'estimate_vs_ai' && m.metric === 'tier_kappa')).toMatchObject({ market: 'intl' });
    expect(measures.filter((m) => m.layer === 'scorer' || m.layer === 'estimate_vs_ai').every((m) => m.market === 'intl')).toBe(true);
    // The 100 pairs are drawn over the personas, not the first two in order.
    expect(new Set(scored.map((s) => s.split(':')[0])).size).toBe(40);
    expect(live.judge).toEqual({ judgeModel: 'vendor/judge-large', promptVersion: 'judge_v1', markets: ['intl'] });

    // The report: judge-based values are untrusted until a recruiter audit passes.
    const report = buildReport({ enforce: 'all', live: true, invariants: [], suites: live.suites, baselines: {}, audit: readAudit(snapshotsDir), judge: live.judge, listUnbuilt: true });
    const reportFile = live.finish(report, readAudit(snapshotsDir));
    expect(report.rows.filter((r) => r.raw?.labels === 'judged').every((r) => r.status === 'untrusted')).toBe(true);
    const dir = path.join(snapshotsDir, '2026-10-01');
    expect(reportFile).toBe(path.join(dir, 'report.md'));
    expect(readdirSync(dir).sort()).toEqual(['audit.key.json', 'audit.sample.csv', 'report.json', 'report.md', 'snapshot.intl.json']);
    expect(readdirSync(snapshotsDir).sort()).toEqual(['2026-10-01', 'judge-cache']);
    const md = readFileSync(reportFile, 'utf8');
    expect(md).toContain('# Match evaluation, live run of 2026-10-01');
    expect(md).toContain('Judge model: vendor/judge-large (prompt judge_v1; judged intl).');
    expect(md).toContain('Scorer model: intl vendor/scorer.');
    expect(md).toContain('- judged: ');
    expect(md).toContain('Judge audit: none yet');
    expect(md).toContain('intl: personas: 40');
    expect(md).toMatch(/intl: scorer stability pairs \(3 runs, 0 dropped for a failed run; drawn over 40 personas of 120 pooled pairs\): 100/);
    expect(md).toContain('No real user');
    const json = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
    expect(json).toMatchObject({ date: '2026-10-01', models: { judge: 'vendor/judge-large', judgePromptVersion: 'judge_v1', judgedMarkets: ['intl'], scorer: { intl: 'vendor/scorer' } } });
    const sample = parseCsv(readFileSync(path.join(dir, 'audit.sample.csv'), 'utf8'));
    expect(sample).toHaveLength(13);
    // The recruiter gets the persona's resume, as the judge did.
    expect(sample[1]![AUDIT_COLUMNS.indexOf('persona_resume')]).toMatch(/persona-intl-p\d\d@example\.test/);
    expect(JSON.parse(readFileSync(path.join(dir, 'audit.key.json'), 'utf8'))).toMatchObject({ judgeModel: 'vendor/judge-large', promptVersion: 'judge_v1' });

    // A second run reads every grade from the cache: no judge call.
    const again = countingCall();
    await runLive({ exportAudit: false, ctx: ctx(), snapshotsDir, env, log: () => undefined, deps: { ...deps, judgeCall: again } });
    expect(again.calls).toEqual([]);
  });

  it('judges nothing when the judge model is the scorer\'s, and says so', async () => {
    setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'fitShim.ts'));
    const db = fakeDb();
    const call = countingCall();
    const snapshotsDir = path.join(tmp('same'), '.snapshots');
    const live = await runLive({
      exportAudit: true,
      ctx: ctx(),
      snapshotsDir,
      env: { EVAL_LIVE: '1', EVAL_JUDGE_MODEL: 'vendor/scorer' },
      log: () => undefined,
      deps: { withReadOnly: db.withReadOnly, judgeCall: call, scorerModel: async () => 'vendor/scorer', scoreOnce: async () => null },
    });
    expect(call.calls).toEqual([]);
    expect(live.note).toContain('Not judged (intl): EVAL_JUDGE_MODEL (vendor/scorer) is the model the scorer uses');
    expect(live.note).toContain('No audit sample: nothing was judged');
    expect(live.suites.flatMap((s) => s.measures).some((m) => m.labels === 'judged')).toBe(false);
    expect(live.judge).toBeNull();
  });

  it('measures each market as its own brand: its scorer model, its judge refusal, a sample over both markets', async () => {
    setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'fitShim.ts'));
    expect([brandOfMarket('intl'), brandOfMarket('cn')]).toEqual(['roboapply', 'goapply']);
    const db = twoMarketDb(60);
    const judged: Array<{ brand: string | undefined; model: string }> = [];
    const judgeCall: JudgeCall = async (_messages, options) => {
      judged.push({ brand: getCurrentBrandId(), model: options.model });
      return { grade: 1, reason: 'related' };
    };
    const resolved: Array<string | undefined> = [];
    const scored: Array<{ market: string; brand: string | undefined; model: string; persona: string; posting: string; locale: string }> = [];
    const snapshotsDir = path.join(tmp('brands'), '.snapshots');
    const live = await runLive({
      exportAudit: true,
      ctx: ctx({ markets: ['intl', 'cn'] }),
      snapshotsDir,
      // The judge named here is the model GoApply's scorer resolves to, and not RoboApply's.
      env: { EVAL_LIVE: '1', EVAL_JUDGE_MODEL: 'vendor/cn-scorer' },
      log: () => undefined,
      deps: {
        withReadOnly: db.withReadOnly,
        judgeCall,
        // As the production resolver does: the answer depends on the brand of the unit of work.
        scorerModel: async () => {
          resolved.push(getCurrentBrandId());
          return getCurrentBrandId() === 'goapply' ? 'vendor/cn-scorer' : 'vendor/scorer';
        },
        scoreOnce: async ({ persona: p, row, model, market }) => {
          scored.push({ market, brand: getCurrentBrandId(), model, persona: p.id, posting: row.id, locale: p.locale });
          return 50;
        },
      },
    });

    // One resolution per market, each inside its brand.
    expect(resolved).toEqual(['roboapply', 'goapply']);
    // The judge is GoApply's scorer: mainland pairs are not judged, RoboApply's are, inside RoboApply's context.
    expect(live.note).toContain('Not judged (cn): EVAL_JUDGE_MODEL (vendor/cn-scorer) is the model the scorer uses');
    expect(live.note).not.toContain('Not judged (intl)');
    expect(judged).toHaveLength(40 * 50);
    expect(new Set(judged.map((j) => `${j.brand}/${j.model}`))).toEqual(new Set(['roboapply/vendor/cn-scorer']));
    expect(live.judge).toEqual({ judgeModel: 'vendor/cn-scorer', promptVersion: 'judge_v1', markets: ['intl'] });

    // Stability: 100 pairs of each market, three runs, each with that market's model inside that market's brand.
    for (const [market, brand, model] of [['intl', 'roboapply', 'vendor/scorer'], ['cn', 'goapply', 'vendor/cn-scorer']] as const) {
      const mine = scored.filter((s) => s.market === market);
      expect(mine, market).toHaveLength(300);
      expect(new Set(mine.map((s) => `${s.brand}/${s.model}`)), market).toEqual(new Set([`${brand}/${model}`]));
      expect(new Set(mine.map((s) => `${s.persona}::${s.posting}`)).size, market).toBe(100);
      // Pools of 50 per persona: the sample is spread over the personas, not the first two.
      expect(new Set(mine.map((s) => s.persona)).size, market).toBe(40);
      expect(mine.every((s) => s.posting.startsWith(`${market}-live-`)), market).toBe(true);
    }
    // More than English engineers: other locales are in the mainland sample.
    expect(new Set(scored.filter((s) => s.market === 'cn').map((s) => s.locale))).toContain('zh');

    const measures = live.suites.flatMap((s) => s.measures.map((m) => ({ ...m, layer: s.layer })));
    for (const metric of ['icc_3_runs', 'tier_flip_rate']) expect(measures.filter((m) => m.metric === metric).map((m) => m.market)).toEqual(['intl', 'cn']);
    expect(measures.filter((m) => m.layer === 'scorer' || m.layer === 'estimate_vs_ai').some((m) => m.market === 'all')).toBe(false);
    // Only RoboApply's pairs were judged: no judged value for the mainland market.
    expect(new Set(measures.filter((m) => m.labels === 'judged' && m.layer === 'ranking').map((m) => m.market))).toEqual(new Set(['intl']));

    const report = buildReport({ enforce: 'all', live: true, invariants: [], suites: live.suites, baselines: {}, audit: null, judge: live.judge, listUnbuilt: false });
    const md = readFileSync(live.finish(report, null), 'utf8');
    expect(md).toContain('Scorer model: intl vendor/scorer; cn vendor/cn-scorer.');
    expect(md).toContain('Judge model: vendor/cn-scorer (prompt judge_v1; judged intl).');
    expect(md).toMatch(/cn: scorer stability pairs \(3 runs, 0 dropped for a failed run; drawn over 40 personas of 2000 pooled pairs\): 100/);
    expect(report.rows.filter((r) => r.layer === 'scorer').map((r) => r.metric)).toEqual(['icc_3_runs [live] [intl]', 'tier_flip_rate [live] [intl]', 'icc_3_runs [live] [cn]', 'tier_flip_rate [live] [cn]']);
  });

  it('the report says which labels each value used', () => {
    const report = buildReport({
      enforce: 'all',
      live: true,
      invariants: [],
      suites: [
        { file: 'live', name: 'live ranking', layer: 'ranking', error: null, notBuilt: null, measures: [{ metric: 'ndcg_at_10', market: 'intl', scope: 'live', value: 0.6, n: 40, labels: 'judged' }] },
        { file: 'x', name: 'ranking', layer: 'ranking', error: null, notBuilt: null, measures: [{ metric: 'ndcg_at_10', market: 'intl', value: 0.9, n: 40, labels: 'constructed' }] },
      ],
      baselines: {},
      audit: { kappa: 0.71, pairs: 44, judgeModel: 'j', promptVersion: 'judge_v1', markets: { intl: 44 } },
      judge: { judgeModel: 'j', promptVersion: 'judge_v1', markets: ['intl'] },
      listUnbuilt: false,
    });
    const md = renderReportMd(
      {
        date: '2026-10-01',
        takenAt: '2026-10-01T12:00:00.000Z',
        markets: ['intl'],
        models: { judge: 'j', judgePromptVersion: 'judge_v1', judgedMarkets: ['intl'], scorer: { intl: 's' } },
        samples: [{ what: 'intl: personas', n: 40 }],
        audit: { kappa: 0.71, pairs: 44, judgeModel: 'j', promptVersion: 'judge_v1', markets: { intl: 44 } },
        notes: ['one note'],
      },
      report,
    );
    expect(md).toContain('- judged: 1 value(s)');
    expect(md).toContain('- constructed: 1 value(s)');
    expect(md).toContain('44 pairs graded by recruiters (intl 44), of judge j, prompt judge_v1; judge-human quadratic-weighted kappa 0.710');
    expect(md).toContain('an audit of the same judge model and prompt version');
    expect(md).toContain('| ranking | ndcg_at_10 [live] [intl] | 0.6000  n=40  judged labels |');
    expect(md).toContain('- one note');
  });

  it('a persona summary carries no contact detail', () => {
    const p = loadPersonas('cn')![0]!;
    expect(personaSummary(p)).not.toMatch(/@|example\.test/);
    expect(personaSummary(p)).toContain('Looking for: backend engineer');
  });
});
