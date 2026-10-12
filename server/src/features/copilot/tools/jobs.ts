// server/src/features/copilot/tools/jobs.ts — job tools (ARCH §5.2; WP-50; MKT-4H).
//
// search_jobs · top_fit_jobs · added_jobs · similar_jobs · show_jobs · get_job ·
// analyze_fit · company_insights · salary_context · competitiveness. All
// read-only. Lists come from the feed seam (`feedService.preview`, no session:
// a typed query runs the feed's own retrieval), jobs from job detail (market
// and GoApply mode checks happen there), fit from THE fit (match/fit.ts
// through `areas.fit` / `areas.fits`: the person's primary resume, so the
// Assistant and the job page say one number whatever resume is attached to the
// thread; the paid `fit_analysis` card lives on the job page), company facts
// only with their provenance. Only an explicit question about a resume
// version adds the second, separately named measure "With this version" to
// analyze_fit. No tool here calls the scorer except analyze_fit.
//
// The card shows exactly the jobs the answer cites (MARKET_STRATEGY §2.3 step
// 8; SM-9). A list tool (search_jobs, top_fit_jobs, added_jobs, similar_jobs)
// returns its rows and ids to the model and marks its output `list:
// 'candidates'`: its card is the whole list, which the service holds back.
// The model then calls `show_jobs` with the ids of the jobs it is going to
// talk about, and THAT card (`cited: true`, those jobs, that order) is what
// the user sees. A list no show_jobs call followed (none in the turn, or none
// after the last citation) is shown whole by the service when the turn ends,
// so nothing a search found is lost and the reply names no job that is on no
// card. Whatever narrows a list by a rule is still done by the tool ("only
// posts that list pay" is the `payListed` argument), never by the model in
// its text.
//
// Jobs the user added themselves (a pasted link or text) are private rows the
// public lists never include. `added_jobs` lists them, `search_jobs` with
// keywords looks through them too ("the job I added at Acme" is found), and
// `top_fit_jobs` ranks them with the rest by the same fit. `added_jobs` works
// with GoApply's third-party postings off: the user's own rows are theirs to
// ask about. Their fits are read in ONE batch (`areas.fits`).
//
// A 台灣就業通 open-data row carries its licence credit line in
// `cardMeta.tw_sources`; the job-list card prints it (JobListCard.tsx), so
// such a row is listed like any other.

import { z } from 'zod';
import { FEED_SORTS } from '../../feed/contract.js';
import { parseFilterSetPatch, type FilterSet } from '../../search/index.js';
import { JOB_LIST_MAX, JOB_LIST_NOTE_MAX, type CardSource, type CompetitivenessCardData, type CopilotCard, type JobListCardData } from '../contract.js';
import type { FeedItem, SalaryStatsResult } from '../../feed/index.js';
import type { AddedJobItem } from '../../jobs/import/index.js';
import type { MatchFitView } from '../../match/contract.js';
import { logger } from '../../../services/LoggerService.js';
import type { CopilotTool, JobListItem, ToolContext, ToolOutput } from '../types.js';
import { card, clip, indexCount, isNotFound, JobId, jobForModel, notAvailable, requireUser } from './util.js';

const FIT_LINE = 'This is not your chance of getting hired.';

/** A partial FilterSet from the model: a value replaces, null/absent ignored. */
function readFilters(raw: unknown): { ok: true; filters: Partial<FilterSet> } | { ok: false; issues: unknown } {
  if (raw === undefined || raw === null) return { ok: true, filters: {} };
  const parsed = parseFilterSetPatch(raw);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const filters: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.value)) if (v !== null && v !== undefined) filters[k] = v;
  return { ok: true, filters: filters as Partial<FilterSet> };
}

/** What the model reads after a list tool: nothing is on screen until it cites. */
const CITE_NOTE =
  'Nothing is shown to the user yet. Call show_jobs with the ids of the jobs you are going to talk about, in the order you mention them: the card shows exactly those jobs. To narrow the list by a rule, call the tool again with arguments.';

