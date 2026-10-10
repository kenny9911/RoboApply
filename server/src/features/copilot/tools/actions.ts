// server/src/features/copilot/tools/actions.ts — paid actions and job help (WP-50).
//
// tailor_resume · write_cover_letter · add_external_job · draft_outreach are
// proposals: the tool stores a pending `credit_action` and returns a card with
// the cost line; the credit is spent by the area service only when the user
// applies it (proposals.ts). find_connections · interview_prep read; a missing
// practice set is written only when the user asked for questions.
// D1: nothing here applies to a job or contacts anyone. A draft is text the
// user copies and sends themselves.

import { z } from 'zod';
import { LETTER_LENGTHS, LETTER_TONES } from '../../coverletter/contract.js';
import { OUTREACH_CHANNELS, OUTREACH_CHANNELS_BY_MARKET, type OutreachChannel } from '../../network/contract.js';
import type { ActionCardData, CreditAction, CreditActionCardData } from '../contract.js';
import type { CopilotTool, ToolContext, ToolOutput } from '../types.js';
import { card, costLine, isNotFound, isNotImplemented, JobId, notAvailable, requireUser } from './util.js';

/** Credits each action uses (one unit of its bucket). */
export const ACTION_BUCKETS: Record<CreditAction, string> = {
  tailor: 'tailor',
  cover_letter: 'cover_letter',
  outreach: 'outreach',
  job_import: 'job_import',
  rewrite: 'rewrite',
};

export async function creditProposal(
  ctx: ToolContext,
  action: CreditAction,
  args: Record<string, unknown>,
  jobId: string | null,
): Promise<ToolOutput> {
  const bucket = ACTION_BUCKETS[action];
  const cost = 1;
  const proposal = await ctx.propose({ kind: 'credit_action', payload: { action, args, bucket, cost, messageId: ctx.messageId } });
  const line = await costLine(ctx, bucket);
  const data: CreditActionCardData = {
    proposalId: proposal.id,
    status: 'pending',
    expiresAt: proposal.expiresAt.toISOString(),
    action,
    jobId,
    bucket,
    cost,
    remaining: line.remaining,
    resetsAt: line.resetsAt,
  };
  return {
    data: { proposed: true, started: false, action, creditsItUses: cost, creditsLeft: line.remaining, note: 'Nothing runs and nothing is charged until the user taps the button on the card.' },
    cards: [card(ctx, 'credit_action', data)],
    jobIds: jobId ? [jobId] : [],
  };
}

function linkCard(ctx: ToolContext, href: string, label: Extract<ActionCardData, { kind: 'open_link' }>['label']) {
  const data: ActionCardData = { kind: 'open_link', href, label };
  return card(ctx, 'action', data);
}

async function jobExists(ctx: ToolContext, userId: string, jobId: string): Promise<boolean> {
  try {
    await ctx.areas.getJob(userId, jobId);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

const JobArgs = z.object({ jobId: JobId }).strict();

export const tailorResume: CopilotTool<z.infer<typeof JobArgs>> = {
  name: 'tailor_resume',
  description: "Offer to tailor the user's resume for a job (uses one tailoring credit when the user confirms). Returns a card; nothing starts until the user confirms.",
  schema: JobArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    if (!(await jobExists(ctx, userId, args.jobId))) return notAvailable('job_not_found');
    const resumeId = ctx.resumeId ?? (await ctx.areas.primaryResumeId(userId));
    if (!resumeId) return { data: { available: false, reason: 'no_resume', note: 'The user needs a resume first.' }, cards: [linkCard(ctx, '/resume', 'resume')] };
    return creditProposal(ctx, 'tailor', { jobId: args.jobId, baseVariantId: resumeId }, args.jobId);
  },
};

const LetterArgs = z
  .object({ jobId: JobId, tone: z.enum(LETTER_TONES).optional(), length: z.enum(LETTER_LENGTHS).optional() })
  .strict();

export const writeCoverLetter: CopilotTool<z.infer<typeof LetterArgs>> = {
  name: 'write_cover_letter',
  description: 'Offer to write a cover letter for a job from the user\'s resume (uses one cover-letter credit when the user confirms).',
  schema: LetterArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    if (!(await jobExists(ctx, userId, args.jobId))) return notAvailable('job_not_found');
    const resumeId = ctx.resumeId ?? (await ctx.areas.primaryResumeId(userId));
    if (!resumeId) return { data: { available: false, reason: 'no_resume' }, cards: [linkCard(ctx, '/resume', 'resume')] };
    return creditProposal(ctx, 'cover_letter', { jobId: args.jobId, resumeVariantId: resumeId, tone: args.tone ?? null, length: args.length ?? null }, args.jobId);
  },
};

