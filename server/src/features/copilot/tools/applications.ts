// server/src/features/copilot/tools/applications.ts — the Assistant and the
// applications agent (docs/agent-driven/REDESIGN.md §1, §9: "the Assistant
// cannot run the loop").
//
//   application_status   read: is a job on the user's list (Applications →
//                        Getting ready), and where does its application stand
//   add_to_list          proposal `list_add`: put a job on the list (no credit)
//   prepare_application  proposal `prepare_application`: put the job on the list
//                        when needed, then prepare its application. The card
//                        carries the cost BEFORE anything is spent: the lines
//                        the cost sheet shows (the agent's own credit proposal,
//                        `ready_kits` being the weekly allowance)
//
// Offered only with the capability `agent` (the same one the list's routes
// need). The tools read through the agent's public surface; the writes run
// only when the user applies the card (proposals.ts), through the same agent
// calls as the "Prepare application" button: the same list, credit rules,
// weekly allowance and states. A job past "To prepare" is never prepared
// twice: the tools answer where it stands instead.
// D1: nothing here submits, sends or opens anything. Preparing tailors the
// resume and writes a letter when the post asks for one; the user checks the
// application, opens it and submits it on the employer's site.

import { z } from 'zod';
import { PREPARABLE_STATES, type JobPlaceView, type QueueItemView, type QueueJobSummary, type QueueState } from '../../agent/contract.js';
import type { ApplicationStatusCardData, ListAddCardData, PrepareApplicationCardData, PrepareCostView } from '../contract.js';
import type { CopilotTool, ToolContext, ToolOutput } from '../types.js';
import { card, JobId, notAvailable, requireUser } from './util.js';

/** What each list state means, for the model (English; the user never reads it). */
export const STATE_MEANING: Record<QueueState, string> = {
  picked: 'on the list, not prepared yet',
  preparing: 'being prepared now (resume tailored, a letter written when the post asks for one); it waits for the user to check it when done',
  ready_for_review: 'prepared; waiting for the user to check it',
  approved: 'checked by the user; ready for them to open',
  opened: "the user opened the application on the employer's site",
  applied: 'the user marked it as applied',
  skipped: 'skipped by the user',
  expired: 'the company no longer lists this job',
  failed: 'preparing it did not work; it can be prepared again',
};

const SUBMIT_NOTE = "The user checks the application, opens it and submits it on the employer's site themselves. Nothing is ever submitted or sent for them.";
const LIST_FULL_NOTE = 'The list is full. The user removes a job from Applications, Getting ready, first.';

/** Picked or failed: an application that can be prepared (again). */
export function canPrepare(state: QueueState): boolean {
  return (PREPARABLE_STATES as readonly string[]).includes(state);
}

/** One job's place as the model reads it. */
function placeForModel(p: JobPlaceView, listFull: boolean): Record<string, unknown> {
  if (!p.job) return { jobId: p.jobId, onList: false, canAdd: false, reason: 'not_available_for_the_list' };
  const base = { jobId: p.jobId, title: p.job.title, company: p.job.companyName || null };
  if (!p.item) {
    const reason = p.job.closed ? 'job_closed' : listFull ? 'list_full' : null;
    return { ...base, onList: false, canAdd: !reason, ...(reason ? { reason } : {}) };
  }
  return { ...base, onList: true, state: p.item.state, meaning: STATE_MEANING[p.item.state], canPrepare: canPrepare(p.item.state) };
}

/** The card and the model's answer for a job that is on the list already (nothing is proposed). */
function whereItStands(ctx: ToolContext, item: QueueItemView, job: QueueJobSummary): ToolOutput {
  const data: ApplicationStatusCardData = {
    jobId: item.jobId,
    state: item.state,
    jobTitle: job.title,
    company: job.companyName || null,
    trackerEntryId: item.trackerEntryId,
  };
  return {
    data: {
      alreadyOnList: true,
      proposed: false,
      state: item.state,
      meaning: STATE_MEANING[item.state],
      note: `Nothing was proposed and nothing is used: the card shows where this application stands and links to it. ${SUBMIT_NOTE}`,
    },
    cards: [card(ctx, 'application_status', data)],
    jobIds: [item.jobId],
  };
}

const agentOn = (ctx: ToolContext) => ctx.isEnabled('agent');

const StatusArgs = z
  .object({
    jobIds: z
      .array(JobId)
      .min(1)
      .max(8)
      .describe('The jobs to check: ids returned by a tool (search_jobs, top_fit_jobs, added_jobs, similar_jobs) or the job in context.'),
  })
  .strict();

export const applicationStatus: CopilotTool<z.infer<typeof StatusArgs>> = {
  name: 'application_status',
  description:
    "Whether jobs are on the user's list of applications to prepare (Applications, Getting ready) and where each application stands: not prepared yet, being prepared, ready for the user to check, opened. Read only. Call it before saying whether a job is on the list.",
  schema: StatusArgs,
  available: agentOn,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const { items, listFull } = await ctx.areas.jobPlaces(userId, args.jobIds);
    return {
      data: { jobs: items.map((p) => placeForModel(p, listFull)), listFull, note: SUBMIT_NOTE },
      jobIds: items.map((p) => p.jobId),
    };
  },
};

