// server/src/features/copilot/tools/jobs.ts — job tools (ARCH §5.2; WP-50).
//
// search_jobs · top_fit_jobs · added_jobs · get_job · analyze_fit ·
// company_insights · salary_context · competitiveness. All read-only. Lists
// come from the feed seam (`feedService.preview`, no session), jobs from job
// detail (market and GoApply mode checks happen there), fit from MATCH's free
// on-demand score (the paid `fit_analysis` card lives on the job page),
// company facts only with their provenance.
//
// The card is the list. A `job_list` card shows every job the tool returned,
// so whatever narrows a list is done HERE, by the tool, never by the model in
// its text: "only posts that list pay" is the `payListed` argument (the
// search's own "Only jobs that list pay" filter, and no pay-less row is kept),
// and each row carries its work model so "remote" can be seen on the card.
//
// Jobs the user added themselves (a pasted link or text) are private rows the
// public lists never include. `added_jobs` lists them, and `search_jobs` with
// keywords looks through them too, so "the job I added at Acme" is found.
// `added_jobs` works with GoApply's third-party postings off: the user's own
// rows are theirs to ask about.

import { z } from 'zod';
import { FEED_SORTS } from '../../feed/contract.js';
import { parseFilterSetPatch, type FilterSet } from '../../search/index.js';
import type { CardSource, CompetitivenessCardData } from '../contract.js';
import type { FeedItem, SalaryStatsResult } from '../../feed/index.js';
import type { AddedJobItem } from '../../jobs/import/index.js';
import { logger } from '../../../services/LoggerService.js';
import type { CopilotTool, ToolContext, ToolOutput } from '../types.js';
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

const LIST_NOTE = 'The card shows exactly these jobs, all of them. Describe the list as it is; to show fewer or other jobs, call the tool again with the filters that narrow it.';

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
  fit: { tier: string | null; score: number | null; kind: 'pre' | 'ai'; topGap: string | null; topOverlap: string | null } | null;
  badges: [];
}

/**
 * The stored fit of each added job (never a model call). A job whose fit
 * cannot be read has none. Read one after another: each read is a chain of
 * queries (the job, the user's profile and resume, the stored score), and a
 * turn must not take eight database connections at once for a list of at
 * most eight rows.
 */
async function addedRows(ctx: ToolContext, userId: string, jobs: readonly AddedJobItem[]): Promise<AddedRow[]> {
  const rows: AddedRow[] = [];
  for (const j of jobs) {
    let fit: AddedRow['fit'] = null;
    try {
      const view = await ctx.areas.storedFit(userId, j.jobId, { resumeVariantId: ctx.resumeId, locale: ctx.locale });
      if (view.tier || view.score !== null) fit = { tier: view.tier, score: view.score, kind: view.kind, topGap: view.topGap, topOverlap: view.topOverlap };
    } catch (err) {
      logger.debug('COPILOT', 'no stored fit for an added job', { jobId: j.jobId, error: err instanceof Error ? err.message : String(err) });
    }
    rows.push({
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
      fit,
      badges: [],
    });
  }
  return rows;
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
    limit: z.number().int().min(1).max(8).optional(),
  })
  .strict();

const hasPay = (item: FeedItem): boolean => item.pay !== null && item.pay !== undefined;

export const searchJobs: CopilotTool<z.infer<typeof SearchJobsArgs>> = {
  name: 'search_jobs',
  description:
    'Search open jobs for the user. Returns at most 8 jobs with ids; the card shows exactly the jobs returned, so narrow the list with arguments (filters, payListed), never in your text. With keywords it also looks through the jobs the user added themselves. Does not change the saved search; to change it, use propose_filter_change.',
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
    const found = await ctx.areas.feedPreview(userId, { q: args.q, filters, sort: args.sort, limit });
    // The card is the list: a row without pay never rides along on a pay-only search
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
    return {
      data: {
        count: rows.length,
        jobs: rows.map((r) => ('addedByUser' in r ? addedForModel(r) : jobForModel(r))),
        ...(payOnly ? { payListedOnly: true } : {}),
        fitNote: FIT_LINE,
        listNote: LIST_NOTE,
      },
      cards: rows.length ? [card(ctx, 'job_list', { items: rows, query: { q: args.q ?? null, sort: args.sort ?? null, ...(payOnly ? { payListed: true } : {}) } })] : [],
      jobIds: rows.map((i) => i.jobId),
    };
  },
};

const AddedJobsArgs = z.object({ limit: z.number().int().min(1).max(8).optional() }).strict();

export const addedJobs: CopilotTool<z.infer<typeof AddedJobsArgs>> = {
  name: 'added_jobs',
  description:
    'The jobs the user added themselves (from a link or pasted text), newest first, each with its stored fit when there is one. Use it for "the jobs I added", "my added jobs", or a job or company the user says they added. These jobs are not in search_jobs without keywords.',
  schema: AddedJobsArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const rows = await addedRows(ctx, userId, await ctx.areas.addedJobs(userId, { limit: args.limit ?? 8 }));
    return {
      data: {
        count: rows.length,
        jobs: rows.map(addedForModel),
        ...(rows.length ? { fitNote: FIT_LINE, listNote: LIST_NOTE } : { note: 'The user has not added any job yet. They can add one with a link or pasted text (add_external_job).' }),
      },
      cards: rows.length ? [card(ctx, 'job_list', { items: rows, query: { added: true } })] : [],
      jobIds: rows.map((r) => r.jobId),
    };
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

const TopFitArgs = z.object({ limit: z.number().int().min(1).max(8).optional() }).strict();

export const topFitJobs: CopilotTool<z.infer<typeof TopFitArgs>> = {
  name: 'top_fit_jobs',
  description: "The user's best-fitting open jobs under the saved search, best fit first.",
  schema: TopFitArgs,
  available: (ctx) => ctx.areas.postingsAllowed(ctx.market),
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const items = await ctx.areas.feedPreview(userId, { sort: 'best_fit', limit: args.limit ?? 5 });
    return {
      data: { count: items.length, jobs: items.map(jobForModel), fitNote: FIT_LINE, listNote: LIST_NOTE },
      cards: items.length ? [card(ctx, 'job_list', { items, query: { sort: 'best_fit' } })] : [],
      jobIds: items.map((i) => i.jobId),
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

export const analyzeFit: CopilotTool<z.infer<typeof JobArgs>> = {
  name: 'analyze_fit',
  description: 'How the user fits one job: the fit tier, skills the resume shows and misses, and gaps. Use for "why do I fit" and "what am I missing".',
  schema: JobArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    try {
      const view = await ctx.areas.scoreJob(userId, args.jobId, { resumeVariantId: ctx.resumeId, locale: ctx.locale });
      return {
        data: {
          jobId: view.jobId,
          score: view.score,
          tier: view.tier,
          kind: view.kind === 'pre' ? 'quick estimate (no AI read)' : 'ai',
          summary: view.summary,
          strengths: view.strengths,
          gaps: view.gaps,
          skillsShown: view.skills.aligned,
          skillsMissing: view.skills.missing,
          skillsListed: view.skills.listed,
          fitNote: FIT_LINE,
        },
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