const ImportArgs = z
  .object({ url: z.string().trim().url().max(2048).refine((u) => /^https?:\/\//i.test(u), { message: 'http(s) only' }) })
  .strict();

export const addExternalJob: CopilotTool<z.infer<typeof ImportArgs>> = {
  name: 'add_external_job',
  description: 'Offer to add a job from a link the user pasted (uses one job-import credit when the user confirms). The page is read through our import service, never fetched here.',
  schema: ImportArgs,
  async run(args, ctx) {
    requireUser(ctx);
    return creditProposal(ctx, 'job_import', { url: args.url }, null);
  },
};

const OutreachArgs = z
  .object({
    jobId: JobId,
    channel: z
      .enum(OUTREACH_CHANNELS)
      .optional()
      .describe('Kind of message: linkedin_note, email, referral_ask, follow_up (after applying) or wechat. Leave out when the user did not say.'),
  })
  .strict();

/** The message kinds this market offers, most common first (no LinkedIn note on GoApply, no WeChat on RoboApply). */
export function outreachChannelFor(market: 'intl' | 'cn', asked: OutreachChannel | undefined): OutreachChannel {
  const allowed = OUTREACH_CHANNELS_BY_MARKET[market];
  return asked && allowed.includes(asked) ? asked : allowed[0]!;
}

export const draftOutreach: CopilotTool<z.infer<typeof OutreachArgs>> = {
  name: 'draft_outreach',
  description:
    'Offer to write a short message about a job for the user to send themselves (uses one message-draft credit when the user confirms). Returns a card; nothing is written until the user confirms, and nothing is ever sent.',
  schema: OutreachArgs,
  available: (ctx) => ctx.hiringContactsMode() !== 'off',
  async run(args, ctx) {
    const userId = requireUser(ctx);
    if (!(await jobExists(ctx, userId, args.jobId))) return notAvailable('job_not_found');
    const channel = outreachChannelFor(ctx.market === 'cn' ? 'cn' : 'intl', args.channel);
    const out = await creditProposal(ctx, 'outreach', { jobId: args.jobId, channel, locale: ctx.locale }, args.jobId);
    return { ...out, data: { ...(out.data as object), channel, note: 'Nothing is written or charged until the user taps the button on the card. The user sends the message themselves.' } };
  },
};

export const findConnections: CopilotTool<z.infer<typeof JobArgs>> = {
  name: 'find_connections',
  description: 'People the user may know at the job\'s company (from contacts the user imported, and recruiter records with a named source), plus people-search links.',
  schema: JobArgs,
  available: (ctx) => ctx.hiringContactsMode() !== 'off',
  async run(args, ctx) {
    const userId = requireUser(ctx);
    try {
      const res = await ctx.areas.connectionsForJob(userId, args.jobId);
      return {
        data: { fromYourCompanies: res.fromYourCompanies.length, fromYourSchools: res.fromYourSchools.length, recruiters: res.recruiters.length, searchLinks: res.searchLinks },
        cards: [card(ctx, 'contacts', { jobId: args.jobId, ...res })],
        jobIds: [args.jobId],
      };
    } catch (err) {
      if (isNotImplemented(err)) return { ...notAvailable('not_available_yet'), cards: [linkCard(ctx, `/jobs/${encodeURIComponent(args.jobId)}?tab=people`, 'people')], jobIds: [args.jobId] };
      if (isNotFound(err)) return notAvailable('job_not_found');
      throw err;
    }
  },
};

const PrepArgs = z
  .object({
    jobId: JobId,
    generate: z
      .boolean()
      .optional()
      .describe('true only when the user asked for interview questions for this job and none are listed yet: writes a practice set for the job (AI-written, labelled as such).'),
  })
  .strict();

export const interviewPrep: CopilotTool<z.infer<typeof PrepArgs>> = {
  name: 'interview_prep',
  description:
    'Questions to prepare for a job (each labelled with where it comes from) and a link to practise for this job. Pass generate: true when the user asks for questions.',
  schema: PrepArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const practiceHref = `/practice?job=${encodeURIComponent(args.jobId)}&from=assistant`;
    let questions: Array<{ id: string; text: string; category: string; sourceKind: string; sourceLabelKey: string }> = [];
    let note: string | null = null;
    try {
      // Read-only unless the user asked for questions (`generate`): then prep may
      // write a missing AI practice set for this job (its own limits and AI gate).
      const plan = await ctx.areas.planForJob(userId, args.jobId, { write: args.generate === true, locale: ctx.locale });
      // Card vocabulary (WP-51 `parseInterviewPlan`): 'ai' | 'bank' | 'posting'.
      // An AI-written question must arrive as 'ai' so the card labels it and
      // shows AiGeneratedBadge on GoApply (D3); staff-written and moderated
      // user reports are both question-bank items. (Wave 4 gate fix.)
      questions = plan.questions.slice(0, 8).map((q) => ({
        id: q.id,
        text: q.title,
        category: q.category,
        sourceKind: q.sourceKind === 'ai_practice' ? 'ai' : 'bank',
        sourceLabelKey: q.sourceLabelKey,
      }));
    } catch (err) {
      if (isNotFound(err)) return notAvailable('job_not_found');
      if (!isNotImplemented(err)) throw err;
      note = 'The question bank is not available yet; offer the practice link.';
    }
    return {
      data: { questions: questions.map((q) => ({ text: q.text, category: q.category, source: q.sourceKind })), practiceHref, ...(note ? { note } : {}) },
      cards: [card(ctx, 'interview_plan', { jobId: args.jobId, questions, practiceHref })],
      jobIds: [args.jobId],
    };
  },
};
