// server/src/features/copilot/tools/you.ts — the user's own things (WP-50).
//
// application_summary · get_profile_gaps · remember · resume_issues ·
// rewrite_resume_section (F-RES-11, resume scope; a paid proposal) ·
// campus_deadlines (GoApply, when the calendar is on) · explain_feature
// (static; the visitor turn's only non-data tool).

import { z } from 'zod';
import { redactPii, LLM_PII_KINDS } from '../../../platform/pii/index.js';
import { COPILOT_MEMORY_FACT_MAX, type ActionCardData, type CampusDeadlinesCardData, type MemoryAddCardData, type ResumeTipsCardData } from '../contract.js';
import type { CopilotTool, ToolContext } from '../types.js';
import { creditProposal } from './actions.js';
import { card, clip, isNotFound, isNotImplemented, notAvailable, requireUser } from './util.js';

const NoArgs = z.object({}).strict() as unknown as z.ZodType<Record<string, never>>;

function linkCard(ctx: ToolContext, href: string, label: Extract<ActionCardData, { kind: 'open_link' }>['label']) {
  const data: ActionCardData = { kind: 'open_link', href, label };
  return card(ctx, 'action', data);
}

export const applicationSummary: CopilotTool<Record<string, never>> = {
  name: 'application_summary',
  description: "The user's applications by stage and the follow-ups that are due.",
  schema: NoArgs,
  async run(_args, ctx) {
    const userId = requireUser(ctx);
    const summary = await ctx.areas.trackerSummary(userId);
    return {
      data: { byStatus: summary.byStatus, followUps: summary.followUps.slice(0, 10) },
      cards: [card(ctx, 'applications', summary)],
    };
  },
};

export const getProfileGaps: CopilotTool<Record<string, never>> = {
  name: 'get_profile_gaps',
  description: 'What is missing from the user\'s profile (fields that help the job list and fit).',
  schema: NoArgs,
  async run(_args, ctx) {
    const userId = requireUser(ctx);
    const res = await ctx.areas.profileCompleteness(userId);
    return { data: res, cards: [card(ctx, 'profile_gaps', { ...res, href: '/profile' })] };
  },
};

const RememberArgs = z
  .object({ fact: z.string().trim().min(3).max(COPILOT_MEMORY_FACT_MAX).describe('One short fact about the user\'s job search, in their words (no contact details).') })
  .strict();

export const remember: CopilotTool<z.infer<typeof RememberArgs>> = {
  name: 'remember',
  description: 'Offer to remember one fact for later conversations. Nothing is stored until the user confirms on the card.',
  schema: RememberArgs,
  async run(args, ctx) {
    requireUser(ctx);
    const fact = redactPii(args.fact, { kinds: LLM_PII_KINDS }).text.trim().slice(0, COPILOT_MEMORY_FACT_MAX);
    if (!fact) return { data: { error: 'empty_fact' } };
    const consentRequired = ctx.market === 'cn' && !(await ctx.hasConsent('copilot_memory'));
    const proposal = await ctx.propose({ kind: 'memory_add', payload: { fact, messageId: ctx.messageId } });
    const data: MemoryAddCardData = { proposalId: proposal.id, status: 'pending', expiresAt: proposal.expiresAt.toISOString(), fact, consentRequired };
    return {
      data: { proposed: true, stored: false, fact, note: 'Stored only if the user confirms on the card.' },
      cards: [card(ctx, 'memory_add', data)],
    };
  },
};

const ResumeArgs = z.object({ resumeId: z.string().min(1).max(64).optional() }).strict();

async function resolveResume(ctx: ToolContext, userId: string, resumeId?: string): Promise<string | null> {
  return resumeId ?? ctx.resumeId ?? (await ctx.areas.primaryResumeId(userId));
}

export const resumeIssues: CopilotTool<z.infer<typeof ResumeArgs>> = {
  name: 'resume_issues',
  description: "Issues the latest resume check found on the user's resume (with ids the rewrite tool takes). Use for resume tips.",
  schema: ResumeArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const resumeId = await resolveResume(ctx, userId, args.resumeId);
    if (!resumeId) return { data: { available: false, reason: 'no_resume' }, cards: [linkCard(ctx, '/resume', 'resume')] };
    try {
      const latest = await ctx.areas.resumeLatestGrade(userId, resumeId);
      const grade = latest.grade;
      if (!grade || grade.status !== 'done') {
        return { data: { available: false, reason: 'no_check_yet', note: 'Offer to run the resume check.' }, cards: [linkCard(ctx, `/resume/${encodeURIComponent(resumeId)}/check`, 'resume_check')] };
      }
      const issues = grade.issues.slice(0, 12).map((i) => ({
        id: i.id,
        severity: i.severity,
        section: i.section,
        why: i.why,
        how: i.how,
        evidence: clip(i.evidence, 300),
        fixable: Boolean(i.fixable) && latest.aiAvailable,
      }));
      // The card carries `type` + `params` so the client renders the localized
      // `resumeCheck.issue.<type>.*` text; `why`/`how` are the English fallback.
      const tips: ResumeTipsCardData = {
        resumeId,
        stale: latest.stale,
        href: `/resume/${encodeURIComponent(resumeId)}/check`,
        issues: grade.issues.slice(0, 12).map((i, n) => ({
          ...issues[n]!,
          type: i.type,
          ...(i.params ? { params: i.params } : {}),
          ...(i.source ? { source: i.source } : {}),
        })),
      };
      return {
        data: { resumeId, stale: latest.stale, issues },
        cards: [card(ctx, 'resume_tips', tips)],
      };
    } catch (err) {
      if (isNotFound(err)) return notAvailable('resume_not_found');
      throw err;
    }
  },
};

