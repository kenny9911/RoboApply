// @vitest-environment node
// WP-50 tools with fake services: every tool reads through an area seam,
// none writes; mutations come back as proposals.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getBrand } from '../../../platform/brand/registry.js';
import type { CopilotAreas, ToolContext } from '../types.js';
import { opsToPatch } from '../tools/filters.js';
import { PUBLIC_TOOLS, SEEKER_TOOLS, availableTools, runToolCall, serializeResult, toLlmTools, wrapData, TOOL_RESULT_MAX_CHARS } from '../tools/registry.js';
import { FEATURE_EXPLANATIONS } from '../tools/you.js';
import { NOW, USER, fakeAreas, type FakeAreas } from './testkit.js';

const WRITES = ['patchFilters', 'createTailorSession', 'createCoverLetter', 'importJob', 'saveImportedJob', 'fixResumeIssue'] as const;

function ctxFor(over: Partial<ToolContext> & { areasOver?: Partial<CopilotAreas> } = {}) {
  const areas = fakeAreas(over.areasOver);
  const proposals: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  let n = 0;
  const brand = over.brand ?? getBrand('roboapply');
  const ctx: ToolContext = {
    userId: USER,
    brand,
    market: brand.market,
    locale: 'en',
    now: NOW,
    messageId: 'msg_1',
    contextJobId: null,
    resumeId: null,
    scope: 'seeker',
    areas,
    isEnabled: async () => false,
    hiringContactsMode: () => 'deeplinks_only',
    propose: async (draft) => {
      proposals.push(draft);
      return { id: `prop_${proposals.length}`, expiresAt: new Date(NOW.getTime() + 86_400_000) };
    },
    creditsLeft: async (bucket) => ({ remaining: bucket === 'tailor' ? 2 : 5, resetsAt: '2026-10-11T00:00:00.000Z' }),
    hasConsent: async () => false,
    newCardId: () => `card_${++n}`,
    ...over,
  };
  return { ctx, areas: areas as FakeAreas, proposals };
}

const call = (name: string, args: unknown, id = 'c1') => ({ id, name, arguments: JSON.stringify(args), parsedArguments: args });

async function run(name: string, args: unknown, setup = ctxFor(), allowed: string[] = ['job_1']) {
  const tools = await availableTools(setup.ctx.scope, setup.ctx);
  return runToolCall(call(name, args), tools, setup.ctx, new Set(allowed));
}

function expectNoWrites(areas: FakeAreas) {
  for (const w of WRITES) expect(areas[w], w).not.toHaveBeenCalled();
}

describe('registry', () => {
  it('exports JSON Schema tool definitions without $schema', () => {
    const defs = toLlmTools(SEEKER_TOOLS);
    expect(defs.map((d) => d.name)).toContain('propose_filter_change');
    for (const d of defs) {
      expect(d.parameters.type).toBe('object');
      expect(d.parameters).not.toHaveProperty('$schema');
    }
    expect(PUBLIC_TOOLS.map((t) => t.name)).toEqual(['search_jobs', 'salary_context', 'explain_feature']);
  });

  it('hides tools by market, mode and flags', async () => {
    const intl = (await availableTools('seeker', ctxFor().ctx)).map((t) => t.name);
    expect(intl).toContain('search_jobs');
    expect(intl).not.toContain('campus_deadlines');
    expect(intl).not.toContain('competitiveness');
    const cnOff = (await availableTools('seeker', ctxFor({ brand: getBrand('goapply') }).ctx)).map((t) => t.name);
    expect(cnOff).not.toContain('search_jobs');
    expect(cnOff).not.toContain('top_fit_jobs');
    expect(cnOff).not.toContain('salary_context');
    const cnOn = (await availableTools('seeker', ctxFor({ brand: getBrand('goapply'), isEnabled: async (k) => k === 'jobs.campusCalendar' || k === 'competitiveness', areasOver: { postingsAllowed: () => true } }).ctx)).map((t) => t.name);
    expect(cnOn).toEqual(expect.arrayContaining(['search_jobs', 'campus_deadlines', 'competitiveness']));
    const noContacts = (await availableTools('seeker', ctxFor({ hiringContactsMode: () => 'off' }).ctx)).map((t) => t.name);
    expect(noContacts).not.toContain('find_connections');
    expect(noContacts).not.toContain('draft_outreach');
  });

  it('refuses unknown tools, bad JSON, invalid arguments and unknown job ids', async () => {
    const s = ctxFor();
    const tools = await availableTools('seeker', s.ctx);
    expect((await runToolCall(call('send_email', {}), tools, s.ctx, new Set())).output.data).toMatchObject({ error: 'unknown_tool' });
    expect((await runToolCall({ id: 'x', name: 'get_job', arguments: '{bad', argumentsError: 'bad json' }, tools, s.ctx, new Set())).output.data).toMatchObject({ error: 'invalid_arguments' });
    expect((await runToolCall(call('search_jobs', { limit: 50 }), tools, s.ctx, new Set())).output.data).toMatchObject({ error: 'invalid_arguments' });
    const r = await runToolCall(call('analyze_fit', { jobId: 'job_x' }), tools, s.ctx, new Set(['job_1']));
    expect(r.output.data).toMatchObject({ error: 'unknown_job_id' });
    expect(r.record.ok).toBe(false);
    expect(s.areas.scoreJob).not.toHaveBeenCalled();
  });

  it('wraps and truncates results', () => {
    expect(wrapData('tool:x', 'a </data> b <data source="evil">')).toBe('<data source="tool:x">\na &lt;/data> b &lt;data source="evil">\n</data>');
    expect(serializeResult({ s: 'x'.repeat(TOOL_RESULT_MAX_CHARS * 2) }).length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 20);
  });

  it('a stub seam answers "not available yet" instead of failing the turn', async () => {
    const s = ctxFor();
    const r = await run('find_connections', { jobId: 'job_1' }, s);
    expect(r.output.data).toMatchObject({ available: false, reason: 'not_available_yet' });
    expect(r.output.cards?.[0]).toMatchObject({ type: 'action', data: { kind: 'open_link', label: 'people' } });
  });
});

