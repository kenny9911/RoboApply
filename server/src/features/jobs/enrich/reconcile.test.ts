// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_JOB_SKILLS,
  PROVIDER_SPONSORSHIP_PREFIX,
  SPONSORSHIP_SOURCE_QUOTE,
  clampSummary,
  deterministicCoverage,
  heldSkillIds,
  keywordSkillsOf,
  needsLlm,
  postingTextOf,
  readStoredRequirements,
  reconcile,
  reconcileSkillColumns,
  requirementsHashRow,
  roleFromTitle,
  skillGrounded,
  skillTermsOf,
  titleEvidence,
  titleIsDecisive,
  type EnrichJobRecord,
  type RequirementHashInput,
} from './reconcile.js';
import { AGE_LIMIT_TAG } from './ageLimit.js';
import { selectTaxonomyCandidates } from './candidates.js';
import { detectScamSignals } from './scamSignals.js';
import { ENRICH_VERSION, MAX_SUMMARY_CHARS, RULES_ONLY_MODEL, parseEnrichOutput } from './schema.js';
import { skillMapKey, type SkillMap, type SkillMapping } from './skills.js';
import { jobContentHash } from '../../match/jobHash.js';
import { PROVIDER_SPONSORSHIP_PREFIX as INGEST_PROVIDER_PREFIX, SPONSORSHIP_SOURCE_QUOTE as INGEST_SOURCE_QUOTE } from '../ingest/upsert.js';
import { CN_POSTING, FIXTURE_SKILLS, INTL_BUSINESS_LINE, INTL_POSTING, INTL_POSTING_WITH_BUSINESS, fixtureSkillMap, fixtureVocabulary, intlModelReply, makeJob } from './__tests__/fixtures.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');

interface RunOptions {
  skillMap?: SkillMap;
  /** Pass the real `jobContentHash` so the requirement list is written. */
  hash?: boolean;
}

function run(job = makeJob(), reply: Record<string, unknown> | null = intlModelReply(), options: RunOptions = {}) {
  const postingText = postingTextOf(job);
  return reconcile({
    job,
    postingText,
    output: reply ? parseEnrichOutput(reply) : null,
    candidates: selectTaxonomyCandidates(job.title, postingText, undefined, [job.primaryTaxonomyId]),
    scamSignals: detectScamSignals(postingText, job.market),
    model: 'test/enrich-model',
    now: NOW,
    skillMap: options.skillMap,
    contentHash: options.hash ? (row: RequirementHashInput) => jobContentHash(row) : undefined,
  });
}

/** Reconcile with the fixture vocabulary's answers for the job's own skill strings (exact alias only). */
async function runMapped(job: EnrichJobRecord, reply: Record<string, unknown> | null, options: RunOptions = {}) {
  const postingText = postingTextOf(job);
  const terms = skillTermsOf(job, postingText, reply ? parseEnrichOutput(reply) : null);
  return run(job, reply, { ...options, skillMap: options.skillMap ?? (await fixtureSkillMap(terms)) });
}

const mapping = (over: Partial<SkillMapping>): SkillMapping => ({ skillId: null, kind: null, status: 'unreviewed', via: 'none', labels: [], ...over });

describe('posting text', () => {
  it('uses the plain description, falls back to stripped HTML and appends sections not already present', () => {
    expect(postingTextOf(makeJob({ descriptionPlain: '', description: '<p>Hello&nbsp;<b>world</b></p><ul><li>One</li></ul>' }))).toBe('Hello world\nOne');
    const text = postingTextOf(makeJob({ descriptionPlain: 'Main text.', qualifications: 'Main text.', benefits: 'Dental.' }));
    expect(text).toBe('Main text.\n\nDental.');
  });
});