const JobArgs = z.object({ jobId: JobId }).strict();

export const addToList: CopilotTool<z.infer<typeof JobArgs>> = {
  name: 'add_to_list',
  description:
    "Offer to put a job on the user's list of applications to prepare later (Applications, Getting ready). No credit is used, and nothing is prepared or sent. Returns a card; nothing changes until the user confirms. For a job already on the list it shows where its application stands instead.",
  schema: JobArgs,
  available: agentOn,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const { items, listFull } = await ctx.areas.jobPlaces(userId, [args.jobId]);
    const place = items.find((p) => p.jobId === args.jobId);
    if (!place?.job) return notAvailable('job_not_found');
    if (place.item) return whereItStands(ctx, place.item, place.job);
    if (place.job.closed) return notAvailable('job_closed', { note: 'The company no longer lists this job, so it cannot go on the list.' });
    if (listFull) return notAvailable('list_full', { note: LIST_FULL_NOTE });
    const proposal = await ctx.propose({ kind: 'list_add', payload: { jobId: args.jobId, messageId: ctx.messageId } });
    const data: ListAddCardData = {
      proposalId: proposal.id,
      status: 'pending',
      expiresAt: proposal.expiresAt.toISOString(),
      jobId: args.jobId,
      jobTitle: place.job.title,
      company: place.job.companyName || null,
    };
    return {
      data: {
        proposed: true,
        added: false,
        creditsItUses: 0,
        note: 'Nothing changes until the user taps the button on the card. No credit is used, and nothing is prepared or sent.',
      },
      cards: [card(ctx, 'list_add', data)],
      jobIds: [args.jobId],
    };
  },
};

/** The model's words for a cost line (the card shows the localized line). */
const BUCKET_WORDS: Record<PrepareCostView['bucket'], string> = {
  ready_kits: 'applications from the weekly allowance',
  tailor: 'tailoring credits',
  cover_letter: 'cover letter credits',
};

export const prepareApplication: CopilotTool<z.infer<typeof JobArgs>> = {
  name: 'prepare_application',
  description:
    "Offer to prepare the user's application for a job: their resume tailored for it, a cover letter when the post asks for one, and their saved answers collected, ready for them to check. Puts the job on their list first when it is not there. Uses one application from their weekly allowance, plus the tailoring and letter credits the card shows, only when the user confirms. Nothing is ever sent or submitted: the user opens the application and submits it on the employer's site. For a job that is already prepared or being prepared it shows where the application stands instead.",
  schema: JobArgs,
  available: agentOn,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const quote = await ctx.areas.prepareQuote(userId, args.jobId);
    if (!quote.job) return notAvailable('job_not_found');
    // Past "To prepare": never prepared twice.
    if (quote.item && !canPrepare(quote.item.state)) return whereItStands(ctx, quote.item, quote.job);
    if (quote.job.closed) return notAvailable('job_closed', { note: 'The company no longer lists this job, so nothing can be prepared.' });
    if (!quote.item && quote.listFull) return notAvailable('list_full', { note: LIST_FULL_NOTE });
    if (!quote.proposal) return notAvailable('cannot_prepare');
    const credits: PrepareCostView[] = quote.proposal.credits.map((c) => ({
      bucket: c.bucket,
      cost: c.cost,
      remaining: typeof c.remaining === 'number' ? c.remaining : null,
      window: c.window ?? null,
      resetsAt: c.resetsAt ?? null,
    }));
    const enough = quote.proposal.enough !== false;
    const proposal = await ctx.propose({
      kind: 'prepare_application',
      payload: { jobId: args.jobId, credits: credits.map(({ bucket, cost }) => ({ bucket, cost })), messageId: ctx.messageId },
    });
    const data: PrepareApplicationCardData = {
      proposalId: proposal.id,
      status: 'pending',
      expiresAt: proposal.expiresAt.toISOString(),
      jobId: args.jobId,
      jobTitle: quote.job.title,
      company: quote.job.companyName || null,
      addsToList: !quote.item,
      credits,
      enough,
      aiAvailable: quote.proposal.aiAvailable !== false,
      tailorEach: quote.tailorEach,
    };
    return {
      data: {
        proposed: true,
        started: false,
        addsToList: !quote.item,
        uses: credits.map((c) => ({ what: BUCKET_WORDS[c.bucket], count: c.cost, left: c.remaining })),
        enough,
        note: [
          'Nothing is prepared or charged until the user taps the button on the card.',
          enough ? null : 'Not enough credits are left for this now; the card shows what is left.',
          SUBMIT_NOTE,
        ]
          .filter(Boolean)
          .join(' '),
      },
      cards: [card(ctx, 'prepare_application', data)],
      jobIds: [args.jobId],
    };
  },
};
