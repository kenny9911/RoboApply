// server/src/features/jobs/enrich/service.ts
//
// Enrich one job (ARCHITECTURE.md §4.5). Steps:
//   1. load; skip archived rows and rows already enriched at ENRICH_VERSION
//      (idempotent: the same work item delivered twice does nothing);
//   2. rule-based scam signals (intl) — always, no model; a rule an admin
//      cleared when restoring the job (RAJobReview.clearedRules of its latest
//      'restore') is never raised again, however often the job is re-enriched;
//   3. skip the model when ingest already covered taxonomy, seniority and ≥5
//      skills, the title names its role outright, and the posting has nothing
//      only the model can cite;
//      also skip it when the brand has no model (GoApply without CN config)
//      or the job is a GoApply user's import without AI consent (aiAllowed);
//   4. otherwise spend one unit of the market's daily budget; over budget →
//      write the rule-based parts now and defer the item to the next window
//      (a budget of 0 means "LLM enrichment off": finish rules only);
//      a rules-only row records on itself whether a model pass is still owed
//      (`enrichModel` RULES_ONLY_MODEL: no model / enrichment off) or would
//      change nothing (RULES_CHECKED_MODEL: covered, no AI consent, the call
//      failed on its last attempt) — jobs-maintain retries only the former;
//   5. one structured call under the job's brand (`task: 'enrich'`);
//   6. reconcile (quote guard, negation rule, candidate-only taxonomy; the
//      model may overrule a role whose title match is weak, SM-2), write the
//      row, the RAKeywordExtraction row (top 30) and the cost row; when a
//      public posting states what its employer does, pass that industry to
//      the company row (SM-10);
//   7. queue the job for indexing (`job.index`, features/retrieval: the search
//      document, the content hash and the vector), once per enrichment, after
//      an enriched and after a rules-only finish alike;
//   8. call `marketHooks.afterEnrich` (WP-41's CN classifier and others).
// A failed or unparsable call is retried by the queue; on the last attempt
// the job is finished rules-only so it never stays unenriched forever.

import { calculateModelCost } from '../../../lib/modelPricing.js';
import { logger } from '../../../services/LoggerService.js';
import { aiAllowed as platformAiAllowed } from '../../../platform/consent/index.js';
import { brandEnv, getBrand } from '../../../platform/brand/index.js';
import { SHARED_COST_USER_ID } from '../../../roboapply/v2/lib/raFeatureCatalog.js';
import { afterEnrich as marketAfterEnrich, type MarketHookContext, type MarketHookJob } from '../marketHooks.js';
import type { PostingIndustry } from '../companies/index.js';
import { createEnrichBudget, type EnrichBudget } from './budget.js';
import { selectTaxonomyCandidates } from './candidates.js';
import { buildKeywords } from './keywords.js';
import {
  brandForMarket,
  defaultEnrichLlm,
  resolveEnrichModel,
  runEnrichCall,
  type EnrichCallResult,
  type EnrichLlm,
} from './agent.js';
import { createPrismaEnrichRepository, type EnrichRepository } from './repository.js';
import { fraudFlagUpdate, needsLlm, postingTextOf, reconcile, type EnrichJobRecord, type EnrichUpdate } from './reconcile.js';
import { detectScamSignals } from './scamSignals.js';
import { ENRICH_VERSION, RULES_CHECKED_MODEL, RULES_ONLY_MODEL, type EnrichPayload } from './schema.js';

export interface EnrichDeps {
  repo: EnrichRepository;
  llm: EnrichLlm;
  budget: EnrichBudget;
  /** GoApply AI consent for a user's own import (platform/consent). */
  aiAllowed: (userId: string) => Promise<boolean>;
  afterEnrich: (job: MarketHookJob, ctx: MarketHookContext) => Promise<void>;
  /**
   * Write the industry a posting states to its company row (SM-10,
   * companies/service.ts). Optional so a caller's own dependency double need
   * not model it (absent = the industry is not stored).
   */
  setCompanyIndustry?: (companyId: string, input: PostingIndustry) => Promise<unknown>;
  /**
   * Queue the job for indexing (MKT-2H): `job.index` with the job's id, one
   * item per job and enrichment (dedupe key `job.index:<jobId>:<enrichedAt ms>`),
   * in the brand of the job's market. Optional so a caller's own dependency
   * double need not model it (absent = the retrieval sweep indexes the row later).
   */
  enqueueIndex?: (job: EnrichedJobRef) => Promise<unknown>;
  env: Record<string, string | undefined>;
  now: () => Date;
}