/**
 * The same, for a list returned in the answer's last tool round
 * (`ctx.lastToolRound`): the reply comes next and no show_jobs call can
 * follow, so the service shows this list whole. The model is told what the
 * user will see, not asked for a call it cannot make.
 */
const WHOLE_LIST_NOTE =
  'You cannot call another tool in this answer, so this whole list is shown to the user as it is, in this order. Write only about jobs on it, or on a card you already showed.';

/** A fit as a list row carries it (the feed card's own fields). */
type RowFit = { tier: string | null; score: number | null; kind: 'pre' | 'ai'; topGap: string | null; topOverlap: string | null; confidence?: 'high' | 'medium' | 'low'; confidenceReason?: string | null };

/** THE fit as a row shows it; null when nothing could be compared. */
function rowFit(view: MatchFitView | undefined): RowFit | null {
  if (!view || (!view.tier && view.score === null)) return null;
  return {
    tier: view.tier,
    score: view.score,
    kind: view.kind,
    topGap: view.topGap,
    topOverlap: view.topOverlap,
    ...(view.confidence ? { confidence: view.confidence, confidenceReason: view.confidenceReason ?? null } : {}),
  };
}

/** The fits of a list in one batch read (never a model call). A failed read answers none: the rows show no fit. */
async function fitsOf(ctx: ToolContext, userId: string, jobIds: readonly string[]): Promise<Map<string, MatchFitView>> {
  if (!jobIds.length) return new Map();
  try {
    return await ctx.areas.fits(userId, jobIds, { locale: ctx.locale });
  } catch (err) {
    logger.debug('COPILOT', 'fits not read for a job list (rows show none)', { jobs: jobIds.length, error: err instanceof Error ? err.message : String(err) });
    return new Map();
  }
}

/** One of the user's own added jobs as a list row. Its pay is not known here (`payKnown: false`): the card shows none rather than "not listed". */
interface AddedRow {
  jobId: string;
  title: string;
  company: { id: null; name: string; logoUrl: null };
  location: string | null;
  workModel: AddedJobItem['workModel'];
  pay: null;
  payKnown: false;
  addedByUser: true;
  addedAt: string;
  tracker: { status: string } | null;
  fit: RowFit | null;
  badges: [];
}

/**
 * The user's own added jobs as rows, each with THE fit the job page shows
 * (the stored AI read, else the quick estimate), read for all of them in one
 * batch: a list of eight never opens eight chains of queries.
 */
async function addedRows(ctx: ToolContext, userId: string, jobs: readonly AddedJobItem[]): Promise<AddedRow[]> {
  const fits = await fitsOf(ctx, userId, jobs.map((j) => j.jobId));
  return jobs.map((j) => ({
    jobId: j.jobId,
    title: j.title,
    company: { id: null, name: j.companyName, logoUrl: null },
    location: j.location,
    workModel: j.workModel,
    pay: null,
    payKnown: false,
    addedByUser: true,
    addedAt: j.addedAt,
    tracker: j.trackerStatus ? { status: j.trackerStatus } : null,
    fit: rowFit(fits.get(j.jobId)),
    badges: [],
  }));
}

function addedForModel(row: AddedRow): Record<string, unknown> {
  return {
    jobId: row.jobId,
    title: row.title,
    company: row.company.name,
    location: row.location,
    workModel: row.workModel,
    addedByUser: true,
    addedAt: row.addedAt,
    applicationStatus: row.tracker?.status ?? null,
    pay: 'not read here; call get_job for what the post says about pay',
    fit: row.fit ? { tier: row.fit.tier, score: row.fit.score, kind: row.fit.kind === 'pre' ? 'quick estimate' : 'ai', topGap: row.fit.topGap, topOverlap: row.fit.topOverlap } : null,
  };
}