const RewriteArgs = z
  .object({
    resumeId: z.string().min(1).max(64).optional(),
    issueId: z.string().min(1).max(64).describe('An issue id from resume_issues.'),
    style: z.enum(['ai', 'longer', 'shorter', 'stronger']).optional(),
    instruction: z.string().trim().max(500).optional().describe("The user's own wording for the change."),
  })
  .strict();

export const rewriteResumeSection: CopilotTool<z.infer<typeof RewriteArgs>> = {
  name: 'rewrite_resume_section',
  description:
    'Offer an AI rewrite of one resume line or the summary that the resume check flagged (uses one rewrite credit when the user confirms). The user picks a suggestion and applies it on the resume page; the resume is not changed here.',
  schema: RewriteArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const resumeId = await resolveResume(ctx, userId, args.resumeId);
    if (!resumeId) return { data: { available: false, reason: 'no_resume' } };
    const latest = await ctx.areas.resumeLatestGrade(userId, resumeId);
    if (!latest.aiAvailable) return notAvailable('ai_off');
    const issue = latest.grade?.issues.find((i) => i.id === args.issueId);
    if (!issue) return { data: { error: 'unknown_issue', note: 'Call resume_issues first.' } };
    if (!issue.fixable) return { data: { error: 'issue_not_fixable' } };
    return creditProposal(ctx, 'rewrite', { resumeId, issueId: issue.id, style: args.style ?? 'ai', instruction: args.instruction ?? null }, null);
  },
};

const CampusArgs = z.object({ limit: z.number().int().min(1).max(10).optional() }).strict();

export const campusDeadlines: CopilotTool<z.infer<typeof CampusArgs>> = {
  name: 'campus_deadlines',
  description: 'Upcoming official campus-recruiting (网申) windows the user follows, each with its official link and last-verified date.',
  schema: CampusArgs,
  available: async (ctx) => ctx.market === 'cn' && (await ctx.isEnabled('jobs.campusCalendar')),
  async run(args, ctx) {
    const userId = requireUser(ctx);
    try {
      const items = await ctx.areas.campusUpcoming(userId, { limit: args.limit ?? 5 });
      const data: CampusDeadlinesCardData = {
        items: items.map((e) => ({
          company: e.companyName,
          programme: e.title || null,
          closesAt: e.applyClosesAt,
          officialUrl: e.officialUrl,
          sourceUrl: e.sourceUrl,
          sourceName: e.sourceName,
          verifiedAt: e.verifiedAt,
          needsReverify: e.needsReverify,
        })),
      };
      return {
        data: {
          items: items.map((e) => ({ company: e.companyName, title: e.title, applyClosesAt: e.applyClosesAt, officialUrl: e.officialUrl, verifiedAt: e.verifiedAt, needsReverify: e.needsReverify })),
        },
        cards: [card(ctx, 'campus_deadlines', data)],
      };
    } catch (err) {
      if (isNotImplemented(err)) return notAvailable('not_available_yet');
      throw err;
    }
  },
};

/** Plain, D1-safe descriptions (English; the model answers in the user's language). */
export const FEATURE_EXPLANATIONS = {
  fit: 'Each job shows a fit level (Great fit, Good fit, Possible, Unlikely) from comparing the post with your profile and resume, with the skills you show and the ones you miss. It is not your chance of getting hired.',
  job_list: 'The job list shows open posts from named sources. You filter by role, place, pay and more; every number on a card has a source line.',
  tailoring: 'Tailoring rewrites your resume for one job using only facts already in your resume; anything new is marked for you to check before you use it.',
  cover_letters: 'Cover letters are written from your resume and the job post, and you edit them before using them.',
  tracker: 'The applications list keeps every job you saved or applied to, with follow-up reminders. You mark jobs as applied; nothing is sent for you.',
  practice: 'Interview practice runs a mock interview for a job and gives a written report. It does not predict real interview results.',
  ready_to_apply: 'Ready to apply prepares a weekly list of jobs with a tailored resume and letter for you to review. You open each application and submit it yourself on the employer\'s site.',
  extension: 'The browser extension fills application forms with your saved answers for you to check. You click submit yourself.',
  alerts: 'Job alerts email you new posts that fit your saved search, as often as you choose.',
  assistant: 'The Assistant answers questions about your search, jobs, your resume and interviews, and proposes changes you confirm before anything changes.',
  pricing: 'Some actions use credits that reset on a schedule; the pricing page lists the plans.',
} as const;
export type FeatureKey = keyof typeof FEATURE_EXPLANATIONS;

const ExplainArgs = z
  .object({ feature: z.enum(Object.keys(FEATURE_EXPLANATIONS) as [FeatureKey, ...FeatureKey[]]) })
  .strict();

export const explainFeature: CopilotTool<z.infer<typeof ExplainArgs>> = {
  name: 'explain_feature',
  description: 'How a product feature works, in plain words.',
  schema: ExplainArgs,
  public: true,
  async run(args) {
    return { data: { feature: args.feature, explanation: FEATURE_EXPLANATIONS[args.feature] } };
  },
};