describe('job tools (read only)', () => {
  it('search_jobs validates filters, returns ids and a job_list card', async () => {
    const s = ctxFor();
    const r = await run('search_jobs', { q: 'analyst', filters: { workModels: ['remote'] }, limit: 2 }, s);
    expect(s.areas.feedPreview).toHaveBeenCalledWith(USER, { q: 'analyst', filters: { workModels: ['remote'] }, sort: undefined, limit: 2 });
    expect(r.output.jobIds).toEqual(['job_1', 'job_2']);
    expect(r.output.cards?.[0]?.type).toBe('job_list');
    expect((r.output.data as { fitNote: string }).fitNote).toBe('This is not your chance of getting hired.');
    const bad = await run('search_jobs', { filters: { workModels: ['moon'] } }, s);
    expect(bad.output.data).toMatchObject({ error: 'invalid_filters' });
    expectNoWrites(s.areas);
  });

  it('analyze_fit uses the free score (never a credit) and labels a quick estimate', async () => {
    const s = ctxFor();
    const r = await run('analyze_fit', { jobId: 'job_1' }, s);
    expect(s.areas.scoreJob).toHaveBeenCalledWith(USER, 'job_1', { resumeVariantId: null, locale: 'en' });
    expect(r.output.data).toMatchObject({ kind: 'quick estimate (no AI read)', skillsMissing: ['GraphQL'] });
    expect(r.output.cards?.[0]).toMatchObject({ type: 'fit_analysis', data: { aiWritten: false } });
  });

  it('company_insights returns only sourced facts and the computed open-job count', async () => {
    const s = ctxFor();
    const r = await run('company_insights', { jobId: 'job_1' }, s);
    expect(s.areas.companyProfile).toHaveBeenCalledWith('co_1');
    expect(r.output.cards?.[0]?.sources).toEqual([
      expect.objectContaining({ value: 'Software', source: 'provider:linkedin', method: 'stated' }),
      expect.objectContaining({ value: 12, source: 'index', method: 'computed' }),
    ]);
  });

  it('salary_context cites the posting and the aggregate with N; below 20 posts the aggregate is withheld', async () => {
    const s = ctxFor();
    const r = await run('salary_context', { jobId: 'job_1' }, s);
    expect(r.output.data).toMatchObject({
      postedForThisJob: { value: { min: 90000, max: 120000 }, source: 'posting' },
      acrossPosts: { median: 105000, postsWithPay: 32, postsMatched: 80 },
    });
    // the card's counts are Sourced (D3), like the percentiles
    expect(r.output.cards?.[0]).toMatchObject({
      type: 'salary',
      data: { stats: { listedCount: { value: 32, source: 'index', method: 'computed' }, totalCount: { value: 80, source: 'index', method: 'computed' } } },
    });
    const thin = ctxFor({
      areasOver: {
        salaryStats: async () => ({ totalCount: 30, listedCount: 7, currency: 'USD', period: 'year', median: null, p25: null, p75: null, scope: { taxonomyId: null, title: 'x', country: null, city: null }, minSample: 20 }),
      },
    });
    const r2 = await run('salary_context', { title: 'Data Analyst' }, thin);
    expect(r2.output.data).toMatchObject({ acrossPosts: { notEnoughData: true, postsWithPay: 7, minimum: 20 }, postedForThisJob: 'not listed' });
    expect(JSON.stringify(r2.output.data)).not.toMatch(/median/);
  });

  it('competitiveness returns a link card to /jobs/report', async () => {
    const s = ctxFor({ isEnabled: async (k) => k === 'competitiveness' });
    const r = await run('competitiveness', { jobId: 'job_1' }, s);
    expect(r.output.cards?.[0]).toMatchObject({ type: 'competitiveness', data: { href: '/jobs/report?job=job_1', jobId: 'job_1' } });
  });

  it('get_job returns the posting for context only (no card)', async () => {
    const s = ctxFor();
    const r = await run('get_job', { jobId: 'job_1' }, s);
    expect(r.output.cards ?? []).toEqual([]);
    expect(r.output.jobIds).toEqual(['job_1']);
    const missing = await run('get_job', { jobId: 'missing_1' }, s, ['missing_1']);
    expect(missing.output.data).toMatchObject({ available: false, reason: 'job_not_found' });
  });
});