/** Every word of `q` appears in the title or the company (case, punctuation and spacing do not count). */
function matchesKeywords(job: AddedJobItem, q: string): boolean {
  const norm = (v: string) => v.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const hay = ` ${norm(`${job.title} ${job.companyName}`)} `;
  const words = norm(q).split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

const SearchJobsArgs = z
  .object({
    q: z.string().trim().min(1).max(200).optional().describe('Free-text title/company keywords.'),
    filters: z.record(z.string(), z.unknown()).optional().describe('Filter fields for this search only (same names as get_current_filters). Does not change the saved search.'),
    payListed: z.boolean().optional().describe('true = only jobs whose post lists pay. Use it when the user asks for jobs that list or show their pay.'),
    sort: z.enum(FEED_SORTS).optional(),
    limit: z.number().int().min(1).max(JOB_LIST_MAX).optional(),
  })
  .strict();

const hasPay = (item: FeedItem): boolean => item.pay !== null && item.pay !== undefined;

/**
 * A list for the model to choose from. The rows and ids are its data; the
 * card is the list as a whole, which the service holds back (`list:
 * 'candidates'`) until the model cites jobs with show_jobs or the turn ends.
 */
function candidates(ctx: ToolContext, rows: readonly JobListItem[], forModel: Array<Record<string, unknown>>, query: Record<string, unknown>, extra: Record<string, unknown> = {}): ToolOutput {
  if (!rows.length) return { data: { count: 0, jobs: [], ...extra }, cards: [], jobIds: [] };
  const data: JobListCardData = { items: [...rows], query };
  return {
    data: { count: rows.length, jobs: forModel, ...extra, fitNote: FIT_LINE, listNote: ctx.lastToolRound ? WHOLE_LIST_NOTE : CITE_NOTE },
    cards: [card(ctx, 'job_list', data)],
    jobIds: rows.map((r) => r.jobId),
    list: 'candidates',
  };
}

/** The rows of a job-list card (each with a job id), as `show_jobs` reads them. */
export function jobListItems(c: CopilotCard): JobListItem[] {
  if (c.type !== 'job_list') return [];
  const items = (c.data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((it): it is JobListItem => !!it && typeof it === 'object' && typeof (it as { jobId?: unknown }).jobId === 'string' && !!(it as { jobId: string }).jobId);
}

/** The rows a list tool returned (empty for every other tool). */
export function listedItems(output: ToolOutput): JobListItem[] {
  return output.list === 'candidates' ? (output.cards ?? []).flatMap(jobListItems) : [];
}

type Scored = { fit?: { score?: number | null; kind?: string } | null };
const scoreOf = (row: Scored): number | null => (typeof row.fit?.score === 'number' ? row.fit.score : null);
/** Does `a` come before `b` by the fit: the higher score, and at one score the AI read before the quick estimate? A row with no fit beats none. */
function beats(a: Scored, b: Scored): boolean {
  const sa = scoreOf(a);
  const sb = scoreOf(b);
  if (sa === null) return false;
  if (sb === null) return true;
  return sa !== sb ? sa > sb : a.fit?.kind === 'ai' && b.fit?.kind !== 'ai';
}

/**
 * Rows of several lists in ONE order, by the fit every one of them shows:
 * best score first, the AI read before the quick estimate at one score, rows
 * with no fit last. Rows that tie keep the order they came in. The scores are
 * THE fit (one scale); nothing here computes or adjusts one.
 */
export function orderByFit<T extends Scored>(rows: readonly T[]): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (beats(a.row, b.row) ? -1 : beats(b.row, a.row) ? 1 : a.i - b.i))
    .map((entry) => entry.row);
}

