// components/features/copilot/__tests__/wireCards.ts — Assistant cards as the
// server really sends them. Runs the WP-50 tools (server/src/features/copilot/
// tools) and the proposal service (apply → result cards) over the server's
// area fakes, so cards.test.tsx renders the producers' actual output instead
// of shapes written on the client. A server shape change fails the card tests.
//
// Fictional data only. No network, no database, no LLM.

import { getBrand } from '../../../../server/src/platform/brand/registry';
import type { CardType, CopilotCard } from '../../../../server/src/features/copilot/contract';
import { NOW, USER, fakeAreas, fitView } from '../../../../server/src/features/copilot/__tests__/areaFakes';
import { createProposalService } from '../../../../server/src/features/copilot/proposals';
import type { CopilotStore, ProposalRow } from '../../../../server/src/features/copilot/store';
import type { CopilotAreas, CopilotTool, ToolContext } from '../../../../server/src/features/copilot/types';
import { addExternalJob, draftOutreach, findConnections, interviewPrep, tailorResume, writeCoverLetter } from '../../../../server/src/features/copilot/tools/actions';
import { getCurrentFilters, proposeFilterChange, setSort } from '../../../../server/src/features/copilot/tools/filters';
import { analyzeFit, companyInsights, competitiveness, salaryContext, topFitJobs } from '../../../../server/src/features/copilot/tools/jobs';
import { applicationSummary, campusDeadlines, getProfileGaps, remember, resumeIssues, rewriteResumeSection } from '../../../../server/src/features/copilot/tools/you';

/** Area answers with every field the cards read (the shared fakes leave some seams as stubs). */
export const WIRE_AREAS: Partial<CopilotAreas> = {
  scoreJob: async (_u, jobId) => ({
    ...fitView(jobId),
    kind: 'ai',
    summary: 'You show most of what the post asks for.',
    strengths: ['Four years of SQL reporting'],
    gaps: ['No dashboard work described'],
    skills: { aligned: ['SQL'], missing: ['GraphQL'], listed: 2 },
  }),
  connectionsForJob: async () => ({
    fromYourCompanies: [
      {
        id: 'ct_1',
        source: 'user_connections_import',
        sourceLabel: 'Your LinkedIn connections',
        sourceName: null,
        fullName: 'Alex Sample',
        title: 'Data Engineer',
        companyName: 'Acme',
        linkedinUrl: null,
        connectedOn: null,
        optedInAt: null,
      },
    ],
    fromYourSchools: [],
    recruiters: [
      {
        id: 'ct_2',
        source: 'bank_recruiter',
        sourceLabel: 'Recruiter on RoboHire',
        sourceName: 'RoboHire',
        fullName: 'Sam Example',
        title: 'Recruiter',
        companyName: 'Acme',
        linkedinUrl: null,
        connectedOn: null,
        optedInAt: NOW.toISOString(),
      },
    ],
    searchLinks: [{ label: 'People at Acme on LinkedIn', url: 'https://www.linkedin.com/search/results/people/?keywords=Acme' }],
    mode: 'on',
    importedCount: 40,
    aiAvailable: true,
    drafts: [],
  }),
  planForJob: async () => ({
    questions: [
      { id: 'q1', companySlug: null, companyName: null, title: 'Walk us through a dashboard you built.', body: '', category: 'technical', difficulty: null, seniority: null, locale: 'en', sourceKind: 'staff', sourceLabelKey: 'source.staff', reportedPeriod: null, aiGenerated: false },
      { id: 'q2', companySlug: null, companyName: null, title: 'How would you size the data?', body: '', category: 'technical', difficulty: null, seniority: null, locale: 'en', sourceKind: 'ai_practice', sourceLabelKey: 'source.ai', reportedPeriod: null, aiGenerated: true },
    ],
  }) as never,
  trackerSummary: async () => ({
    byStatus: { bookmarked: 2, applied: 3, interviewing: 1 },
    followUps: [
      { entryId: 'te_1', reason: 'no_reply_10d', at: '2026-09-28T00:00:00.000Z', days: 12, companyName: 'Acme', title: 'Data Analyst' },
      { entryId: 'te_2', reason: 'interview_tomorrow', at: '2026-10-11T09:00:00.000Z', days: null, companyName: null, title: 'BI Analyst' },
    ],
  }),
  profileCompleteness: async () => ({
    completeness: 60,
    missing: [
      { key: 'skills', label: 'profile.missing.skills', section: 'skills' },
      { key: 'workAuth', label: 'profile.missing.workAuth', section: 'workAuth' },
    ] as never,
  }),
  resumeLatestGrade: async () =>
    ({
      grade: {
        id: 'g1',
        resumeVariantId: 'res_1',
        status: 'done',
        label: null,
        score: 70,
        counts: null,
        issues: [
          {
            id: 'iss_1',
            type: 'weak_verb',
            severity: 'medium',
            section: 'experience',
            anchor: null,
            why: 'Weak verb',
            how: 'Lead with a stronger verb',
            params: { opener: 'Helped with' },
            target: 'Helped with reports',
            fixable: true,
            source: 'rules',
          },
        ],
        profile: {},
        method: 'rules',
        aiSkipped: null,
        rulesChecked: 20,
      },
      previous: null,
      stale: false,
      aiAvailable: true,
    }) as never,
  campusUpcoming: async () => [
    {
      id: 'ce_1',
      companyName: '示例公司',
      companySlug: 'shili',
      title: '2027 校园招聘',
      graduationClass: '2027',
      kind: 'campus',
      applyOpensAt: '2026-09-01T00:00:00.000Z',
      applyClosesAt: '2026-10-20T00:00:00.000Z',
      stages: [],
      cities: ['上海'],
      roles: ['数据分析'],
      officialUrl: 'https://campus.example.com/2027',
      sourceUrl: null,
      sourceName: null,
      verifiedAt: '2026-10-01T00:00:00.000Z',
      needsReverify: false,
      subscribed: true,
    },
  ] as never,
};