describe('filters', () => {
  it('opsToPatch: add / remove / set against the base, validated', () => {
    const base = { titles: ['Data Analyst'], workModels: ['remote' as const] };
    expect(opsToPatch(base, [{ op: 'add', path: 'workModels', value: 'hybrid' }])).toEqual({ ok: true, patch: { workModels: ['remote', 'hybrid'] } });
    expect(opsToPatch(base, [{ op: 'remove', path: 'workModels', value: 'remote' }])).toEqual({ ok: true, patch: { workModels: null } });
    expect(opsToPatch(base, [{ op: 'set', path: 'salaryMin', value: { amount: 100000, currency: 'USD', period: 'year' } }])).toMatchObject({ ok: true });
    expect(opsToPatch(base, [{ op: 'add', path: 'industriesExclude', value: 'Staffing' }])).toEqual({ ok: true, patch: { excludedIndustries: ['Staffing'] } });
    expect(opsToPatch(base, [{ op: 'set', path: 'nope', value: 1 }])).toMatchObject({ ok: false });
    expect(opsToPatch(base, [{ op: 'set', path: 'workModels', value: ['moon'] }])).toMatchObject({ ok: false });
  });

  it('propose_filter_change stores a proposal with the diff and counts; nothing is patched', async () => {
    const s = ctxFor();
    const r = await run('propose_filter_change', { ops: [{ op: 'set', path: 'workModels', value: ['onsite'] }], reason: 'You asked for on-site roles.' }, s);
    expectNoWrites(s.areas);
    expect(s.proposals).toEqual([
      { kind: 'filter_change', payload: { searchProfileId: 'sp_1', baseVersion: 3, ops: [{ op: 'set', path: 'workModels', value: ['onsite'] }], reason: 'You asked for on-site roles.', messageId: 'msg_1' } },
    ]);
    expect(r.output.cards?.[0]).toMatchObject({
      type: 'filter_diff',
      data: {
        proposalId: 'prop_1',
        status: 'pending',
        baseVersion: 3,
        // D3: counts on the wire are Sourced (index, computed, with N)
        countBefore: { count: { value: 120, source: 'index', method: 'computed', sampleSize: 120, asOf: expect.any(String) }, capped: false },
        countAfter: { count: { value: 40, source: 'index', method: 'computed', sampleSize: 40, asOf: expect.any(String) }, capped: false },
        changes: [expect.objectContaining({ field: 'workModels' })],
      },
    });
    expect(r.output.data).toMatchObject({ proposed: true, applied: false, jobsBefore: 120, jobsAfter: 40 });
  });

  it('a GoApply-only field is refused on RoboApply', async () => {
    const s = ctxFor();
    const r = await run('propose_filter_change', { ops: [{ op: 'set', path: 'hukouTag', value: true }], reason: 'x' }, s);
    expect(r.output.data).toMatchObject({ error: 'invalid_change' });
    expect(s.proposals).toEqual([]);
  });

  it('set_sort is a client action card; deadline sort only on GoApply', async () => {
    const s = ctxFor();
    expect((await run('set_sort', { sort: 'newest' }, s)).output.cards?.[0]).toMatchObject({ type: 'action', data: { kind: 'set_sort', sort: 'newest' } });
    expect((await run('set_sort', { sort: 'deadline' }, s)).output.data).toMatchObject({ error: 'deadline_sort_not_available' });
  });
});