export const searchJobs: CopilotTool<z.infer<typeof SearchJobsArgs>> = {
  name: 'search_jobs',
  description:
    'Search open jobs for the user. Returns at most 8 jobs with ids. Nothing is shown to the user until you call show_jobs with the ids you are going to talk about. Narrow the list with arguments (filters, payListed), never in your text. With keywords it also looks through the jobs the user added themselves. Does not change the saved search; to change it, use propose_filter_change.',
  schema: SearchJobsArgs,
  available: (ctx) => ctx.areas.postingsAllowed(ctx.market),
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const read = readFilters(args.filters);
    if (!read.ok) return { data: { error: 'invalid_filters', issues: read.issues } };
    const limit = args.limit ?? 5;
    // "Only jobs that list pay" is the search's own filter; asked for by argument or inside `filters`.
    const payOnly = args.payListed === true || read.filters.includeUndisclosedPay === false;
    const filters: Partial<FilterSet> = payOnly ? { ...read.filters, includeUndisclosedPay: false } : read.filters;
    // `q` is the typed query: the feed runs its own retrieval for it (nothing is ranked here).
    const found = await ctx.areas.feedPreview(userId, { q: args.q, filters, sort: args.sort, limit });
    // A row without pay never rides along on a pay-only search
    // (the filter steps back when a minimum pay is set; this does not).
    const items = payOnly ? found.filter(hasPay) : found;
    // The user's own added jobs are not in the public lists: keywords look through them too.
    // (Their pay is not read here, so a pay-only search leaves them out rather than guess.)
    let mine: AddedRow[] = [];
    if (args.q && !payOnly) {
      try {
        const added = (await ctx.areas.addedJobs(userId, { limit: 50 })).filter((j) => matchesKeywords(j, args.q!)).slice(0, limit);
        mine = await addedRows(ctx, userId, added);
      } catch (err) {
        logger.warn('COPILOT', 'added jobs unavailable for search_jobs', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const mineIds = new Set(mine.map((m) => m.jobId));
    const rows = [...mine, ...items.filter((i) => !mineIds.has(i.jobId))].slice(0, Math.max(limit, mine.length));
    return candidates(
      ctx,
      rows as unknown as JobListItem[],
      rows.map((r) => ('addedByUser' in r ? addedForModel(r) : jobForModel(r))),
      { q: args.q ?? null, sort: args.sort ?? null, ...(payOnly ? { payListed: true } : {}) },
      payOnly ? { payListedOnly: true } : {},
    );
  },
};

const AddedJobsArgs = z.object({ limit: z.number().int().min(1).max(JOB_LIST_MAX).optional() }).strict();

export const addedJobs: CopilotTool<z.infer<typeof AddedJobsArgs>> = {
  name: 'added_jobs',
  description:
    'The jobs the user added themselves (from a link or pasted text), newest first, each with its fit when there is one. Use it for "the jobs I added", "my added jobs", or a job or company the user says they added. These jobs are not in search_jobs without keywords. Nothing is shown to the user until you call show_jobs.',
  schema: AddedJobsArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const rows = await addedRows(ctx, userId, await ctx.areas.addedJobs(userId, { limit: args.limit ?? JOB_LIST_MAX }));
    return candidates(
      ctx,
      rows as unknown as JobListItem[],
      rows.map(addedForModel),
      { added: true },
      rows.length ? {} : { note: 'The user has not added any job yet. They can add one with a link or pasted text (add_external_job).' },
    );
  },
};

const PublicSearchArgs = z
  .object({
    role: z.string().trim().min(1).max(80).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    limit: z.number().int().min(1).max(8).optional(),
  })
  .strict();

/** Visitor variant: public listings only, never a fit (no profile). */
export const publicSearchJobs: CopilotTool<z.infer<typeof PublicSearchArgs>> = {
  name: 'search_jobs',
  description: 'Search public job listings by role and place. Returns at most 8 jobs. There is no fit information for visitors.',
  schema: PublicSearchArgs,
  public: true,
  available: (ctx) => ctx.areas.postingsAllowed(ctx.market),
  async run(args, ctx) {
    const items = await ctx.areas.feedPublicList({
      role: args.role ?? ctx.page?.role,
      city: args.city ?? ctx.page?.city,
      country: (args.country ?? ctx.page?.country)?.toUpperCase(),
      limit: args.limit ?? 5,
    });
    return {
      data: { count: items.length, jobs: items.map(jobForModel) },
      cards: items.length ? [card(ctx, 'job_list', { items, visitor: true })] : [],
      jobIds: items.map((i) => i.jobId),
    };
  },
};

const TopFitArgs = z.object({ limit: z.number().int().min(1).max(JOB_LIST_MAX).optional() }).strict();

/** Most added jobs `top_fit_jobs` ranks with the saved search's list (what `areas.addedJobs` reads at once). */
const TOP_FIT_ADDED_MAX = 50;

export const topFitJobs: CopilotTool<z.infer<typeof TopFitArgs>> = {
  name: 'top_fit_jobs',
  description:
    "The user's best-fitting open jobs, best fit first: the jobs under the saved search and the jobs they added themselves. Nothing is shown to the user until you call show_jobs.",
  schema: TopFitArgs,
  available: (ctx) => ctx.areas.postingsAllowed(ctx.market),
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const limit = args.limit ?? 5;
    const items = await ctx.areas.feedPreview(userId, { sort: 'best_fit', limit });
    // The feed's list leaves out an added job whose post has no date. Added jobs compete by the same fit:
    // one batch read for all of them, and only a job that has a fit can be a best fit.
    let mine: AddedRow[] = [];
    try {
      const listed = new Set(items.map((i) => i.jobId));
      const added = (await ctx.areas.addedJobs(userId, { limit: TOP_FIT_ADDED_MAX })).filter((j) => !listed.has(j.jobId));
      mine = (await addedRows(ctx, userId, added)).filter((row) => row.fit?.score !== null && row.fit?.score !== undefined);
    } catch (err) {
      logger.warn('COPILOT', 'added jobs unavailable for top_fit_jobs', { error: err instanceof Error ? err.message : String(err) });
    }
    const rows = orderByFit<FeedItem | AddedRow>([...items, ...mine]).slice(0, limit);
    return candidates(
      ctx,
      rows as unknown as JobListItem[],
      rows.map((r) => ('addedByUser' in r ? addedForModel(r) : jobForModel(r))),
      { sort: 'best_fit' },
    );
  },
};

