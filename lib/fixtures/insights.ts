// lib/fixtures/insights.ts
//
// One RACareerInsight for the current demo week (Sunday-anchored UTC,
// 2026-05-24). Cites the real tracker IDs cm_tr_005 (Anthropic applied)
// and cm_tr_007 (Linear interviewing) so the InsightCard's [[tracker:…]]
// links resolve to actual rows. Metrics are realistic for a senior
// engineer ~5 weeks into a search.

import type { RACareerInsight } from '../api/v2/types';

export const FIXTURE_INSIGHT: RACareerInsight = {
  id: 'cm_in_w2126',
  userId: 'cm_user_demo',
  weekStartUtc: '2026-05-24',
  summaryMarkdown:
    `## Week of May 24 — strong execution week\n\n` +
    `You applied to **3 roles** this week (target: 5/week). Two were AI Engineer roles at AI labs ` +
    `and one was a Senior SWE at Stripe — all within your target salary band of $180k–$260k.\n\n` +
    `**Anthropic** (Senior Developer Experience) [[tracker:cm_tr_005]] and **Linear** (Software Engineer) ` +
    `[[tracker:cm_tr_007]] are your strongest momentum signals. The Linear onsite is Tuesday — that's your ` +
    `near-term focus.\n\n` +
    `Two follow-ups need attention this week: **Anthropic** is 2 days post-application and your usual ` +
    `recruiter response window is ~5 days; the **Linear** on-site is in 2 days.\n\n` +
    `Skills observed in your applied roles: **LLM evaluation** (3/3), **inference optimization** (2/3), ` +
    `**TypeScript** (3/3), **Python** (2/3). Consider tightening your story around eval-suite design — ` +
    `it shows up in 3 of your tailored resumes and is the differentiator that landed your Linear interview.`,
  citedTrackerIds: ['cm_tr_005', 'cm_tr_007'],
  metrics: {
    applicationsCount: 3,
    interviewsCount: 2,
    offerCount: 1,
    weeksToOfferEstimate: 4,
    recruiterViewsCount: 14,
    topSkillsObserved: [
      'LLM evaluation',
      'inference optimization',
      'TypeScript',
      'Python',
      'developer experience',
    ],
  },
  modelUsed: 'anthropic/claude-sonnet-4.6',
  citationGuardPassed: true,
  generatedAt: '2026-05-26T18:30:00.000Z',
  createdAt: '2026-05-26T18:30:00.000Z',
};