/** A minimal proposal store for the apply path (one thread, cards kept per message). */
function memoryStore() {
  const proposals = new Map<string, ProposalRow>();
  let n = 0;
  const store = {
    async createProposal(input: { id?: string; threadId: string; userId: string; kind: string; payload: Record<string, unknown>; expiresAt: Date }) {
      const row: ProposalRow = { id: input.id ?? `prop_${++n}`, threadId: input.threadId, userId: input.userId, kind: input.kind, payload: input.payload, status: 'pending', expiresAt: input.expiresAt, appliedAt: null, createdAt: NOW };
      proposals.set(row.id, row);
      return row;
    },
    async getProposal(id: string) {
      return proposals.get(id) ?? null;
    },
    async getThread() {
      return { id: 'thread_1', brand: 'roboapply' };
    },
    async transitionProposal(id: string, from: string, to: string) {
      const row = proposals.get(id);
      if (!row || row.status !== from) return false;
      row.status = to;
      return true;
    },
    async updateCards() {},
    async appendCard() {},
    async countMemory() {
      return 0;
    },
    async createMemoryCapped(input: { userId: string; fact: string }) {
      return { id: 'mem_1', userId: input.userId, fact: input.fact, source: 'user_confirmed', createdAt: NOW, deletedAt: null };
    },
  };
  return store as unknown as CopilotStore & { createProposal: typeof store.createProposal };
}

/**
 * One card per contract type, each from the tool (or proposal apply) that
 * produces it. `notice` has no server producer yet (the stream reports errors
 * as SSE `error` events), so it is the only client-written card here.
 */