const SimilarJobsArgs = z.object({ jobId: JobId, limit: z.number().int().min(1).max(JOB_LIST_MAX).optional() }).strict();

export const similarJobs: CopilotTool<z.infer<typeof SimilarJobsArgs>> = {
  name: 'similar_jobs',
  description:
    'Open jobs like one job: the Similar jobs list of that job\'s page. Use it for "jobs like this one" and "similar jobs". Returns at most 8 jobs with ids. Nothing is shown to the user until you call show_jobs.',
  schema: SimilarJobsArgs,
  available: (ctx) => ctx.areas.postingsAllowed(ctx.market),
  async run(args, ctx) {
    const userId = requireUser(ctx);
    try {
      const found = await ctx.areas.similarJobs(userId, args.jobId);
      const rows = found.items.filter((i) => i.jobId !== args.jobId).slice(0, args.limit ?? 5);
      return candidates(
        ctx,
        rows as unknown as JobListItem[],
        rows.map(jobForModel),
        { similarTo: args.jobId, by: found.by },
        {
          // Said as it is: the page's list, or (where that list is not offered) jobs with a similar title.
          basis: found.by === 'similar' ? "the Similar jobs list of the job's page" : 'open jobs with a similar title under the saved search',
          ...(rows.length ? {} : { note: 'No similar job is listed right now.' }),
        },
      );
    } catch (err) {
      if (isNotFound(err)) return notAvailable('job_not_found');
      throw err;
    }
  },
};

const ShowJobsArgs = z
  .object({
    jobIds: z
      .array(JobId)
      .min(1)
      .max(JOB_LIST_MAX)
      .describe('The jobs you are going to talk about, in the order you mention them. Only ids a list tool returned (search_jobs, top_fit_jobs, added_jobs, similar_jobs).'),
    note: z.string().trim().min(1).max(JOB_LIST_NOTE_MAX).optional().describe('One short line shown above the list, for example what these jobs have in common. No number that is not in a tool result.'),
  })
  .strict();

const NOT_LISTED_NOTE = 'Only a job from a list tool can be shown. Call search_jobs, top_fit_jobs, added_jobs or similar_jobs first, then pass ids it returned.';

/**
 * The card of the answer: exactly the jobs the model cites, in the order it
 * gives. Rows come from the lists the turn already holds (`ctx.listedJobs`:
 * no new query). A row taken from an earlier answer has its fit read again,
 * so the card never shows a fit from then as the fit now.
 */