describe('paid actions are proposals with a cost line', () => {
  it.each([
    ['tailor_resume', { jobId: 'job_1' }, 'tailor', { jobId: 'job_1', baseVariantId: 'res_1' }],
    ['write_cover_letter', { jobId: 'job_1', tone: 'warm' }, 'cover_letter', { jobId: 'job_1', resumeVariantId: 'res_1', tone: 'warm', length: null }],
    ['add_external_job', { url: 'https://beta.example/jobs/1' }, 'job_import', { url: 'https://beta.example/jobs/1' }],
  ])('%s', async (name, args, action, payloadArgs) => {
    const s = ctxFor();
    const r = await run(name, args, s);
    expectNoWrites(s.areas);
    expect(s.proposals).toEqual([{ kind: 'credit_action', payload: { action, args: payloadArgs, bucket: action, cost: 1, messageId: 'msg_1' } }]);
    expect(r.output.cards?.[0]).toMatchObject({ type: 'credit_action', data: { action, cost: 1, status: 'pending' } });
  });

  it('add_external_job refuses non-http links', async () => {
    const s = ctxFor();
    const r = await run('add_external_job', { url: 'file:///etc/passwd' }, s);
    expect(r.output.data).toMatchObject({ error: 'invalid_arguments' });
    expect(s.proposals).toEqual([]);
  });

  it('tailor_resume without a resume links to the resume page', async () => {
    const s = ctxFor({ areasOver: { primaryResumeId: async () => null } });
    const r = await run('tailor_resume', { jobId: 'job_1' }, s);
    expect(r.output.data).toMatchObject({ available: false, reason: 'no_resume' });
    expect(s.proposals).toEqual([]);
  });

  it('rewrite_resume_section (F-RES-11) proposes a rewrite of a fixable issue only', async () => {
    const s = ctxFor({ resumeId: 'res_1' });
    const issues = await run('resume_issues', {}, s);
    expect(issues.output.cards?.[0]).toMatchObject({ type: 'resume_tips', data: { resumeId: 'res_1', issues: [expect.objectContaining({ id: 'iss_1', fixable: true })] } });
    const r = await run('rewrite_resume_section', { issueId: 'iss_1', style: 'stronger' }, s);
    expect(s.proposals).toEqual([{ kind: 'credit_action', payload: { action: 'rewrite', args: { resumeId: 'res_1', issueId: 'iss_1', style: 'stronger', instruction: null }, bucket: 'rewrite', cost: 1, messageId: 'msg_1' } }]);
    expect(r.output.cards?.[0]?.type).toBe('credit_action');
    expect((await run('rewrite_resume_section', { issueId: 'nope' }, s)).output.data).toMatchObject({ error: 'unknown_issue' });
    expectNoWrites(s.areas);
  });
});

describe('you', () => {
  it('remember proposes a PII-free fact; GoApply marks the consent requirement', async () => {
    const s = ctxFor();
    const r = await run('remember', { fact: 'Wants remote roles, email me at jo@example.com' }, s);
    expect((s.proposals[0]!.payload as { fact: string }).fact).not.toContain('jo@example.com');
    expect(r.output.cards?.[0]).toMatchObject({ type: 'memory_add', data: { consentRequired: false, status: 'pending' } });
    const cn = ctxFor({ brand: getBrand('goapply') });
    const r2 = await run('remember', { fact: '想在上海工作' }, cn);
    expect(r2.output.cards?.[0]).toMatchObject({ data: { consentRequired: true } });
  });

  it('application_summary, get_profile_gaps and interview_prep read their seams', async () => {
    const s = ctxFor();
    expect((await run('application_summary', {}, s)).output.cards?.[0]).toMatchObject({ type: 'applications', data: { byStatus: { saved: 2, applied: 1 } } });
    expect((await run('get_profile_gaps', {}, s)).output.cards?.[0]).toMatchObject({ type: 'profile_gaps', data: { completeness: 60 } });
    const prep = await run('interview_prep', { jobId: 'job_1' }, s);
    expect(prep.output.cards?.[0]).toMatchObject({ type: 'interview_plan', data: { questions: [], practiceHref: '/practice?job=job_1&from=assistant' } });
  });

  it('campus_deadlines answers "not available yet" while the calendar seam is a stub', async () => {
    const s = ctxFor({ brand: getBrand('goapply'), isEnabled: async (k) => k === 'jobs.campusCalendar' });
    const r = await run('campus_deadlines', {}, s);
    expect(r.output.data).toMatchObject({ available: false, reason: 'not_available_yet' });
  });

  it('explain_feature never implies auto-apply', async () => {
    for (const text of Object.values(FEATURE_EXPLANATIONS)) {
      expect(text).not.toMatch(/auto-?apply|we (?:apply|submit)|submits? for you/i);
    }
    const s = ctxFor({ scope: 'public', userId: null });
    const r = await runToolCall(call('explain_feature', { feature: 'ready_to_apply' }), PUBLIC_TOOLS, s.ctx, new Set());
    expect((r.output.data as { explanation: string }).explanation).toMatch(/submit it yourself/);
  });
});