/** What the index hook needs of a job that just finished enrichment. */
export interface EnrichedJobRef {
  id: string;
  market: string;
  /** The stamp of the enrichment that just finished (the row's own when hooks are re-run). */
  enrichedAt: Date | null;
}

/** `job.index` for one enriched job, once per enrichment. Loaded on first use: the retrieval area is not part of enrichment's start-up. */
async function defaultEnqueueIndex(job: EnrichedJobRef): Promise<unknown> {
  const [{ enqueue }, { RETRIEVAL_WORK_KINDS, jobIndexDedupeKey }] = await Promise.all([import('../../../platform/queue/index.js'), import('../../retrieval/index.js')]);
  return enqueue(RETRIEVAL_WORK_KINDS.jobIndex, { jobIds: [job.id] }, { dedupeKey: jobIndexDedupeKey(job.id, job.enrichedAt), brand: brandForMarket(job.market) });
}

export function defaultEnrichDeps(): EnrichDeps {
  return {
    repo: createPrismaEnrichRepository(),
    llm: defaultEnrichLlm,
    budget: createEnrichBudget(),
    aiAllowed: (userId) => platformAiAllowed(userId),
    afterEnrich: (job, ctx) => marketAfterEnrich(job, ctx),
    // Loaded on first use: the companies area (its routes included) is not part of enrichment's start-up.
    setCompanyIndustry: async (companyId, input) => (await import('../companies/index.js')).recordPostingIndustry(companyId, input),
    enqueueIndex: defaultEnqueueIndex,
    env: process.env,
    now: () => new Date(),
  };
}

export interface EnrichAttempt {
  /** 1-based attempt of the work item. */
  attempt: number;
  maxAttempts: number;
  requestId?: string;
}

export type EnrichOutcome =
  | { status: 'not_found' | 'archived' }
  | { status: 'already_enriched'; hooksRerun: boolean }
  | { status: 'enriched'; model: string; costUsd: number }
  | { status: 'rules_only'; reason: 'covered' | 'no_model' | 'no_ai_consent' | 'budget_disabled' | 'llm_failed' }
  | { status: 'deferred'; retryAfterMs: number };

/**
 * The user id cost rows go under: the brand's system user (GoApply:
 * CN_RA_SYSTEM_USER_ID when set, else the shared RA_SYSTEM_USER_ID, per key),
 * else the shared-cost sentinel when neither is set.
 */
export function systemUserIdFor(market: string, env: Record<string, string | undefined> = process.env): string {
  return brandEnv(getBrand(brandForMarket(market)), 'RA_SYSTEM_USER_ID', env) ?? SHARED_COST_USER_ID;
}

/** The work-item dedupe key: one enrichment per job per ENRICH_VERSION. */
export function enrichDedupeKey(jobId: string, version: number = ENRICH_VERSION): string {
  return `job.enrich:${jobId}:v${version}`;
}

type RulesOnlyReason = Extract<EnrichOutcome, { status: 'rules_only' }>['reason'];

/**
 * What a rules-only row stores in `enrichModel`. Only a row that never had
 * the chance of a model pass (no model for the brand, enrichment switched
 * off) stays RULES_ONLY_MODEL, the value jobs-maintain retries. The rest are
 * settled for this version: the work queue forgets a finished item after a
 * week, so the row itself has to say that the pass was made.
 */
export function rulesOnlyMarker(reason: RulesOnlyReason): string {
  return reason === 'no_model' || reason === 'budget_disabled' ? RULES_ONLY_MODEL : RULES_CHECKED_MODEL;
}

function hookJob(job: EnrichJobRecord, update: EnrichUpdate): MarketHookJob {
  return { ...job, ...update, id: job.id, market: job.market === 'cn' ? 'cn' : 'intl', provider: job.sourceBoard };
}