export const showJobs: CopilotTool<z.infer<typeof ShowJobsArgs>> = {
  name: 'show_jobs',
  description:
    'Show the user the jobs your answer is about: one card with exactly these jobs, in this order. Call it after a list tool (search_jobs, top_fit_jobs, added_jobs, similar_jobs), with ids it returned, before you write about the jobs. Never name a job you did not pass here.',
  schema: ShowJobsArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const ids = [...new Set(args.jobIds)];
    const known = ctx.listedJobs;
    const unlisted = ids.filter((id) => !known?.has(id));
    if (unlisted.length) return { data: { error: 'job_not_listed', jobIds: unlisted, note: NOT_LISTED_NOTE } };
    const earlier = ids.filter((id) => !known!.get(id)!.fromThisTurn);
    const fresh = earlier.length ? await fitsOf(ctx, userId, earlier) : null;
    const items = ids.map((id): JobListItem => {
      const row = known!.get(id)!;
      return row.fromThisTurn ? row.item : { ...row.item, fit: rowFit(fresh!.get(id)) };
    });
    const data: JobListCardData = { items, cited: true, ...(args.note ? { note: args.note } : {}) };
    return {
      data: { shown: ids.length, jobIds: ids, note: 'The card shows exactly these jobs, in this order. Write about these jobs only.' },
      cards: [card(ctx, 'job_list', data)],
      jobIds: ids,
      list: 'cited',
    };
  },
};

const JobArgs = z.object({ jobId: JobId }).strict();

export const getJob: CopilotTool<z.infer<typeof JobArgs>> = {
  name: 'get_job',
  description: "Read one job's posting: title, company, place, pay as listed, skills, requirements and the posting's own sections.",
  schema: JobArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    try {
      const d = await ctx.areas.getJob(userId, args.jobId);
      return {
        data: {
          jobId: d.job.id,
          title: d.job.title,
          company: d.job.companyName,
          location: d.job.location,
          workModel: d.job.workModel,
          status: d.job.status,
          pay: d.job.pay ?? (d.job.payText ? { text: d.job.payText } : 'not listed'),
          skills: d.job.skills.slice(0, 30),
          sponsorship: d.job.sponsorship,
          requirements: d.job.requirements,
          sections: d.job.sections.map((s) => ({ kind: s.kind, body: clip(s.body, 1500) })),
          postedAt: d.job.postedAt,
          fit: d.fit ? { score: d.fit.score, tier: d.fit.tier, kind: d.fit.kind === 'pre' ? 'quick estimate' : 'ai', topGap: d.fit.topGap, topOverlap: d.fit.topOverlap } : null,
          fitNote: FIT_LINE,
        },
        jobIds: [d.job.id],
      };
    } catch (err) {
      if (isNotFound(err)) return notAvailable('job_not_found');
      throw err;
    }
  },
};

const ESTIMATE_KIND = 'quick estimate (no AI read)';
export const YOUR_FIT_LABEL = 'Your fit';
export const WITH_THIS_VERSION_LABEL = 'With this version';

/** What the model is told about one measure: the number, how it was made and how much it rests on. */
function measureForModel(view: MatchFitView): Record<string, unknown> {
  const estimate = view.kind === 'pre';
  return {
    score: view.score,
    tier: view.tier,
    kind: estimate ? ESTIMATE_KIND : 'ai',
    confidence: view.confidence ?? null,
    // Why this is a quick estimate and, when it rests on little, what is missing.
    ...(estimate ? { reason: view.estimateReason ?? null, confidenceReason: view.confidenceReason ?? null } : {}),
  };
}

const AnalyzeFitArgs = z
  .object({
    jobId: JobId,
    resumeVariantId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Only when the user asks how ONE SPECIFIC resume version fits (for example "how does my tailored resume fit"): the id of that version. Leave it out otherwise; the answer is then the fit for their main resume, the number the job page shows.',
      ),
  })
  .strict();

