// server/src/features/jobs/enrich/index.ts — public surface of job enrichment (WP-17).
//
// Producers (WP-16b ingest, WP-35 import, WP-42 ATS sources) enqueue with
// `enqueueJobEnrich(jobId, { changed })`; readers use the exported shapes:
//   - `RAJob.sponsorship` + `sponsorshipEvidence` (the quote the badge/tooltip shows);
//   - `RAJob.citizenshipRequired` / `clearanceRequired`, quotes in `marketTags`
//     under REQUIREMENT_TAGS;
//   - `RAJob.fraudFlags` rules INTL_SCAM_RULES (WP-32 excludes, WP-74 lists);
//   - `RAJob.summary` is AI output: render it as `{ text, aiWritten: true }`
//     ("Summary written by AI from the job post"; AiGeneratedBadge on GoApply).

import { enqueue, type EnqueueOptions, type EnqueuedItem } from '../../../platform/queue/index.js';
// agent.js before service.js, on purpose: service.js loads the market hooks, and a hook module
// (cn/jobs/fraud/llm.ts) reads this area's CN_DOMESTIC_PROVIDERS while this file is still loading.
// With the other order, a process whose first import is this file stops with "Cannot access
// 'CN_DOMESTIC_PROVIDERS' before initialization" (a command-line script, for example).
import { brandForMarket } from './agent.js';
import { enrichDedupeKey } from './service.js';
import { JOBS_ENRICH_WORK_KINDS } from './workers.js';
import type { EnrichPayload } from './schema.js';

export {
  EDUCATION_LEVELS,
  EMPLOYER_TAG_IDS,
  ENRICH_INDUSTRY_IDS,
  ENRICH_VERSION,
  EnrichLlmOutputSchema,
  EnrichOutputError,
  EnrichPayloadSchema,
  MAX_QUOTE_CHARS,
  RULES_CHECKED_MODEL,
  RULES_ONLY_MODEL,
  SENIORITY_LEVELS,
  SPONSORSHIP_STATUSES,
  parseEnrichOutput,
  parseEnrichText,
} from './schema.js';
export type { EducationLevel, EmployerTagId, EnrichLlmOutput, EnrichPayload, Seniority, SponsorshipStatus } from './schema.js';
export { hasNegation, mentionsWorkAuthorization, reconcileSponsorship, verifyQuote } from './quotes.js';
export { INTL_SCAM_RULES, detectScamSignals, mergeFraudFlags } from './scamSignals.js';
export type { FraudFlag, IntlScamRule, ScamSignal } from './scamSignals.js';
export { buildKeywords, MAX_KEYWORDS } from './keywords.js';
export type { JobKeyword, KeywordImportance } from './keywords.js';
export { selectTaxonomyCandidates } from './candidates.js';
export { REQUIREMENT_TAGS, needsLlm, postingTextOf } from './reconcile.js';
export { heldByRetiredWord, roleFromTitle, titleEvidence, titleIsDecisive, titleMatches, titleReadings } from './titleEvidence.js';
export type { TitleRuling } from './titleEvidence.js';
export type { CompanyIndustryClaim, ReconcileReport } from './reconcile.js';
export { CN_DOMESTIC_PROVIDERS, brandForMarket, resolveEnrichModel, taskModelRoute, type EnrichModelRoute } from './agent.js';
export { DEFAULT_ENRICH_DAILY_JOBS, enrichDailyLimit } from './budget.js';
export { enrichDedupeKey, enrichJob, systemUserIdFor } from './service.js';
export type { EnrichOutcome } from './service.js';
export { ENRICH_CONCURRENCY, JOBS_ENRICH_WORK_KINDS } from './workers.js';

/**
 * The dedupe suffix of a forced pass queued by the role backfill
 * (backfill/rematchRoles.ts): one per job per rematch generation. Bump it
 * when the title matcher changes again and stored roles must be looked at anew.
 */
export const REMATCH_GENERATION = 'rematch-v2';

/** The work-item dedupe key of the backfill's forced pass for a job. */
export function rematchDedupeKey(jobId: string): string {
  return `${enrichDedupeKey(jobId)}:${REMATCH_GENERATION}`;
}

/**
 * Queue one forced enrichment for a job whose title does not decide its role
 * (SM-2 backfill), so the model picks among the candidates. A second call for
 * the same job in the same rematch generation is a no-op (`created: false`):
 * the backfill can be run again without queueing the row twice.
 */
export function enqueueJobRematch(jobId: string, options: { market?: string } & Pick<EnqueueOptions, 'brand' | 'priority' | 'runAfter' | 'db'> = {}): Promise<EnqueuedItem> {
  const { market, brand, ...rest } = options;
  const payload: EnrichPayload = { jobId, force: true };
  return enqueue(JOBS_ENRICH_WORK_KINDS.jobEnrich, payload, {
    ...rest,
    brand: brand ?? (market ? brandForMarket(market) : undefined),
    dedupeKey: rematchDedupeKey(jobId),
    onConflict: 'keep',
  });
}

/**
 * Enqueue enrichment for a job. A new job: one item per job per version
 * (a duplicate call is a no-op). A materially changed job (`changed: true`):
 * the finished item is put back in the queue with `force`, so the row is
 * re-enriched even though it already carries ENRICH_VERSION. Pass the job's
 * `market` so the item is drained by the deployment that serves that brand
 * (an explicit `brand` wins; otherwise the current context's brand).
 */
export function enqueueJobEnrich(
  jobId: string,
  options: { changed?: boolean; market?: string } & Pick<EnqueueOptions, 'brand' | 'priority' | 'runAfter' | 'db'> = {},
): Promise<EnqueuedItem> {
  const { changed, market, brand, ...rest } = options;
  const payload: EnrichPayload = changed ? { jobId, force: true } : { jobId };
  return enqueue(JOBS_ENRICH_WORK_KINDS.jobEnrich, payload, {
    ...rest,
    brand: brand ?? (market ? brandForMarket(market) : undefined),
    dedupeKey: enrichDedupeKey(jobId),
    onConflict: changed ? 'requeue' : 'keep',
  });
}