export async function wireCards(): Promise<Record<CardType, CopilotCard>> {
  const areas = fakeAreas(WIRE_AREAS);
  const store = memoryStore();
  let cardN = 0;
  const ctx: ToolContext = {
    userId: USER,
    brand: getBrand('roboapply'),
    market: 'intl',
    locale: 'en',
    now: NOW,
    messageId: 'msg_1',
    contextJobId: 'job_1',
    resumeId: null,
    scope: 'seeker',
    areas,
    isEnabled: async () => true,
    hiringContactsMode: () => 'on',
    propose: async (draft) => {
      const row = await store.createProposal({ threadId: 'thread_1', userId: USER, kind: draft.kind, payload: draft.payload, expiresAt: new Date(NOW.getTime() + 86_400_000) });
      return { id: row.id, expiresAt: row.expiresAt };
    },
    creditsLeft: async () => ({ remaining: 2, resetsAt: '2026-10-11T00:00:00.000Z' }),
    hasConsent: async () => false,
    newCardId: () => `card_${++cardN}`,
  };
  const service = createProposalService({
    store,
    areas,
    brand: () => getBrand('roboapply'),
    now: () => NOW,
    hasConsent: async () => true,
    newCardId: () => `card_${++cardN}`,
  });

  const out: Partial<Record<CardType, CopilotCard>> = {};
  const take = (cards: CopilotCard[] | undefined) => {
    for (const c of cards ?? []) if (!out[c.type]) out[c.type] = c;
  };
  const run = async <A>(tool: CopilotTool<A>, args: A) => (await tool.run(args, ctx)).cards ?? [];
  const applied = async (cards: CopilotCard[]) => {
    const proposalId = (cards[0]?.data as { proposalId: string }).proposalId;
    const res = await service.apply(USER, proposalId, { locale: 'en' });
    return [(res.result as { card: CopilotCard }).card];
  };

  take(await run(topFitJobs, {}));
  take(await run(getCurrentFilters, {}));
  take(await run(proposeFilterChange, { ops: [{ op: 'add', path: 'workModels', value: 'onsite' }], reason: 'You said you can work on site.' }));
  take(await run(setSort, { sort: 'newest' }));
  take(await run(analyzeFit, { jobId: 'job_1' }));
  take(await run(companyInsights, { jobId: 'job_1' }));
  take(await run(findConnections, { jobId: 'job_1' }));
  const tailor = await run(tailorResume, { jobId: 'job_1' });
  take(tailor);
  take(await applied(tailor));
  take(await applied(await run(writeCoverLetter, { jobId: 'job_1' })));
  take(await applied(await run(addExternalJob, { url: 'https://beta.example/jobs/9' })));
  take(await run(interviewPrep, { jobId: 'job_1' }));
  take(await run(salaryContext, { jobId: 'job_1' }));
  take(await run(applicationSummary, {}));
  take(await run(remember, { fact: 'Prefers remote jobs in Berlin time zones.' }));
  take(await run(getProfileGaps, {}));
  take(await run(campusDeadlines, {}));
  take(await run(competitiveness, { jobId: 'job_1' }));
  take(await run(resumeIssues, {}));
  take(await applied(await run(rewriteResumeSection, { issueId: 'iss_1' })));
  out.notice = { type: 'notice', id: 'card_notice', data: { code: 'copilot_budget_exhausted' } };
  return out as Record<CardType, CopilotCard>;
}

/** Cards that only some tool runs produce (the open_link action, the rewrite proposal, the job_import proposal). */
export async function wireCard(name: 'outreach_link' | 'rewrite_proposal' | 'job_import_proposal'): Promise<CopilotCard> {
  const areas = fakeAreas(WIRE_AREAS);
  let n = 0;
  const ctx = {
    userId: USER,
    brand: getBrand('roboapply'),
    market: 'intl',
    locale: 'en',
    now: NOW,
    messageId: 'msg_1',
    contextJobId: 'job_1',
    resumeId: null,
    scope: 'seeker',
    areas,
    isEnabled: async () => true,
    hiringContactsMode: () => 'on',
    propose: async () => ({ id: `p_${name}`, expiresAt: new Date('2099-01-01T00:00:00.000Z') }),
    creditsLeft: async () => ({ remaining: 2, resetsAt: '2026-10-11T00:00:00.000Z' }),
    hasConsent: async () => false,
    newCardId: () => `card_${++n}`,
  } satisfies ToolContext;
  const out =
    name === 'outreach_link'
      ? await draftOutreach.run({ jobId: 'job_1' }, ctx)
      : name === 'rewrite_proposal'
        ? await rewriteResumeSection.run({ issueId: 'iss_1' }, ctx)
        : await addExternalJob.run({ url: 'https://beta.example/jobs/9' }, ctx);
  return out.cards![0]!;
}