export const analyzeFit: CopilotTool<z.infer<typeof AnalyzeFitArgs>> = {
  name: 'analyze_fit',
  description:
    'How the user fits one job: the fit tier, skills the resume shows and misses, and gaps. Use for "why do I fit" and "what am I missing". The fit is for their main resume and is the number the job page shows. With resumeVariantId the answer also carries a second, separately named measure, "With this version".',
  schema: AnalyzeFitArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    try {
      // The canonical fit: never the resume attached to the thread.
      const view = await ctx.areas.fit(userId, args.jobId, { locale: ctx.locale });
      let withThisVersion: Record<string, unknown> | undefined;
      if (args.resumeVariantId) {
        try {
          const variant = await ctx.areas.variantFit(userId, args.jobId, args.resumeVariantId, { locale: ctx.locale });
          withThisVersion = { variant: true, label: WITH_THIS_VERSION_LABEL, resumeVariantId: variant.resumeVariantId ?? args.resumeVariantId, ...measureForModel(variant) };
        } catch (err) {
          if (!isNotFound(err)) throw err;
          withThisVersion = { variant: true, label: WITH_THIS_VERSION_LABEL, available: false, reason: 'resume_version_not_found' };
        }
      }
      return {
        data: {
          jobId: view.jobId,
          label: YOUR_FIT_LABEL,
          ...measureForModel(view),
          summary: view.summary,
          strengths: view.strengths,
          gaps: view.gaps,
          skillsShown: view.skills.aligned,
          skillsMissing: view.skills.missing,
          skillsListed: view.skills.listed,
          ...(withThisVersion
            ? {
                withThisVersion,
                measuresNote: `Two different measures. "${YOUR_FIT_LABEL}" is for the main resume and is the number the job page shows. "${WITH_THIS_VERSION_LABEL}" is for the one version asked about. Name each when you quote it; never call the second one the fit.`,
              }
            : {}),
          fitNote: FIT_LINE,
        },
        // The card is the canonical fit only.
        cards: [card(ctx, 'fit_analysis', { ...view, aiWritten: view.kind === 'ai' })],
        jobIds: [view.jobId],
      };
    } catch (err) {
      if (isNotFound(err)) return notAvailable('job_not_found');
      throw err;
    }
  },
};

const CompanyArgs = z
  .object({ jobId: JobId.optional(), companyId: z.string().min(1).max(64).optional() })
  .strict()
  .refine((a) => Boolean(a.jobId || a.companyId), { message: 'jobId or companyId is required' });

export const companyInsights: CopilotTool<z.infer<typeof CompanyArgs>> = {
  name: 'company_insights',
  description: 'Facts about the company behind a job, each with its source. Fields without a source are not listed.',
  schema: CompanyArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    let companyId = args.companyId ?? null;
    try {
      if (!companyId && args.jobId) companyId = (await ctx.areas.getJob(userId, args.jobId)).company.id;
      if (!companyId) return notAvailable('no_company_record');
      const profile = await ctx.areas.companyProfile(companyId);
      const sources: CardSource[] = Object.entries(profile.facts).flatMap(([field, f]) =>
        f ? [{ value: f.value, source: f.source, asOf: f.asOf, method: 'stated' as const, ...(f.url ? { url: f.url } : {}), field } as CardSource] : [],
      );
      sources.push({ value: profile.openJobs.value, source: profile.openJobs.source, asOf: profile.openJobs.asOf, method: 'computed', ...(profile.openJobs.sampleSize !== undefined ? { sampleSize: profile.openJobs.sampleSize } : {}) });
      return {
        data: { company: profile.name, facts: profile.facts, openJobs: profile.openJobs, note: 'Only facts with a source are listed; anything else is not known.' },
        cards: [card(ctx, 'company', profile, sources)],
        jobIds: args.jobId ? [args.jobId] : [],
      };
    } catch (err) {
      if (isNotFound(err)) return notAvailable('company_not_found');
      throw err;
    }
  },
};

/** The salary card's stats with every count Sourced (D3); the percentiles already are. */
function salaryStatsView(stats: SalaryStatsResult, now: Date) {
  return {
    ...stats,
    listedCount: indexCount(stats.listedCount, now),
    totalCount: indexCount(stats.totalCount, now),
  };
}

