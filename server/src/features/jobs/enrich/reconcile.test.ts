// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clampSummary, deterministicCoverage, needsLlm, postingTextOf, reconcile, skillGrounded } from './reconcile.js';
import { selectTaxonomyCandidates } from './candidates.js';
import { detectScamSignals } from './scamSignals.js';
import { ENRICH_VERSION, MAX_SUMMARY_CHARS, RULES_ONLY_MODEL, parseEnrichOutput } from './schema.js';
import { CN_POSTING, INTL_POSTING, intlModelReply, makeJob } from './__tests__/fixtures.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');

function run(job = makeJob(), reply: Record<string, unknown> | null = intlModelReply()) {
  const postingText = postingTextOf(job);
  return reconcile({
    job,
    postingText,
    output: reply ? parseEnrichOutput(reply) : null,
    candidates: selectTaxonomyCandidates(job.title, postingText),
    scamSignals: detectScamSignals(postingText, job.market),
    model: 'test/enrich-model',
    now: NOW,
  });
}

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
    expect(update.skillsDetail).toEqual([
      { skill: 'python', kind: 'hard', required: true },
      { skill: 'go', kind: 'hard', required: true },
      { skill: 'sql', kind: 'hard', required: true },
      { skill: 'kafka', kind: 'hard', required: false },
    ]);
    expect(update.marketTags).toEqual([
      { tag: 'citizenship_required', evidenceQuote: 'Applicants must be US citizens due to a government contract.', evidenceUrl: null },
    ]);
    expect(update.searchText).toBe('backend engineer acme analytics python go sql kafka');
    expect(report).toEqual({ sponsorshipCorrected: null, droppedQuotes: [], droppedSkills: [], staleEvidence: [], taxonomyRejected: false });
  });

  it('only accepts a taxonomy id from the candidate list', () => {
    const { update, report } = run(makeJob(), intlModelReply({ taxonomyId: 'nurse_practitioner_invented' }));
    expect(update.taxonomyIds).toBeUndefined();
    expect(update.primaryTaxonomyId).toBeUndefined();
    expect(report.taxonomyRejected).toBe(true);
  });

  it('keeps deterministic taxonomy, seniority and education from ingest', () => {
    const job = makeJob({ primaryTaxonomyId: 'software_engineer', taxonomyIds: ['software_engineering', 'swe_backend', 'software_engineer'], seniority: 'senior', educationLevel: 'master' });
    const { update } = run(job, intlModelReply({ educationLevel: 'bachelor' }));
    expect(update.primaryTaxonomyId).toBeUndefined();
    expect(update.seniority).toBeUndefined();
    expect(update.educationLevel).toBeUndefined();
  });

  it('merges provider skills before the model skills', () => {
    const job = makeJob({ skills: ['PostgreSQL', 'python'], skillsDetail: [{ skill: 'PostgreSQL', kind: 'hard', required: true }] });
    const { update } = run(job);
    expect(update.skills).toEqual(['postgresql', 'python', 'go', 'sql', 'kafka']);
    expect(update.skillsDetail![0]).toEqual({ skill: 'postgresql', kind: 'hard', required: true });
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