async function runHooks(deps: EnrichDeps, job: EnrichJobRecord, update: EnrichUpdate): Promise<void> {
  const market = job.market === 'cn' ? 'cn' : 'intl';
  // Indexing first, so a market hook that fails cannot hold it back. A lost enqueue is not worth failing the
  // enrichment for: the retrieval sweep finds a row without a search document or a current vector.
  if (deps.enqueueIndex) {
    try {
      await deps.enqueueIndex({ id: job.id, market: job.market, enrichedAt: update.enrichedAt ?? job.enrichedAt ?? null });
    } catch (err) {
      logger.warn('JOB_ENRICH', 'could not queue the job for indexing; the retrieval sweep picks it up', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await deps.afterEnrich(hookJob(job, update), { brand: brandForMarket(market), market, stage: 'enrich', userId: job.ownerUserId });
}

async function writeKeywords(deps: EnrichDeps, job: EnrichJobRecord, text: string, update: EnrichUpdate, model: string, cost: number | null): Promise<void> {
  const detail = update.skillsDetail ?? [];
  const skills = detail.length
    ? detail.map((d) => ({ skill: d.skill, required: d.required }))
    : (update.skills ?? job.skills).map((s) => ({ skill: s, required: false }));
  await deps.repo.saveKeywords(job.id, { keywords: buildKeywords(text, skills), modelUsed: model, tokenCost: cost, generatedAt: deps.now() });
}

/** Write the rule-based parts only (scam flags, keywords); the row stays unenriched. */
async function writePartial(deps: EnrichDeps, job: EnrichJobRecord, text: string, update: EnrichUpdate): Promise<void> {
  if (update.fraudFlags !== undefined) await deps.repo.saveJob(job.id, { fraudFlags: update.fraudFlags });
  await writeKeywords(deps, job, text, update, RULES_ONLY_MODEL, null);
}

async function finishRulesOnly(
  deps: EnrichDeps,
  job: EnrichJobRecord,
  text: string,
  signals: ReturnType<typeof detectScamSignals>,
  reason: RulesOnlyReason,
): Promise<EnrichOutcome> {
  const { update, report } = reconcile({ job, postingText: text, output: null, candidates: [], scamSignals: signals, model: null, now: deps.now() });
  update.enrichModel = rulesOnlyMarker(reason);
  if (report.staleEvidence.length) logger.info('JOB_ENRICH', 'removed evidence the posting no longer contains', { jobId: job.id, stale: report.staleEvidence });
  // The title moves or removes a role without a model too (SM-2): it leaves the same trace as a model's override.
  if (report.taxonomyOverridden) logger.info('JOB_ENRICH', 'role changed by the title', { jobId: job.id, reason, taxonomyOverridden: report.taxonomyOverridden });
  await deps.repo.saveJob(job.id, update);
  await writeKeywords(deps, job, text, update, RULES_ONLY_MODEL, null);
  await runHooks(deps, job, update);
  return { status: 'rules_only', reason };
}

/**
 * Drop the scam rules an admin cleared for this job ("Keep" on the reports
 * page): a decision holds across re-enrichment. When the decision log cannot
 * be read the rules are kept (a posting stays flagged rather than unflagged by
 * an outage); the next enrichment reads the log again.
 */
async function withoutClearedRules<T extends { rule: string }>(deps: EnrichDeps, jobId: string, signals: T[]): Promise<T[]> {
  if (!signals.length || !deps.repo.clearedScamRules) return signals;
  try {
    const cleared = new Set(await deps.repo.clearedScamRules(jobId));
    return cleared.size ? signals.filter((s) => !cleared.has(s.rule)) : signals;
  } catch (err) {
    logger.warn('JOB_ENRICH', 'admin decisions unavailable; scam rules raised as detected', { jobId, error: err instanceof Error ? err.message : String(err) });
    return signals;
  }
}

/** Enrich one job. Throws only for errors the queue should retry. */
export async function enrichJob(payload: EnrichPayload, attempt: EnrichAttempt, deps: EnrichDeps = defaultEnrichDeps()): Promise<EnrichOutcome> {
  const job = await deps.repo.loadJob(payload.jobId);
  if (!job) return { status: 'not_found' };
  if (job.archivedAt) return { status: 'archived' };

  if (!payload.force && job.enrichedAt && job.enrichVersion === ENRICH_VERSION) {
    // A retry means the previous attempt failed after writing, i.e. in a hook: run hooks again.
    const hooksRerun = attempt.attempt > 1;
    if (hooksRerun) await runHooks(deps, job, {});
    return { status: 'already_enriched', hooksRerun };
  }

  const now = deps.now();
  const text = postingTextOf(job);
  const signals = await withoutClearedRules(deps, job.id, detectScamSignals(`${job.title}\n${text}`, job.market));

  const need = needsLlm(job, text);
  if (!need.needed) return finishRulesOnly(deps, job, text, signals, 'covered');

  const brandId = brandForMarket(job.market);
  const route = resolveEnrichModel(getBrand(brandId), deps.env);
  if (!route.available) {
    if (route.refused) {
      logger.warn('JOB_ENRICH', 'GoApply enrich model is not on a domestic provider (CN_LLM_DOMESTIC_ONLY is on); finishing rules only', { jobId: job.id, reason: route.refused });
    }
    return finishRulesOnly(deps, job, text, signals, 'no_model');
  }

  const isUserImport = job.visibility === 'private' && !!job.ownerUserId;
  if (isUserImport && !(await deps.aiAllowed(job.ownerUserId!))) return finishRulesOnly(deps, job, text, signals, 'no_ai_consent');

  const budget = await deps.budget(job.market, now);
  // ENRICH_DAILY_JOBS=0 switches LLM enrichment off: finish rules only rather
  // than deferring forever (the row would never be stamped nor reach the hooks).
  if (!budget.allowed && budget.limit === 0) return finishRulesOnly(deps, job, text, signals, 'budget_disabled');
  if (!budget.allowed) {
    await writePartial(deps, job, text, fraudFlagUpdate(job, signals, now));
    logger.info('JOB_ENRICH', 'daily enrichment budget reached; deferring', { jobId: job.id, market: job.market, limit: budget.limit });
    return { status: 'deferred', retryAfterMs: Math.max(1, budget.retryAfterSec) * 1000 };
  }

  const candidates = selectTaxonomyCandidates(job.title, text, undefined, [job.primaryTaxonomyId]);
  let call: EnrichCallResult;
  try {
    call = await runEnrichCall(
      {
        title: job.title,
        companyName: job.companyName,
        postingText: text,
        market: job.market,
        candidates,
        brand: brandId,
        route,
        carriesUserData: isUserImport,
        requestId: attempt.requestId,
      },
      deps.llm,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt.attempt < attempt.maxAttempts) {
      await writePartial(deps, job, text, fraudFlagUpdate(job, signals, now));
      throw err;
    }
    logger.warn('JOB_ENRICH', 'enrichment call failed on the last attempt; finishing rules only', { jobId: job.id, error: message });
    return finishRulesOnly(deps, job, text, signals, 'llm_failed');
  }

  const { update, report, companyIndustry } = reconcile({ job, postingText: text, output: call.output, candidates, scamSignals: signals, model: call.model, now });
  if (
    report.sponsorshipCorrected ||
    report.droppedQuotes.length ||
    report.droppedSkills.length ||
    report.staleEvidence.length ||
    report.taxonomyRejected ||
    report.taxonomyOverridden
  ) {
    logger.info('JOB_ENRICH', 'model claims dropped by the quote guard', { jobId: job.id, ...report });
  }
  await deps.repo.saveJob(job.id, update);
  // A public posting that says what its employer does fills the company's industry. A user's own
  // import never does: its text is that user's data, and a company row is shared by everyone.
  if (companyIndustry && job.companyId && !isUserImport && deps.setCompanyIndustry) {
    try {
      await deps.setCompanyIndustry(job.companyId, { industry: companyIndustry.industry, sourceUrl: job.sourceUrl ?? job.applyUrl ?? null, at: now });
    } catch (err) {
      // The job row is already written; a lost company fact is retried by the next posting of that employer.
      logger.warn('JOB_ENRICH', 'could not store the industry the posting states', { jobId: job.id, companyId: job.companyId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const costUsd = calculateModelCost(call.model, call.usage.promptTokens, call.usage.completionTokens);
  await writeKeywords(deps, job, text, update, call.model, costUsd);
  await deps.repo.logCost({
    userId: systemUserIdFor(job.market, deps.env),
    jobId: job.id,
    brand: brandId,
    market: job.market,
    model: call.model,
    promptTokens: call.usage.promptTokens,
    completionTokens: call.usage.completionTokens,
    costUsd,
    requestId: attempt.requestId ?? null,
  });
  await runHooks(deps, job, update);
  return { status: 'enriched', model: call.model, costUsd };
}
