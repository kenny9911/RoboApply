// Area fakes for the Assistant tests (WP-50): fixtures and a fake
// `CopilotAreas` with no service, store or LLM behind it. Split out of
// testkit.ts so the web card tests (components/features/copilot/__tests__)
// can run the real tools without loading CopilotService.

import { vi } from 'vitest';
import type { FeedItem } from '../../feed/contract.js';
import type { SearchProfileWire } from '../../search/contract.js';
import type { JobDetailResponse } from '../../jobs/detail/contract.js';
import type { MatchFitView } from '../../match/contract.js';
import type { CopilotAreas } from '../types.js';

export const NOW = new Date('2026-10-10T08:00:00.000Z');
export const USER = 'user_1';

// ── Area fixtures ─────────────────────────────────────────────────────────

export function feedItem(over: Partial<FeedItem> = {}): FeedItem {
  return {
    jobId: 'job_1',
    title: 'Data Analyst',
    company: { id: 'co_1', name: 'Acme', logoUrl: null },
    location: 'Austin, TX',
    workModel: 'hybrid',
    employmentType: 'full_time',
    seniority: 'mid',
    pay: { min: 90000, max: 120000, currency: 'USD', period: 'year', text: null },
    postedAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-10-09T00:00:00.000Z',
    source: { name: 'Acme careers', kind: 'ats_public' },
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: false,
    badges: [],
    fit: { tier: 'good', score: 72, kind: 'pre', topGap: 'GraphQL', topOverlap: 'SQL' },
    tracker: null,
    ...over,
  };
}

