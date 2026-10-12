// @vitest-environment node
//
// Market wave M4 gate: the cross-bundle contracts of MARKET_TASK_PLAN.md 3.3
// that no single bundle could test, on the merged tree. Each bundle was built
// in its own worktree against the contract TEXT, and each tested its own side
// with a hand-written copy of the other's shape. Here the real producer feeds
// the real consumer.
//
//   1. Requirement lines (MKT-4D writes, MKT-4G reads): the key enrichment v3
//      stores a list under is the key the scorer looks it up by, also after the
//      row's skill strings changed. (They disagreed at the merge: the scorer's
//      key read the skills. One line in MatchService.ts.)
//   2. Skill rows (MKT-4D writes; MKT-4E's estimate and keyword check and the
//      search document read): one entry per skill, every other string of
//      `RAJob.skills` a spelling of an entry, never a second skill or a hard one.
//   3. Keyword rows (MKT-4D writes `skillId`; MKT-4G's repository passes it on;
//      MKT-4E's keyword check reads it).
//   4. The ordered preview (MKT-4F's service, the feed facade, MKT-4H's index
//      provider) and the Similar jobs list (job detail's facade, MKT-4H's
//      Assistant adapter): the consumer is wired to the real producer.
//
// No database (a recording fake behind the Prisma module), no model, no
// embeddings endpoint, no network. Enrichment's own fixture vocabulary is the
// vocabulary of both sides, as one `RASkill` table is in production.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const table = vi.hoisted(() => ({ keywordRow: null as { keywords: unknown } | null }));