describe('skip-LLM rule', () => {
  const covered = { primaryTaxonomyId: 'backend_engineer', taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'], seniority: 'mid', skills: ['python', 'go', 'sql', 'kafka', 'terraform'] };

  it('needs taxonomy, seniority and at least 5 skills', () => {
    expect(deterministicCoverage(makeJob(covered))).toBe(true);
    expect(deterministicCoverage(makeJob({ ...covered, skills: ['python'] }))).toBe(false);
    expect(deterministicCoverage(makeJob({ ...covered, seniority: null }))).toBe(false);
    expect(deterministicCoverage(makeJob({ ...covered, primaryTaxonomyId: null, taxonomyIds: [] }))).toBe(false);
  });

  it('skips the model only when the posting has nothing it must cite', () => {
    const plain = 'Build APIs in Python. Benefits include dental.';
    expect(needsLlm(makeJob({ ...covered, descriptionPlain: plain }), plain)).toEqual({ needed: false, reason: 'covered' });
    expect(needsLlm(makeJob({ ...covered }), INTL_POSTING).reason).toBe('work_authorization_text');
    expect(needsLlm(makeJob({ ...covered, sponsorship: 'not_offered' }), INTL_POSTING).reason).toBe('requirement_text');
    expect(needsLlm(makeJob({ ...covered, market: 'cn' }), CN_POSTING).reason).toBe('employer_tag_text');
    expect(needsLlm(makeJob(), plain).reason).toBe('coverage_incomplete');
  });

  it('SM-2: a covered row still needs the model when its title does not name the role outright', () => {
    const plain = 'Build APIs in Python. Benefits include dental.';
    // "Backend Engineer" is the role by name: nothing to decide.
    expect(titleIsDecisive(titleEvidence('Backend Engineer'))).toBe(true);
    expect(needsLlm(makeJob({ ...covered, descriptionPlain: plain }), plain)).toEqual({ needed: false, reason: 'covered' });
    // A role chosen by its modifiers (0.85), a partial phrase, a catch-all role by name (0.85) and no match at all are the model's to decide.
    for (const title of ['Java Backend Architect', 'Senior Backend Engineer, Payments Platform', 'Software Engineer', 'Head of Special Projects']) {
      expect(titleIsDecisive(titleEvidence(title)), title).toBe(false);
      expect(needsLlm(makeJob({ ...covered, title, descriptionPlain: plain }), plain), title).toEqual({ needed: true, reason: 'weak_title_match' });
    }
  });
});

describe('reconcile', () => {
  it('writes the reconciled fields, version and model', () => {
    const { update, report } = run();
    expect(update).toMatchObject({
      taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
      primaryTaxonomyId: 'backend_engineer',
      seniority: 'mid',
      sponsorship: 'not_offered',
      sponsorshipEvidence: 'We are unable to sponsor work visas for this role.',
      citizenshipRequired: true,
      clearanceRequired: null,
      summary: 'Build data APIs for retail clients in Python and Go. The team runs services on Kubernetes.',
      enrichedAt: NOW,
      enrichVersion: ENRICH_VERSION,
      enrichModel: 'test/enrich-model',
      fraudFlags: null,
    });
    expect(update.skills).toEqual(['python', 'go', 'sql', 'kafka']);
    // No vocabulary answer was handed in: the strings are stored as they are, with no canonical id.
    expect(update.skillsDetail).toEqual([
      { skill: 'python', kind: 'hard', required: true, skillId: null, via: 'none' },
      { skill: 'go', kind: 'hard', required: true, skillId: null, via: 'none' },
      { skill: 'sql', kind: 'hard', required: true, skillId: null, via: 'none' },
      { skill: 'kafka', kind: 'hard', required: false, skillId: null, via: 'none' },
    ]);
    expect(update.skillIds).toEqual([]);
    expect(update.requirements).toBeUndefined();
    expect(update.marketTags).toEqual([
      { tag: 'citizenship_required', evidenceQuote: 'Applicants must be US citizens due to a government contract.', evidenceUrl: null },
    ]);
    expect(update.searchText).toBe('backend engineer acme analytics python go sql kafka');
    expect(update.titleMatchScore).toBe(1);
    expect(report).toEqual({
      sponsorshipCorrected: null,
      droppedQuotes: [],
      droppedSkills: [],
      staleEvidence: [],
      taxonomyRejected: false,
      taxonomyOverridden: null,
      skillCounts: { canonical: 0, unreviewed: 4, dropped: 0 },
      requirements: null,
    });
  });

  it('only accepts a taxonomy id from the candidate list', () => {
    // A title that names no role: the model decides, and an id it was never offered is dropped.
    const job = makeJob({ title: 'Head of Special Projects' });
    const { update, report } = run(job, intlModelReply({ taxonomyId: 'nurse_practitioner_invented' }));
    expect(update.taxonomyIds).toBeUndefined();
    expect(update.primaryTaxonomyId).toBeUndefined();
    expect(update.titleMatchScore).toBeNull();
    expect(report.taxonomyRejected).toBe(true);
    expect(report.taxonomyOverridden).toBeNull();
    // The same reply on a row that holds a role under a weak title match: the role stays, the id is still reported as dropped.
    const held = run(
      makeJob({ title: 'Registered Nurse - ICU', primaryTaxonomyId: 'nurse_practitioner', taxonomyIds: ['healthcare', 'clinical', 'nurse_practitioner'] }),
      intlModelReply({ taxonomyId: 'nurse_practitioner_invented' }),
    );
    expect(held.update.primaryTaxonomyId).toBeUndefined();
    expect(held.report).toMatchObject({ taxonomyRejected: true, taxonomyOverridden: null });
  });

  it('keeps deterministic seniority and education from ingest, and a role the title names outright even when the model disagrees', () => {
    const job = makeJob({ primaryTaxonomyId: 'backend_engineer', taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'], seniority: 'senior', educationLevel: 'master' });
    const { update, report } = run(job, intlModelReply({ educationLevel: 'bachelor', taxonomyId: 'software_architect' }));
    expect(selectTaxonomyCandidates(job.title, postingTextOf(job)).map((c) => c.id)).toContain('software_architect');
    expect(update.primaryTaxonomyId).toBeUndefined();
    expect(update.taxonomyIds).toBeUndefined();
    expect(update.titleMatchScore).toBe(1);
    expect(update.seniority).toBeUndefined();
    expect(update.educationLevel).toBeUndefined();
    expect(report).toMatchObject({ taxonomyRejected: false, taxonomyOverridden: null });
  });

  it('SM-2: the model overrules a role whose title match is under 0.9', () => {
    // A row filed under the building profession by the old one-word match.
    const job = makeJob({ title: 'Java Backend Architect', primaryTaxonomyId: 'architect', taxonomyIds: ['design', 'spatial_design', 'architect'] });
    expect(titleEvidence(job.title)!.score).toBeLessThan(0.9);
    const { update, report } = run(job, intlModelReply({ taxonomyId: 'software_architect' }));
    expect(update.taxonomyIds).toEqual(['software_engineering', 'swe_leadership', 'software_architect']);
    expect(update.primaryTaxonomyId).toBe('software_architect');
    expect(update.titleMatchScore).toBe(titleEvidence(job.title)!.score);
    expect(report.taxonomyOverridden).toEqual({ from: 'architect', to: 'software_architect', by: 'model' });
    expect(report.taxonomyRejected).toBe(false);
  });

  it('SM-2: the model may also overrule the weak deterministic pick itself, and silence keeps what the row holds', () => {
    // "Software Engineer" is the catch-all role by name (0.85): the posting says which kind.
    const job = makeJob({ title: 'Software Engineer', primaryTaxonomyId: 'software_engineer', taxonomyIds: ['software_engineering', 'swe_backend', 'software_engineer'] });
    const picked = run(job, intlModelReply({ taxonomyId: 'backend_engineer' }));
    expect(picked.update.primaryTaxonomyId).toBe('backend_engineer');
    expect(picked.report.taxonomyOverridden).toEqual({ from: 'software_engineer', to: 'backend_engineer', by: 'model' });
    const silent = run(job, intlModelReply({ taxonomyId: null }));
    expect(silent.update.primaryTaxonomyId).toBeUndefined();
    expect(silent.update.titleMatchScore).toBe(0.85);
    expect(silent.report.taxonomyOverridden).toBeNull();
    // The model confirming the held role changes nothing either.
    expect(run(job, intlModelReply({ taxonomyId: 'software_engineer' })).update.taxonomyIds).toBeUndefined();
  });

  it('SM-2: a title that names another role outright corrects the row on any pass, the rules-only one included', () => {
    // "Microservices Architect" is a software architect by name; the row was filed under buildings.
    const job = makeJob({ title: 'Microservices Architect', primaryTaxonomyId: 'architect', taxonomyIds: ['design', 'spatial_design', 'architect'] });
    for (const reply of [null, intlModelReply({ taxonomyId: 'architect' })]) {
      const { update, report } = run(job, reply);
      expect(update.taxonomyIds).toEqual(['software_engineering', 'swe_leadership', 'software_architect']);
      expect(update.titleMatchScore).toBe(1);
      expect(report.taxonomyOverridden).toEqual({ from: 'architect', to: 'software_architect', by: 'title' });
    }
  });

  it('SM-2: every pass stores how strong the title evidence was, whoever set the role', () => {
    expect(run(makeJob({ title: 'Backend Engineer' }), null).update.titleMatchScore).toBe(1);
    expect(run(makeJob({ title: 'Java Backend Architect' }), null).update.titleMatchScore).toBeGreaterThanOrEqual(0.85);
    expect(run(makeJob({ title: 'Head of Special Projects' }), null).update.titleMatchScore).toBeNull();
    // Rules only never moves a role on a weak match alone: there is no model pick to take.
    const weak = run(makeJob({ title: 'Registered Nurse - ICU', primaryTaxonomyId: 'nurse_practitioner', taxonomyIds: ['healthcare', 'clinical', 'nurse_practitioner'] }), null);
    expect(weak.update.primaryTaxonomyId).toBeUndefined();
    expect(weak.update.titleMatchScore).toBe(0.883);
    expect(weak.report.taxonomyOverridden).toBeNull();
  });

  it('SM-2: a role that only the retired one-word match explains gives way to what the title says today, model or no model', () => {
    // "Java Backend Architect" under the building profession: today the title says software architect (weakly).
    const architect = makeJob({ title: 'Java Backend Architect', primaryTaxonomyId: 'architect', taxonomyIds: ['design', 'spatial_design', 'architect'] });
    expect(roleFromTitle(architect.title, 'architect')).toMatchObject({ decisive: false, role: 'software_architect' });
    for (const reply of [null, intlModelReply({ taxonomyId: null }), intlModelReply({ taxonomyId: 'nurse_practitioner_invented' })]) {
      const { update, report } = run(architect, reply);
      expect(update.taxonomyIds).toEqual(['software_engineering', 'swe_leadership', 'software_architect']);
      expect(update.primaryTaxonomyId).toBe('software_architect');
      expect(report.taxonomyOverridden).toEqual({ from: 'architect', to: 'software_architect', by: 'title' });
    }
    // The model still has the last word under 0.9: its pick among the candidates wins over the weak match.
    const picked = run(architect, intlModelReply({ taxonomyId: 'backend_engineer' }));
    expect(picked.update.primaryTaxonomyId).toBe('backend_engineer');
    expect(picked.report.taxonomyOverridden).toEqual({ from: 'architect', to: 'backend_engineer', by: 'model' });
    // It may even confirm the building profession (it is offered: the row holds it).
    expect(run(architect, intlModelReply({ taxonomyId: 'architect' })).update.primaryTaxonomyId).toBeUndefined();

    // "Principal Engineer" under school principals: the title names no role, so the honest state is unknown.
    const principal = makeJob({ title: 'Principal Engineer', primaryTaxonomyId: 'education_administrator', taxonomyIds: ['education', 'education_support', 'education_administrator'] });
    const cleared = run(principal, null);
    expect(cleared.update).toMatchObject({ taxonomyIds: [], primaryTaxonomyId: null, titleMatchScore: null });
    expect(cleared.report.taxonomyOverridden).toEqual({ from: 'education_administrator', to: null, by: 'title' });

    // A word that is still the role by name retires nothing: "Senior Developer" stays a software engineer.
    const developer = makeJob({ title: 'Senior Developer', primaryTaxonomyId: 'software_engineer', taxonomyIds: ['software_engineering', 'swe_backend', 'software_engineer'] });
    expect(run(developer, null).update.primaryTaxonomyId).toBeUndefined();
    // A role nothing in the title explains (a model chose it) is never retired by the title.
    expect(roleFromTitle('Head of Special Projects', 'strategy_manager').role).toBeUndefined();
    expect(roleFromTitle('Java Backend Architect', 'backend_engineer').role).toBeUndefined();
  });

  it('SM-10: the employer industry needs a quote from the posting that says what the employer does', () => {
    const quote = INTL_BUSINESS_LINE;
    const job = makeJob({ description: INTL_POSTING_WITH_BUSINESS, descriptionPlain: INTL_POSTING_WITH_BUSINESS });
    const stated = run(job, intlModelReply({ industry: { value: 'B2B SaaS', quote } }));
    expect(stated.companyIndustry).toEqual({ industry: 'B2B SaaS', quote });
    expect(stated.report.droppedQuotes).toEqual([]);
    // The industry is never a job column.
    expect(Object.keys(stated.update)).not.toContain('industry');

    const invented = run(job, intlModelReply({ industry: { value: 'Fintech', quote: 'We are a leading payments company.' } }));
    expect(invented.companyIndustry).toBeNull();
    expect(invented.report.droppedQuotes).toEqual(['industry']);

    // The name alone is not a statement of what the company does.
    const nameOnly = run(job, intlModelReply({ industry: { value: 'B2B SaaS', quote: 'Acme Analytics is hiring' } }));
    expect(nameOnly.companyIndustry).toBeNull();
    expect(nameOnly.report.droppedQuotes).toEqual(['industry:company_name_only']);

    // A real line of the posting that does not say what the employer does backs no industry,
    // and a line about one industry does not back another.
    const hiring = run(job, intlModelReply({ industry: { value: 'B2B SaaS', quote: 'Acme Analytics is hiring a Backend Engineer to build data APIs for retail clients.' } }));
    expect(hiring.companyIndustry).toBeNull();
    expect(hiring.report.droppedQuotes).toEqual(['industry:off_topic']);
    const other = run(job, intlModelReply({ industry: { value: 'Fintech', quote } }));
    expect(other.companyIndustry).toBeNull();
    expect(other.report.droppedQuotes).toEqual(['industry:off_topic']);

    expect(run(job, intlModelReply()).companyIndustry).toBeNull();
    expect(run(job, intlModelReply({ industry: { value: 'Space mining', quote } })).companyIndustry).toBeNull();
    expect(run(job, null).companyIndustry).toBeNull();
  });

  it('SM-10: the industry word in the company name is not a statement of the business', () => {
    // 某某能源集团是一家中央企业: the sentence says the employer is a state company that is hiring.
    // "能源" stands only in its name, so no industry follows from it.
    const job = makeJob({ market: 'cn', title: '数据分析师', companyName: '某某能源集团', description: CN_POSTING, descriptionPlain: CN_POSTING });
    const reply = (industry: unknown) => intlModelReply({ sponsorship: null, citizenshipRequired: null, skills: [], industry });
    const fromName = run(job, reply({ value: 'climate', quote: '某某能源集团是一家中央企业，现招聘数据分析师。' }));
    expect(fromName.companyIndustry).toBeNull();
    expect(fromName.report.droppedQuotes).toEqual(['industry:off_topic']);
    const nameOnly = run(job, reply({ value: 'Climate', quote: '某某能源集团' }));
    expect(nameOnly.companyIndustry).toBeNull();
    expect(nameOnly.report.droppedQuotes).toEqual(['industry:company_name_only']);

    // The same employer, a posting that states the business in its own words.
    const business = '公司主营光伏与储能业务，在全国运营四十座电站。';
    const text = `${CN_POSTING}\n${business}`;
    const stating = makeJob({ market: 'cn', title: '数据分析师', companyName: '某某能源集团', description: text, descriptionPlain: text });
    const ok = run(stating, reply({ value: 'climate', quote: business }));
    expect(ok.companyIndustry).toEqual({ industry: 'Climate', quote: business });
    expect(ok.report.droppedQuotes).toEqual([]);
    // The short form of the name is taken out too: 某某能源是… states nothing either.
    const shortName = `${CN_POSTING}\n某某能源是行业领先的综合服务商。`;
    const short = makeJob({ market: 'cn', title: '数据分析师', companyName: '某某能源集团', description: shortName, descriptionPlain: shortName });
    expect(run(short, reply({ value: 'Climate', quote: '某某能源是行业领先的综合服务商。' })).report.droppedQuotes).toEqual(['industry:off_topic']);
  });

  it('SM-10: a recruiter describing a client sets no industry for the recruiter', () => {
    const line = 'Our client is a leading fintech building payments infrastructure for banks.';
    const text = `${INTL_POSTING}\n${line}`;
    const job = makeJob({ companyName: 'Northbridge Recruitment', description: text, descriptionPlain: text });
    const out = run(job, intlModelReply({ industry: { value: 'Fintech', quote: line } }));
    expect(out.companyIndustry).toBeNull();
    expect(out.report.droppedQuotes).toEqual(['industry:client']);
  });

  it('merges provider skills before the model skills', () => {
    const job = makeJob({ skills: ['PostgreSQL', 'python'], skillsDetail: [{ skill: 'PostgreSQL', kind: 'hard', required: true }] });
    const { update } = run(job);
    expect(update.skills).toEqual(['postgresql', 'python', 'go', 'sql', 'kafka']);
    expect(update.skillsDetail![0]).toEqual({ skill: 'postgresql', kind: 'hard', required: true, skillId: null, via: 'none' });
  });

  it('drops claims whose quotes are not in the posting', () => {
    const { update, report } = run(
      makeJob(),
      intlModelReply({
        sponsorship: { status: 'not_offered', quote: 'No visas, ever.' },
        citizenshipRequired: { value: true, quote: 'Only citizens may apply.' },
        clearanceRequired: { value: true, quote: 'TS/SCI required.' },
      }),
    );
    expect(update.sponsorship).toBeNull();
    expect(update.sponsorshipEvidence).toBeNull();
    expect(update.citizenshipRequired).toBeNull();
    expect(update.clearanceRequired).toBeNull();
    expect(update.marketTags).toBeNull();
    expect(report.droppedQuotes).toEqual(['sponsorship', 'citizenship', 'clearance']);
  });

  it('corrects "unable to sponsor" labelled offered to not stated', () => {
    const { update, report } = run(makeJob(), intlModelReply({ sponsorship: { status: 'offered', quote: 'We are unable to sponsor work visas for this role.' } }));
    expect(update.sponsorship).toBeNull();
    expect(report.sponsorshipCorrected).toBe('negation_in_offered_quote');
  });

  it("keeps a provider's sponsorship on a never-enriched row when the model finds none, but clears a stale enrichment", () => {
    const reply = intlModelReply({ sponsorship: { status: 'not_stated', quote: null } });
    const fresh = run(makeJob({ sponsorship: 'offered', sponsorshipEvidence: 'Visa sponsorship available.' }), reply);
    expect(fresh.update.sponsorship).toBeUndefined();
    const stale = run(makeJob({ sponsorship: 'offered', sponsorshipEvidence: 'x', enrichedAt: new Date('2026-01-01') }), reply);
    expect(stale.update.sponsorship).toBeNull();
    expect(stale.update.sponsorshipEvidence).toBeNull();
  });

  it('adds GoApply employer tags only with a quote, keeping ingest tags', () => {
    const job = makeJob({
      market: 'cn',
      title: '数据分析师',
      description: CN_POSTING,
      descriptionPlain: CN_POSTING,
      employerTags: ['foreign'],
      marketTags: [{ tag: 'foreign', evidenceQuote: '外资企业', evidenceUrl: 'https://example.com' }],
    });
    const { update, report } = run(job, {
      taxonomyId: 'data_analyst',
      sponsorship: { status: 'not_stated', quote: null },
      summary: '负责业务数据分析和报表搭建。',
      employerTags: [
        { tag: 'soe', quote: '某某能源集团是一家中央企业' },
        { tag: 'hukou', quote: '表现优秀者可协助办理北京落户。' },
        { tag: 'bianzhi', quote: '提供事业编制' },
      ],
    });
    expect(update.employerTags).toEqual(['foreign', 'soe', 'hukou']);
    expect(update.marketTags).toEqual([
      { tag: 'foreign', evidenceQuote: '外资企业', evidenceUrl: 'https://example.com' },
      { tag: 'soe', evidenceQuote: '某某能源集团是一家中央企业', evidenceUrl: null },
      { tag: 'hukou', evidenceQuote: '表现优秀者可协助办理北京落户。', evidenceUrl: null },
    ]);
    expect(report.droppedQuotes).toEqual(['employerTag:bianzhi']);
    expect(update.fraudFlags).toBeUndefined();
    expect(update.primaryTaxonomyId).toBe('data_analyst');
    expect(update.summary).toBe('负责业务数据分析和报表搭建。');
  });

  it('drops off-topic and contradictory requirement quotes (review probe)', () => {
    const posting = `${INTL_POSTING}\nMust be authorized to work in the United States.\nUS citizenship is required for this position.`;
    const job = makeJob({ descriptionPlain: posting, description: posting });
    const offTopic = run(job, intlModelReply({ citizenshipRequired: { value: true, quote: 'Must be authorized to work in the United States.' } }));
    expect(offTopic.update.citizenshipRequired).toBeNull();
    expect(offTopic.update.marketTags).toBeNull();
    expect(offTopic.report.droppedQuotes).toContain('citizenship:off_topic');
    const flipped = run(job, intlModelReply({ citizenshipRequired: { value: false, quote: 'US citizenship is required for this position.' } }));
    expect(flipped.update.citizenshipRequired).toBeNull();
    expect(flipped.update.marketTags).toBeNull();
    expect(flipped.report.droppedQuotes).toContain('citizenship:no_negation_keyword');
  });

  it('rejects an employer tag backed by an unrelated quote (review probe)', () => {
    const posting = `${CN_POSTING}\n缴纳五险一金。`;
    const job = makeJob({ market: 'cn', title: '数据分析师', description: posting, descriptionPlain: posting });
    const { update, report } = run(job, {
      sponsorship: { status: 'not_stated', quote: null },
      employerTags: [
        { tag: 'hukou', quote: '缴纳五险一金。' },
        { tag: 'bianzhi', quote: '缴纳五险一金。' },
      ],
    });
    expect(update.employerTags).toBeUndefined();
    expect(update.marketTags).toBeNull();
    expect(report.droppedQuotes).toEqual(['employerTag:hukou', 'employerTag:bianzhi']);
  });

  it('a forced re-enrichment of a changed posting removes model employer tags whose quote is gone, keeping cited ingest tags', () => {
    const changed = ['某某能源集团是一家中央企业，现招聘数据分析师。', '岗位职责：负责业务数据分析。'].join('\n');
    const job = makeJob({
      market: 'cn',
      title: '数据分析师',
      description: changed,
      descriptionPlain: changed,
      enrichedAt: new Date('2026-09-01'),
      enrichVersion: ENRICH_VERSION,
      employerTags: ['foreign', 'soe', 'bianzhi', 'hukou'],
      marketTags: [
        { tag: 'foreign', evidenceQuote: '外资企业', evidenceUrl: 'https://example.com/company' },
        { tag: 'soe', evidenceQuote: '某某能源集团是一家中央企业', evidenceUrl: null },
        { tag: 'bianzhi', evidenceQuote: '提供事业编制', evidenceUrl: null },
        { tag: 'hukou', evidenceQuote: '表现优秀者可协助办理北京落户。', evidenceUrl: null },
      ],
    });
    const { update, report } = run(job, { sponsorship: { status: 'not_stated', quote: null }, employerTags: [] });
    expect(update.employerTags).toEqual(['foreign', 'soe']);
    expect(update.marketTags).toEqual([
      { tag: 'foreign', evidenceQuote: '外资企业', evidenceUrl: 'https://example.com/company' },
      { tag: 'soe', evidenceQuote: '某某能源集团是一家中央企业', evidenceUrl: null },
    ]);
    expect(report.staleEvidence).toEqual(['employerTag:bianzhi', 'employerTag:hukou']);

    // The same pruning on a rules-only re-enrichment, plus stale sponsorship / requirement evidence.
    const rulesOnly = run(
      {
        ...job,
        sponsorship: 'offered',
        sponsorshipEvidence: '可协助外国人办理工作签证。',
        citizenshipRequired: true,
        marketTags: [...(job.marketTags as object[]), { tag: 'citizenship_required', evidenceQuote: '仅限中国公民。', evidenceUrl: null }],
      },
      null,
    );
    expect(rulesOnly.update).toMatchObject({ employerTags: ['foreign', 'soe'], sponsorship: null, sponsorshipEvidence: null, citizenshipRequired: null });
    expect(rulesOnly.update.marketTags).toEqual([
      { tag: 'foreign', evidenceQuote: '外资企业', evidenceUrl: 'https://example.com/company' },
      { tag: 'soe', evidenceQuote: '某某能源集团是一家中央企业', evidenceUrl: null },
    ]);
    expect(rulesOnly.report.staleEvidence).toEqual(['employerTag:bianzhi', 'employerTag:hukou', 'citizenship', 'sponsorship']);
  });

  it('leaves employer tags alone on a rules-only first run (nothing earlier to re-check)', () => {
    const job = makeJob({ market: 'cn', title: '数据分析师', description: CN_POSTING, descriptionPlain: CN_POSTING, employerTags: ['bianzhi'], marketTags: [{ tag: 'bianzhi', evidenceQuote: '提供事业编制', evidenceUrl: null }] });
    const { update } = run(job, null);
    expect(update.employerTags).toBeUndefined();
    expect(update.marketTags).toBeUndefined();
  });

  it('stores only model skills the posting names (review: no invented requirements)', () => {
    const { update, report } = run(
      makeJob(),
      intlModelReply({
        skills: [
          { skill: 'Python', kind: 'hard', required: true },
          { skill: 'Rust', kind: 'hard', required: true },
          { skill: 'PostgreSQL', kind: 'hard', required: false },
          { skill: 'Stakeholder management', kind: 'soft', required: false },
        ],
      }),
    );
    expect(update.skills).toEqual(['python', 'postgresql']);
    expect(report.droppedSkills).toEqual(['rust', 'stakeholder management']);
  });

  it('grounds skills by exact phrase, punctuation variants or word stems', () => {
    expect(skillGrounded('Experience with Node.js and CI/CD.', 'nodejs')).toBe(true);
    expect(skillGrounded('Experience with NodeJS.', 'node.js')).toBe(true);
    expect(skillGrounded('Own the CI CD pipeline.', 'ci/cd')).toBe(true);
    expect(skillGrounded('You will manage stakeholders across teams.', 'stakeholder management')).toBe(true);
    expect(skillGrounded('熟悉SQL和Python。', 'python')).toBe(true);
    expect(skillGrounded('熟悉SQL和Python。', '数据可视化')).toBe(false);
    expect(skillGrounded('We use Go.', 'rust')).toBe(false);
    expect(skillGrounded('We use Go.', 'machine learning')).toBe(false);
    expect(skillGrounded('Anything.', '  ')).toBe(false);
  });

  it('ignores employer tags on intl jobs', () => {
    const { update } = run(makeJob(), intlModelReply({ employerTags: [{ tag: 'soe', quote: 'Acme Analytics is hiring' }] }));
    expect(update.employerTags).toBeUndefined();
  });

  it('rules only: scam flags, version and "rules" model, no AI fields', () => {
    const job = makeJob({ descriptionPlain: 'Pay the $40 registration fee to start. Contact us only via Telegram.' });
    const { update } = run(job, null);
    expect(update.enrichModel).toBe(RULES_ONLY_MODEL);
    expect(update.enrichVersion).toBe(ENRICH_VERSION);
    expect(update.summary).toBeUndefined();
    expect(update.sponsorship).toBeUndefined();
    expect(update.skills).toBeUndefined();
    expect(update.titleMatchScore).toBe(1);
    expect(update.fraudFlags!.map((f) => f.rule)).toEqual(['intl_fee_required', 'intl_messaging_app_only']);
    for (const f of update.fraudFlags!) expect(job.descriptionPlain).toContain(f.evidence);
  });
});

describe('clampSummary', () => {
  it('keeps at most two sentences and caps the length', () => {
    expect(clampSummary('One. Two! Three?')).toBe('One. Two!');
    expect(clampSummary('第一句。第二句。第三句。')).toBe('第一句。第二句。');
    expect(clampSummary('  ')).toBeNull();
    expect(clampSummary(null)).toBeNull();
    const long = clampSummary(`${'word '.repeat(200)}.`)!;
    expect(long.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 1);
    expect(long.endsWith('…')).toBe(true);
  });
});

// ── SM-6: canonical skill ids at write time ──────────────────────────────

describe('SM-6: skills are written with canonical ids', () => {
  const POSTGRES_POSTING = [
    'We run Postgres in production, and query tuning for PostgreSQL is weekly work.',
    'Clear communication with the product team matters.',
    'You will also keep our feature flags tidy.',
  ].join('\n');
  const postgresJob = () => makeJob({ description: POSTGRES_POSTING, descriptionPlain: POSTGRES_POSTING });

  it('ACCEPT: "postgres", "PostgreSQL" and "communication" end as one PostgreSQL entry with its id; the soft skill is shown and never in skillIds; both spellings stay searchable', async () => {
    const reply = intlModelReply({
      skills: [
        { skill: 'postgres', kind: 'hard', required: true },
        { skill: 'PostgreSQL', kind: 'hard', required: false },
        // The model calls it hard; the vocabulary knows it is a soft skill.
        { skill: 'communication', kind: 'hard', required: true },
      ],
    });
    const { update, report } = await runMapped(postgresJob(), reply);
    expect(update.skillsDetail).toEqual([
      // One entry for the two spellings, shown by the skill's own name; required because one of them was called required.
      // The other spelling is named on the entry: it stays in `skills`, and a reader must not take it for a second skill.
      { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias', also: ['postgres'] },
      { skill: 'communication', kind: 'soft', required: true, skillId: 'communication', via: 'alias' },
    ]);
    expect(update.skillIds).toEqual(['postgresql']);
    expect(update.skills).toEqual(['postgres', 'postgresql', 'communication']);
    expect(report.skillCounts).toEqual({ canonical: 2, unreviewed: 0, dropped: 0 });
  });

  it('every string of `skills` is spoken for by one entry: its own, or the `also` of the skill it spells (review: a second spelling is not a second, hard skill)', async () => {
    const text = 'We need a team player with good teamwork, 沟通能力 and clear communication. Postgres and PostgreSQL daily; pgsqldb too.';
    const snapshot = fixtureVocabulary(FIXTURE_SKILLS.map((r) => (r.id === 'teamwork' ? { ...r, aliases: ['team player'] } : r)));
    const job = makeJob({ description: text, descriptionPlain: text, skills: ['postgres', 'team player'] });
    const reply = intlModelReply({
      skills: [
        { skill: 'PostgreSQL', kind: 'hard', required: true },
        { skill: 'teamwork', kind: 'soft', required: false },
        { skill: 'communication', kind: 'soft', required: false },
        { skill: '沟通能力', kind: 'soft', required: false },
        { skill: 'pgsqldb', kind: 'hard', required: false },
      ],
    });
    const postingText = postingTextOf(job);
    const terms = skillTermsOf(job, postingText, parseEnrichOutput(reply));
    const skillMap = new Map(await fixtureSkillMap(terms, snapshot));
    // A spelling no alias knows, mapped by an embedding neighbour: the reader's own vocabulary cannot fold it.
    skillMap.set('pgsqldb', mapping({ skillId: 'postgresql', kind: 'hard', status: 'reviewed', via: 'embedding', labels: ['postgresql'] }));
    const { update } = run(job, reply, { skillMap });
    expect(update.skills).toEqual(['postgres', 'team player', 'postgresql', 'teamwork', 'communication', '沟通能力', 'pgsqldb']);
    expect(update.skillsDetail).toEqual([
      { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias', also: ['postgres', 'pgsqldb'] },
      // The soft skill's alias is soft with it: never a missing hard skill.
      { skill: 'teamwork', kind: 'soft', required: false, skillId: 'teamwork', via: 'alias', also: ['team player'] },
      { skill: 'communication', kind: 'soft', required: false, skillId: 'communication', via: 'alias', also: ['沟通能力'] },
    ]);
    // The entry is a guess only when no spelling of it is a name the vocabulary knows, whichever spelling came first.
    const guessFirst = run(makeJob({ description: text, descriptionPlain: text, skills: ['pgsqldb', 'postgres'] }), null, { skillMap });
    expect(guessFirst.update.skillsDetail).toEqual([{ skill: 'pgsqldb', kind: 'hard', required: false, skillId: 'postgresql', via: 'alias', also: ['postgres'] }]);
    const guessOnly = run(makeJob({ description: text, descriptionPlain: text, skills: ['pgsqldb'] }), null, { skillMap });
    expect(guessOnly.update.skillsDetail).toEqual([{ skill: 'pgsqldb', kind: 'hard', required: false, skillId: 'postgresql', via: 'embedding' }]);
    const spokenFor = new Set(update.skillsDetail!.flatMap((d) => [d.skill, ...(d.also ?? [])]));
    expect(update.skills!.every((s) => spokenFor.has(s))).toBe(true);
    expect(update.skillIds).toEqual(['postgresql']);

    // The next pass reads the entry back with its spellings, also after ingest wrote the provider's list over `skills`.
    const refreshed = makeJob({ description: text, descriptionPlain: text, skills: ['postgres', 'team player'], skillsDetail: update.skillsDetail, skillIds: update.skillIds, enrichedAt: new Date('2026-10-01') });
    expect(skillTermsOf(refreshed, postingText, null)).toEqual(['postgres', 'team player', 'postgresql', 'pgsqldb', 'teamwork', 'communication', '沟通能力']);
    const again = run(refreshed, null, { skillMap });
    expect(again.update.skillsDetail).toEqual(update.skillsDetail);
    expect(again.update.skillIds).toEqual(['postgresql']);
    // And the keyword list does not read a spoken-for spelling as a skill of its own.
    expect(keywordSkillsOf(refreshed, {}).map((k) => k.skill)).toEqual(['postgresql', 'teamwork', 'communication']);
  });

  it('skillIds: hard skills and certifications only, required first, each id once', async () => {
    const text = 'Requirements: CPA, SQL and Python. Nice to have: Kafka, Kubernetes (k8s) and teamwork.';
    const job = makeJob({ description: text, descriptionPlain: text });
    const { update } = await runMapped(
      job,
      intlModelReply({
        skills: [
          { skill: 'Kafka', kind: 'hard', required: false },
          { skill: 'k8s', kind: 'hard', required: false },
          { skill: 'teamwork', kind: 'soft', required: true },
          { skill: 'CPA', kind: 'hard', required: true },
          { skill: 'Kubernetes', kind: 'hard', required: false },
          { skill: 'SQL', kind: 'hard', required: true },
          { skill: 'Python', kind: 'hard', required: true },
        ],
      }),
    );
    // Required first (in the order the posting's skills were listed), then the preferred ones.
    expect(update.skillIds).toEqual(['cpa', 'sql', 'python', 'kafka', 'kubernetes']);
    const byId = new Map(update.skillsDetail!.map((d) => [d.skillId, d]));
    // The vocabulary's kind wins for a reviewed skill: CPA is a certification whatever the model said.
    expect(byId.get('cpa')).toMatchObject({ kind: 'certification', required: true });
    expect(byId.get('teamwork')).toMatchObject({ kind: 'soft', required: true });
    expect(byId.get('kubernetes')).toMatchObject({ skill: 'kubernetes', required: false });
    // Required under one spelling is required: the order the model lists the spellings in does not matter.
    const either = await runMapped(
      job,
      intlModelReply({ skills: [{ skill: 'Kubernetes', kind: 'hard', required: false }, { skill: 'k8s', kind: 'hard', required: true }] }),
    );
    expect(either.update.skillsDetail).toEqual([{ skill: 'kubernetes', kind: 'hard', required: true, skillId: 'kubernetes', via: 'alias', also: ['k8s'] }]);
    expect(update.skillsDetail!.filter((d) => d.skillId === 'kubernetes')).toHaveLength(1);
    expect(update.skills).toEqual(expect.arrayContaining(['k8s', 'kubernetes', 'teamwork']));
  });

  it('a skill the vocabulary does not know: created as unreviewed it is shown with its id; with no id at all it is shown without one; neither counts as canonical', () => {
    const job = postgresJob();
    const reply = intlModelReply({
      skills: [
        { skill: 'PostgreSQL', kind: 'hard', required: true },
        { skill: 'feature flags', kind: 'hard', required: false },
        { skill: 'query tuning', kind: 'hard', required: false },
      ],
    });
    const skillMap: SkillMap = new Map([
      ['postgresql', mapping({ skillId: 'postgresql', kind: 'hard', status: 'reviewed', via: 'alias', labels: ['postgresql'] })],
      // What a public posting gets once the embedding step found no neighbour: a new unreviewed skill.
      ['feature flags', mapping({ skillId: 'featureflag', kind: 'hard', status: 'unreviewed', via: 'new', labels: ['feature flags'] })],
      // With no embedding key only the exact-alias step runs: no id.
      ['query tuning', mapping({})],
    ]);
    const { update, report } = run(job, reply, { skillMap });
    expect(update.skillsDetail).toEqual([
      { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias' },
      { skill: 'feature flags', kind: 'hard', required: false, skillId: 'featureflag', via: 'new' },
      { skill: 'query tuning', kind: 'hard', required: false, skillId: null, via: 'none' },
    ]);
    // The unreviewed id is carried (a reader scores a skill only when the vocabulary has reviewed it).
    expect(update.skillIds).toEqual(['postgresql', 'featureflag']);
    expect(update.skills).toEqual(['postgresql', 'feature flags', 'query tuning']);
    expect(report.skillCounts).toEqual({ canonical: 1, unreviewed: 2, dropped: 0 });
  });

  it('a machine guess keeps its mark: `via` is stored on the entry', () => {
    const skillMap: SkillMap = new Map([['postgres db', mapping({ skillId: 'postgresql', kind: 'hard', status: 'reviewed', via: 'embedding', labels: ['postgresql'] })]]);
    const text = 'You will look after our Postgres DB.';
    const { update } = run(makeJob({ description: text, descriptionPlain: text }), intlModelReply({ skills: [{ skill: 'Postgres DB', kind: 'hard', required: true }] }), { skillMap });
    expect(update.skillsDetail).toEqual([{ skill: 'postgres db', kind: 'hard', required: true, skillId: 'postgresql', via: 'embedding' }]);
    expect(update.skillIds).toEqual(['postgresql']);
  });

  it('no skill is stored that the posting does not name, and such a string never reaches the vocabulary', () => {
    const job = postgresJob();
    const output = parseEnrichOutput(intlModelReply({ skills: [{ skill: 'PostgreSQL', kind: 'hard', required: true }, { skill: 'Rust', kind: 'hard', required: true }] }));
    // The terms that are sent to canonicalizeMany: grounded ones only (so nothing is created for "rust").
    expect(skillTermsOf(job, postingTextOf(job), output)).toEqual(['postgresql']);
    const { update, report } = run(job, intlModelReply({ skills: [{ skill: 'PostgreSQL', kind: 'hard', required: true }, { skill: 'Rust', kind: 'hard', required: true }] }));
    expect(update.skills).toEqual(['postgresql']);
    expect(report.droppedSkills).toEqual(['rust']);
    expect(report.skillCounts.dropped).toBe(1);
  });

  it('the terms are the row\'s own strings first (the provider field), then stored entries, then the model\'s; each once', () => {
    const job = makeJob({
      description: POSTGRES_POSTING,
      descriptionPlain: POSTGRES_POSTING,
      skills: ['Postgres', 'SQL'],
      skillsDetail: [{ skill: 'communication', kind: 'soft', required: false }],
    });
    const output = parseEnrichOutput(intlModelReply({ skills: [{ skill: 'PostgreSQL', kind: 'hard', required: true }, { skill: 'postgres', kind: 'hard', required: true }] }));
    expect(skillTermsOf(job, postingTextOf(job), output)).toEqual(['postgres', 'sql', 'communication', 'postgresql']);
    // A rules-only pass has no model list.
    expect(skillTermsOf(job, postingTextOf(job), null)).toEqual(['postgres', 'sql', 'communication']);
  });

  it('the model fills what the provider did not say: its `required` for a provider string, and its reading replaces an earlier pass\'s', async () => {
    const text = 'Must have: Python and SQL. Nice to have: Kafka.';
    const job = makeJob({
      description: text,
      descriptionPlain: text,
      skills: ['python', 'sql', 'kafka'],
      // An earlier pass called Kafka required; the posting says otherwise today.
      skillsDetail: [{ skill: 'kafka', kind: 'hard', required: true, skillId: 'kafka', via: 'alias' }],
    });
    const { update } = await runMapped(job, intlModelReply({ skills: [{ skill: 'Python', kind: 'hard', required: true }, { skill: 'Kafka', kind: 'hard', required: false }] }));
    expect(update.skillsDetail).toEqual([
      { skill: 'python', kind: 'hard', required: true, skillId: 'python', via: 'alias' },
      // The provider listed it and nothing says whether it is required.
      { skill: 'sql', kind: 'hard', required: false, skillId: 'sql', via: 'alias' },
      { skill: 'kafka', kind: 'hard', required: false, skillId: 'kafka', via: 'alias' },
    ]);
    expect(update.skillIds).toEqual(['python', 'sql', 'kafka']);
    // A stored entry the model does not list keeps what it said.
    const kept = await runMapped(job, intlModelReply({ skills: [{ skill: 'Python', kind: 'hard', required: true }] }));
    expect(kept.update.skillsDetail!.find((d) => d.skillId === 'kafka')).toMatchObject({ required: true });
    expect(kept.update.skillIds).toEqual(['python', 'kafka', 'sql']);
  });

  it('a rules-only pass gives the provider\'s skills their ids too (no model needed)', async () => {
    const plain = 'Build APIs in Python and Go. Benefits include dental.';
    const job = makeJob({ description: plain, descriptionPlain: plain, skills: ['python', 'golang', 'sql', 'kafka', 'in-house rpc'] });
    const { update, report } = await runMapped(job, null);
    expect(update.enrichModel).toBe(RULES_ONLY_MODEL);
    expect(update.skillIds).toEqual(['python', 'go', 'sql', 'kafka']);
    expect(update.skillsDetail).toEqual([
      { skill: 'python', kind: 'hard', required: false, skillId: 'python', via: 'alias' },
      { skill: 'golang', kind: 'hard', required: false, skillId: 'go', via: 'alias' },
      { skill: 'sql', kind: 'hard', required: false, skillId: 'sql', via: 'alias' },
      { skill: 'kafka', kind: 'hard', required: false, skillId: 'kafka', via: 'alias' },
      { skill: 'in-house rpc', kind: 'hard', required: false, skillId: null, via: 'none' },
    ]);
    expect(update.skills).toEqual(['python', 'golang', 'sql', 'kafka', 'in-house rpc']);
    expect(report.skillCounts).toEqual({ canonical: 4, unreviewed: 1, dropped: 0 });
  });

  it('a string a reviewer ruled is not a skill is not stored, whoever listed it', async () => {
    const text = 'A fast-paced environment. You will write Python.';
    const job = makeJob({ description: text, descriptionPlain: text, skills: ['fast-paced environment', 'python'] });
    const postingText = postingTextOf(job);
    const reply = intlModelReply({ skills: [{ skill: 'Fast-paced environment', kind: 'soft', required: false }, { skill: 'Python', kind: 'hard', required: true }] });
    const dropped = fixtureVocabulary(undefined, ['fastpacedenvironment']);
    const skillMap = await fixtureSkillMap(skillTermsOf(job, postingText, parseEnrichOutput(reply)), dropped);
    expect(skillMap.get('fast-paced environment')).toMatchObject({ status: 'dropped', skillId: null });
    const { update, report } = run(job, reply, { skillMap });
    expect(update.skills).toEqual(['python']);
    expect(update.skillsDetail).toEqual([{ skill: 'python', kind: 'hard', required: true, skillId: 'python', via: 'alias' }]);
    expect(report.skillCounts).toEqual({ canonical: 1, unreviewed: 0, dropped: 1 });
    // When every string of the row is ruled out, the row ends with no skills at all.
    const only = makeJob({ description: text, descriptionPlain: text, skills: ['fast-paced environment'] });
    const emptied = run(only, null, { skillMap });
    expect(emptied.update).toMatchObject({ skills: [], skillsDetail: null, skillIds: [] });
  });

  it('keeps at most 25 skills and 25 ids', () => {
    const names = Array.from({ length: 40 }, (_, i) => `tool${i}`);
    const text = `We use ${names.join(', ')}.`;
    const job = makeJob({ description: text, descriptionPlain: text, skills: names });
    const skillMap: SkillMap = new Map(names.map((n) => [n, mapping({ skillId: `id_${n}`, kind: 'hard', status: 'reviewed', via: 'alias', labels: [n] })]));
    const { update } = run(job, null, { skillMap });
    expect(update.skills).toHaveLength(MAX_JOB_SKILLS);
    expect(update.skillsDetail).toHaveLength(MAX_JOB_SKILLS);
    expect(update.skillIds).toHaveLength(MAX_JOB_SKILLS);
    expect(update.skillIds![0]).toBe('id_tool0');
  });

  it('the keyword list reads the entries of this pass, else what the row holds; a row counts a skill it already holds once', () => {
    const job = makeJob({
      skills: ['python', 'sql', 'legacy tool'],
      skillIds: ['python'],
      skillsDetail: [
        { skill: 'python', kind: 'hard', required: true, skillId: 'python', via: 'alias' },
        { skill: 'communication', kind: 'soft', required: false, skillId: 'communication', via: 'alias' },
        // Written before version 3: no id on the entry.
        { skill: 'sql', kind: 'hard', required: true },
      ],
    });
    expect(keywordSkillsOf(job, {})).toEqual([
      { skill: 'python', required: true, skillId: 'python', kind: 'hard', via: 'alias' },
      { skill: 'communication', required: false, skillId: 'communication', kind: 'soft', via: 'alias' },
      { skill: 'sql', required: true },
      { skill: 'legacy tool', required: false },
    ]);
    // How the id was found travels with the skill: a machine guess is never a keyword (keywords.ts).
    expect(keywordSkillsOf(job, { skillsDetail: [{ skill: 'go', kind: 'hard', required: false, skillId: 'go', via: 'embedding' }] })).toEqual([{ skill: 'go', required: false, skillId: 'go', kind: 'hard', via: 'embedding' }]);
    // A pass that ended with no skill at all (every string was ruled out) says so: the row's old entries are not read.
    expect(keywordSkillsOf(job, { skillsDetail: null })).toEqual([]);
    expect([...heldSkillIds(job)].sort()).toEqual(['communication', 'python']);
    expect([...heldSkillIds(makeJob())]).toEqual([]);
  });

  it('reconcileSkillColumns: the skill columns of an enriched row mapped anew, and whether anything changed', async () => {
    const text = 'Must have: Python and vector clocks. Nice to have: Kafka.';
    // As a pass wrote it while the embedding step was off: "vector clocks" has no id.
    const stored = [
      { skill: 'python', kind: 'hard', required: true, skillId: 'python', via: 'alias' },
      { skill: 'vector clocks', kind: 'hard', required: true, skillId: null, via: 'none' },
      { skill: 'kafka', kind: 'hard', required: false, skillId: 'kafka', via: 'alias' },
    ];
    const job = makeJob({ description: text, descriptionPlain: text, skills: ['python', 'vector clocks', 'kafka'], skillsDetail: stored, skillIds: ['python', 'kafka'], enrichedAt: new Date('2026-10-01'), enrichVersion: ENRICH_VERSION });
    const postingText = postingTextOf(job);
    const terms = skillTermsOf(job, postingText, null);
    // The vocabulary answers what it answered then: nothing changes, whatever order jsonb gives the keys back in.
    const same = reconcileSkillColumns({ ...job, skillsDetail: stored.map((d) => ({ via: d.via, skillId: d.skillId, skill: d.skill, required: d.required, kind: d.kind })) }, postingText, await fixtureSkillMap(terms));
    expect(same.changed).toBe(false);
    expect(same.update).toEqual({ skills: ['python', 'vector clocks', 'kafka'], skillsDetail: stored, skillIds: ['python', 'kafka'], searchText: 'backend engineer acme analytics python vector clocks kafka' });
    // Now the string has a skill (created as unreviewed once label vectors exist): what the model said of it stays.
    const skillMap = new Map(await fixtureSkillMap(terms));
    skillMap.set('vector clocks', mapping({ skillId: 'vectorclock', kind: 'hard', status: 'unreviewed', via: 'new', labels: ['vector clocks'] }));
    const mapped = reconcileSkillColumns(job, postingText, skillMap);
    expect(mapped.changed).toBe(true);
    expect(mapped.update.skillsDetail).toEqual([stored[0], { skill: 'vector clocks', kind: 'hard', required: true, skillId: 'vectorclock', via: 'new' }, stored[2]]);
    expect(mapped.update.skillIds).toEqual(['python', 'vectorclock', 'kafka']);
    expect(mapped.counts).toEqual({ canonical: 2, unreviewed: 1, dropped: 0 });
    // Only the skill columns: nothing of the version stamp, the requirement list or the tags.
    expect(Object.keys(mapped.update).sort()).toEqual(['searchText', 'skillIds', 'skills', 'skillsDetail']);
  });

  it('writes a skill string the way RAJob.skills holds it', () => {
    expect(skillMapKey('  PostgreSQL  ')).toBe('postgresql');
    expect(skillMapKey('Ｎｏｄｅ.js')).toBe('node.js');
    expect(skillMapKey('Stakeholder   Management')).toBe('stakeholder management');
  });
});

// ── SM-8: requirement lines, extracted once per posting ──────────────────

describe('SM-8: requirement lines', () => {
  const REQ_POSTING = [
    'About the role: you will own our billing services.',
    'Requirements:',
    '5+ years building backend services',
    'Bachelor’s degree in Computer Science or a related field',
    'Nice to have: Kubernetes',
    'Must be authorized to work in the United States.',
    'We pay $150,000 a year and the office is in Austin.',
  ].join('\n');
  const reqJob = (over: Partial<EnrichJobRecord> = {}) => makeJob({ description: REQ_POSTING, descriptionPlain: REQ_POSTING, ...over });
  const lines = (requirements: unknown[]) => intlModelReply({ requirements, sponsorship: null, citizenshipRequired: null, skills: [] });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ACCEPT: "5+ years building backend services" and "Nice to have: Kubernetes" become two items with those exact texts, their kinds and importance', () => {
    const { update, report } = run(
      reqJob(),
      lines([
        { kind: 'skill', text: 'Nice to have: Kubernetes', importance: 'preferred' },
        { kind: 'experience', text: '5+ years building backend services', importance: 'must' },
      ]),
      { hash: true },
    );
    expect(update.requirements).toEqual({
      v: 1,
      contentHash: jobContentHash({ title: 'Backend Engineer', qualifications: null, descriptionPlain: REQ_POSTING, skills: [] }),
      model: 'test/enrich-model',
      extractedAt: NOW.toISOString(),
      // Ids follow the order of the posting, not the model's.
      items: [
        { id: 'r1', kind: 'experience', text: '5+ years building backend services', importance: 'must' },
        { id: 'r2', kind: 'skill', text: 'Nice to have: Kubernetes', importance: 'preferred' },
      ],
    });
    // The row had no list: the write holds only while that is still so (the scorer may store one first).
    expect(update.requirementsWere).toBeNull();
    expect(report.requirements).toEqual({ kept: 2, notInPosting: 0, age: 0, logistics: 0 });
  });

  it('a line that is not in the posting is dropped and counted; a line that differs only in spacing, case or curly quotes is the posting\'s own', () => {
    const { update, report } = run(
      reqJob(),
      lines([
        { kind: 'experience', text: 'Seven years of backend experience', importance: 'must' },
        { kind: 'education', text: "bachelor's   degree in computer science or a related field", importance: 'must' },
        { kind: 'skill', text: 'Experience with Rust', importance: 'preferred' },
      ]),
      { hash: true },
    );
    expect(update.requirements!.items).toEqual([{ id: 'r1', kind: 'education', text: "bachelor's degree in computer science or a related field", importance: 'must' }]);
    expect(report.requirements).toEqual({ kept: 1, notInPosting: 2, age: 0, logistics: 0 });
  });

  it('drops a repeated line, and lines about work authorization (logistics are computed elsewhere)', () => {
    const { update, report } = run(
      reqJob(),
      lines([
        { kind: 'experience', text: '5+ years building backend services', importance: 'must' },
        { kind: 'experience', text: '5+ YEARS building backend services', importance: 'preferred' },
        { kind: 'scope', text: 'Must be authorized to work in the United States.', importance: 'must' },
      ]),
      { hash: true },
    );
    expect(update.requirements!.items).toEqual([{ id: 'r1', kind: 'experience', text: '5+ years building backend services', importance: 'must' }]);
    expect(report.requirements).toEqual({ kept: 1, notInPosting: 0, age: 0, logistics: 1 });
  });

  it('only wording about the applicant\'s own status is logistics: visas as the work itself stay a requirement', () => {
    const text = [
      'Experience preparing visa petitions for corporate clients',
      'Familiarity with event sponsorship deals',
      'Applicants must have valid work authorization',
      'We are unable to provide sponsorship',
      '熟悉各国签证办理流程',
      '需持有有效工作许可',
      // Review probes: the subject named as the work an HR, mobility or immigration role does.
      'Experience with visa sponsorship processes and immigration compliance (HR)',
      'Knowledge of employment authorization rules, I-9 and E-Verify',
      '熟悉外籍员工工作许可办理流程',
      '负责外籍员工工作签证的办理',
      // The same nouns as the applicant's own status, or as what the employer offers.
      'Work authorization in the United States is required',
      'Visa sponsorship is not available for this role',
      '公司可协助办理工作签证',
    ].join('\n');
    // Thirteen lines: over the default cap of twelve.
    vi.stubEnv('ENRICH_REQUIREMENTS_MAX', '24');
    const { update, report } = run(
      makeJob({ description: text, descriptionPlain: text }),
      lines(text.split('\n').map((t) => ({ kind: 'experience', text: t, importance: 'must' }))),
      { hash: true },
    );
    expect(update.requirements!.items.map((i) => i.text)).toEqual([
      'Experience preparing visa petitions for corporate clients',
      'Familiarity with event sponsorship deals',
      '熟悉各国签证办理流程',
      'Experience with visa sponsorship processes and immigration compliance (HR)',
      'Knowledge of employment authorization rules, I-9 and E-Verify',
      '熟悉外籍员工工作许可办理流程',
      '负责外籍员工工作签证的办理',
    ]);
    expect(report.requirements).toEqual({ kept: 7, notInPosting: 0, age: 0, logistics: 6 });
  });

  it('keeps at most ENRICH_REQUIREMENTS_MAX lines', () => {
    const many = Array.from({ length: 6 }, (_, i) => `Requirement line number ${i + 1} about the work`);
    const text = many.join('\n');
    vi.stubEnv('ENRICH_REQUIREMENTS_MAX', '4');
    const { update } = run(makeJob({ description: text, descriptionPlain: text }), lines(many.map((t) => ({ kind: 'experience', text: t, importance: 'must' }))), { hash: true });
    expect(update.requirements!.items.map((i) => i.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('a list belongs to one text of the posting: kept when the content hash is the same, replaced when it changed', () => {
    const reply = lines([{ kind: 'experience', text: '5+ years building backend services', importance: 'must' }]);
    const first = run(reqJob(), reply, { hash: true });
    const stored = first.update.requirements!;
    // The same posting again (a version bump, a forced pass): two people scored later read the same checklist.
    const again = run(reqJob({ requirements: stored, enrichedAt: new Date('2026-10-01') }), lines([{ kind: 'skill', text: 'Nice to have: Kubernetes', importance: 'preferred' }]), { hash: true });
    expect(again.update.requirements).toBeUndefined();
    expect(again.update.requirementsWere).toBeUndefined();
    // The posting changed: the list is extracted anew, and the write is tied to the list that was read.
    const edited = `${REQ_POSTING}\nOn-call one week in six.`;
    const changed = run(reqJob({ description: edited, descriptionPlain: edited, requirements: stored, enrichedAt: new Date('2026-10-01') }), reply, { hash: true });
    expect(changed.update.requirements!.contentHash).not.toBe(stored.contentHash);
    expect(changed.update.requirements!.items).toHaveLength(1);
    expect(changed.update.requirementsWere).toBe(stored.contentHash);
  });

  it('the key of a list is the posting\'s text, never its skill strings: a pass that adds a skill and an ingest refresh that resets them leave the list', () => {
    const reply = lines([{ kind: 'experience', text: '5+ years building backend services', importance: 'must' }]);
    const withSkill = intlModelReply({ requirements: reply.requirements, sponsorship: null, citizenshipRequired: null, skills: [{ skill: 'Kubernetes', kind: 'hard', required: false }] });
    // A provider row: the pass adds the skill the posting names to the provider's list.
    const provider = reqJob({ skills: ['backend'] });
    const first = run(provider, withSkill, { hash: true });
    expect(first.update.skills).toEqual(['backend', 'kubernetes']);
    const stored = first.update.requirements!;
    const textHash = jobContentHash({ title: 'Backend Engineer', qualifications: null, descriptionPlain: REQ_POSTING, skills: [] });
    expect(stored.contentHash).toBe(textHash);
    expect(requirementsHashRow(provider)).toEqual({ title: 'Backend Engineer', qualifications: null, descriptionPlain: REQ_POSTING, skills: [] });
    // The row's own content hash reads the skills, and differs before and after the pass: it is not the key.
    expect(jobContentHash({ title: 'Backend Engineer', descriptionPlain: REQ_POSTING, skills: ['backend'] })).not.toBe(textHash);
    expect(jobContentHash({ title: 'Backend Engineer', descriptionPlain: REQ_POSTING, skills: ['backend', 'kubernetes'] })).not.toBe(textHash);
    // The row as enrichment left it, then as the next ingest refresh leaves it (the provider's list written back),
    // then with a provider list that changed: the list is the same posting's every time, on a model pass and on a
    // rules-only pass. Two people scored on either side of the refresh read one checklist.
    for (const skills of [['backend', 'kubernetes'], ['backend'], ['backend', 'apis'], []]) {
      for (const r of [withSkill, null]) {
        const later = run(reqJob({ skills, requirements: stored, enrichedAt: new Date('2026-10-01') }), r, { hash: true });
        expect(later.update.requirements, JSON.stringify(skills)).toBeUndefined();
        expect('requirementsWere' in later.update).toBe(false);
      }
    }
    // The text is what counts: the same skills with an edited posting is a new list.
    const edited = `${REQ_POSTING}\nOn-call one week in six.`;
    const changed = run(reqJob({ skills: ['backend', 'kubernetes'], description: edited, descriptionPlain: edited, requirements: stored, enrichedAt: new Date('2026-10-01') }), withSkill, { hash: true });
    expect(changed.update.requirements!.contentHash).not.toBe(textHash);
  });

  it('a rules-only pass writes no list; it removes one that belongs to an earlier text and leaves a current one', () => {
    expect(run(reqJob(), null, { hash: true }).update.requirements).toBeUndefined();
    const stored = run(reqJob(), lines([{ kind: 'experience', text: '5+ years building backend services', importance: 'must' }]), { hash: true }).update.requirements!;
    expect(run(reqJob({ requirements: stored, enrichedAt: new Date('2026-10-01') }), null, { hash: true }).update.requirements).toBeUndefined();
    const edited = `${REQ_POSTING}\nOn-call one week in six.`;
    const stale = run(reqJob({ description: edited, descriptionPlain: edited, requirements: stored, enrichedAt: new Date('2026-10-01') }), null, { hash: true });
    expect(stale.update.requirements).toBeNull();
    expect(stale.update.requirementsWere).toBe(stored.contentHash);
    expect(stale.report.requirements).toBeNull();
  });

  it('a model that returns no line of the posting writes nothing on a row without a list, and removes a stale one', () => {
    const none = run(reqJob(), lines([{ kind: 'skill', text: 'Experience with Rust', importance: 'must' }]), { hash: true });
    expect(none.update.requirements).toBeUndefined();
    expect(none.report.requirements).toEqual({ kept: 0, notInPosting: 1, age: 0, logistics: 0 });
    const stale = run(reqJob({ requirements: { v: 1, contentHash: 'older', model: 'm', extractedAt: 'x', items: [] } }), lines([]), { hash: true });
    expect(stale.update.requirements).toBeNull();
    expect(stale.update.requirementsWere).toBe('older');
  });

  it('without the hash function the list is left alone', () => {
    const { update, report } = run(reqJob(), lines([{ kind: 'experience', text: '5+ years building backend services', importance: 'must' }]));
    expect(update.requirements).toBeUndefined();
    expect(report.requirements).toBeNull();
  });

  it('reads a stored list only in the shape this module writes', () => {
    const ok = { v: 1, contentHash: 'h', model: 'm', extractedAt: 'x', items: [] };
    expect(readStoredRequirements(ok)).toBe(ok);
    for (const bad of [null, undefined, 'x', [], { v: 2, contentHash: 'h', items: [] }, { v: 1, items: [] }, { v: 1, contentHash: 'h' }]) expect(readStoredRequirements(bad)).toBeNull();
    // Something unreadable on the row is replaced without a condition.
    const { update } = run(reqJob({ requirements: { legacy: true } }), lines([{ kind: 'experience', text: '5+ years building backend services', importance: 'must' }]), { hash: true });
    expect(update.requirements!.items).toHaveLength(1);
    expect('requirementsWere' in update).toBe(false);
  });

  it('GoApply: 届别 and 学历 lines are requirements of kind education; an age line is never a requirement and is recorded as a quoted tag', () => {
    const posting = [
      '某某科技招聘数据分析师。',
      '任职要求：',
      '2026届应届毕业生',
      '本科及以上学历，统计学相关专业',
      '年龄35周岁以下',
      '熟悉SQL和Python',
    ].join('\n');
    const job = makeJob({ market: 'cn', title: '数据分析师', companyName: '某某科技', description: posting, descriptionPlain: posting });
    const { update, report } = run(
      job,
      {
        taxonomyId: 'data_analyst',
        sponsorship: { status: 'not_stated', quote: null },
        requirements: [
          { kind: 'education', text: '2026届应届毕业生', importance: 'must' },
          { kind: 'education', text: '本科及以上学历，统计学相关专业', importance: 'must' },
          { kind: 'experience', text: '年龄35周岁以下', importance: 'must' },
          { kind: 'skill', text: '熟悉SQL和Python', importance: 'must' },
        ],
      },
      { hash: true },
    );
    expect(update.requirements!.items).toEqual([
      { id: 'r1', kind: 'education', text: '2026届应届毕业生', importance: 'must' },
      { id: 'r2', kind: 'education', text: '本科及以上学历，统计学相关专业', importance: 'must' },
      { id: 'r3', kind: 'skill', text: '熟悉SQL和Python', importance: 'must' },
    ]);
    expect(report.requirements).toEqual({ kept: 3, notInPosting: 0, age: 1, logistics: 0 });
    expect(update.marketTags).toEqual([{ tag: AGE_LIMIT_TAG, evidenceQuote: '年龄35周岁以下', evidenceUrl: null }]);
    // The tag is a rule, not a model claim: a rules-only first pass records it too.
    const rules = run(job, null);
    expect(rules.update.marketTags).toEqual([{ tag: AGE_LIMIT_TAG, evidenceQuote: '年龄35周岁以下', evidenceUrl: null }]);
    expect(rules.update.requirements).toBeUndefined();
  });

  it('a line that states an age AND something else keeps the something else: only the age clause is taken out (review probe)', () => {
    const posting = [
      '某某机械招聘设备维修工。',
      '任职要求：',
      '年龄25-35岁，大专及以上学历，3年以上机械维修经验',
      '身体健康，年龄18-50周岁，能适应倒班',
      '年满18周岁，持有电工证',
      '年龄45周岁以下',
    ].join('\n');
    const job = makeJob({ market: 'cn', title: '设备维修工', companyName: '某某机械', description: posting, descriptionPlain: posting });
    const { update, report } = run(
      job,
      {
        taxonomyId: null,
        sponsorship: { status: 'not_stated', quote: null },
        requirements: [
          { kind: 'experience', text: '年龄25-35岁，大专及以上学历，3年以上机械维修经验', importance: 'must' },
          { kind: 'scope', text: '身体健康，年龄18-50周岁，能适应倒班', importance: 'must' },
          { kind: 'skill', text: '年满18周岁，持有电工证', importance: 'must' },
          { kind: 'experience', text: '年龄45周岁以下', importance: 'must' },
        ],
      },
      { hash: true },
    );
    // Every text is still a verbatim piece of the posting; no item mentions an age.
    expect(update.requirements!.items).toEqual([
      { id: 'r1', kind: 'experience', text: '大专及以上学历，3年以上机械维修经验', importance: 'must' },
      { id: 'r2', kind: 'scope', text: '身体健康', importance: 'must' },
      { id: 'r3', kind: 'scope', text: '能适应倒班', importance: 'must' },
      { id: 'r4', kind: 'skill', text: '持有电工证', importance: 'must' },
    ]);
    for (const item of update.requirements!.items) expect(posting).toContain(item.text);
    // Only the line that is about age and nothing else counts as an age line.
    expect(report.requirements).toEqual({ kept: 4, notInPosting: 0, age: 1, logistics: 0 });
    expect(update.marketTags).toEqual([{ tag: AGE_LIMIT_TAG, evidenceQuote: '年龄25-35岁，大专及以上学历，3年以上机械维修经验', evidenceUrl: null }]);
  });

  it('the ages of the people a job serves, and a production year, are the work: the lines stay requirements and nothing is flagged (review probes)', () => {
    const cnLines = ['1、熟悉2018年以后生产的数控设备的维修保养；', '负责18-35岁女性护肤产品的市场推广', '产品主要面向35岁以下白领'];
    const cnPosting = ['某某公司招聘。', ...cnLines].join('\n');
    const cn = run(
      makeJob({ market: 'cn', title: '市场专员', companyName: '某某公司', description: cnPosting, descriptionPlain: cnPosting }),
      { taxonomyId: null, sponsorship: { status: 'not_stated', quote: null }, requirements: cnLines.map((text) => ({ kind: 'experience', text, importance: 'must' })) },
      { hash: true },
    );
    expect(cn.update.requirements!.items.map((i) => i.text)).toEqual(cnLines);
    expect(cn.report.requirements).toEqual({ kept: 3, notInPosting: 0, age: 0, logistics: 0 });
    // No age statement in the posting: no tag, on a model pass and on a rules-only pass.
    expect(cn.update.marketTags).toBeNull();
    expect(run(makeJob({ market: 'cn', title: '市场专员', description: cnPosting, descriptionPlain: cnPosting }), null).update.marketTags).toBeUndefined();

    const enLines = ['Experience marketing to consumers aged 18 to 34', 'Experience coaching youth ages 10-18', 'Experience caring for adults 65 and older', 'Valid first aid certificate'];
    const enPosting = ['Join our care team.', ...enLines].join('\n');
    const en = run(makeJob({ title: 'Care Worker', description: enPosting, descriptionPlain: enPosting }), lines(enLines.map((text) => ({ kind: 'experience', text, importance: 'must' }))), { hash: true });
    expect(en.update.requirements!.items.map((i) => i.text)).toEqual(enLines);
    expect(en.report.requirements).toEqual({ kept: 4, notInPosting: 0, age: 0, logistics: 0 });
  });

  it('the age tag: GoApply only, beside the other quoted tags, and gone when the posting no longer states a limit', () => {
    const aged = `${CN_POSTING}\n年龄要求：22-35岁。`;
    const cn = (text: string, over: Partial<EnrichJobRecord> = {}) => makeJob({ market: 'cn', title: '数据分析师', companyName: '某某能源集团', description: text, descriptionPlain: text, ...over });
    const reply = { taxonomyId: 'data_analyst', sponsorship: { status: 'not_stated', quote: null }, employerTags: [{ tag: 'soe', quote: '某某能源集团是一家中央企业' }] };
    expect(run(cn(aged), reply).update.marketTags).toEqual([
      { tag: 'soe', evidenceQuote: '某某能源集团是一家中央企业', evidenceUrl: null },
      { tag: AGE_LIMIT_TAG, evidenceQuote: '年龄要求：22-35岁。', evidenceUrl: null },
    ]);
    // Ingest's tags stay where they are; the age tag is written once, with today's sentence.
    const held = [
      { tag: 'class_year:2026', evidenceQuote: '2026届', evidenceUrl: null },
      { tag: AGE_LIMIT_TAG, evidenceQuote: '年龄不超过30岁', evidenceUrl: null },
    ];
    const again = run(cn(aged, { marketTags: held, enrichedAt: new Date('2026-10-01') }), null);
    expect(again.update.marketTags).toEqual([
      { tag: 'class_year:2026', evidenceQuote: '2026届', evidenceUrl: null },
      { tag: AGE_LIMIT_TAG, evidenceQuote: '年龄要求：22-35岁。', evidenceUrl: null },
    ]);
    // The posting no longer states one: the tag goes, on a model pass and on a rules-only pass.
    for (const r of [reply, null]) {
      const gone = run(cn(CN_POSTING, { marketTags: held, enrichedAt: new Date('2026-10-01') }), r);
      expect((gone.update.marketTags ?? []).some((t) => t.tag === AGE_LIMIT_TAG)).toBe(false);
      expect((gone.update.marketTags ?? []).some((t) => t.tag === 'class_year:2026')).toBe(true);
    }
    // The working age is no limit, and RoboApply rows never carry the tag.
    expect(run(cn(`${CN_POSTING}\n年满18周岁。`), null).update.marketTags).toBeUndefined();
    const intl = `${INTL_POSTING}\nApplicants must be under 35 years old.`;
    expect(run(makeJob({ description: intl, descriptionPlain: intl }), null).update.marketTags).toBeUndefined();
  });
});

// ── JI-11: enrichment says where its sponsorship reading comes from ──────

describe('JI-11: sponsorshipSource', () => {
  const OFFERED = `${INTL_POSTING.replace('We are unable to sponsor work visas for this role.', 'Visa sponsorship is available for this role.')}`;
  const offeredJob = (over: Partial<EnrichJobRecord> = {}) => makeJob({ description: OFFERED, descriptionPlain: OFFERED, ...over });
  const offered = intlModelReply({ sponsorship: { status: 'offered', quote: 'Visa sponsorship is available for this role.' } });
  const silent = intlModelReply({ sponsorship: { status: 'not_stated', quote: null } });
  const NO_SIGNAL = INTL_POSTING.split('\n')
    .filter((l) => !/sponsor/i.test(l))
    .join('\n');
  const quietJob = (over: Partial<EnrichJobRecord> = {}) => makeJob({ description: NO_SIGNAL, descriptionPlain: NO_SIGNAL, ...over });

  it('uses the two strings ingest writes and reads', () => {
    expect(SPONSORSHIP_SOURCE_QUOTE).toBe(INGEST_SOURCE_QUOTE);
    expect(PROVIDER_SPONSORSHIP_PREFIX).toBe(INGEST_PROVIDER_PREFIX);
  });

  it('(a) ACCEPT: a value written with a verified quote names the posting as its source, also over a provider\'s reading', () => {
    expect(run(offeredJob(), offered).update).toMatchObject({
      sponsorship: 'offered',
      sponsorshipEvidence: 'Visa sponsorship is available for this role.',
      sponsorshipSource: 'posting_quote',
    });
    // The provider said the opposite: the posting's own words win.
    const over = run(offeredJob({ sponsorship: 'not_offered', sponsorshipSource: 'provider:activejobs_feed' }), offered);
    expect(over.update).toMatchObject({ sponsorship: 'offered', sponsorshipEvidence: 'Visa sponsorship is available for this role.', sponsorshipSource: 'posting_quote' });
    const enriched = run(offeredJob({ sponsorship: 'offered', sponsorshipSource: 'provider:activejobs_feed', enrichedAt: new Date('2026-09-01') }), offered);
    expect(enriched.update.sponsorshipSource).toBe('posting_quote');
    // "Unable to sponsor" is a quoted reading as well.
    expect(run(makeJob({ sponsorship: 'offered', sponsorshipSource: 'provider:jsearch' })).update).toMatchObject({ sponsorship: 'not_offered', sponsorshipSource: 'posting_quote' });
  });

  it('(b) ACCEPT: with no sponsorship sentence in the text a provider\'s reading and its source stay exactly as they are', () => {
    for (const enrichedAt of [null, new Date('2026-09-01')]) {
      const { update } = run(quietJob({ sponsorship: 'offered', sponsorshipSource: 'provider:activejobs_feed', enrichedAt }), silent);
      expect('sponsorship' in update).toBe(false);
      expect('sponsorshipSource' in update).toBe(false);
      expect('sponsorshipEvidence' in update).toBe(false);
    }
    // A rules-only pass leaves it alone too.
    const rules = run(quietJob({ sponsorship: 'not_offered', sponsorshipSource: 'provider:jsearch', enrichedAt: new Date('2026-09-01') }), null);
    expect('sponsorship' in rules.update).toBe(false);
    expect('sponsorshipSource' in rules.update).toBe(false);
    // A quote the model made up changes nothing about the provider's reading either.
    const invented = run(quietJob({ sponsorship: 'offered', sponsorshipSource: 'provider:activejobs_feed' }), intlModelReply({ sponsorship: { status: 'not_offered', quote: 'No visas, ever.' } }));
    expect('sponsorship' in invented.update).toBe(false);
    expect(invented.report.droppedQuotes).toContain('sponsorship');
  });

  it('(c) ACCEPT: a stored quote that no longer verifies is removed with its value and its source; a provider\'s reading loses only the quote', () => {
    const gone = { sponsorship: 'offered', sponsorshipEvidence: 'Visa sponsorship is available for this role.', enrichedAt: new Date('2026-09-01') };
    // Rules only (the posting was edited and nothing needs the model).
    const rules = run(quietJob({ ...gone, sponsorshipSource: 'posting_quote' }), null);
    expect(rules.update).toMatchObject({ sponsorship: null, sponsorshipEvidence: null, sponsorshipSource: null });
    expect(rules.report.staleEvidence).toEqual(['sponsorship']);
    // The same row as it was stored before this rule existed (no source): the same outcome.
    expect(run(quietJob(gone), null).update).toMatchObject({ sponsorship: null, sponsorshipEvidence: null, sponsorshipSource: null });
    // A provider's reading stays, labelled as the provider's.
    const provider = run(quietJob({ ...gone, sponsorshipSource: 'provider:activejobs_feed' }), null);
    expect(provider.update.sponsorshipEvidence).toBeNull();
    expect('sponsorship' in provider.update).toBe(false);
    expect('sponsorshipSource' in provider.update).toBe(false);
    expect(provider.report.staleEvidence).toEqual(['sponsorship']);
    // With a model that finds nothing: the earlier enrichment's value goes with its source; the provider's stays.
    expect(run(quietJob({ ...gone, sponsorshipSource: 'posting_quote' }), silent).update).toMatchObject({ sponsorship: null, sponsorshipEvidence: null, sponsorshipSource: null });
    const kept = run(quietJob({ ...gone, sponsorshipSource: 'provider:activejobs_feed' }), silent);
    expect(kept.update.sponsorshipEvidence).toBeNull();
    expect('sponsorship' in kept.update).toBe(false);
    expect('sponsorshipSource' in kept.update).toBe(false);
  });

  it('a quote that still stands makes the posting the source on a rules-only pass (a row enriched before this rule)', () => {
    const before = offeredJob({ sponsorship: 'offered', sponsorshipEvidence: 'Visa sponsorship is available for this role.', enrichedAt: new Date('2026-09-01') });
    const { update, report } = run(before, null);
    expect(update.sponsorshipSource).toBe('posting_quote');
    expect('sponsorship' in update).toBe(false);
    expect('sponsorshipEvidence' in update).toBe(false);
    expect(report.staleEvidence).toEqual([]);
    // Already labelled: nothing to write.
    expect('sponsorshipSource' in run({ ...before, sponsorshipSource: 'posting_quote' }, null).update).toBe(false);
  });

  it('the no-signal case is unchanged: nothing stated, nothing stored, no source', () => {
    const { update } = run(quietJob(), silent);
    expect(update.sponsorship).toBeNull();
    expect(update.sponsorshipEvidence).toBeNull();
    expect(update.sponsorshipSource).toBeNull();
    // A never-enriched row whose value names no source (stored before JI-7) is kept, as before.
    const legacy = run(quietJob({ sponsorship: 'offered' }), silent);
    expect('sponsorship' in legacy.update).toBe(false);
    expect('sponsorshipSource' in legacy.update).toBe(false);
    // A rules-only first pass claims nothing.
    const first = run(quietJob(), null);
    expect('sponsorship' in first.update).toBe(false);
    expect('sponsorshipSource' in first.update).toBe(false);
  });
});