const SalaryArgs = z
  .object({
    jobId: JobId.optional(),
    taxonomyId: z.string().min(1).max(80).optional(),
    title: z.string().trim().min(1).max(120).optional().describe('Role title when there is no job or taxonomy id.'),
    country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    city: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

/** Posted pay: the job's own range (source `posting`) and the range across matching posts in our index (n ≥ 20). */
export const salaryContext: CopilotTool<z.infer<typeof SalaryArgs>> = {
  name: 'salary_context',
  description:
    'Pay as posted: the job\'s own listed range, and the middle of listed ranges across similar open posts with how many posts it is based on. Returns nothing for the aggregate when fewer than 20 posts list pay. Never estimate pay yourself.',
  schema: SalaryArgs,
  public: true,
  available: (ctx) => ctx.areas.postingsAllowed(ctx.market),
  async run(args, ctx) {
    let posted: Record<string, unknown> | null = null;
    let title = args.title ?? ctx.page?.role ?? null;
    let country = args.country?.toUpperCase() ?? ctx.page?.country?.toUpperCase() ?? null;
    const city = args.city ?? ctx.page?.city ?? null;
    const jobIds: string[] = [];
    if (args.jobId) {
      if (!ctx.userId) return notAvailable('sign_in_required');
      try {
        const d = await ctx.areas.getJob(ctx.userId, args.jobId);
        jobIds.push(d.job.id);
        title = title ?? d.job.title;
        posted = d.job.pay
          ? { value: { min: d.job.pay.min, max: d.job.pay.max, currency: d.job.pay.currency, period: d.job.pay.period, text: d.job.pay.text }, source: 'posting', asOf: d.job.lastSeenAt ?? ctx.now.toISOString(), method: 'stated' }
          : d.job.payText
            ? { value: { text: d.job.payText }, source: 'posting', asOf: d.job.lastSeenAt ?? ctx.now.toISOString(), method: 'stated' }
            : null;
      } catch (err) {
        if (isNotFound(err)) return notAvailable('job_not_found');
        throw err;
      }
    }
    if (!args.taxonomyId && !title) return notAvailable('role_required');
    const stats = await ctx.areas.salaryStats({ market: ctx.market, taxonomyId: args.taxonomyId ?? null, title, country, city, now: ctx.now });
    const out: ToolOutput = {
      data: {
        postedForThisJob: posted ?? 'not listed',
        acrossPosts: stats.median
          ? { median: stats.median.value, p25: stats.p25?.value, p75: stats.p75?.value, currency: stats.currency, period: stats.period, postsWithPay: stats.listedCount, postsMatched: stats.totalCount }
          : { notEnoughData: true, postsWithPay: stats.listedCount, postsMatched: stats.totalCount, minimum: stats.minSample },
        source: 'Listed pay in open posts on this site (not a market survey).',
      },
      cards: [card(ctx, 'salary', { posted, stats: salaryStatsView(stats, ctx.now), jobId: args.jobId ?? null }, [...(posted ? [posted as unknown as CardSource] : []), ...(stats.median ? [stats.median as CardSource] : [])])],
      jobIds,
    };
    return out;
  },
};

const CompetitivenessArgs = z.object({ jobId: JobId.optional() }).strict();

export const competitiveness: CopilotTool<z.infer<typeof CompetitivenessArgs>> = {
  name: 'competitiveness',
  description: 'Offer the competitiveness report (how the user compares with what posts ask for). Returns a link card; the report page has the numbers.',
  schema: CompetitivenessArgs,
  available: (ctx) => ctx.isEnabled('competitiveness'),
  async run(args, ctx: ToolContext) {
    const data: CompetitivenessCardData = { href: args.jobId ? `/jobs/report?job=${encodeURIComponent(args.jobId)}` : '/jobs/report', jobId: args.jobId ?? null };
    return { data: { offered: true, note: 'The report page shows the figures with their sources.' }, cards: [card(ctx, 'competitiveness', data)], jobIds: args.jobId ? [args.jobId] : [] };
  },
};