vi.mock('../lib/prisma.js', () => ({ default: { rAKeywordExtraction: { findUnique: vi.fn(async () => table.keywordRow) } } }));
vi.mock('../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../platform/brand/registry.js';
import { feedService } from './feed/index.js';
import { jobDetailService } from './jobs/detail/index.js';
import { FIXTURE_SKILLS, fixtureEnrichVocabulary, fixtureSkillMap, fixtureVocabulary, intlModelReply, makeJob } from './jobs/enrich/__tests__/fixtures.js';
import { selectTaxonomyCandidates } from './jobs/enrich/candidates.js';
import { JobSkillsDetailSchema } from './jobs/companies/contract.js';
import { requirementsHashRow as enrichRequirementsHashRow } from './jobs/enrich/index.js';
import { buildKeywords } from './jobs/enrich/keywords.js';
import { keywordSkillsOf, postingTextOf, reconcile, skillTermsOf, type EnrichJobRecord, type RequirementHashInput } from './jobs/enrich/reconcile.js';
import { detectScamSignals } from './jobs/enrich/scamSignals.js';
import { parseEnrichOutput } from './jobs/enrich/schema.js';
import { toMatchJob } from './match/context.js';
import { jobContentHash, requirementListHash } from './match/jobHash.js';
import { buildKeywordRows } from './match/keywordRows.js';
import { createMatchService, type MatchServiceDeps } from './match/MatchService.js';
import { jobSkillList, splitSkills } from './match/preScore.js';
import { createPrismaMatchRepo } from './match/repo.js';
import { createMemoryRepo, jobRecord, matchUser } from './match/testkit.js';
import { jobTextParts } from './retrieval/jobText.js';
import { buildSearchDoc } from './retrieval/searchDoc.js';
import { indexJob } from './retrieval/testkit.js';
import { resetVocabularyForTests, setVocabularyForTests } from './skills/index.js';
import { createDefaultAreas } from './copilot/areas.js';
import { orderedPreview, type PreviewSeam } from '../job-search/index-provider.js';

const NOW = new Date('2026-10-11T08:00:00.000Z');

/** The vocabulary of both sides: enrichment's fixture, with "team player" as another name of the soft skill Teamwork. */
const VOCABULARY = fixtureVocabulary(FIXTURE_SKILLS.map((r) => (r.id === 'teamwork' ? { ...r, aliases: ['team player'] } : r)));

/** One enrichment pass with the model's reply, as jobs/enrich/service.ts runs `reconcile`: the match area's hash handed in. */
async function enrich(job: EnrichJobRecord, reply: Record<string, unknown> | null) {
  const postingText = postingTextOf(job);
  const output = reply ? parseEnrichOutput(reply) : null;
  const terms = skillTermsOf(job, postingText, output);
  return reconcile({
    job,
    postingText,
    output,
    candidates: selectTaxonomyCandidates(job.title, postingText, undefined, [job.primaryTaxonomyId]),
    scamSignals: detectScamSignals(postingText, job.market),
    model: 'test/enrich-model',
    now: NOW,
    skillMap: await fixtureSkillMap(terms, VOCABULARY),
    // service.ts: `contentHash: async () => (await import('../../match/index.js')).jobContentHash`.
    contentHash: (row: RequirementHashInput) => jobContentHash(row),
  });
}

beforeEach(() => {
  setVocabularyForTests(VOCABULARY);
  table.keywordRow = null;
});
afterEach(() => resetVocabularyForTests());

describe('1. requirement lines: enrichment v3 writes the list the scorer reads (MKT-4D to MKT-4G)', () => {
  const POSTING = [
    'Acme Analytics is hiring a Backend Engineer to build data APIs for retail clients.',
    '5+ years building backend services',
    'Nice to have: Kubernetes',
    'Benefits include health insurance and a learning budget.',
  ].join('\n');
  const REPLY = intlModelReply({
    requirements: [
      { kind: 'experience', text: '5+ years building backend services', importance: 'must' },
      { kind: 'skill', text: 'Nice to have: Kubernetes', importance: 'preferred' },
    ],
    sponsorship: null,
    citizenshipRequired: null,
    skills: [{ skill: 'Kubernetes', kind: 'hard', required: false }],
  });

  it('both areas compute one key: the title and the requirement text, never the skills', () => {
    for (const row of [
      { title: 'Backend Engineer', qualifications: null, descriptionPlain: POSTING },
      { title: 'Backend Engineer', qualifications: '5+ years of backend experience. Kubernetes required.', descriptionPlain: 'Build APIs.' },
      { title: '数据分析师', qualifications: null, descriptionPlain: '任职要求：本科及以上学历，熟悉SQL和Python。' },
    ]) {
      const enrichKey = jobContentHash(enrichRequirementsHashRow(row));
      expect(requirementListHash(row)).toBe(enrichKey);
      // Whatever the row's skill strings are at the time: the key does not read them, the fit's own hash does.
      expect(requirementListHash({ ...row, skills: ['kubernetes', 'go'] } as never)).toBe(enrichKey);
      expect(jobContentHash({ ...row, skills: ['kubernetes', 'go'] })).not.toBe(enrichKey);
    }
  });

  it('a list enrichment stored is the scorer\'s checklist, with no second extraction, also after ingest rewrote the skill strings', async () => {
    const { update } = await enrich(makeJob({ description: POSTING, descriptionPlain: POSTING }), REPLY);
    const stored = update.requirements!;
    expect(stored.items).toEqual([
      { id: 'r1', kind: 'experience', text: '5+ years building backend services', importance: 'must' },
      { id: 'r2', kind: 'skill', text: 'Nice to have: Kubernetes', importance: 'preferred' },
    ]);

    // The row as the scorer loads it later: the same text, the list enrichment wrote, and the skill strings as a
    // provider refresh left them (ingest writes the provider's list back over `RAJob.skills`).
    const row = jobRecord({
      title: 'Backend Engineer',
      description: POSTING,
      descriptionPlain: POSTING,
      qualifications: null,
      skills: ['a provider string', 'kubernetes'],
      skillsDetail: null,
      minYears: null,
      requirements: JSON.parse(JSON.stringify(stored)),
    });
    expect(stored.contentHash).toBe(requirementListHash(row));

    const repo = createMemoryRepo({ jobs: [row] });
    const saveJobRequirements = vi.spyOn(repo, 'saveJobRequirements');
    const scorerV4 = {
      run: vi.fn(async (input: { requirements?: Array<{ id: string }> | null }) => ({
        // Stored mode: the model fills status and evidence for the ids it was handed, nothing else.
        requirements: (input.requirements ?? []).map((r) => ({ id: r.id, kind: null, text: '', importance: null, status: 'not_shown', evidence: '' })),
        level: { post: 'senior', resume: 'senior', direction: 'match' },
        domain: { status: 'not_stated', evidence: '' },
        trajectory: { status: 'neutral', evidence: '' },
        strengths: [],
        gaps: [],
        summary: null,
      })),
    };
    const service = createMatchService({
      repo,
      scorerV4: scorerV4 as never,
      resolveModel: () => 'test/scorer-model',
      routeAllowed: () => true,
      aiAllowed: async () => true,
      consume: async () => ({ allowed: true, retryAfterSec: 0, remaining: 10, windows: [] }),
      withCredit: (async (_o: unknown, fn: () => Promise<unknown>) => fn()) as never,
      costLog: async () => undefined,
      profileSnapshot: async () => null,
      brand: () => getBrand('roboapply'),
      env: {},
      now: () => NOW,
    } as MatchServiceDeps);
    const fit = await service.scoreJob('u1', 'job1', { locale: 'en' });

    expect(scorerV4.run).toHaveBeenCalledTimes(1);
    // The scorer was handed enrichment's lines (it did not copy the posting's lines itself) ...
    expect(scorerV4.run.mock.calls[0]![0].requirements).toEqual(stored.items);
    // ... the fit carries them by id, text, kind and importance ...
    expect(fit.kind).toBe('ai');
    expect(fit.requirements!.map(({ id, kind, text, importance }) => ({ id, kind, text, importance }))).toEqual(stored.items);
    // ... and nothing is written over the list enrichment stored.
    expect(saveJobRequirements).not.toHaveBeenCalled();
    expect(repo.state.jobs[0]!.requirements).toEqual(JSON.parse(JSON.stringify(stored)));
  });
});

describe('2. skill rows: one entry per skill, every other string a spelling (MKT-4D to MKT-4E and the search document)', () => {
  const TEXT = 'We need a team player with good teamwork. Postgres and PostgreSQL daily, and Python for the data jobs.';

  async function enrichedRow() {
    const job = makeJob({ description: TEXT, descriptionPlain: TEXT, skills: ['postgres', 'team player'] });
    const { update } = await enrich(
      job,
      intlModelReply({
        skills: [
          { skill: 'PostgreSQL', kind: 'hard', required: true },
          { skill: 'teamwork', kind: 'soft', required: false },
          { skill: 'Python', kind: 'hard', required: true },
        ],
        sponsorship: null,
        citizenshipRequired: null,
      }),
    );
    return { job, update };
  }

  it('the row enrichment writes: both spellings in `skills`, one entry each in `skillsDetail`, the other spelling named in `also`', async () => {
    const { update } = await enrichedRow();
    expect(update.skills).toEqual(['postgres', 'team player', 'postgresql', 'teamwork', 'python']);
    expect(update.skillsDetail).toEqual([
      { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias', also: ['postgres'] },
      // The row's own strings come first, so the soft skill ("team player" was on the row) precedes Python.
      { skill: 'teamwork', kind: 'soft', required: false, skillId: 'teamwork', via: 'alias', also: ['team player'] },
      { skill: 'python', kind: 'hard', required: true, skillId: 'python', via: 'alias' },
    ]);
    // The documented shape of the column (jobs/companies/contract.ts) is the shape written, and still the older one.
    expect(JobSkillsDetailSchema.safeParse(JSON.parse(JSON.stringify(update.skillsDetail))).success).toBe(true);
    expect(JobSkillsDetailSchema.safeParse([{ skill: 'TypeScript', kind: 'hard', required: true }]).success).toBe(true);
    // Every string of `skills` is spoken for by one entry: its own, or the `also` of the skill it spells.
    const spokenFor = new Set(update.skillsDetail!.flatMap((d) => [d.skill, ...(d.also ?? [])]));
    expect(update.skills!.every((s) => spokenFor.has(s))).toBe(true);
    expect(update.skillIds).toEqual(['postgresql', 'python']);
  });

  it('the estimate lists PostgreSQL and Python as the hard skills and Teamwork as soft: nothing twice, no alias of a soft skill as a hard one', async () => {
    const { update } = await enrichedRow();
    const job = toMatchJob(jobRecord({ description: TEXT, descriptionPlain: TEXT, qualifications: null, skills: update.skills!, skillsDetail: update.skillsDetail as never, skillIds: update.skillIds! }));
    const list = jobSkillList(job, 'en');
    expect(list.map((s) => [s.skill, s.kind, s.skillId])).toEqual([
      ['PostgreSQL', 'hard', 'postgresql'],
      ['Python', 'hard', 'python'],
      ['Teamwork', 'soft', 'teamwork'],
    ]);
    // A person who lists PostgreSQL and Python shows both: nothing is missing, and no skill is counted twice.
    const split = splitSkills(matchUser({ skills: ['PostgreSQL', 'Python'], resumeTextNorm: null }), job);
    expect(split.aligned.sort()).toEqual(['PostgreSQL', 'Python']);
    expect(split.missing).toEqual([]);
  });

  it('the keyword check has one PostgreSQL item and one Python item, and never lists the soft skill or its alias', async () => {
    const { job, update } = await enrichedRow();
    // 3. The keyword row as enrichment writes it, through the repository the keyword check reads it with.
    table.keywordRow = { keywords: JSON.parse(JSON.stringify(buildKeywords(TEXT, keywordSkillsOf(job, update), fixtureEnrichVocabulary(VOCABULARY)))) };
    const keywords = await createPrismaMatchRepo().getKeywords('job1');
    expect(keywords!.length).toBeGreaterThan(0);
    // Every keyword of a version-3 row carries its canonical skill, and the repository passes it on.
    for (const k of keywords!) expect(typeof k.skillId === 'string' && k.skillId.length > 0, k.keyword).toBe(true);
    expect(keywords!.map((k) => k.skillId).sort()).toEqual(['postgresql', 'python']);

    const rows = buildKeywordRows({
      job: { ...toMatchJob(jobRecord({ description: TEXT, descriptionPlain: TEXT, qualifications: null, skills: update.skills!, skillsDetail: update.skillsDetail as never, skillIds: update.skillIds! })), minYears: null },
      user: matchUser({ skills: ['PostgreSQL'], resumeTextNorm: null }),
      resumeText: '',
      keywords,
      locale: 'en',
    });
    const skills = rows.find((r) => r.key === 'skills')!;
    expect(skills.items.map((i) => [i.term, i.state, i.skillId])).toEqual([
      ['PostgreSQL', 'shown', 'postgresql'],
      ['Python', 'not_shown', 'python'],
    ]);
    expect(skills.unchecked ?? 0).toBe(0);
    // The keywords row repeats no skill the skills row already lists.
    const listed = rows.flatMap((r) => (r.key === 'skills' || r.key === 'keywords' ? r.items.map((i) => i.skillId) : []));
    expect(new Set(listed).size).toBe(listed.length);
    for (const r of rows) for (const i of r.items) expect(/team/i.test(i.term), i.term).toBe(false);
  });

  it('the search document carries both spellings of the hard skill and neither spelling of the soft one', async () => {
    const { update } = await enrichedRow();
    const row = indexJob({ skills: update.skills!, skillsDetail: update.skillsDetail as never, skillIds: [], summary: null, qualifications: 'Requirements are listed above.', descriptionPlain: null });
    const parts = jobTextParts(row);
    const all = [...parts.requiredSkills, ...parts.preferredSkills].map((s) => s.toLowerCase());
    expect(all).toEqual(expect.arrayContaining(['postgresql', 'postgres', 'python']));
    expect(all).not.toContain('teamwork');
    expect(all).not.toContain('team player');
    const tokens = buildSearchDoc(row).split(' ');
    for (const t of ['postgresql', 'postgres', 'python']) expect(tokens).toContain(t);
    for (const t of ['teamwork', 'team', 'player']) expect(tokens).not.toContain(t);
  });
});

describe('4. the consumer is wired to the real producer (MKT-4F and job detail to MKT-4H)', () => {
  it('the feed facade offers the ordered preview, and the job-search index provider reads the order from it', async () => {
    expect(typeof feedService.previewOrdered).toBe('function');
    expect(typeof feedService.preview).toBe('function');
    // `orderedPreview` takes the facade's shape: with `previewOrdered` it never falls back to `preview`.
    const facade = {
      preview: vi.fn(async () => [{ jobId: 'plain' }]),
      previewOrdered: vi.fn(async () => ({ items: [{ jobId: 'ordered' }], relevanceApplied: true })),
    } satisfies Record<keyof Pick<typeof feedService, 'preview' | 'previewOrdered'>, unknown>;
    const read = await orderedPreview(facade as unknown as PreviewSeam<string>, 'u1', { q: 'backend engineer', relevance: 'climate Rust', limit: 50 });
    expect(read).toEqual({ items: [{ jobId: 'ordered' }], relevanceApplied: true });
    expect(facade.preview).not.toHaveBeenCalled();
    // The real service's own answer for this read is asserted in job-search/index-feed.gate.test.ts.
  });

  it('job detail\'s public surface offers the Similar jobs list, and the Assistant reads that list, not a title search', async () => {
    expect(typeof jobDetailService.similar).toBe('function');
    // The adapter with a seam of the facade's own shape (`get` and `similar`): `by: 'similar'`, no feed search.
    const seam = {
      get: vi.fn(async () => ({ job: { id: 'job_1', title: 'Data Analyst' } }) as never),
      similar: vi.fn(async () => ({ items: [{ jobId: 'near_1' }, { jobId: 'near_2' }] }) as never),
    } satisfies Record<keyof Pick<typeof jobDetailService, 'get' | 'similar'>, unknown>;
    const feedPreview = vi.fn(async () => []);
    const areas = createDefaultAreas({ store: {} as never, jobDetail: seam as never, feedPreview });
    expect(await areas.similarJobs('u1', 'job_1')).toEqual({ items: [{ jobId: 'near_1' }, { jobId: 'near_2' }], by: 'similar' });
    // Since the M5 gate the Assistant asks for the rows that owe an open-data credit line too: its card prints the line.
    expect(seam.similar).toHaveBeenCalledWith('u1', 'job_1', { creditLines: true });
    expect(feedPreview).not.toHaveBeenCalled();
  });
});