export function profile(over: Partial<SearchProfileWire> = {}): SearchProfileWire {
  return {
    id: 'sp_1',
    name: '',
    isDefault: true,
    isActive: true,
    version: 3,
    schemaVersion: 1,
    filters: { titles: ['Data Analyst'], workModels: ['remote'] },
    alertInstantMax: 1,
    alertDigest: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

export function jobDetail(id = 'job_1', description = 'We need SQL and Python.'): JobDetailResponse {
  return {
    job: {
      id,
      title: 'Data Analyst',
      companyName: 'Acme',
      location: 'Austin, TX',
      workModel: 'hybrid',
      employmentType: 'full_time',
      seniority: 'mid',
      pay: { min: 90000, max: 120000, currency: 'USD', period: 'year', text: null },
      payText: null,
      summary: null,
      sections: [{ kind: 'responsibilities', body: description }],
      skills: [{ skill: 'SQL', kind: 'hard', required: true }],
      sponsorship: { status: 'not_stated', quote: null },
      requirements: [],
      applyUrl: 'https://acme.example/jobs/1',
      postedAt: '2026-10-01T00:00:00.000Z',
      postedAtEstimated: false,
      lastSeenAt: '2026-10-09T00:00:00.000Z',
      closedAt: null,
      status: 'open',
      source: { name: 'Acme careers', kind: 'ats_public', originalName: null },
      fromRecruiterBank: false,
      employerVerified: false,
      isAgency: false,
      visibility: 'public',
      badges: [],
    },
    company: { id: 'co_1', name: 'Acme', slug: 'acme', logoUrl: null, domain: 'acme.example', facts: {}, openJobs: null },
    fit: null,
    explanation: null,
    tracker: null,
    checklist: {} as JobDetailResponse['checklist'],
    similarIds: [],
    autofill: { supported: false, atsType: null },
    people: {} as JobDetailResponse['people'],
    marketMeta: {},
  } as unknown as JobDetailResponse;
}

export function fitView(jobId = 'job_1'): MatchFitView {
  return {
    jobId,
    score: 72,
    tier: 'good',
    kind: 'pre',
    dimensions: [],
    summary: null,
    strengths: [],
    gaps: [],
    keywordsMatched: [],
    keywordsMissing: [],
    skills: { aligned: ['SQL'], missing: ['GraphQL'], listed: 2 },
    topOverlap: 'SQL',
    topGap: 'GraphQL',
    scoredAt: NOW.toISOString(),
    // The canonical fit: the person's main resume, whatever resume is attached to the thread.
    resumeVariantId: 'res_primary',
    estimateReason: null,
    summaryLocaleStale: false,
    cached: false,
    coverage: 0.8,
    confidence: 'high',
    confidenceReason: null,
  } as unknown as MatchFitView;
}

/**
 * The fit of one named resume version ("With this version"): what
 * `areas.variantFit` answers. A
 * different number than the canonical fit, on purpose.
 */
export function variantFitView(jobId = 'job_1', resumeVariantId = 'res_tailored'): MatchFitView {
  return { ...fitView(jobId), score: 81, tier: 'great', kind: 'ai', resumeVariantId, cached: true } as MatchFitView;
}

export type FakeAreas = { [K in keyof CopilotAreas]: ReturnType<typeof vi.fn> & CopilotAreas[K] };

export function fakeAreas(over: Partial<CopilotAreas> = {}): FakeAreas {
  const base: CopilotAreas = {
    feedPreview: async () => [feedItem(), feedItem({ jobId: 'job_2', title: 'BI Analyst' })],
    feedPublicList: async () => [feedItem({ jobId: 'job_pub' })],
    countForFilters: async (_u, f) => ({ count: f.workModels?.includes('onsite') ? 40 : 120, capped: false }),
    activeSearchProfile: async () => profile(),
    searchProfile: async () => profile(),
    patchFilters: async (_u, id, version, patch) => profile({ id, version: version + 1, filters: { ...profile().filters, ...(patch as object) } }),
    getJob: async (_u, jobId) => {
      if (jobId.startsWith('missing')) throw Object.assign(new Error('nf'), { code: 'not_found', status: 404 });
      return jobDetail(jobId);
    },
    // Like the real area: `fit` is the canonical fit, `variantFit` the named version.
    fit: async (_u, jobId) => fitView(jobId),
    variantFit: async (_u, jobId, variantId) => {
      if (variantId === 'res_gone') throw Object.assign(new Error('Resume not found.'), { code: 'not_found', status: 404 });
      return variantFitView(jobId, variantId);
    },
    storedFit: async (_u, jobId) => fitView(jobId),
    addedJobs: async () => [],
    companyProfile: async () => ({
      id: 'co_1',
      name: 'Acme',
      slug: 'acme',
      logoUrl: null,
      domain: 'acme.example',
      facts: { industry: { value: 'Software', source: 'provider:linkedin', asOf: NOW.toISOString() } },
      openJobs: { value: 12, source: 'index', asOf: NOW.toISOString(), method: 'computed' },
    }),
    connectionsForJob: async () => {
      throw Object.assign(new Error('network.connectionsForJob is not implemented yet.'), { code: 'not_implemented', status: 501 });
    },
    planForJob: async () => {
      throw Object.assign(new Error('prep.planForJob is not implemented yet.'), { code: 'not_implemented', status: 501 });
    },
    trackerSummary: async () => ({ byStatus: { saved: 2, applied: 1 }, followUps: [] }),
    profileCompleteness: async () => ({ completeness: 60, missing: [{ key: 'skills', label: 'Skills' }] }),
    profileSnapshot: async () => 'Target role: Data Analyst. 4 years of experience. Skills: SQL, Python.',
    primaryResumeId: async () => 'res_1',
    resumeLatestGrade: async () => ({
      grade: {
        id: 'g1',
        resumeVariantId: 'res_1',
        status: 'done',
        label: null,
        score: 70,
        counts: null,
        issues: [{ id: 'iss_1', type: 'weak_verb', severity: 'medium', section: 'experience', anchor: null, why: 'Weak verb', how: 'Lead with a stronger verb', target: 'Helped with reports', fixable: true }],
        profile: {},
        method: 'rules',
        aiSkipped: null,
        rulesChecked: 20,
      },
      previous: null,
      stale: false,
      aiAvailable: true,
    }) as never,
    campusUpcoming: async () => {
      throw Object.assign(new Error('campus.upcomingForUser is not implemented yet.'), { code: 'not_implemented', status: 501 });
    },
    salaryStats: async (input) => ({
      totalCount: 80,
      listedCount: 32,
      currency: 'USD',
      period: 'year',
      median: { value: 105000, source: 'index', sampleSize: 32, asOf: (input.now ?? NOW).toISOString(), method: 'computed' },
      p25: { value: 95000, source: 'index', sampleSize: 32, asOf: (input.now ?? NOW).toISOString(), method: 'computed' },
      p75: { value: 118000, source: 'index', sampleSize: 32, asOf: (input.now ?? NOW).toISOString(), method: 'computed' },
      scope: { taxonomyId: null, title: input.title ?? null, country: input.country ?? null, city: input.city ?? null },
      minSample: 20,
    }),
    postingsAllowed: (market) => market !== 'cn',
    createTailorSession: async (_u, input) => ({ id: 'ts_1', status: 'ready', baseVariantId: input.baseVariantId, jobId: input.jobId, resultVariantId: 'res_t1' }) as never,
    createCoverLetter: async (_u, input) => ({ id: 'cl_1', title: 'Letter', jobId: input.jobId, resumeVariantId: input.resumeVariantId }) as never,
    createOutreachDraft: async (_u, body) =>
      ({
        id: 'dr_1',
        channel: body.channel,
        contactId: null,
        jobId: body.jobId,
        trackerEntryId: null,
        subject: body.channel === 'email' ? 'Data Analyst at Acme' : null,
        body: 'Hi, I saw the Data Analyst role at Acme and would like to learn more.',
        copiedAt: null,
        markedSentAt: null,
        aiWritten: true,
        createdAt: NOW.toISOString(),
      }) as never,
    importJob: async () => ({
      importId: 'draft_1',
      status: 'needs_fields',
      jobId: null,
      missingFields: [],
      warnings: [],
      reason: null,
      draft: { title: 'Analyst', company: 'Beta', description: 'x'.repeat(200), location: null, applyUrl: 'https://beta.example/j', sources: {} },
      matched: null,
    }),
    saveImportedJob: async () => ({ importId: 'job_new', status: 'done', jobId: 'job_new', missingFields: [], warnings: [], reason: null, draft: null, matched: null }),
    fixResumeIssue: async () => ({ suggestions: [{ text: 'Built weekly reports', aiWritten: true }], blocked: 0 }),
  };
  const out = {} as FakeAreas;
  for (const [k, v] of Object.entries({ ...base, ...over })) (out as Record<string, unknown>)[k] = vi.fn(v as (...a: unknown[]) => unknown);
  return out;
}
